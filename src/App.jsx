import axios from "axios";
import { useState, useEffect, useRef } from "react";
import SEO from "./components/SEO";
import { IcfesIcons } from "./components/IcfesIcons";
import { HiOutlineShieldCheck, HiOutlineCode } from "react-icons/hi";

// Detecta automáticamente si estás en localhost o en la web publicada
const API_BASE_URL = import.meta.env.DEV 
  ? "http://localhost:3001/consulta" 
  : "/consulta"; 

function Toast({ type, message }) {
  return (
    <div className={`toast ${type}`}>
      {message}
    </div>
  )
}

const IcfesLogoSVG = ({ size = 50 }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
    <path d="M22,17 L36,31 L36,48 L17,48 L4,35 L22,35 Z" fill="#DC2626"/>
    <path d="M83,22 L69,36 L52,36 L52,17 L65,4 L65,22 Z" fill="#991B1B"/>
    <path d="M17,78 L31,64 L48,64 L48,83 L35,96 L35,78 Z" fill="#EF4444"/>
    <path d="M78,83 L64,69 L64,52 L83,52 L96,65 L78,65 Z" fill="#7F1D1D"/>
  </svg>
);

function calcPercentil(puntaje, media = 250, desviacion = 50) {
  const z = (puntaje - media) / desviacion;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327;
  const p = d * Math.exp(-z * z / 2);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = z >= 0 ? 1 - p * poly : p * poly;
  return Math.min(100, Math.max(1, Math.round(cdf * 100)));
}

function calcPercentilMateria(puntaje) {
  if (puntaje >= 95) return 100;
  return calcPercentil(puntaje, 50, 10);
}

function getNombreMateria(code) {
  const nombres = { LEC: 'Lectura Crítica', MAT: 'Matemáticas', SOC: 'Sociales y Ciudadanas', CIE: 'Ciencias Naturales', ING: 'Inglés' };
  return nombres[code] || code;
}

function getNivelDesempeno(puntaje) {
  if (puntaje >= 76) return { nivel: 'Nivel 4', desc: 'Desempeño superior', color: '#16a34a' };
  if (puntaje >= 61) return { nivel: 'Nivel 3', desc: 'Desempeño alto', color: '#2563eb' };
  if (puntaje >= 41) return { nivel: 'Nivel 2', desc: 'Desempeño medio', color: '#d97706' };
  return { nivel: 'Nivel 1', desc: 'Desempeño bajo', color: '#dc2626' };
}

