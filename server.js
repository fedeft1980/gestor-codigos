import 'dotenv/config';
import express from 'express';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const app = express();

app.use(express.json());
app.use(express.static('public'));

// Extrae el primer enlace de verificación del cuerpo del correo (HTML o texto plano)
function extraerEnlaceDelCuerpo(html, text) {
  const cuerpo = html || text || '';
  const urlRegex = /(https?:\/\/[^\s"<>]+)/g;
  const matches = cuerpo.match(urlRegex);
  return matches && matches.length > 0 ? matches[0] : null;
}

// Se conecta por IMAP a Gmail y busca el último correo dirigido a "correoCliente"
async function buscarCorreo(correoCliente) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASS
    },
    logger: false
  });

  await client.connect();

  try {
    await client.mailboxOpen('INBOX');

    // Busca por header "To" que contenga el correo del cliente
    const uids = await client.search({ to: correoCliente }, { uid: true });

    if (!uids || uids.length === 0) {
      return { encontrado: false };
    }

    // El UID más alto es, en general, el mensaje más reciente
    const ultimoUid = uids[uids.length - 1];

    const mensaje = await client.fetchOne(ultimoUid, { source: true }, { uid: true });
    const parsed = await simpleParser(mensaje.source);

    return {
      encontrado: true,
      fecha: parsed.date,
      html: parsed.html,
      text: parsed.text
    };
  } finally {
    await client.logout();
  }
}

// Ruta POST para obtener el enlace
app.post('/api/obtener-codigo', async (req, res) => {
  const { correoCliente } = req.body;

  if (!correoCliente) {
    return res.status(400).json({ exito: false, error: 'Debe ingresar un correo electrónico.' });
  }

  try {
    const resultado = await buscarCorreo(correoCliente.trim());

    if (!resultado.encontrado) {
      return res.status(404).json({
        exito: false,
        correoNoEncontrado: true,
        error: 'No se encontraron correos para este cliente.'
      });
    }

    // 1. Obtener timestamp del correo
    const timestampCorreo = resultado.fecha ? resultado.fecha.getTime() : null;

    const horaRecepcion = timestampCorreo
      ? new Date(timestampCorreo).toLocaleString('es-AR', {
          timeZone: 'America/Argentina/Buenos_Aires',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric'
        })
      : null;

    // 2. Calcular diferencia en minutos
    const ahora = Date.now();
    const diferenciaMinutos = timestampCorreo ? (ahora - timestampCorreo) / (1000 * 60) : null;

    // 3. Regla de los 15 minutos
    if (diferenciaMinutos === null || isNaN(diferenciaMinutos) || diferenciaMinutos > 15) {
      return res.json({
        exito: false,
        vencido: true,
        horaRecepcion,
        error: 'ENLACE VENCIDO, REENVÍA'
      });
    }

    // 4. Extraer el enlace de verificación
    const enlaceOriginal = extraerEnlaceDelCuerpo(resultado.html, resultado.text);

    if (!enlaceOriginal) {
      return res.status(404).json({ exito: false, error: 'No se encontró un enlace de verificación.', horaRecepcion });
    }

    return res.json({
      exito: true,
      vencido: false,
      horaRecepcion,
      leyenda: `Correo encontrado. Recibido a las ${horaRecepcion} (código válido por 15 min).`,
      enlace: enlaceOriginal
    });

  } catch (error) {
    console.error('Error en el servidor:', error);
    return res.status(500).json({ exito: false, error: 'Error al consultar la cuenta.' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Servidor activo en http://localhost:${PORT}`));
