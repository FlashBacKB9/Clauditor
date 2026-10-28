// Servidor local de Clauditor (por defecto http://localhost:4310; el puerto se cambia en clauditor.json)
// Sirve la interfaz, los proxies (con Range para poder saltar dentro del vídeo), miniaturas y la API.
// Vigila proyecto.json y estado.json: cualquier cambio (tuyo o de Claude por MCP) llega al navegador por SSE.
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { DIR, cfg, RUTAS } = require("./config");
const P = require("./proyecto");
const X = require("./exportar");
const M = require("./medios");

const PUERTO = cfg.puerto;
const UI = path.join(__dirname, "..", "ui");
const VERSIONES = path.join(DIR, "versiones");
const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".mp4": "video/mp4", ".webm": "video/webm", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg", ".json": "application/json" };

const json = (res, obj, code = 200) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
const leerCuerpo = req => new Promise((ok, mal) => { let b = ""; req.on("data", d => b += d); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { mal(e); } }); });

function servirFichero(req, res, ruta, cache = "no-cache") {
  let st;
  try { st = fs.statSync(ruta); } catch { res.writeHead(404); return res.end(); }
  const tipo = TIPOS[path.extname(ruta).toLowerCase()] || "application/octet-stream";
  const rango = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (rango) {
    const ini = rango[1] ? +rango[1] : st.size - +rango[2];
    // Las peticiones abiertas («bytes=N-») se sirven en trozos de 4 MB: si no, cada reproductor deja una
    // descarga a medias ocupando una de las 6 conexiones que permite el navegador y la API se queda en cola
    const TROZO = 4 << 20;
    const fin = rango[1] && rango[2] ? Math.min(+rango[2], st.size - 1) : Math.min(st.size - 1, ini + TROZO - 1);
    res.writeHead(206, { "Content-Type": tipo, "Content-Range": `bytes ${ini}-${fin}/${st.size}`, "Accept-Ranges": "bytes", "Content-Length": fin - ini + 1, "Cache-Control": cache });
    enviar(res, fs.createReadStream(ruta, { start: ini, end: fin }));
  } else {
    res.writeHead(200, { "Content-Type": tipo, "Content-Length": st.size, "Accept-Ranges": "bytes", "Cache-Control": cache });
    enviar(res, fs.createReadStream(ruta));
  }
}
// El visor corta muchas descargas a medias (al saltar dentro de un vídeo): que eso no tumbe el servidor
function enviar(res, flujo) {
  flujo.on("error", () => res.destroy());
  res.on("close", () => flujo.destroy());
  flujo.pipe(res);
}

async function listaMedios() {
  const cat = M.catalogo();
  // v = fecha del fichero que se reproduce: va en la URL para que el navegador no use una versión vieja de caché
  const version = r => { try { return Math.round(fs.statSync(r).mtimeMs); } catch { return 0; } };
  const out = Object.entries(cat).map(([clave, m]) => {
    const r = M.rutaReproducible(clave);
    return { clave, tipo: m.tipo, listo: !!r, v: r ? version(r) : 0, dur: null };
  });
  const conDur = out.filter(m => m.tipo !== "foto");
  for (let i = 0; i < conDur.length; i += 8)
    await Promise.all(conDur.slice(i, i + 8).map(async m => { m.dur = await M.duracion(m.clave).catch(() => null); }));
  return out.sort((a, b) => a.clave.localeCompare(b.clave));
}

// SSE
const clientes = new Set();
function emitir(evento, datos) {
  const msg = `event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`;
  for (const r of clientes) { try { r.write(msg); } catch { clientes.delete(r); } }
}
let tProy, tEst;
fs.watch(DIR, (ev, f) => {
  if (f === "proyecto.json") { clearTimeout(tProy); tProy = setTimeout(() => { try { emitir("proyecto", P.cargar()); } catch {} }, 60); }
  if (f === "estado.json") { clearTimeout(tEst); tEst = setTimeout(() => emitir("estado", P.cargarEstado()), 60); }
});
// Avisar cuando termina un proxy para que el navegador recargue ese medio
fs.watch(RUTAS.proxies, (ev, f) => { if (f && !f.endsWith(".tmp")) emitir("proxy", { archivo: f }); });
// Igual con los audios (voz provisional regenerada, música nueva)
fs.watch(RUTAS.audio, (ev, f) => { if (f && !f.endsWith(".json")) emitir("proxy", { archivo: f }); });
setInterval(() => { for (const r of clientes) { try { r.write(": latido\n\n"); } catch { clientes.delete(r); } } }, 20000);

