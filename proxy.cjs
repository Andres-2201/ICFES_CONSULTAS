/*
 * Proxy LOCAL para desarrollo (npm run proxy).
 * Replica la lógica de la Cloudflare Pages Function en functions/api/consulta.js
 * para poder probar en tu máquina con `npm run dev` (Vite) apuntando a localhost:3001.
 *
 * En producción NO se usa este archivo: Cloudflare Pages sirve /api/consulta
 * mediante la función en functions/api/consulta.js.
 *
 * Requiere Node 18+ (usa fetch nativo).
 */
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
  const { document, young, born } = req.body;
  const docType = young ? 'TI' : 'CC';

  try {
    const authRes = await fetch(`${ICFES_BASE}/api/segurity/autenticacionResultados`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipoDocumento: docType, numeroDocumento: document,
        fechaNacimiento: born, numeroRegistro: '', captcha: 'dummy_token',
      }),
    });

    if (!authRes.ok) {
      if (authRes.status === 404) {
        return res.json({ status: false, message: 'El ICFES indica que no se pudieron generar los resultados.' });
      }
      return res.status(authRes.status).json({ status: false, message: 'Error interno conectando al ICFES.' });
    }

    const authJson = await authRes.json();
    if (!authJson.datosAutenticacion || authJson.datosAutenticacion.length === 0) {
      return res.json({ status: false, message: 'No se encontraron resultados para los datos proporcionados.' });
    }

    const token = authJson.token;
    const authData = authJson.datosAutenticacion[0];
    const authHeaders = { Authorization: `Bearer ${token}` };

    let nombreEstudiante = 'Estudiante';
    try {
      const basicUrl = new URL(`${ICFES_BASE}/api/datos-basicos/datosBasicosRespuesta`);
      basicUrl.searchParams.set('identificacionUnica', authData.numeroRegistro);
      basicUrl.searchParams.set('examen', authData.datosParametros.examen);
      const basicRes = await fetch(basicUrl, { headers: authHeaders });
      if (basicRes.ok) {
        const basicJson = await basicRes.json();
        const campo = basicJson?.camposDatosBasicos?.find(
          (c) => c.labelDatoBasico && c.labelDatoBasico.includes('Nombre')
        );
        if (campo) nombreEstudiante = campo.valorDatoBasico;
      }
    } catch { /* nombre opcional */ }

    const resultUrl = new URL(`${ICFES_BASE}/api/resultados/datosReporteGeneral`);
    resultUrl.searchParams.set('identificacionUnica', authData.numeroRegistro);
    resultUrl.searchParams.set('examen', authData.datosParametros.examen);
    resultUrl.searchParams.set('periodoAnioExamen', authData.datosParametros.periodoAnioExamen);

    const resultsRes = await fetch(resultUrl, { headers: authHeaders });
    if (!resultsRes.ok) {
      if (resultsRes.status === 404) {
        return res.json({ status: false, message: 'El ICFES indica que no se pudieron generar los resultados.' });
      }
      return res.status(resultsRes.status).json({ status: false, message: 'Error interno conectando al ICFES.' });
    }

    const dataIcfes = await resultsRes.json();
    const puntajeMaterias = (dataIcfes.reporteIndividuales || []).map((prueba) => ({
      code: getMateriaCode(prueba.nombrePrueba),
      nombrePrueba: prueba.nombrePrueba,
      puntaje: parseInt(prueba.puntajePrueba, 10),
    }));

    res.json({
      status: true,
      estudiante: nombreEstudiante,
      examenes: [{
        ACREGISTRO: authData.numeroRegistro,
        puntaje: parseInt(dataIcfes.resultadosGenerales.puntajeGlobal, 10),
        puntajeMaterias,
      }],
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
