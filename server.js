import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const REMITENTE_NETFLIX = 'info@account.netflix.com';

app.post('/api/obtener-codigo', async (req, res) => {
  const { correoCliente } = req.body;

  if (!correoCliente) {
    return res.status(400).json({ error: 'Falta ingresar el correo del cliente.' });
  }

  const gmailUser = (process.env.GMAIL_USER || '').trim();
  const gmailPass = (process.env.GMAIL_APP_PASS || '').replace(/\s+/g, '').trim();

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: gmailUser, pass: gmailPass },
    tls: { rejectUnauthorized: false },
    logger: false
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      const messages = await client.search({
        header: { 'to': correoCliente },
        from: REMITENTE_NETFLIX
      });

      if (!messages || messages.length === 0) {
        return res.status(404).json({ error: 'No se encontraron correos para esta cuenta.' });
      }

      // Ordenar de más reciente a más antiguo
      const ultimosMensajes = messages.reverse().slice(0, 10);

      let correoValido = null;
      let contenido = '';
      let asuntoEncontrado = '';

      for (const msgSeq of ultimosMensajes) {
        const message = await client.fetchOne(msgSeq, { source: true });
        const parsed = await simpleParser(message.source);
        const asunto = (parsed.subject || '').trim();
        const asuntoLower = asunto.toLowerCase();

        const esAccesoCodigo = asuntoLower.includes('obten tu cod') || 
                              asuntoLower.includes('obtén tu cod') || 
                              asuntoLower.includes('código de acceso temporal') || 
                              asuntoLower.includes('codigo de acceso temporal');

        const esHogar = asuntoLower.includes('actualizar tu hogar');

        if (esAccesoCodigo || esHogar) {
          correoValido = parsed;
          asuntoEncontrado = asunto;
          contenido = parsed.text || parsed.html || '';
          break; // Detiene la búsqueda al encontrar el más reciente que cumpla el filtro
        }
      }

      if (!correoValido) {
        return res.status(404).json({ error: 'No se encontró código de acceso ni actualización de hogar para esta cuenta.' });
      }

      const esHogarCorreo = asuntoEncontrado.toLowerCase().includes('actualizar tu hogar');

      let codigoMatch = null;
      if (!esHogarCorreo) {
        codigoMatch = contenido.match(/\b\d{4,6}\b/);
      }

      const urls = contenido.match(/https?:\/\/[^\s"]+/g) || [];
      const enlaceHogar = urls.find(url => 
        url.includes('update') || 
        url.includes('household') || 
        url.includes('travel') || 
        url.includes('verify') ||
        url.includes('nftx.me') ||
        url.includes('code')
      );

      return res.json({
        exito: true,
        servicio: 'Netflix',
        correo: correoCliente,
        asunto: asuntoEncontrado,
        codigo: codigoMatch ? codigoMatch[0] : null,
        enlace: enlaceHogar || null,
        fechaRecepcion: correoValido.date ? correoValido.date.toISOString() : null
      });

    } finally {
      lock.release();
    }
  } catch (error) {
    console.error('Error procesando correo:', error);
    return res.status(500).json({ error: 'Error de autenticación o conexión con Gmail.' });
  } finally {
    if (client.usable) {
      await client.logout();
    }
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
});