const servidor = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const ruta = decodeURIComponent(u.pathname);
  try {
    if (ruta === "/") return servirFichero(req, res, path.join(UI, "index.html"));
    if (ruta.startsWith("/ui/")) {
      const f = path.join(UI, ruta.slice(4));
      if (!f.startsWith(UI)) { res.writeHead(403); return res.end(); }
      return servirFichero(req, res, f);
    }
    if (ruta === "/eventos") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write("retry: 1000\n\n");
      clientes.add(res);
      req.on("close", () => clientes.delete(res));
      return;
    }
    if (ruta === "/api/proyecto") return json(res, P.cargar());
    if (ruta === "/api/info") return json(res, { nombre: cfg.nombre, carpeta: DIR, medios: RUTAS.medios, encuadre: cfg.encuadre || null });
    if (ruta === "/api/estado" && req.method === "GET") return json(res, P.cargarEstado());
    if (ruta === "/api/estado" && req.method === "POST") {
      const b = await leerCuerpo(req);
      const e = {};
      for (const k of ["seleccion", "cabezal"]) if (b[k] !== undefined) e[k] = b[k];
      return json(res, P.guardarEstado({ ...e, origen: "tú" }));
    }
    if (ruta === "/api/ops" && req.method === "POST") {
      const b = await leerCuerpo(req);
      return json(res, P.aplicar(b.ops, b.origen === "claude" ? "claude" : "tú", b.motivo));
    }
    if (ruta === "/api/deshacer" && req.method === "POST") return json(res, { rev: P.deshacer(1, "tú") });
    if (ruta === "/api/rehacer" && req.method === "POST") return json(res, { rev: P.rehacer("tú") });
    // Versiones guardadas a mano (Archivo › Guardar versión) en <proyecto>/versiones
    if (ruta === "/api/guardar" && req.method === "POST") {
      const b = await leerCuerpo(req).catch(() => ({}));
      fs.mkdirSync(VERSIONES, { recursive: true });
      const d = new Date(), dd = n => String(n).padStart(2, "0");
      const sello = `${d.getFullYear()}-${dd(d.getMonth() + 1)}-${dd(d.getDate())}_${dd(d.getHours())}-${dd(d.getMinutes())}-${dd(d.getSeconds())}`;
      const nota = String(b.nombre || "").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60);
      const fich = sello + (nota ? " " + nota : "") + ".json";
      fs.copyFileSync(P.FICH, path.join(VERSIONES, fich));
      return json(res, { fichero: fich, carpeta: VERSIONES });
    }
    if (ruta === "/api/versiones") {
      let lista = [];
      try { lista = fs.readdirSync(VERSIONES).filter(f => f.endsWith(".json")).sort().reverse(); } catch {}
      return json(res, lista.map(f => { const st = fs.statSync(path.join(VERSIONES, f)); let n = null; try { n = JSON.parse(fs.readFileSync(path.join(VERSIONES, f), "utf8")).clips.length; } catch {} return { fichero: f, bytes: st.size, clips: n }; }));
    }
    if (ruta === "/api/restaurar" && req.method === "POST") {
      const b = await leerCuerpo(req);
      let nuevo = b.proyecto;
      if (b.fichero) {
        const f = path.join(VERSIONES, path.basename(String(b.fichero)));
        nuevo = JSON.parse(fs.readFileSync(f, "utf8"));
      }
      return json(res, { rev: P.restaurar(nuevo, "tú", b.fichero ? `restaurada la versión ${b.fichero.replace(/\.json$/, "")}` : "importado un proyecto") });
    }
    if (ruta === "/api/exportar") return json(res, await X.exportar(u.query.formato || "json"));
    if (ruta === "/api/medios") return json(res, { medios: await listaMedios(), proxies: M.estadoProxies() });
    if (ruta === "/api/transcripcion") return json(res, M.transcripcion(u.query.medio || "", +u.query.desde || 0, u.query.hasta ? +u.query.hasta : Infinity));
    if (ruta.startsWith("/medio/")) {
      const clave = ruta.slice(7);
      const r = M.rutaReproducible(clave);
      if (r) return servirFichero(req, res, r, "max-age=3600");
      if (!M.catalogo()[clave]) { res.writeHead(404); return res.end("No existe"); }
      M.pedirProxy(clave).catch(e => console.error(e.message));
      res.writeHead(503, { "Retry-After": "5" }); return res.end("Generando proxy");
    }
    if (ruta.startsWith("/miniatura/")) {
      const clave = ruta.slice(11);
      const f = await M.fotograma(clave, +u.query.t || 0, +u.query.w || 192);
      return servirFichero(req, res, f, "max-age=86400");
    }
    res.writeHead(404); res.end("No encontrado");
  } catch (e) {
    try { json(res, { error: e.message }, 400); } catch { res.destroy(); }
  }
});

// Ningún error suelto debe parar el servidor: se apunta en cache/servidor.log y se sigue
const LOG = path.join(RUTAS.cache, "servidor.log");
const apuntar = e => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${e && e.stack || e}\n`); } catch {} };
process.on("uncaughtException", apuntar);
process.on("unhandledRejection", apuntar);

// Si ya hay otro servidor en el puerto (por ejemplo, el que levanta el MCP), se usa ese.
// Lanzado con node se cierra; dentro del programa (Electron) solo avisa.
const listo = new Promise(ok => {
  servidor.on("error", e => {
    if (e.code !== "EADDRINUSE") return apuntar(e);
    console.log(`Clauditor ya está abierto en http://localhost:${PUERTO}`);
    if (require.main === module) process.exit(0);
    ok("existente");
  });
  servidor.listen(PUERTO, "127.0.0.1", () => { console.log(`Clauditor · ${cfg.nombre} en http://localhost:${PUERTO}`); ok("propio"); });
});
module.exports = { PUERTO, listo, DIR, cfg };
