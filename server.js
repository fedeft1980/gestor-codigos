const express = require('express');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Configuración de conexión IMAP (ej. Gmail con contraseña de aplicación)
const client = new ImapFlow({
  host: process.env.IMAP_HOST || 'imap.gmail.com',
  port: parseInt(process.env.IMAP_PORT || '993'),
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  logger: false
});

// Función auxiliar para extraer enlaces
function extraerEnlaceDelCuerpo(texto) {
  if (!texto) return null;
  const urlRegex = /(https?:\/\/[^\s"<]+)/g;
  const urls = texto.match(urlRegex);
  if (!urls || urls.length === 0) return null;

  // Filtrar enlaces de tracking o basura común si es necesario
  for (let url of urls) {
    if (!url.includes('google.com') && !url.includes('schema.org') && !url.includes('facebook')) {
      return url.replace(/["'>]/g, '');
    }
  }
  return urls[0].replace(/["'>]/g, '');
}

app.post('/api/obtener-codigo', async (req, res) => {
  const { correoCliente } = req.body;

  if (!correoCliente) {
    return res.status(400).json({ exito: false, error: 'Debe ingresar un correo electrónico.' });
  }

  try {
    await client.connect();
    let lock = await client.getMailboxLock('INBOX');

    try {
      // Buscar correos dirigidos al cliente
      const query = { to: correoCliente.trim() };
      const messages = client.fetch(query, { envelope: true, source: true }, { reverse: true, limit: 5 });

      let correoValido = null;
      let asuntoEncontrado = '';
      let fechaCorreo = null;
      let contenido = '';

      for await (let msg of messages) {
        const parsed = await simpleParser(msg.source);
        const asunto = parsed.subject || '';
        const asuntoLower = asunto.toLowerCase();

        // Validar si es un correo de acceso/código o de hogar de Netflix
        const esAccesoCodigo = asuntoLower.includes('obten tu cod') || 
                              asuntoLower.includes('obtén tu cod') || 
                              asuntoLower.includes('código de acceso temporal') || 
                              asuntoLower.includes('codigo de acceso temporal');

        const esHogar = asuntoLower.includes('actualizar tu hogar') ||
                        asuntoLower.includes('cómo cambiar tu hogar') ||
                        asuntoLower.includes('como cambiar tu hogar');

        if (esAccesoCodigo || esHogar) {
          correoValido = parsed;
          asuntoEncontrado = asunto;
          fechaCorreo = msg.envelope.date || parsed.date;
          contenido = parsed.text || parsed.html || '';
          break; // Tomar el más reciente que coincida
        }
      }

      if (!correoValido || !fechaCorreo) {
        lock.release();
        await client.logout();
        return res.status(404).json({ exito: false, error: 'No se encontraron correos recientes de verificación o hogar para este cliente.' });
      }

      // Cálculo de tiempo transcurrido (Regla de los 13 minutos)
      const ahora = Date.now();
      const timestampCorreo = new Date(fechaCorreo).getTime();
      const diferenciaMinutos = (ahora - timestampCorreo) / (1000 * 60);

      // Formatear hora de recepción para mostrar si está vencido
      const fechaObj = new Date(timestampCorreo);
      const horaFormateada = !isNaN(fechaObj.getTime()) ? fechaObj.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : 'Desconocida';

      if (isNaN(diferenciaMinutos) || diferenciaMinutos > 13) {
        lock.release();
        await client.logout();
        return res.json({
          exito: false,
          vencido: true,
          hora: horaFormateada,
          error: 'ENLACE VENCIDO: PEDIR FOTO AL CLIENTE COMO QUE ENVIO Y CORROBORAR EL CORREO DE LA PANTALLA CON LA CONSULTA'
        });
      }

      // Extracción del enlace
      const enlaceValido = extraerEnlaceDelCuerpo(contenido);

      if (!enlaceValido) {
        lock.release();
        await client.logout();
        return res.status(404).json({ exito: false, error: 'No se encontró un enlace válido en el correo.' });
      }

      lock.release();
      await client.logout();

      return res.json({
        exito: true,
        vencido: false,
        enlace: enlaceValido,
        hora: horaFormateada
      });

    } catch (err) {
      lock.release();
      throw err;
    }

  } catch (error) {
    console.error('Error en el servidor:', error);
    if (client.usable) {
      await client.logout();
    }
    return res.status(500).json({ exito: false, error: 'Error al consultar la bandeja de entrada.' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
});
