const ICFES_BASE = 'https://resultadosbackend.icfes.gov.co';
const ICFES_ORIGIN = 'https://resultados.icfes.gov.co';

const FETCH_TIMEOUT_MS = 12000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 400;

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 30000;
const rateStore = new Map();

const CACHE_TTL_S = 3600;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

async function resilientFetch(url, options = {}) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status >= 500 && attempt < MAX_RETRIES - 1) {
        await sleep(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
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

function checkRateLimit(ip) {
  const now = Date.now();
  const hits = (rateStore.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_LIMIT) return false;
  hits.push(now);
  rateStore.set(ip, hits);
  return true;
}

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

async function handlePost(request) {
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

  const { document, docType, born, numeroRegistro } = body;
  if (!document || !born) {
    return json({ status: false, message: 'Faltan datos: documento y fecha de nacimiento son obligatorios.' }, 400);
  }
  const tipoDoc = docType || 'TI';

  const regKey = numeroRegistro ? encodeURIComponent(numeroRegistro) : 'ALL';
  const cacheKey = new Request(
    `https://cache.icfes-consultas/${tipoDoc}/${encodeURIComponent(document)}/${encodeURIComponent(born)}/${regKey}`
  );
  
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const data = await cached.json();
    return json({ ...data, _cache: true });
  }

  try {
    const authRes = await authFetch({
      tipoDocumento: tipoDoc,
      numeroDocumento: document,
      fechaNacimiento: born,
      numeroRegistro: numeroRegistro || '',
      captcha: 'dummy_token',
    });

    if (!authRes.ok) {
      if (authRes.status === 404) {
        return json({ status: false, message: 'El ICFES indica que no se pudieron generar los resultados. Verifica el tipo/número de documento y la fecha con que te inscribiste al examen.' });
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
    const authHeaders = icfesHeaders({ Authorization: `Bearer ${token}` });

    let registrosAProcesar = authJson.datosAutenticacion;
    if (numeroRegistro) {
      const filtrado = authJson.datosAutenticacion.filter(
        item => item.numeroRegistro && item.numeroRegistro.trim().toUpperCase() === numeroRegistro.trim().toUpperCase()
      );
      if (filtrado.length > 0) registrosAProcesar = filtrado;
    }

    let nombreEstudiante = 'Estudiante';
    const primerRegistro = registrosAProcesar[0];
    try {
      const basicUrl = new URL(`${ICFES_BASE}/api/datos-basicos/datosBasicosRespuesta`);
      basicUrl.searchParams.set('identificacionUnica', primerRegistro.numeroRegistro);
      basicUrl.searchParams.set('examen', primerRegistro.datosParametros.examen);
      const basicRes = await resilientFetch(basicUrl.toString(), { headers: authHeaders });
      if (basicRes.ok) {
        const basicJson = await basicRes.json();
        const campo = basicJson?.camposDatosBasicos?.find(
          (c) => c.labelDatoBasico && c.labelDatoBasico.includes('Nombre')
        );
        if (campo) nombreEstudiante = campo.valorDatoBasico;
      }
    } catch { /* nombre opcional */ }

    const listaExamenes = [];

    for (const authData of registrosAProcesar) {
      try {
        const resultUrl = new URL(`${ICFES_BASE}/api/resultados/datosReporteGeneral`);
        resultUrl.searchParams.set('identificacionUnica', authData.numeroRegistro);
        resultUrl.searchParams.set('examen', authData.datosParametros.examen);
        resultUrl.searchParams.set('periodoAnioExamen', authData.datosParametros.periodoAnioExamen);

        const resultsRes = await resilientFetch(resultUrl.toString(), { headers: authHeaders });
        if (resultsRes.ok) {
          const dataIcfes = await resultsRes.json();
          const puntajeMaterias = (dataIcfes.reporteIndividuales || []).map((prueba) => ({
            code: getMateriaCode(prueba.nombrePrueba),
            nombrePrueba: prueba.nombrePrueba,
            puntaje: parseInt(prueba.puntajePrueba, 10),
          }));

          listaExamenes.push({
            ACREGISTRO: authData.numeroRegistro,
            periodo: authData.datosParametros.periodoAnioExamen || 'N/A',
            examenNombre: authData.datosParametros.examen || 'SABER 11',
            puntaje: parseInt(dataIcfes.resultadosGenerales.puntajeGlobal, 10),
            puntajeMaterias,
          });
        }
      } catch { /* ignora fallos individuales */ }
    }

    if (listaExamenes.length === 0) {
      return json({ status: false, message: 'El ICFES no devolvió información para los exámenes registrados.' }, 404);
    }

    const result = {
      status: true,
      estudiante: nombreEstudiante,
      examenes: listaExamenes,
    };

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
        return handleGet();
      }
      if (request.method === 'POST') return handlePost(request);
      return json({ error: 'Method not allowed' }, 405);
    }

    return env.ASSETS.fetch(request);
  },
};