// Cloudflare Worker (entrypoint) para "icfes-consultas".
// - Sirve el frontend estático (dist/) mediante el binding ASSETS.
// - Maneja /api/consulta como proxy hacia la API OFICIAL del ICFES.
//
// AVISO: Herramienta NO oficial. Solo reenvía la consulta a los servidores
// oficiales del ICFES y formatea la respuesta. No almacena datos.

const ICFES_BASE = 'https://resultadosbackend.icfes.gov.co';
const ICFES_ORIGIN = 'https://resultados.icfes.gov.co';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Headers de navegador realistas. Muchas APIs gubernamentales rechazan
// peticiones sin User-Agent/Origin/Referer, devolviendo 403 o cerrando la conexión.
function icfesHeaders(extra = {}) {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8',
    Origin: ICFES_ORIGIN,
    Referer: `${ICFES_ORIGIN}/`,
    ...extra,
  };
}

function getMateriaCode(nombreIcfes) {
  const n = (nombreIcfes || '').toLowerCase();
  if (n.includes('lectura')) return 'LEC';
  if (n.includes('matem')) return 'MAT';
  if (n.includes('sociales')) return 'SOC';
  if (n.includes('ciencias')) return 'CIE';
  if (n.includes('ingl')) return 'ING';
  return 'LEC';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// Petición de autenticación al ICFES.
function authFetch(payload) {
  return fetch(`${ICFES_BASE}/api/segurity/autenticacionResultados`, {
    method: 'POST',
    headers: icfesHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
}

// Health check: verifica que la API del ICFES esté viva.
async function handleGet() {
  try {
    const res = await authFetch({
      tipoDocumento: 'TI', numeroDocumento: '111111111',
      fechaNacimiento: '01/01/2000', numeroRegistro: '', captcha: 'ping',
    });
    // Cualquier respuesta HTTP (incluso 4xx por datos inexistentes) = servidor vivo.
    if (res.status > 0) {
      return json({ status: true, message: 'Funcionando' });
    }
    return json({ status: false, message: 'Caído' }, 200);
  } catch (e) {
    // Solo un fallo de red real (no se pudo conectar) = Caído.
    return json({ status: false, message: 'Caído', detalle: String(e && e.message || e) }, 200);
  }
}

// Diagnóstico: /api/consulta?debug=1 devuelve el status crudo del ICFES.
async function handleDebug() {
  const out = {};
  try {
    const res = await authFetch({
      tipoDocumento: 'TI', numeroDocumento: '111111111',
      fechaNacimiento: '01/01/2000', numeroRegistro: '', captcha: 'ping',
    });
    out.httpStatus = res.status;
    out.ok = res.ok;
    const text = await res.text();
    out.bodyPreview = text.slice(0, 500);
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  return json(out);
}

// Consulta real de resultados oficiales.
async function handlePost(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ status: false, message: 'Solicitud inválida.' }, 400);
  }

  const { document, young, born } = body;
  const docType = young ? 'TI' : 'CC';

  try {
    const authRes = await authFetch({
      tipoDocumento: docType, numeroDocumento: document,
      fechaNacimiento: born, numeroRegistro: '', captcha: 'dummy_token',
    });

    if (!authRes.ok) {
      if (authRes.status === 404) {
        return json({ status: false, message: 'El ICFES indica que no se pudieron generar los resultados.' });
      }
      return json({ status: false, message: 'Error interno conectando al ICFES.' }, authRes.status);
    }

    const authJson = await authRes.json();
    if (!authJson.datosAutenticacion || authJson.datosAutenticacion.length === 0) {
      return json({ status: false, message: 'No se encontraron resultados para los datos proporcionados.' });
    }

    const token = authJson.token;
    const authData = authJson.datosAutenticacion[0];
    const authHeaders = icfesHeaders({ Authorization: `Bearer ${token}` });

    // Datos básicos (nombre).
    let nombreEstudiante = 'Estudiante';
    try {
      const basicUrl = new URL(`${ICFES_BASE}/api/datos-basicos/datosBasicosRespuesta`);
      basicUrl.searchParams.set('identificacionUnica', authData.numeroRegistro);
      basicUrl.searchParams.set('examen', authData.datosParametros.examen);
      const basicRes = await fetch(basicUrl.toString(), { headers: authHeaders });
      if (basicRes.ok) {
        const basicJson = await basicRes.json();
        const campo = basicJson?.camposDatosBasicos?.find(
          (c) => c.labelDatoBasico && c.labelDatoBasico.includes('Nombre')
        );
        if (campo) nombreEstudiante = campo.valorDatoBasico;
      }
    } catch { /* nombre opcional */ }

    // Reporte general (puntajes).
    const resultUrl = new URL(`${ICFES_BASE}/api/resultados/datosReporteGeneral`);
    resultUrl.searchParams.set('identificacionUnica', authData.numeroRegistro);
    resultUrl.searchParams.set('examen', authData.datosParametros.examen);
    resultUrl.searchParams.set('periodoAnioExamen', authData.datosParametros.periodoAnioExamen);

    const resultsRes = await fetch(resultUrl.toString(), { headers: authHeaders });
    if (!resultsRes.ok) {
      if (resultsRes.status === 404) {
        return json({ status: false, message: 'El ICFES indica que no se pudieron generar los resultados.' });
      }
      return json({ status: false, message: 'Error interno conectando al ICFES.' }, resultsRes.status);
    }

    const dataIcfes = await resultsRes.json();
    const puntajeMaterias = (dataIcfes.reporteIndividuales || []).map((prueba) => ({
      code: getMateriaCode(prueba.nombrePrueba),
      nombrePrueba: prueba.nombrePrueba,
      puntaje: parseInt(prueba.puntajePrueba, 10),
    }));

    return json({
      status: true,
      estudiante: nombreEstudiante,
      examenes: [{
        ACREGISTRO: authData.numeroRegistro,
        puntaje: parseInt(dataIcfes.resultadosGenerales.puntajeGlobal, 10),
        puntajeMaterias,
      }],
    });
  } catch (e) {
    return json({ status: false, message: 'Error interno conectando al ICFES.', detalle: String(e && e.message || e) }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/consulta') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 200, headers: CORS_HEADERS });
      }
      if (request.method === 'GET') {
        if (url.searchParams.get('debug') === '1') return handleDebug();
        return handleGet();
      }
      if (request.method === 'POST') return handlePost(request);
      return json({ error: 'Method not allowed' }, 405);
    }

    // Frontend estático (SPA fallback vía config de [assets]).
    return env.ASSETS.fetch(request);
  },
};
