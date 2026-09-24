const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const ICFES_BASE = 'https://resultadosbackend.icfes.gov.co';

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
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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
      return res.status(authRes.status).json({ status: false, message: 'Error interno conectando al ICFES.' });
    }

    const authJson = await authRes.json();
    if (!authJson.datosAutenticacion || authJson.datosAutenticacion.length === 0) {
      return res.json({ status: false, message: 'No se encontraron resultados para los datos proporcionados.' });
    }

    const token = authJson.token;
    const authHeaders = { Authorization: `Bearer ${token}` };

    // Si el usuario especificó un registro, filtramos la lista. Si no, tomamos todos.
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

    // Procesar todos los exámenes asociados
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
      } catch { /* continuar con otros exámenes si falla uno */ }
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

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Proxy local ICFES escuchando en http://localhost:${PORT}`);
  console.log('Ejecuta "npm run dev" en otra terminal para el frontend.');
});