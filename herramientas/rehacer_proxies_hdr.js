// Rehace los proxies de los vídeos HDR (antes salían grises y apagados). Cada proxy nuevo se escribe aparte y
// sustituye al viejo al terminar, así el editor abierto nunca se queda sin vídeo.
// Uso: node herramientas/rehacer_proxies_hdr.js --proyecto <carpeta> [--todos]  (--todos: también los que no tienen proxy)
const fs = require("fs");
const { execFile } = require("child_process");
const M = require("../src/medios.js");
const todos = process.argv.includes("--todos");
const lista = Object.entries(M.catalogo()).filter(([k, v]) => v.tipo === "video" && M.esHDR(v.ruta) && (todos || fs.existsSync(M.rutaProxy(k, "video"))));
let i = 0, hechos = 0;
const uno = (k, m, porCPU) => new Promise(ok => {
  const sal = M.rutaProxy(k, "video"), tmp = sal + ".hdr.tmp";
  execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", ...M.argsProxy(m, tmp, porCPU)], { windowsHide: true, maxBuffer: 1 << 24 }, e => {
    if (e && !porCPU) return uno(k, m, true).then(ok);
    if (e) { console.log("FALLO", k, String(e.message).slice(-300)); try { fs.unlinkSync(tmp); } catch {} return ok(); }
    fs.renameSync(tmp, sal); hechos++; console.log(`${hechos}/${lista.length} ${k}`); ok();
  });
});
async function hilo() { while (i < lista.length) { const [k, m] = lista[i++]; await uno(k, m, false); } }
console.log(`Proxies HDR por rehacer: ${lista.length}`);
Promise.all([hilo(), hilo(), hilo()]).then(() => console.log("HECHO"));
