# 🎓 ICFES Consultas (no oficial)

Aplicación web para consultar resultados del examen **ICFES Saber 11**.
Obtiene los **resultados oficiales** directamente desde la API del ICFES, con una
interfaz moderna inspirada en el portal institucional.

> ⚠️ **Aviso:** Esta es una herramienta **NO oficial**. No está afiliada, avalada
> ni respaldada por el ICFES. Únicamente reenvía la consulta a los servidores
> oficiales del ICFES y muestra los resultados. No almacenamos ningún dato.

## 🧱 Arquitectura

- **Frontend:** React 18 + Vite (estático).
- **Backend proxy:** una **Cloudflare Pages Function** (`functions/api/consulta.js`).
  Es necesaria porque el navegador no puede llamar directamente a la API del ICFES
  (bloqueo CORS). La función corre en el borde de Cloudflare y reenvía la petición.

Todo se despliega **gratis** en **Cloudflare Pages** (no requiere Vercel ni tarjeta):
- Peticiones a archivos estáticos: ilimitadas y gratis.
- Peticiones a la Function: 100.000/día en el plan gratuito.

## 🚀 Despliegue en Cloudflare Pages

1. Sube este repositorio a GitHub (ya está en `dfleonm-jpg/ICFES_CONSULTAS`).
2. En el dashboard de Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**.
3. Selecciona este repositorio.
4. Configura el build:
   - **Framework preset:** `Vite`
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
5. Deja el resto por defecto y pulsa **Save and Deploy**.

Cloudflare detecta automáticamente la carpeta `functions/` y publica el endpoint
`/api/consulta`. No hay que configurar nada más.

## 💻 Desarrollo local

Necesitas Node 18+.

```bash
# 1. Instalar dependencias
npm install

# 2. En una terminal: proxy local (simula la Function en localhost:3001)
npm run proxy

# 3. En otra terminal: frontend
npm run dev
```

En desarrollo el frontend llama a `http://localhost:3001/consulta`.
En producción llama a `/api/consulta` (la Cloudflare Pages Function).

### Probar con Wrangler (opcional, más fiel a producción)

Si tienes [Wrangler](https://developers.cloudflare.com/workers/wrangler/) instalado,
puedes ejecutar el build + las Functions localmente:

```bash
npm run build
npm run pages:dev
```

## 🛠️ Tecnologías

- React 18, Vite
- Axios (peticiones HTTP)
- html2pdf.js / impresión nativa (exportar PDF)
- react-icons, react-router-dom
- Cloudflare Pages + Pages Functions

## 📂 Estructura

```
functions/
  api/
    consulta.js        # Proxy hacia la API oficial del ICFES (producción)
src/
  components/          # Íconos SVG, SEO, layout, etc.
  App.jsx              # Vista principal (login + resultados)
  index.css            # Estilos institucionales
  main.jsx             # Entrada + rutas
proxy.cjs              # Proxy equivalente para desarrollo local
public/                # Assets estáticos, _redirects (SPA)
```

## 📝 Créditos

Interfaz basada en el proyecto de código abierto
[CONSULTAS-ICFES-MODERNO](https://github.com/juanitogit/CONSULTAS-ICFES-MODERNO)
de [@juanitogit](https://github.com/juanitogit), adaptado para desplegarse en
Cloudflare Pages.
