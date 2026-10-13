import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { ImapFlow } from 'imapflow';
import mailparser from 'mailparser';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const { simpleParser } = mailparser;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// REMITENTES PERMITIDOS
// Solo se aceptan correos enviados por estas direcciones (evita correos falsos).
// Para agregar más, ponelos en Render como variable REMITENTES_NETFLIX separados
// por coma. Ej: info@account.netflix.com,info@mailer.netflix.com
// También se puede poner un dominio completo con @: @netflix.com
// ---------------------------------------------------------------------------
const REMITENTES = (process.env.REMITENTES_NETFLIX || 'info@account.netflix.com')
  .split(',')
  .map(r => r.trim().toLowerCase())
  .filter(Boolean);

function remitentePermitido(direccion) {
  const d = (direccion || '').toLowerCase();
  return REMITENTES.some(r => (r.startsWith('@') ? d.endsWith(r) : d === r));
}

// Variables de entorno (tus nombres de Render: GMAIL_USER y GMAIL_APP_PASS)
const GMAIL_USER = (process.env.GMAIL_USER || process.env.EMAIL_USER || '').trim();
const GMAIL_PASS = (process.env.GMAIL_APP_PASS || process.env.EMAIL_PASS || '').replace(/\s+/g, '').trim();

if (!GMAIL_USER || !GMAIL_PASS) {
  console.error('FALTAN VARIABLES DE ENTORNO: GMAIL_USER y/o GMAIL_APP_PASS no están definidas en Render.');
} else {
  console.log(`Configuración IMAP: usuario=${GMAIL_USER} | remitentes=${REMITENTES.join(', ')}`);
}

function esCorreoValido(asunto) {
  const a = (asunto || '').toLowerCase();

  const esAcceso =
    a.includes('obten tu cod') ||
    a.includes('obtén tu cod') ||
    a.includes('código de acceso temporal') ||
    a.includes('codigo de acceso temporal');

  const esHogar =
    a.includes('actualizar tu hogar') ||
    a.includes('cómo cambiar tu hogar') ||
    a.includes('como cambiar tu hogar');

  return esAcceso || esHogar;
}

// Elige el enlace de verificación del correo
function extraerEnlace(parsed) {
  const texto = (parsed.text || '') + '\n' + (parsed.html || '');

  const urls = (texto.match(/https?:\/\/[^\s"'<>)\]]+/g) || [])
    .map(u => u.replace(/&amp;/g, '&').replace(/[.,;]+$/, ''));

  const basura = [
    '.png', '.jpg', '.jpeg', '.gif', 'schema.org', 'facebook', 'twitter',
    'instagram', 'google.com', 'unsubscribe', 'privacy', 'help.netflix'
  ];
  const validas = urls.filter(u => !basura.some(b => u.toLowerCase().includes(b)));

  // 1) enlaces típicos de verificación / hogar de Netflix
  const claves = ['update', 'household', 'travel', 'verify', 'nftx.me', 'code'];
  const prioritario = validas.find(u => claves.some(k => u.toLowerCase().includes(k)));
  if (prioritario) return prioritario;

  // 2) cualquier enlace de netflix, 3) cualquier otro válido
  return validas.find(u => u.includes('netflix.com')) || validas[0] || null;
}

app.get('/version', (req, res) => res.send('server nuevo v5 (remitentes + GMAIL_APP_PASS)'));

app.post('/api/obtener-codigo', async (req, res) => {
  const { correoCliente } = req.body;

  if (!correoCliente) {
    return res.status(400).json({ exito: false, error: 'Falta ingresar el correo del cliente.' });
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
    logger: false
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    let correoEncontrado = null;
    let fechaCorreo = null;

    try {
      // Búsqueda: dirigido al cliente Y enviado por un remitente permitido
      const criterios = { header: { to: correoCliente.trim() } };
      if (REMITENTES.length === 1) {
        criterios.from = REMITENTES[0];
      } else {
        criterios.or = REMITENTES.map(r => ({ from: r }));
      }

      const encontrados = await client.search(criterios, { uid: true });

      if (!encontrados || encontrados.length === 0) {
        return res.status(404).json({ exito: false, error: 'No se encontraron correos para esta cuenta.' });
      }

      // Los 10 más recientes, del más nuevo al más viejo
      const ultimos = encontrados.slice(-10).reverse();

      for (const uid of ultimos) {
        const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
        if (!msg || !msg.source) continue;

        const parsed = await simpleParser(msg.source);

        // Doble verificación del remitente real
        const desde = parsed.from && parsed.from.value && parsed.from.value[0]
          ? parsed.from.value[0].address
          : '';
        if (!remitentePermitido(desde)) continue;

        if (esCorreoValido(parsed.subject)) {
          correoEncontrado = parsed;
          fechaCorreo = (msg.envelope && msg.envelope.date) || parsed.date;
          break; // el más reciente que cumpla
        }
      }
    } finally {
      lock.release();
    }

    if (!correoEncontrado || !fechaCorreo) {
      return res.status(404).json({
        exito: false,
        error: 'No se encontró código de acceso ni actualización de hogar para esta cuenta.'
      });
    }

    const fecha = new Date(fechaCorreo);
    const minutos = (Date.now() - fecha.getTime()) / 60000;

    return res.json({
      exito: true,
      servicio: 'Netflix',
      correo: correoCliente,
      asunto: correoEncontrado.subject || '',
      fechaRecepcion: fecha.toISOString(),
      vencido: minutos > 13,
      enlace: extraerEnlace(correoEncontrado)
    });

  } catch (error) {
    console.error('Error procesando correo:', error.message, '|', error.responseText || '', '|', error.code || '');

    if (error.authenticationFailed) {
      return res.status(500).json({
        exito: false,
        error: 'Error de autenticación con Gmail. Revisá GMAIL_USER y GMAIL_APP_PASS en Render.'
      });
    }
    return res.status(500).json({ exito: false, error: 'Error de conexión con Gmail.' });
  } finally {
    if (client.usable) {
      try { await client.logout(); } catch (_) {}
    }
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
});
