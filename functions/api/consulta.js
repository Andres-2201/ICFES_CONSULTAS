// Cloudflare Pages Function: /api/consulta
// Actúa como proxy hacia la API oficial del ICFES (resultados oficiales).
// Reemplaza el backend serverless de Vercel. Usa fetch nativo (no requiere axios).
//
// AVISO: Esta herramienta NO es oficial ni está afiliada al ICFES.
// Solo reenvía la consulta a los servidores oficiales del ICFES y formatea la respuesta.

const ICFES_BASE = 'https://resultadosbackend.icfes.gov.co';

// Mapea los nombres de las pruebas del ICFES a códigos cortos que usa el frontend.
function getMateriaCode(nombreIcfes) {
  const n = (nombreIcfes || '').toLowerCase();
  if (n.includes('lectura')) return 'LEC';
  if (n.includes('matem')) return 'MAT';
  if (n.includes('sociales')) return 'SOC';
  if (n.includes('ciencias')) return 'CIE';
  if (n.includes('ingl')) return 'ING';
  return 'LEC';
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// Preflight CORS
export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS_HEADERS });
}

// Health check: verifica que la API del ICFES esté viva sin gastar cuota real.
export async function onRequestGet() {
  try {
    const res = await fetch(`${ICFES_BASE}/api/segurity/autenticacionResultados`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipoDocumento: 'TI',
        numeroDocumento: '111111111',
        fechaNacimiento: '01/01/2000',
        numeroRegistro: '',
        captcha: 'ping',
      }),
    });
    // Si responde (incluso con 4xx por datos inexistentes), el servidor está vivo.
    if (res.ok || (res.status >= 400 && res.status < 500)) {
      return json({ status: true, message: 'Funcionando' });
    }
    return json({ status: false, message: 'Caído' }, 500);
  } catch {
    return json({ status: false, message: 'Caído' }, 500);
  }
}

// Consulta real de resultados.
export async function onRequestPost({ request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ status: false, message: 'Solicitud inválida.' }, 400);
  }

  const { document, young, born } = body;
  const docType = young ? 'TI' : 'CC';

  try {
    // 1. Autenticación: obtener token (el backend del ICFES no valida el captcha).
    const authRes = await fetch(`${ICFES_BASE}/api/segurity/autenticacionResultados`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipoDocumento: docType,
        numeroDocumento: document,
        fechaNacimiento: born,
        numeroRegistro: '',
        captcha: 'dummy_token',
      }),
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
    const authHeaders = { Authorization: `Bearer ${token}` };

    // 2. Datos básicos (nombre del estudiante).
    const basicUrl = new URL(`${ICFES_BASE}/api/datos-basicos/datosBasicosRespuesta`);
    basicUrl.searchParams.set('identificacionUnica', authData.numeroRegistro);
    basicUrl.searchParams.set('examen', authData.datosParametros.examen);

    let nombreEstudiante = 'Estudiante';
    try {
      const basicRes = await fetch(basicUrl.toString(), { headers: authHeaders });
      if (basicRes.ok) {
        const basicJson = await basicRes.json();
        if (basicJson && basicJson.camposDatosBasicos) {
          const campo = basicJson.camposDatosBasicos.find(
            (c) => c.labelDatoBasico && c.labelDatoBasico.includes('Nombre')
          );
          if (campo) nombreEstudiante = campo.valorDatoBasico;
        }
      }
    } catch {
      // El nombre es opcional; continuamos aunque falle.
    }

    // 3. Reporte general (puntaje global + puntaje por materia).
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

    // 4. Mapear al formato que espera el frontend.
    const puntajeMaterias = (dataIcfes.reporteIndividuales || []).map((prueba) => ({
      code: getMateriaCode(prueba.nombrePrueba),
      nombrePrueba: prueba.nombrePrueba,
      puntaje: parseInt(prueba.puntajePrueba, 10),
    }));

    const mappedData = {
      status: true,
      estudiante: nombreEstudiante,
      examenes: [
        {
          ACREGISTRO: authData.numeroRegistro,
          puntaje: parseInt(dataIcfes.resultadosGenerales.puntajeGlobal, 10),
          puntajeMaterias,
        },
      ],
    };

    return json(mappedData);
  } catch {
    return json({ status: false, message: 'Error interno conectando al ICFES.' }, 500);
  }
}
