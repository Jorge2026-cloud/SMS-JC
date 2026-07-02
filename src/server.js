const express  = require('express');
const session  = require('express-session');
const cors     = require('cors');
const { WebSocketServer } = require('ws');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const multer   = require('multer');
const XLSX     = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const puppeteer = require('puppeteer');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = process.env.PORT || 3000;
const PASS   = process.env.APP_PASSWORD;
const SECRET = process.env.SESSION_SECRET;

if (!PASS)   console.warn('⚠️  APP_PASSWORD no está configurado en las variables de entorno.');
if (!SECRET) console.warn('⚠️  SESSION_SECRET no está configurado en las variables de entorno.');

// ── Middleware ─────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));
const sessionMw = session({
  secret: SECRET || uuidv4(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, secure: false }
});
app.use(sessionMw);
const uploadFile  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// ── State (compartido entre usuarios) ────────────────────────────
let campaigns = [];
let templates = [
  { id:'t1', name:'Recordatorio 30U', type:'30U', body:'Estimado {Nombre}, le recordamos que tiene un saldo pendiente. Por favor realice su pago a la brevedad.' },
  { id:'t2', name:'Aviso 60+ días',   type:'60+', body:'AVISO: {Nombre}, su cuenta presenta más de 60 días de atraso. Le pedimos comunicarse para regularizar su situación.' },
  { id:'t3', name:'TC Primer Aviso',  type:'TC',  body:'Hola {Nombre}, su tarjeta de crédito tiene un saldo vencido. Evite cargos adicionales realizando su pago hoy.' },
];
let users  = [];
let smsLog = [];

const INTERVALS = { '15s': 15000, '40s': 40000, '1min': 60000 };

// ── Sesiones de Google Messages (una por usuario) ───────────────
// sessionId -> { browser, page, status, qrPolling, queue:[], isSending, ownerName }
const gmSessions = new Map();

function getSession(sid) {
  if (!gmSessions.has(sid)) {
    gmSessions.set(sid, { browser:null, page:null, status:'disconnected', qrPolling:false, queue:[], isSending:false, ownerName:null });
  }
  return gmSessions.get(sid);
}

// ── WebSocket (cada cliente se asocia a su sessionId) ───────────
const clients = new Map(); // ws -> sessionId
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const sid = url.searchParams.get('sid') || 'anon';
  clients.set(ws, sid);
  const gs = getSession(sid);
  ws.send(JSON.stringify({ type:'status', data:{ gmStatus: gs.status } }));
  ws.on('close', () => clients.delete(ws));
});
function broadcastTo(sid, type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  clients.forEach((s, ws) => { if (s === sid) { try { ws.send(msg); } catch(e){} } });
}
function broadcastAll(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  clients.forEach((s, ws) => { try { ws.send(msg); } catch(e){} });
}
function log(sid, level, msg) {
  broadcastTo(sid, 'log', { level, msg });
  console.log(`[${level.toUpperCase()}][${sid.slice(0,6)}] ${msg}`);
}

// ── Launch Browser (por sesión) ──────────────────────────────────
async function launchBrowser(sid) {
  const gs = getSession(sid);
  if (gs.browser) return;
  log(sid, 'info', '🌐 Iniciando navegador...');
  gs.browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--no-first-run','--no-zygote','--disable-extensions',
      '--disable-background-networking','--disable-default-apps',
    ],
    executablePath: process.env.PUPPETEER_EXEC_PATH || undefined,
    timeout: 60000,
  });
  log(sid, 'info', '✅ Navegador iniciado');
}

async function openGoogleMessages(sid) {
  const gs = getSession(sid);
  await launchBrowser(sid);
  gs.status = 'waiting_qr';
  broadcastTo(sid, 'status', { gmStatus: gs.status });
  log(sid, 'info', '📱 Abriendo Google Messages...');

  gs.page = await gs.browser.newPage();
  await gs.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await gs.page.setViewport({ width: 1280, height: 900 });

  await gs.page.goto('https://messages.google.com/web/authentication', {
    waitUntil: 'networkidle2', timeout: 30000
  });
  log(sid, 'info', '⏳ Página cargada. Generando código QR...');

  gs.qrPolling = true;
  pollForQRAndConnected(sid);
}

