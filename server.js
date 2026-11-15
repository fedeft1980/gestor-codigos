function esCorreoValido(asunto) {
  const a = (asunto || '').toLowerCase();

  const esAcceso =
    a.includes('obten tu cod') ||
    a.includes('obtén tu cod') ||
    a.includes('código de acceso temporal') ||
    a.includes('codigo de acceso temporal') ||
    a.includes('código de inicio de sesión') ||
    a.includes('codigo de inicio de sesion') ||
    a.includes('código de verificación') ||
    a.includes('codigo de verificacion') ||
    a.includes('solicitud de inicio de sesión') ||
    a.includes('solicitud de inicio de sesion');

  const esHogar =
    a.includes('actualizar tu hogar') ||
    a.includes('cómo cambiar tu hogar') ||
    a.includes('como cambiar tu hogar');

  return (esAcceso || esHogar) && a.includes('netflix') || esAcceso || esHogar;
}
