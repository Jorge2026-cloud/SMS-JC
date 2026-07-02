# SMS JC — Plataforma de envío de SMS/MMS via Google Messages

## Despliegue en Railway

1. Sube este proyecto a GitHub
2. Entra a railway.app → New Project → Deploy from GitHub
3. Selecciona el repositorio
4. En Variables de entorno agrega:
   - `APP_PASSWORD` = una contraseña segura que tú elijas
   - `SESSION_SECRET` = un texto largo y aleatorio
5. Railway generará una URL pública

## Uso

1. Abre la URL de Railway
2. Inicia sesión con nombre, apellido y la contraseña configurada en `APP_PASSWORD`
3. Cada persona vincula **su propio** Google Messages desde el botón de la barra lateral (escanea el QR con su celular). Cada usuario mantiene su propia sesión y cola de envíos, así que varias personas pueden usar la app al mismo tiempo, cada una enviando desde su propio número.
4. Crea una campaña:
   - Elige el tipo de Mora (30U, 60+ o TC)
   - Carga tu Excel con las columnas: Nombre, Número, Mensaje
   - Opcionalmente adjunta una imagen (se envía como MMS)
   - Escribe el mensaje base (se usa si la fila del Excel no trae un mensaje propio)
   - Elige el intervalo entre envíos: 15 segundos, 40 segundos o 1 minuto
5. Sigue el progreso en el Dashboard (enviados, fallidos, pendientes) y en el log en tiempo real

## Formato del Excel

| Nombre | Número | Mensaje |
|--------|--------|---------|
| Juan López | +50212345678 | Estimado Juan, tiene un saldo pendiente... |

Si dejas la columna Mensaje vacía para una fila, se usará la plantilla general con `{Nombre}`, `{Número}` y `{Fecha}`.

## Notas importantes

- El envío se hace automatizando el navegador sobre tu propia sesión de Google Messages Web (no es una API oficial de SMS). Google puede detectar patrones de automatización y bloquear temporalmente la sesión si se envían muchos mensajes muy rápido — usa intervalos conservadores (40s–1min) para lotes grandes.
- El envío de mensajes de cobranza está sujeto a las leyes de protección al consumidor de tu país (frecuencia, horarios, opción de baja). Revisa esto antes de operar campañas masivas.