async function pollForQRAndConnected(sid) {
  const gs = getSession(sid);
  while (gs.qrPolling) {
    try {
      const connected = await gs.page.evaluate(() => {
        return !!(
          document.querySelector('mw-conversation-list') ||
          document.querySelector('.conversation-list-container') ||
          document.querySelector('[data-e2e-conversations]') ||
          (document.title.includes('Messages') && !document.querySelector('mw-qr-code'))
        );
      }).catch(() => false);

      if (connected && gs.status !== 'connected') {
        gs.status = 'connected';
        gs.qrPolling = false;
        broadcastTo(sid, 'status', { gmStatus: gs.status });
        log(sid, 'ok', '✅ Google Messages vinculado. Listo para enviar.');
        break;
      }

      const screenshot = await gs.page.screenshot({ encoding: 'base64' }).catch(() => null);
      if (screenshot) broadcastTo(sid, 'qr_screenshot', { image: screenshot });

    } catch(e) { /* la página puede no estar lista aún */ }
    await new Promise(r => setTimeout(r, 2500));
  }
}

// ── Enviar un SMS (con imagen opcional) via Google Messages ─────
async function sendViaMsgs(sid, phone, message, imagePath) {
  const gs = getSession(sid);
  if (!gs.page) throw new Error('Navegador no iniciado');
  if (gs.status !== 'connected') throw new Error('Google Messages no vinculado');

  const cleanPhone = phone.replace(/\s+/g, '');
  log(sid, 'info', `📤 Enviando a ${cleanPhone}...`);

  try {
    await gs.page.goto(
      `https://messages.google.com/web/conversations/new?recipient=${encodeURIComponent(cleanPhone)}`,
      { waitUntil: 'networkidle2', timeout: 20000 }
    );
    await new Promise(r => setTimeout(r, 2000));

    const inputSels = [
      'textarea[aria-label]', 'textarea[placeholder]', '.input-box textarea',
      'mws-message-compose textarea', '[contenteditable="true"][role="textbox"]', 'textarea',
    ];
    let inputEl = null;
    for (const sel of inputSels) {
      try {
        await gs.page.waitForSelector(sel, { timeout: 3000 });
        inputEl = await gs.page.$(sel);
        if (inputEl) break;
      } catch(e) {}
    }
    if (!inputEl) {
      inputEl = await gs.page.evaluateHandle(() => {
        for (const el of document.querySelectorAll('textarea,[contenteditable="true"]')) {
          const r = el.getBoundingClientRect();
          if (r.width > 50 && r.height > 20) return el;
        }
        return null;
      });
      if (!inputEl || !(await inputEl.asElement())) throw new Error('Campo de texto no encontrado');
    }

    if (message) {
      await inputEl.click({ clickCount: 3 });
      await new Promise(r => setTimeout(r, 300));
      await inputEl.type(message, { delay: 25 });
      await new Promise(r => setTimeout(r, 500));
    }

    // Adjuntar imagen si aplica
    if (imagePath) {
      const fileInput = await gs.page.$('input[type="file"]');
      if (fileInput) {
        await fileInput.uploadFile(imagePath);
        log(sid, 'info', '🖼️ Imagen adjuntada, esperando previsualización...');
        await new Promise(r => setTimeout(r, 2500));
      } else {
        log(sid, 'err', '⚠️ No se encontró el botón para adjuntar imagen; se envía solo el texto.');
      }
    }

    await new Promise(r => setTimeout(r, 500));

    const sendSels = [
      'button[aria-label="Send message"]', 'button[aria-label="Enviar mensaje"]',
      'button[data-e2e-button="send"]', '.send-button button', 'mws-icon-button[icon="send"]',
    ];
    let sent = false;
    for (const sel of sendSels) {
      try {
        const btn = await gs.page.$(sel);
        if (btn) { await btn.click(); sent = true; break; }
      } catch(e) {}
    }
    if (!sent) await inputEl.press('Enter');

    await new Promise(r => setTimeout(r, 1500));
    return { ok: true };

  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// ── Procesar cola de una sesión (usuario) ────────────────────────
async function processQueue(sid) {
  const gs = getSession(sid);
  if (gs.isSending || !gs.queue.length) return;
  gs.isSending = true;
  log(sid, 'info', `▶️ Procesando cola: ${gs.queue.length} mensajes pendientes`);

  while (gs.queue.length > 0) {
    const job  = gs.queue[0];
    const camp = campaigns.find(c => c.id === job.campId);

    log(sid, 'info', `📤 [${job.name}] ${job.phone}`);
    const result = await sendViaMsgs(sid, job.phone, job.message, job.imagePath);

    const entry = {
      id: uuidv4(), campId: job.campId, campName: job.campName,
      name: job.name, phone: job.phone, message: job.message,
      status: result.ok ? 'sent' : 'failed',
      error: result.error || null,
      time: new Date().toISOString(),
    };
    smsLog.push(entry);

    if (camp) {
      if (result.ok) { camp.sent++; log(sid, 'ok', `✅ Enviado a ${job.name}`); }
      else           { camp.failed++; log(sid, 'err', `❌ Error ${job.name}: ${result.error}`); }
      camp.pending = Math.max(0, camp.pending - 1);
      if (camp.pending === 0) { camp.status = 'done'; log(sid, 'ok', `🏁 Campaña "${camp.name}" completada`); }
    }

    broadcastAll('sms_result', entry);
    broadcastAll('campaigns', campaigns);
    gs.queue.shift();

    if (gs.queue.length > 0) await new Promise(r => setTimeout(r, job.intervalMs || 40000));
  }

  gs.isSending = false;
  log(sid, 'info', '✅ Cola vacía.');
}

// ── Auth middleware ────────────────────────────────────────────
function auth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'No autorizado' });
}

