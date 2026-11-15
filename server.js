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
// En Render: REMITENTES_NETFLIX=soporte@streaminfinity.com.co,info@account.netflix.com
// Se puede usar un dominio completo con @: @streaminfinity.com.co
// ---------------------------------------------------------------------------
const REMITENTES = (
  process.env.REMITENTES_NETFLIX ||
  'soporte@streaminfinity.com.co,info@account.netflix.com'
)
  .split(',')
  .map(r => r.trim().toLowerCase())
  .filter(Boolean);

function remitentePermitido(direccion) {
  const d = (direccion || '').toLowerCase();
  return REMITENTES.some(r => (r.startsWith('@') ? d.endsWith(r) : d === r));
}

const GMAIL_USER = (process.env.GMAIL_USER || process.env.EMAIL_USER || '').trim();
const GMAIL_PASS = (process.env.GMAIL_APP_PASS || process.env.EMAIL_PASS || '').replace(/\s+/g, '').trim();

if (!GMAIL_USER || !GMAIL_PASS) {
  console.error('FALTAN VARIABLES DE ENTORNO: GMAIL_USER y/o GMAIL_APP_PASS no están definidas en Render.');
} else {
  console.log(`Configuración IMAP: usuario=${GMAIL_USER} | remitentes=${REMITENTES.join(', ')}`);
}

// ---------------------------------------------------------------------------
// ASUNTOS VÁLIDOS
// Devuelve el tipo de correo o null si no sirve.
// 'verificacion' es ambiguo (puede ser de otro servicio), por eso después
// se exige que el cuerpo mencione Netflix.
// ---------------------------------------------------------------------------
function tipoDeAsunto(asunto) {
  const a = (asunto || '').toLowerCase();

  const esAcceso =
    a.includes('obten tu cod') ||
    a.includes('obtén tu cod') ||
    a.includes('código de acceso temporal') ||
    a.includes('codigo de acceso temporal') ||
    a.includes('código de inicio de sesión') ||
    a.includes('codigo de inicio de sesion') ||
    a.includes('solicitud de inicio de sesión') ||
    a.includes('solicitud de inicio de sesion');

  const esHogar =
    a.includes('actualizar tu hogar') ||
    a.includes('cómo cambiar tu hogar') ||
    a.includes('como cambiar tu hogar');

  const esVerificacion =
    a.includes('código de verificación') ||
    a.includes('codigo de verificacion');

  if (esAcceso || esHogar) return 'normal';
  if (esVerificacion) return 'verificacion';
  return null;
}

function mencionaNetflix(parsed) {
  const t = ((parsed.subject || '') + ' ' + (parsed.text || '') + ' ' + (parsed.html || '')).toLowerCase();
  return t.includes('netflix');
}

function esCorreoValido(parsed) {
  const tipo = tipoDeAsunto(parsed.subject);
  if (tipo === 'normal') return true;
  if (tipo === 'verificacion') return mencionaNetflix(parsed);
  return false;
}

// ---------------------------------------------------------------------------
// ¿El correo corresponde al cliente?
// Revisa destinatarios, cabeceras de reenvío y el cuerpo del mensaje.
// ---------------------------------------------------------------------------
function correoEsDelCliente(parsed, correoCliente) {
  const c = correoCliente.toLowerCase();

  const cabeceras = ['to', 'x-original-to', 'delivered-to', 'x-forwarded-to', 'cc']
    .map(h => {
      const v = parsed.headers && parsed.headers.get(h);
      if (!v) return '';
      return typeof v === 'string' ? v : (v.text || JSON.stringify(v));
    })
    .join(' ')
    .toLowerCase();

  if (cabeceras.includes(c)) return true;

  const cuerpo = ((parsed.text || '') + ' ' + (parsed.html || '')).toLowerCase();
  return cuerpo.includes(c);
}

// ---------------------------------------------------------------------------
// Extrae el enlace de verificación
// ---------------------------------------------------------------------------
function extraerEnlace(parsed) {
  const texto = (parsed.text || '') + '\n' + (parsed.html || '');

  const urls = (texto.match(/https?:\/\/[^\s"'<>)\]]+/g) || [])
    .map(u => u.replace(/&amp;/g, '&').replace(/[.,;]+$/, ''));

  const basura = [
    '.png', '.jpg', '.jpeg', '.gif', 'schema.org', 'facebook', 'twitter',
    'instagram', 'google.com', 'unsubscribe', 'privacy', 'help.netflix'
  ];
  const validas = urls.filter(u => !basura.some(b => u.toLowerCase().includes(b)));

  const claves = ['update', 'household', 'travel', 'verify', 'nftx.me', 'code'];
  const prioritario = validas.find(u => claves.some(k => u.toLowerCase().includes(k)));
  if (prioritario) return prioritario;

  return validas.find(u => u.includes('netflix.com')) || validas[0] || null;
}

// ---------------------------------------------------------------------------
// Extrae un código numérico (4 a 8 dígitos) si el correo lo trae en texto
// ---------------------------------------------------------------------------
function extraerCodigo(parsed) {
  const textoPlano = (parsed.text || '') ||
    (parsed.html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const texto = textoPlano.replace(/\s+/g, ' ');

  let m = texto.match(/c[oó]digo[^0-9]{0,60}(\d{4,8})\b/i);
  if (m) return m[1];

  m = texto.match(/(?:^|\s)(\d{4,8})(?:\s|$)/);
  return m ? m[1] : null;
}

app.get('/version', (req, res) => res.send('server nuevo v7 (streaminfinity + codigo + verificacion)'));

app.post('/api/obtener-codigo', async (req, res) => {
  const { correoCliente } = req.body;

  if (!correoCliente) {
    return res.status(400).json({ exito: false, error: 'Falta ingresar el correo del cliente.' });
  }

  const correo = correoCliente.trim();

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
      const desdeFecha = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const criterios = { since: desdeFecha };

      if (REMITENTES.length === 1) {
        criterios.from = REMITENTES[0];
      } else {
        criterios.or = REMITENTES.map(r => ({ from: r }));
      }

      const encontrados = await client.search(criterios, { uid: true });
      console.log(`Búsqueda: remitentes=${REMITENTES.join(',')} | encontrados=${encontrados ? encontrados.length : 0}`);

      if (!encontrados || encontrados.length === 0) {
        return res.status(404).json({ exito: false, error: 'No se encontraron correos recientes.' });
      }

      // Los 60 más recientes, del más nuevo al más viejo
      const ultimos = encontrados.slice(-60).reverse();

      for (const uid of ultimos) {
        const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
        if (!msg || !msg.source) continue;

        const parsed = await simpleParser(msg.source);

        const desde = parsed.from && parsed.from.value && parsed.from.value[0]
          ? parsed.from.value[0].address
          : '';

        if (!remitentePermitido(desde)) continue;
        if (!esCorreoValido(parsed)) continue;
        if (!correoEsDelCliente(parsed, correo)) continue;

        correoEncontrado = parsed;
        fechaCorreo = (msg.envelope && msg.envelope.date) || parsed.date;
        break; // el más reciente que cumpla todo
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
      correo,
      asunto: correoEncontrado.subject || '',
      fechaRecepcion: fecha.toISOString(),
      vencido: minutos > 13,
      enlace: extraerEnlace(correoEncontrado),
      codigo: extraerCodigo(correoEncontrado)
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
