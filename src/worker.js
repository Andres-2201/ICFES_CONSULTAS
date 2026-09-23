// Cloudflare Worker (entrypoint) para "icfes-consultas".
// - Sirve el frontend estático (dist/) mediante el binding ASSETS.
// - Maneja /api/consulta como proxy ROBUSTO hacia la API OFICIAL del ICFES.
//
// Estabilidad: reintentos con backoff, timeouts, caché de resultados y
// rate limiting por IP. Diagnóstico en /api/consulta?debug=1.
//
// AVISO: Herramienta NO oficial. Solo reenvía la consulta a los servidores
// oficiales del ICFES y formatea la respuesta. No almacena datos personales.

const ICFES_BASE = 'https://resultadosbackend.icfes.gov.co';
const ICFES_ORIGIN = 'https://resultados.icfes.gov.co';

// Tiempos y reintentos.
const FETCH_TIMEOUT_MS = 12000;   // corta peticiones lentas del ICFES
const MAX_RETRIES = 3;            // intentos totales por petición
const BASE_BACKOFF_MS = 400;      // backoff exponencial: 400ms, 800ms, 1600ms

// Rate limit por IP (protege al Worker y evita bloqueos del ICFES).
const RATE_LIMIT = 5;             // máx. consultas
const RATE_WINDOW_MS = 30000;     // por ventana de 30s
const rateStore = new Map();      // IP -> [timestamps] (por instancia de Worker)

