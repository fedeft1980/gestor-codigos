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

app.post('/api/obtener-codigo', async (req, res) => {
  const { correoCliente } = req.body;

  if (!correoCliente) {
    return res.status(400).json({ exito: false, error: 'Falta ingresar el correo del cliente.' });
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
      // Buscar correos dirigidos a la cuenta especificada
      const messages = await client.search({
        header: { 'to': correoCliente }
      });

      if (!messages || messages.length === 0) {
        return res.status(404).json({ exito: false, error: 'No se encontraron correos para esta cuenta.' });
      }

      // Analizar los últimos 15 correos recibidos
      const ultimosMensajes = messages.reverse().slice(0, 15);

      let correoValido = null;
      let contenido = '';
      let asuntoEncontrado = '';
      let servicioDetectado = '';

      for (const msgSeq of ultimosMensajes) {
        const message = await client.fetchOne(msgSeq, { source: true });
        const parsed = await simpleParser(message.source);
        
        const remitente = (parsed.from && parsed.from.value[0] && parsed.from.value[0].address) 
          ? parsed.from.value[0].address.toLowerCase() 
          : '';

        const asunto = (parsed.subject || '').trim();
        const asuntoLower = asunto.toLowerCase();
        const cuerpoTexto = (parsed.text || parsed.html || '').toLowerCase();

        // 1. Filtros Netflix
        const esNetflix = remitente.includes('netflix.com');
        const esAccesoNetflix = asuntoLower.includes('obten tu cod') || 
                                asuntoLower.includes('obtén tu cod') || 
                                asuntoLower.includes('código de acceso temporal') || 
                                asuntoLower.includes('codigo de acceso temporal');
        const esHogarNetflix = asuntoLower.includes('actualizar tu hogar');

        // 2. Filtros Max / HBO Max
        const esMaxRemitente = remitente.includes('max.com') || remitente.includes('hbomax.com');
        const esMaxCodigo = asuntoLower.includes('código') || 
                            asuntoLower.includes('codigo') || 
                            asuntoLower.includes('restablecer') || 
                            asuntoLower.includes('pin') || 
                            asuntoLower.includes('iniciar sesión') || 
                            asuntoLower.includes('iniciar sesion') ||
                            asuntoLower.includes('tu código de') ||
                            asuntoLower.includes('verific');

        // 3. Filtros Disney+ / Star+
        const esDisneyRemitente = remitente.includes('disneyplus.com') || 
                                 remitente.includes('disney.com') || 
                                 remitente.includes('starplus.com') ||
                                 remitente.includes('dssott.com');
        const esDisneyCodigo = asuntoLower.includes('código') || 
                               asuntoLower.includes('codigo') || 
                               asuntoLower.includes('passcode') || 
                               asuntoLower.includes('one-time') || 
                               asuntoLower.includes('verific') ||
                               asuntoLower.includes('iniciar sesión') ||
                               asuntoLower.includes('tu código de acceso') ||
                               cuerpoTexto.includes('disney');

        if (esNetflix && (esAccesoNetflix || esHogarNetflix)) {
          correoValido = parsed;
          asuntoEncontrado = asunto;
          contenido = parsed.text || parsed.html || '';
          servicioDetectado = 'Netflix';
          break;
        } else if (esMaxRemitente || (esMaxCodigo && cuerpoTexto.includes('max'))) {
          correoValido = parsed;
          asuntoEncontrado = asunto;
          contenido = parsed.text || parsed.html || '';
          servicioDetectado = 'Max';
          break;
        } else if (esDisneyRemitente || (esDisneyCodigo && (cuerpoTexto.includes('disney') || cuerpoTexto.includes('star+')))) {
          correoValido = parsed;
          asuntoEncontrado = asunto;
          contenido = parsed.text || parsed.html || '';
          servicioDetectado = 'Disney+';
          break;
        }
      }

      if (!correoValido) {
        return res.status(404).json({ exito: false, error: 'No se encontró un correo reciente de Netflix, Max o Disney+ para esta cuenta.' });
      }

      // --- VALIDACIÓN DE VENCIMIENTO (13 MINUTOS) ---
      const fechaCorreo = correoValido.date ? new Date(correoValido.date) : new Date();
      const horaFormateada = fechaCorreo.toLocaleTimeString('es-ES', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });

      const diferenciaMinutos = (Date.now() - fechaCorreo.getTime()) / (1000 * 60);

      if (diferenciaMinutos > 13) {
        return res.json({
          exito: false,
          vencido: true,
          hora: horaFormateada,
          error: 'ENLACE VENCIDO: PEDIR FOTO AL CLIENTE COMO QUE ENVIO Y CORROBORAR EL CORREO DE LA PANTALLA'
        });
      }

      // --- EXTRACCIÓN DE CÓDIGO Y ENLACE ---
      const esHogarCorreo = asuntoEncontrado.toLowerCase().includes('actualizar tu hogar');

      let codigoMatch = null;
      if (!esHogarCorreo) {
        // Busca secuencias numéricas de 4 a 6 dígitos (códigos típicos de Netflix, Max o Disney+)
        codigoMatch = contenido.match(/\b\d{4,6}\b/);
      }

      const urls = contenido.match(/https?:\/\/[^\s"]+/g) || [];
      const enlaceValido = urls.find(url => 
        url.includes('update') || 
        url.includes('household') || 
        url.includes('travel') || 
        url.includes('verify') ||
        url.includes('nftx.me') ||
        url.includes('code') ||
        url.includes('max.com') ||
        url.includes('hbomax.com') ||
        url.includes('disneyplus.com') ||
        url.includes('disney.com') ||
        url.includes('dssott.com')
      );

      return res.json({
        exito: true,
        vencido: false,
        servicio: servicioDetectado,
        correo: correoCliente,
        asunto: asuntoEncontrado,
        codigo: codigoMatch ? codigoMatch[0] : null,
        enlace: enlaceValido || null,
        hora: horaFormateada,
        fechaRecepcion: fechaCorreo.toISOString()
      });

    } finally {
      lock.release();
    }
  } catch (error) {
    console.error('Error procesando correo:', error);
    return res.status(500).json({ exito: false, error: 'Error de autenticación o conexión con Gmail.' });
  } finally {
    if (client.usable) {
      await client.logout();
    }
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor activo en http://localhost:${PORT}`);
});
