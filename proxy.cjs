const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const ICFES_BASE = 'https://resultadosbackend.icfes.gov.co';

// Cabeceras estándar para simular un navegador real
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Content-Type': 'application/json;charset=UTF-8',
  'Origin': 'https://www.icfes.gov.co',
  'Referer': 'https://www.icfes.gov.co/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'cross-site'
};

function getMateriaCode(nombreIcfes) {
  const n = (nombreIcfes || '').toLowerCase();
  if (n.includes('lectura')) return 'LEC';
  if (n.includes('matem')) return 'MAT';
  if (n.includes('sociales')) return 'SOC';
  if (n.includes('ciencias')) return 'CIE';
  if (n.includes('ingl')) return 'ING';
  return 'LEC';
}

app.get('/consulta', async (req, res) => {
  try {
    const r = await fetch(`${ICFES_BASE}/api/segurity/autenticacionResultados`, {
      method: 'POST',
      headers: DEFAULT_HEADERS,
      body: JSON.stringify({
        tipoDocumento: 'TI', numeroDocumento: '111111111',
        fechaNacimiento: '01/01/2000', numeroRegistro: '', captcha: 'ping',
      }),
    });
    if (r.ok || (r.status >= 400 && r.status < 500)) {
      return res.json({ status: true, message: 'Funcionando' });
    }
    res.status(500).json({ status: false, message: 'Caído' });
  } catch {
    res.status(500).json({ status: false, message: 'Caído' });
  }
});

app.post('/consulta', async (req, res) => {
  const { document, docType, born, numeroRegistro } = req.body;
  const tipoDoc = docType || 'TI';

  try {
    const authRes = await fetch(`${ICFES_BASE}/api/segurity/autenticacionResultados`, {
      method: 'POST',
      headers: DEFAULT_HEADERS,
      body: JSON.stringify({
        tipoDocumento: tipoDoc,
        numeroDocumento: document,
        fechaNacimiento: born,
        numeroRegistro: numeroRegistro || '',
        captcha: 'dummy_token',
      }),
    });

    if (!authRes.ok) {
      if (authRes.status === 404) {
        return res.json({ status: false, message: 'El ICFES indica que no se pudieron generar los resultados. Verifica el tipo/número de documento y fecha de nacimiento con los que te inscribiste al examen.' });
      }
      if (authRes.status === 403) {
        return res.status(403).json({ status: false, message: 'Acceso no autorizado. El servidor del ICFES bloqueó la petición temporalmente.' });
      }
      return res.status(authRes.status).json({ status: false, message: 'Error interno conectando al ICFES.' });
    }

    const authJson = await authRes.json();
    if (!authJson.datosAutenticacion || authJson.datosAutenticacion.length === 0) {
      return res.json({ status: false, message: 'No se encontraron resultados para los datos proporcionados.' });
    }

    const token = authJson.token;
    const authHeaders = {
      ...DEFAULT_HEADERS,
      Authorization: `Bearer ${token}`
    };

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
      const basicRes = await fetch(basicUrl, { headers: authHeaders });
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

        const resultsRes = await fetch(resultUrl, { headers: authHeaders });
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
      } catch { /* continuar con otros exámenes */ }
    }

    if (listaExamenes.length === 0) {
      return res.json({ status: false, message: 'El ICFES no retornó puntajes para los registros encontrados.' });
    }

    res.json({
      status: true,
      estudiante: nombreEstudiante,
      examenes: listaExamenes,
    });
  } catch {
    res.status(500).json({ status: false, message: 'Error interno conectando al ICFES.' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Proxy escuchando en el puerto ${PORT}`);
});