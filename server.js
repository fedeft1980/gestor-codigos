const express = require('express');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Acepta varios nombres posibles de variables de entorno
const EMAIL_USER = process.env.EMAIL_USER || process.env.GMAIL_USER || process.env.IMAP_USER || process.env.USER_EMAIL;
const EMAIL_PASS = process.env.EMAIL_PASS || process.env.GMAIL_PASS || process.env.IMAP_PASS || process.env.APP_PASSWORD;
const IMAP_HOST = process.env.IMAP_HOST || 'imap.gmail.com';
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993');

if (!EMAIL_USER || !EMAIL_PASS) {
  console.error('FALTAN VARIABLES DE ENTORNO: EMAIL_USER y/o EMAIL_PASS no están definidas en Render.');
} else {
  console.log(`Configuración IMAP: usuario=${EMAIL_USER} host=${IMAP_HOST}:${IMAP_PORT}`);
}

// Se crea un cliente nuevo por cada consulta (un cliente no se puede reutilizar tras logout)
function crearCliente() {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS
    },
    logger: false
  });
}

// Extrae el enlace más relevante del correo (prioriza netflix.com)
function extraerEnlaceDelCuerpo(parsed) {
  const texto = (parsed.text || '') + '\n' + (parsed.html || '');
  if (!texto.trim()) return null;

  const urls = (texto.match(/https?:\/\/[^\s"'<>)\]]+/g) || [])
    .map(u => u.replace(/&amp;/g, '&').replace(/[.,;]+$/, ''));

  const descartar = [
    '.png', '.jpg', '.jpeg', '.gif', 'schema.org', 'facebook', 'twitter',
    'instagram', 'google.com', 'unsubscribe', 'privacy', 'help.netflix'
  ];

  const validas = urls.filter(u => !descartar.some(d => u.toLowerCase().includes(d)));

  return validas.find(u => u.includes('netflix.com')) || validas[0] || null;
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

// Ruta para comprobar que corre la versión nueva
app.get('/version', (req, res) => res.send('server nuevo v3'));

app.post('/api/obtener-codigo', async (req, res) => {
  const { correoCliente } = req.body;

  if (!correoCliente) {
    return res.status(400).json({ exito: false, error: 'Debe ingresar un correo electrónico.' });
  }

  const client = crearCliente();

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    let correoEncontrado = null;
    let fechaCorreo = null;

    try {
      // Buscar correos dirigidos al cliente
      const uids = await client.search({ to: correoCliente.trim() }, { uid: true });

      // Tomar los 5 más recientes (UIDs más altos), del más nuevo al más viejo
      const ultimos = (uids || []).slice(-5).reverse();

      for (const uid of ultimos) {
        const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
        if (!msg || !msg.source) continue;

        const parsed = await simpleParser(msg.source);

        if (esCorreoValido(parsed.subject)) {
          correoEncontrado = parsed;
          fechaCorreo = (msg.envelope && msg.envelope.date) || parsed.date;
          break; // el más reciente que coincida
        }
      }
    } finally {
      lock.release();
    }

    if (!correoEncontrado || !fechaCorreo) {
      return res.status(404).json({
        exito: false,
        error: 'No se encontraron correos recientes de verificación o hogar para este cliente.'
      });
    }

    const fecha = new Date(fechaCorreo);
    const minutos = (Date.now() - fecha.getTime()) / 60000;
    const enlace = extraerEnlaceDelCuerpo(correoEncontrado);

    return res.json({
      exito: true,
      servicio: 'Netflix',
      asunto: correoEncontrado.subject || '',
      fechaRecepcion: fecha.toISOString(),
      vencido: minutos > 13,
      enlace
    });

  } catch (error) {
    console.error('Error en el servidor:', error.message, '|', error.responseText || '', '|', error.code || '');
    return res.status(500).json({ exito: false, error: 'Error al consultar la bandeja de entrada.' });
  } finally {
    try { await client.logout(); } catch (_) {}
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
});