// Caché de resultados exitosos (misma consulta no vuelve a golpear al ICFES).
const CACHE_TTL_S = 3600;         // 1 hora

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Headers de navegador realistas: muchas APIs gubernamentales rechazan
// peticiones sin User-Agent/Origin/Referer (403 o cierre de conexión).
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

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch con timeout + reintentos y backoff exponencial.
// Reintenta ante errores de red y 5xx; NO reintenta 4xx (respuesta válida del ICFES).
async function resilientFetch(url, options = {}) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      // 5xx: el servidor tuvo un fallo temporal -> reintentar.
      if (res.status >= 500 && attempt < MAX_RETRIES - 1) {
        await sleep(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      // Fallo de red/timeout -> reintentar con backoff.
      if (attempt < MAX_RETRIES - 1) {
        await sleep(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
    }
  }
  throw lastErr || new Error('Fallo de red al conectar con el ICFES');
}

function authFetch(payload) {
  return resilientFetch(`${ICFES_BASE}/api/segurity/autenticacionResultados`, {
    method: 'POST',
    headers: icfesHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
}

// Rate limit simple por IP.
function checkRateLimit(ip) {
  const now = Date.now();
  const hits = (rateStore.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_LIMIT) return false;
  hits.push(now);
  rateStore.set(ip, hits);
  return true;
}

// Health check: solo marca "Caído" ante fallo de red real.
async function handleGet() {
  try {
    const res = await authFetch({
      tipoDocumento: 'TI', numeroDocumento: '111111111',
      fechaNacimiento: '01/01/2000', numeroRegistro: '', captcha: 'ping',
    });
    if (res.status > 0) return json({ status: true, message: 'Funcionando' });
    return json({ status: false, message: 'Caído' });
  } catch (e) {
    return json({ status: false, message: 'Caído', detalle: String((e && e.message) || e) });
  }
}

// Diagnóstico: /api/consulta?debug=1
// Prueba varias combinaciones de headers para ver cuál acepta el ICFES.
async function handleDebug(request) {
  const out = { cf_country: request.cf?.country, cf_colo: request.cf?.colo, pruebas: [] };
  const payload = {
    tipoDocumento: 'TI', numeroDocumento: '111111111',
    fechaNacimiento: '01/01/2000', numeroRegistro: '', captcha: 'ping',
  };
  const url = `${ICFES_BASE}/api/segurity/autenticacionResultados`;

  const variantes = [
    { nombre: 'solo-content-type', headers: { 'Content-Type': 'application/json' } },
    {
      nombre: 'navegador-sin-origin',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'es-CO,es;q=0.9',
      },
    },
    {
      nombre: 'con-origin-icfes',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://resultados.icfes.gov.co',
        Referer: 'https://resultados.icfes.gov.co/',
      },
    },
  ];

  for (const v of variantes) {
    const r = { variante: v.nombre };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: v.headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      r.httpStatus = res.status;
      r.ok = res.ok;
      r.bodyPreview = (await res.text()).slice(0, 300);
    } catch (e) {
      r.error = String((e && e.message) || e);
    }
    out.pruebas.push(r);
  }

  // Prueba de conectividad: GET simple a varios hosts del ICFES para ver
  // cuáles responden desde el Worker (descarta si el dominio ya no existe).
  const hosts = [
    'https://resultadosbackend.icfes.gov.co/',
    'https://resultados.icfes.gov.co/',
    'https://www.icfes.gov.co/',
  ];
  out.conectividad = [];
  for (const h of hosts) {
    const c = { host: h };
    try {
      const res = await fetch(h, { method: 'GET', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      c.httpStatus = res.status;
    } catch (e) {
      c.error = String((e && e.message) || e);
    }
    out.conectividad.push(c);
  }
  return json(out);
}

// Consulta real de resultados oficiales, con caché.
async function handlePost(request) {
  // Rate limit
  const ip = request.headers.get('CF-Connecting-IP') || 'anon';
  if (!checkRateLimit(ip)) {
    return json(
      { status: false, message: 'Has hecho muchas consultas seguidas. Espera unos segundos e intenta de nuevo.' },
      429
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ status: false, message: 'Solicitud inválida.' }, 400);
  }

  const { document, young, born } = body;
  if (!document || !born) {
    return json({ status: false, message: 'Faltan datos: documento y fecha de nacimiento son obligatorios.' }, 400);
  }
  const docType = young ? 'TI' : 'CC';

  // Caché: clave por documento+tipo+fecha (no expone datos, es un hash de URL).
  const cache = caches.default;
  const cacheKey = new Request(
    `https://cache.icfes-consultas/${docType}/${encodeURIComponent(document)}/${encodeURIComponent(born)}`
  );
  const cached = await cache.match(cacheKey);
  if (cached) {
    const data = await cached.json();
    return json({ ...data, _cache: true });
  }

  try {
    const authRes = await authFetch({
      tipoDocumento: docType, numeroDocumento: document,
      fechaNacimiento: born, numeroRegistro: '', captcha: 'dummy_token',
    });

    if (!authRes.ok) {
      if (authRes.status === 404) {
        return json({ status: false, message: 'El ICFES indica que no se pudieron generar los resultados.' });
      }
      if (authRes.status === 403) {
        return json({ status: false, message: 'El ICFES bloqueó la consulta temporalmente. Intenta de nuevo en unos minutos.' });
      }
      return json({ status: false, message: 'El servidor del ICFES no respondió correctamente. Intenta más tarde.' }, 502);
    }

    const authJson = await authRes.json();
    if (!authJson.datosAutenticacion || authJson.datosAutenticacion.length === 0) {
      return json({ status: false, message: 'No se encontraron resultados para los datos proporcionados.' });
    }

    const token = authJson.token;
    const authData = authJson.datosAutenticacion[0];
    const authHeaders = icfesHeaders({ Authorization: `Bearer ${token}` });

    // Datos básicos (nombre) - opcional.
    let nombreEstudiante = 'Estudiante';
    try {
      const basicUrl = new URL(`${ICFES_BASE}/api/datos-basicos/datosBasicosRespuesta`);
      basicUrl.searchParams.set('identificacionUnica', authData.numeroRegistro);
      basicUrl.searchParams.set('examen', authData.datosParametros.examen);
      const basicRes = await resilientFetch(basicUrl.toString(), { headers: authHeaders });
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

    const resultsRes = await resilientFetch(resultUrl.toString(), { headers: authHeaders });
    if (!resultsRes.ok) {
      if (resultsRes.status === 404) {
        return json({ status: false, message: 'El ICFES indica que no se pudieron generar los resultados.' });
      }
      return json({ status: false, message: 'El servidor del ICFES no respondió correctamente. Intenta más tarde.' }, 502);
    }

    const dataIcfes = await resultsRes.json();
    const puntajeMaterias = (dataIcfes.reporteIndividuales || []).map((prueba) => ({
      code: getMateriaCode(prueba.nombrePrueba),
      nombrePrueba: prueba.nombrePrueba,
      puntaje: parseInt(prueba.puntajePrueba, 10),
    }));

    const result = {
      status: true,
      estudiante: nombreEstudiante,
      examenes: [{
        ACREGISTRO: authData.numeroRegistro,
        puntaje: parseInt(dataIcfes.resultadosGenerales.puntajeGlobal, 10),
        puntajeMaterias,
      }],
    };

    // Guardar en caché (solo resultados exitosos).
    await cache.put(
      cacheKey,
      new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_TTL_S}` },
      })
    );

    return json(result);
  } catch (e) {
    return json(
      { status: false, message: 'No se pudo conectar con el ICFES. Puede estar saturado; intenta de nuevo en un momento.', detalle: String((e && e.message) || e) },
      503
    );
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
        if (url.searchParams.get('debug') === '1') return handleDebug(request);
        return handleGet();
      }
      if (request.method === 'POST') return handlePost(request);
      return json({ error: 'Method not allowed' }, 405);
    }

    // Frontend estático (SPA fallback vía config de [assets]).
    return env.ASSETS.fetch(request);
  },
};