function App() {
  const [numDocument, setNumDocument] = useState("")
  const [docType, setDocType] = useState("TI")
  const [born, setBorn] = useState("")
  const [numeroRegistro, setNumeroRegistro] = useState("")
  
  const [mainData, setMainData] = useState(null)
  const [selectedExamenIndex, setSelectedExamenIndex] = useState(0)
  
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState(null)
  const [selectedMateria, setSelectedMateria] = useState(null)
  const [showCalcModal, setShowCalcModal] = useState(false)
  const [darkMode, setDarkMode] = useState(false)
  const [zoomLevel, setZoomLevel] = useState(100)
  
  const [apiStatus, setApiStatus] = useState("loading");
  const [lastCommit, setLastCommit] = useState("");
  const [showStatusAlert, setShowStatusAlert] = useState(true);
  
  const printRef = useRef();

  const handleZoomIn = () => setZoomLevel(prev => Math.min(prev + 10, 150));
  const handleZoomOut = () => setZoomLevel(prev => Math.max(prev - 10, 70));
  const toggleDarkMode = () => setDarkMode(prev => !prev);

  useEffect(() => {
    const cachedData = localStorage.getItem("icfesCachedResult");
    if (cachedData) {
      const parsed = JSON.parse(cachedData);
      setMainData(parsed.data);
      setNumDocument(parsed.doc || "");
    }
    
    axios.get('https://api.github.com/repos/dfleonm-jpg/ICFES_CONSULTAS/commits?per_page=1')
      .then(res => {
        if (res.data && res.data.length > 0) {
          const date = new Date(res.data[0].commit.author.date);
          setLastCommit(date.toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' }));
        }
      })
      .catch(() => setLastCommit("Desconocida"));

    axios.get(API_BASE_URL, { timeout: 10000 })
      .then(res => setApiStatus(res.data.status ? "Funcionando" : "Caído"))
      .catch(() => setApiStatus("Caído"));
      
    const alertTimer = setTimeout(() => {
      setShowStatusAlert(false);
    }, 5000);
    return () => clearTimeout(alertTimer);
  }, []);

  const showToast = (type, message) => {
    setToast({ type, message })
    setTimeout(() => setToast(null), 3000)
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    setLoading(true)
    const [year, month, day] = born.split("-");
    const fechaTransformada = `${day}/${month}/${year}`;
    
    axios.post(API_BASE_URL, {
      document: numDocument,
      docType: docType,
      born: fechaTransformada,
      numeroRegistro: numeroRegistro.trim()
    }).then((response) => {
      if (response.data.status === false) {
        const msg = response.data.message || "No se encontraron resultados para este documento. Verifica los datos ingresados."
        showToast("error", msg)
        setLoading(false)
        return
      }
      setMainData(response.data)
      setSelectedExamenIndex(0)
      localStorage.setItem("icfesCachedResult", JSON.stringify({ data: response.data, doc: numDocument }));
      setLoading(false)
      showToast("success", "¡Resultados cargados exitosamente!")
    }).catch((error) => {
      setLoading(false)
      if (error.response && error.response.status) {
        const status = error.response.status
        if (status === 403) {
          showToast("error", "Acceso no autorizado. El servidor del ICFES bloqueó la petición temporalmente.")
        } else if (status === 429) {
          showToast("warning", "⏱️ Límite de consultas alcanzado. Espera unos segundos por favor.")
        } else if (status === 404) {
          showToast("error", "No se encontraron resultados. Verifica el tipo de documento y la fecha de nacimiento.")
        } else {
          showToast("error", `Error al consultar los resultados (${status}). Intenta nuevamente.`)
        }
      } else {
        showToast("error", "Error de conexión. Verifica tu acceso a internet.")
      }
    })
  }

  const handleLogout = () => {
    setMainData(null);
    setNumDocument("");
    setBorn("");
    setNumeroRegistro("");
    setSelectedExamenIndex(0);
    localStorage.removeItem("icfesCachedResult");
  }

  const handleExportPDF = () => {
    window.print();
  }

  const getSubjectIcon = (code) => {
    switch(code) {
      case "LEC": return <IcfesIcons.Lectura />;
      case "MAT": return <IcfesIcons.Matematicas />;
      case "SOC": return <IcfesIcons.Sociales />;
      case "CIE": return <IcfesIcons.Ciencias />;
      case "ING": return <IcfesIcons.Ingles />;
      default: return <IcfesIcons.Lectura />;
    }
  };

  if (mainData && mainData.examenes && mainData.examenes.length > 0) {
    const primerNombre = mainData.estudiante.split(' ')[0].toUpperCase();
    const examenActual = mainData.examenes[selectedExamenIndex] || mainData.examenes[0];

    return (
      <div className={`results-wrapper ${darkMode ? 'dark-mode' : ''}`}>
        <SEO title="Resultados | ICFES" description="Tus resultados del ICFES" url="https://icfes-consultas.vercel.app/" />
        
        <nav className="top-nav">
           <button className="icon-btn"><IcfesIcons.Menu /></button>
           <div className="profile-menu">
             <IcfesIcons.User />
             <span>{primerNombre}</span>
             <button className="btn-logout-dropdown" onClick={handleLogout}>Cerrar sesión</button>
           </div>
        </nav>

        <div className="banner-saber">
           <div className="banner-content">
             <div className="banner-text">
               <h2>Resultados del Examen Saber 11º</h2>
               <p>Este examen no se pasa ni se pierde. Es una herramienta clave<br/>para que identifiques tus habilidades, tus fortalezas, y puedas<br/>construir tu proyecto de vida.</p>
             </div>
             <div className="banner-logo">
               <span className="number-11">11</span>
               <div className="logo-text-stack">
                 <span className="small-text">Examen</span>
                 <span className="big-text">Saber 11º</span>
                 <span className="icfes-text">icfes <IcfesLogoSVG size={20} /></span>
               </div>
             </div>
           </div>
        </div>

        {mainData.examenes.length > 1 && (
          <div style={{ maxWidth: '1100px', margin: '20px auto 0 auto', padding: '0 20px' }}>
            <label style={{ fontWeight: '700', marginRight: '10px', fontSize: '0.9rem' }}>
              Selecciona el Examen / Registro:
            </label>
            <select
              value={selectedExamenIndex}
              onChange={(e) => {
                setSelectedExamenIndex(Number(e.target.value));
                setSelectedMateria(null);
              }}
              style={{
                padding: '8px 14px',
                borderRadius: '8px',
                border: '1.5px solid var(--accent-red)',
                fontWeight: '600',
                fontSize: '0.875rem',
                cursor: 'pointer',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)'
              }}
            >
              {mainData.examenes.map((ex, idx) => (
                <option key={ex.ACREGISTRO} value={idx}>
                  {ex.examenNombre} - Periodo: {ex.periodo} (Reg: {ex.ACREGISTRO})
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="floating-tools">
          <button onClick={toggleDarkMode} title="Modo oscuro"><IcfesIcons.Contrast /></button>
          <button onClick={handleZoomIn} title="Aumentar tamaño"><IcfesIcons.ZoomIn /></button>
          <button onClick={handleZoomOut} title="Disminuir tamaño"><IcfesIcons.ZoomOut /></button>
        </div>

        <div className="report-container" ref={printRef} style={{transform: `scale(${zoomLevel/100})`, transformOrigin: 'top center'}}>
          <div className="report-section">
            <div className="section-header">
              <div>
                <h3>Reporte general</h3>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  Registro: <strong>{examenActual.ACREGISTRO}</strong> {examenActual.periodo !== 'N/A' && `| Periodo: ${examenActual.periodo}`}
                </span>
              </div>
              <button className="btn-print" onClick={handleExportPDF}>
                <IcfesIcons.Printer /> Imprimir PDF
              </button>
            </div>
            
            {(() => {
              const percentil = calcPercentil(examenActual.puntaje);
              return (
            <div className="global-flex">
               <div className="global-left">
                  <div className="global-title">
                     <IcfesIcons.Trophy />
                     <span>Puntaje global</span>
                  </div>
                  <div className="score-big">
                     <span className="score-num">{examenActual.puntaje}</span><span className="score-max">/500</span>
                  </div>
                  <button className="btn-calc" onClick={() => setShowCalcModal(true)}>¿Cómo se calcula?</button>
               </div>
               
               <div className="global-right">
                  <div className="percentile-title">
                     <IcfesIcons.Pin />
                     <span>¿En qué percentil estás?</span>
                  </div>
                  <div className="percentile-data">
                     <div className="perc-left">
                        <span className="perc-label">Estudiantes a nivel nacional</span>
                        <div className="perc-bar-container">
                           <div className="perc-bar">
                              <div className="perc-fill" style={{width: `${percentil}%`}}></div>
                           </div>
                           <div className="perc-markers">
                              <span>0</span><span>20</span><span>40</span><span>60</span><span>80</span><span>100</span>
                           </div>
                        </div>
                     </div>
                     <div className="perc-middle">
                        <span className="perc-num">{percentil}</span>
                     </div>
                     <div className="perc-right">
                        <p>Tu puntaje superó al <strong>{percentil}%</strong> de los estudiantes a nivel nacional.</p>
                     </div>
                  </div>
               </div>
            </div>
              );
            })()}

            <div className="section-header pt-pruebas">
              <h3>Puntaje por pruebas</h3>
            </div>
            
            <div className="pruebas-grid">
              {examenActual.puntajeMaterias.map((materia) => (
                <div key={materia.code} className={`prueba-item ${selectedMateria?.code === materia.code ? 'prueba-selected' : ''}`} onClick={() => setSelectedMateria(materia)} style={{cursor:'pointer'}}>
                   <span className="prueba-name">{materia.nombrePrueba}</span>
                   <div className="prueba-score-row">
                     <div className="prueba-icon">
                        {getSubjectIcon(materia.code)}
                     </div>
                     <span className="prueba-score">{materia.puntaje}</span>
                     <span className="prueba-max">/100</span>
                   </div>
                </div>
              ))}
            </div>

            {selectedMateria ? (() => {
              const percMateria = calcPercentilMateria(selectedMateria.puntaje);
              const nivel = getNivelDesempeno(selectedMateria.puntaje);
              return (
              <div className="subject-detail-box">
                <div className="subject-detail-header">
                  <div className="subject-detail-icon">
                    {getSubjectIcon(selectedMateria.code)}
                  </div>
                  <div>
                    <h4>{getNombreMateria(selectedMateria.code)}</h4>
                    <span className="subject-detail-score">{selectedMateria.puntaje}<span className="subject-detail-max">/100</span></span>
                  </div>
                  <button className="subject-detail-close" onClick={() => setSelectedMateria(null)}>✕</button>
                </div>

                <div className="subject-detail-body">
                  <div>
                    <span className="perc-label">Percentil nacional en {getNombreMateria(selectedMateria.code)}</span>
                    <div className="perc-bar-container">
                      <div className="perc-bar">
                        <div className="perc-fill" style={{width: `${percMateria}%`}}></div>
                      </div>
                      <div className="perc-markers">
                        <span>0</span><span>20</span><span>40</span><span>60</span><span>80</span><span>100</span>
                      </div>
                    </div>
                    <div className="subject-perc-result">
                      <span className="perc-num">{percMateria}</span>
                      <p>Tu puntaje en {getNombreMateria(selectedMateria.code)} superó al <strong>{percMateria}%</strong> de los estudiantes a nivel nacional.</p>
                    </div>
                  </div>

                  <div className="subject-nivel-section">
                    <span className="nivel-badge" style={{background: nivel.color}}>{nivel.nivel}</span>
                    <span className="nivel-desc">{nivel.desc}</span>
                  </div>
                </div>
              </div>
              );
            })() : (
            <div className="bottom-placeholder">
               <IcfesIcons.Bulb />
               <p>Haz clic en una materia para ver tus percentiles, nivel de desempeño y un análisis de tus resultados.</p>
               <span className="bottom-link">Conoce a detalle tus resultados</span>
            </div>
            )}

          </div>
        </div>

        {showCalcModal && (() => {
          const materias = examenActual.puntajeMaterias;
          const getLEC = materias.find(m => m.code === 'LEC')?.puntaje || 0;
          const getMAT = materias.find(m => m.code === 'MAT')?.puntaje || 0;
          const getSOC = materias.find(m => m.code === 'SOC')?.puntaje || 0;
          const getCIE = materias.find(m => m.code === 'CIE')?.puntaje || 0;
          const getING = materias.find(m => m.code === 'ING')?.puntaje || 0;
          const suma = (getLEC*3) + (getMAT*3) + (getSOC*3) + (getCIE*3) + (getING*1);
          const resultado = Math.round((suma / 13) * 5);
          return (
          <div className="modal-overlay" onClick={() => setShowCalcModal(false)}>
            <div className="modal-calc" onClick={e => e.stopPropagation()}>
              <button className="modal-close" onClick={() => setShowCalcModal(false)}>✕</button>
              <h3>¿Cómo se calcula tu puntaje global?</h3>
              <p className="modal-desc">Todas las materias se multiplican por <strong>3</strong>, excepto <strong>Inglés</strong> que se multiplica por <strong>1</strong>. Luego se suman, se dividen entre <strong>13</strong> y se multiplican por <strong>5</strong>.</p>
              
              <div className="modal-formula">
                <div className="formula-title">Tu cálculo con tus puntajes reales:</div>
                <div className="formula-row"><span>Lectura Crítica</span><span>{getLEC} × 3 = <strong>{getLEC*3}</strong></span></div>
                <div className="formula-row"><span>Matemáticas</span><span>{getMAT} × 3 = <strong>{getMAT*3}</strong></span></div>
                <div className="formula-row"><span>Sociales y Ciudadanas</span><span>{getSOC} × 3 = <strong>{getSOC*3}</strong></span></div>
                <div className="formula-row"><span>Ciencias Naturales</span><span>{getCIE} × 3 = <strong>{getCIE*3}</strong></span></div>
                <div className="formula-row"><span>Inglés</span><span>{getING} × 1 = <strong>{getING}</strong></span></div>
                <div className="formula-divider"></div>
                <div className="formula-row"><span>Suma total</span><span><strong>{suma}</strong></span></div>
                <div className="formula-row"><span>{suma} ÷ 13 × 5</span><span>= <strong>{resultado}</strong></span></div>
              </div>
              <p className="modal-result">Tu puntaje global calculated: <strong>{resultado}</strong> {Math.abs(resultado - examenActual.puntaje) <= 5 ? '' : `(ICFES reporta: ${examenActual.puntaje})`}</p>
              <p className="modal-note">* Puede haber una pequeña diferencia por redondeo del ICFES.</p>
            </div>
          </div>
          );
        })()}
      </div>
    );
  }

  return (
    <>
      {toast && <Toast type={toast.type} message={toast.message} />}
      
      <div style={{
        position: 'fixed',
        top: showStatusAlert ? '20px' : '-150px',
        right: '20px',
        background: 'var(--dark-surface)',
        border: '1px solid var(--border-color)',
        padding: '12px 18px',
        borderRadius: '12px',
        boxShadow: 'var(--shadow-md)',
        transition: 'top 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        zIndex: 1000,
        fontSize: '0.85rem',
        color: '#ffffff'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div><strong>Última actualización:</strong> {lastCommit || "Cargando..."}</div>
          <button onClick={() => setShowStatusAlert(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', padding: '0 0 0 10px', color: '#a1a1aa' }}>×</button>
        </div>
        <div style={{ marginTop: '5px' }}>
          <strong>Estado:</strong> <span style={{ color: apiStatus === 'Funcionando' ? '#4ade80' : '#f87171' }}>{apiStatus === 'loading' ? "Comprobando..." : apiStatus}</span>
        </div>
        <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.1)', fontSize: '0.8rem' }}>
          Creado por <a href="https://github.com/Andres-2201" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-red)', textDecoration: 'none', fontWeight: 'bold' }}>Andrés</a>
        </div>
      </div>

      <SEO title="Bienvenido | ICFES" description="Consultar ICFES Saber 11." url="https://icfes-consultas.vercel.app/" />
      
      <div className="login-container">
        <div className="login-left">
          <h1>Bienvenido</h1>
          <p className="helper">
            Ingresa el Tipo, Número de Documento de identidad y Fecha de nacimiento con la que te inscribiste.
          </p>

          <form onSubmit={handleSubmit} className="icfes-form">
            <div style={{display: 'flex', flexDirection: 'column', gap: '6px'}}>
              <label>Tipo de documento <span>*</span></label>
              <select value={docType} onChange={(e) => setDocType(e.target.value)} required>
                <option value="TI">Tarjeta de Identidad (TI)</option>
                <option value="CC">Cédula de Ciudadanía (CC)</option>
                <option value="CE">Cédula de Extranjería (CE)</option>
                <option value="PEP">PEP</option>
              </select>
            </div>
            
            <div style={{display: 'flex', flexDirection: 'column', gap: '6px'}}>
              <label>Número de documento <span>*</span></label>
              <input type="text" value={numDocument} onChange={(e) => setNumDocument(e.target.value)} required placeholder="Ej: 1000123456" />
            </div>
            
            <div style={{display: 'flex', flexDirection: 'column', gap: '6px'}}>
              <label>Fecha de nacimiento <span>*</span></label>
              <input type="date" value={born} onChange={(e) => setBorn(e.target.value)} max="2015-12-31" required />
            </div>

            <div style={{display: 'flex', flexDirection: 'column', gap: '6px'}}>
              <label>Número de Registro (Opcional)</label>
              <input 
                type="text" 
                placeholder="Ej: AC202611234567" 
                value={numeroRegistro} 
                onChange={(e) => setNumeroRegistro(e.target.value)} 
              />
            </div>

            <button type="submit" disabled={loading} className="btn-ingresar">
              {loading ? "Consultando..." : "Ingresar"}
            </button>
          </form>
        </div>

        <div className="login-right">
          <svg className="bg-waves top-waves" viewBox="0 0 1440 320" preserveAspectRatio="none">
            <path fill="#dc2626" fillOpacity="0.8" d="M0,0L1440,0L1440,160C960,320 480,-64 0,160Z"></path>
            <path fill="#18181b" fillOpacity="0.9" d="M0,0L1440,0L1440,64C960,192 480,-64 0,64Z"></path>
          </svg>

          <svg className="bg-waves bottom-waves" viewBox="0 0 1440 320" preserveAspectRatio="none">
            <path fill="#b91c1c" fillOpacity="0.4" d="M0,320L1440,320L1440,160C960,0 480,384 0,160Z"></path>
          </svg>

          <div className="center-logo-container">
            <span className="logo-text-huge">icfes</span>
            <IcfesLogoSVG size={70} />
          </div>
        </div>
      </div>

      <footer className="gov-footer">
        <div className="gov-footer-content">
          <div className="footer-col">
            <h4><HiOutlineShieldCheck className="footer-icon-md"/> Privacidad y Seguridad</h4>
            <p>Herramienta <strong>no oficial</strong>. No almacenamos datos personales: la información se consulta directamente de los servidores oficiales del ICFES.</p>
          </div>
          <div className="footer-col">
            <h4><HiOutlineCode className="footer-icon-md"/> Código Abierto</h4>
            <p>Este proyecto es de código abierto. Revisa el código en GitHub.</p>
            <a href="https://github.com/Andres-2201/ICFES_CONSULTAS" target="_blank" rel="noreferrer" className="github-btn">
              Ver en GitHub
            </a>
          </div>
        </div>
        <div className="gov-footer-bottom">
          <p>© {new Date().getFullYear()} ICFES Consultas. Desarrollado para estudiantes colombianos.</p>
          <p className="disclaimer">Sitio NO oficial. No está afiliado ni respaldado por el ICFES.</p>
        </div>
      </footer>
    </>
  )
}

export default App;