// ── Routes ─────────────────────────────────────────────────────

app.post('/api/login', (req, res) => {
  const { nombre, apellido, password } = req.body;
  if (!nombre?.trim() || !apellido?.trim() || !PASS || password !== PASS)
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  const fullName = `${nombre.trim()} ${apellido.trim()}`;
  req.session.user = { nombre: nombre.trim(), apellido: apellido.trim(), fullName };
  const u = users.find(x => x.name === fullName);
  if (u) u.lastLogin = new Date().toISOString();
  else users.push({ name: fullName, lastLogin: new Date().toISOString(), campaigns: 0 });
  const gs = getSession(req.sessionID);
  gs.ownerName = fullName;
  res.json({ ok: true, user: req.session.user, sid: req.sessionID });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/api/me', (req, res) => req.session?.user ? res.json({ user: req.session.user, sid: req.sessionID }) : res.status(401).json({ error: 'No autorizado' }));

// Google Messages — cada usuario vincula su propio número
app.post('/api/gm/connect', auth, async (req, res) => {
  try {
    const gs = getSession(req.sessionID);
    if (gs.status === 'connected') return res.json({ ok: true, status: 'connected' });
    openGoogleMessages(req.sessionID); // corre en segundo plano
    res.json({ ok: true, msg: 'Iniciando... escanea el QR cuando aparezca.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gm/status', auth, (req, res) => res.json({ status: getSession(req.sessionID).status }));

app.get('/api/gm/screenshot', auth, async (req, res) => {
  const gs = getSession(req.sessionID);
  if (!gs.page) return res.status(400).json({ error: 'Sin navegador activo' });
  try {
    const img = await gs.page.screenshot({ encoding: 'base64' });
    res.json({ image: img });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Excel upload — columnas: Nombre | Número | Mensaje
app.post('/api/upload', auth, uploadFile.single('file'), (req, res) => {
  try {
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const start = rows[0] && isNaN(Number(String(rows[0][0]).replace(/[+\s]/g,''))) ? 1 : 0;
    const contacts = rows.slice(start)
      .filter(r => r[0] || r[1])
      .map(r => ({
        nombre:  String(r[0]||'').trim(),
        numero:  String(r[1]||'').trim().replace(/\s+/g,''),
        mensaje: String(r[2]||'').trim(),
      }))
      .filter(c => c.numero);
    res.json({ ok: true, contacts, total: contacts.length });
  } catch(e) { res.status(400).json({ error: 'Error leyendo archivo: ' + e.message }); }
});

// Imagen para adjuntar a la campaña
app.post('/api/upload-image', auth, uploadImage.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Sin archivo' });
    const dir = path.join(os.tmpdir(), 'smsjc-img');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ext = (req.file.originalname.match(/\.[a-zA-Z0-9]+$/) || ['.jpg'])[0];
    const fname = `${uuidv4()}${ext}`;
    const fpath = path.join(dir, fname);
    fs.writeFileSync(fpath, req.file.buffer);
    res.json({ ok: true, imagePath: fpath, previewBase64: req.file.buffer.toString('base64'), mime: req.file.mimetype });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Templates CRUD
app.get('/api/templates',        auth, (req, res) => res.json(templates));
app.post('/api/templates',       auth, (req, res) => { const t = { id: uuidv4(), ...req.body }; templates.push(t); res.json(t); });
app.delete('/api/templates/:id', auth, (req, res) => { templates = templates.filter(t => t.id !== req.params.id); res.json({ ok: true }); });

// Campaigns
app.get('/api/campaigns', auth, (req, res) => res.json(campaigns));

app.post('/api/campaigns', auth, (req, res) => {
  const { name, type, contacts, messageTemplate, scheduledAt, interval, imagePath } = req.body;
  if (!contacts?.length) return res.status(400).json({ error: 'Sin contactos' });

  const intervalMs = INTERVALS[interval] || INTERVALS['40s'];

  const camp = {
    id: uuidv4(), name, type,
    status: scheduledAt ? 'scheduled' : 'running',
    total: contacts.length, sent: 0, failed: 0, pending: contacts.length,
    scheduledAt: scheduledAt || null,
    createdAt: new Date().toISOString(),
    createdBy: req.session.user.fullName,
    ownerSid: req.sessionID,
    interval, intervalMs, hasImage: !!imagePath,
    messageTemplate, contacts,
  };
  campaigns.unshift(camp);
  broadcastAll('campaigns', campaigns);

  const u = users.find(x => x.name === req.session.user.fullName);
  if (u) u.campaigns = (u.campaigns||0) + 1;

  const gs = getSession(req.sessionID);

  if (!scheduledAt) {
    contacts.forEach(c => {
      const msg = c.mensaje && c.mensaje.trim()
        ? c.mensaje.trim()
        : (messageTemplate || '')
            .replace(/{Nombre}/g, c.nombre)
            .replace(/{Número}/g, c.numero)
            .replace(/{Fecha}/g,  new Date().toLocaleDateString('es-GT'));
      gs.queue.push({ campId:camp.id, campName:camp.name, name:c.nombre, phone:c.numero, message:msg, imagePath: imagePath || null, intervalMs });
    });
    processQueue(req.sessionID);
  }

  res.json(camp);
});

app.delete('/api/campaigns/:id', auth, (req, res) => {
  campaigns = campaigns.filter(c => c.id !== req.params.id);
  broadcastAll('campaigns', campaigns);
  res.json({ ok: true });
});

// SMS Log
app.get('/api/smslog', auth, (req, res) => res.json([...smsLog].reverse().slice(0, 300)));

// Stats (globales del equipo)
app.get('/api/stats', auth, (req, res) => {
  const today = new Date().toDateString();
  const tLog  = smsLog.filter(s => new Date(s.time).toDateString() === today);
  const gs = getSession(req.sessionID);
  const totalPending = [...gmSessions.values()].reduce((a,g) => a + g.queue.length, 0);
  res.json({
    sent:    tLog.filter(s => s.status === 'sent').length,
    failed:  tLog.filter(s => s.status === 'failed').length,
    pending: totalPending,
    total:   smsLog.length,
    gmStatus: gs.status,
  });
});

app.get('/api/users', auth, (req, res) => res.json(users));

// Scheduled campaigns
setInterval(() => {
  const now = new Date();
  campaigns
    .filter(c => c.status === 'scheduled' && c.scheduledAt && new Date(c.scheduledAt) <= now)
    .forEach(camp => {
      camp.status = 'running';
      const gs = getSession(camp.ownerSid);
      camp.contacts.forEach(c => {
        const msg = c.mensaje && c.mensaje.trim()
          ? c.mensaje.trim()
          : (camp.messageTemplate || '')
              .replace(/{Nombre}/g, c.nombre)
              .replace(/{Número}/g, c.numero)
              .replace(/{Fecha}/g, new Date().toLocaleDateString('es-GT'));
        gs.queue.push({ campId:camp.id, campName:camp.name, name:c.nombre, phone:c.numero, message:msg, intervalMs: camp.intervalMs });
      });
      log(camp.ownerSid, 'info', `⏰ Campaña programada iniciada: ${camp.name}`);
      broadcastAll('campaigns', campaigns);
      processQueue(camp.ownerSid);
    });
}, 30000);

server.listen(PORT, () => console.log(`SMS JC corriendo en puerto ${PORT}`));
