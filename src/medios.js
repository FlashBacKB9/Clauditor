// Catálogo de medios del montaje y sus proxies ligeros para la previsualización.
// Los originales no se tocan: los proxies van a .clauditor/proxies (vídeo 960 px H.264, vídeos con
// transparencia en WebM VP9 con alfa, fotos JPEG de 1600 px) y las miniaturas a .clauditor/cache.
const fs = require("fs");
const path = require("path");
const { execFile, execFileSync, spawn } = require("child_process");
const { RUTAS } = require("./config");

const PROXIES = RUTAS.proxies, CACHE = RUTAS.cache;
const EXT_VIDEO = /\.(mp4|mov|m4v|mkv|webm|avi)$/i;
const EXT_FOTO = /\.(jpe?g|png|webp)$/i;
const EXT_AUDIO = /\.(wav|mp3|m4a|aac|flac|ogg)$/i;

// ¿El vídeo tiene canal alfa? Entonces es una «animación» (gráfico para superponer). Se mira una vez con
// ffprobe y se guarda en cache/alfa.json junto a la fecha del fichero.
const FICH_ALFA = path.join(CACHE, "alfa.json");
let alfas = {};
try { alfas = JSON.parse(fs.readFileSync(FICH_ALFA, "utf8")); } catch {}
function tieneAlfa(ruta) {
  let mt = 0;
  try { mt = Math.round(fs.statSync(ruta).mtimeMs); } catch { return false; }
  const g = alfas[ruta];
  if (g && g.m === mt) return g.a;
  let a = false;
  try {
    const pf = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", ruta], { windowsHide: true }).toString();
    a = /^(yuva|rgba|argb|bgra|abgr|gbrap|ya)/.test(pf.trim());
  } catch {}
  alfas[ruta] = { a, m: mt };
  fs.writeFileSync(FICH_ALFA, JSON.stringify(alfas, null, 1));
  return a;
}

// Clave de cada medio = nombre de archivo (si dos carpetas tienen uno con el mismo nombre, vale el primero).
// Devuelve { clave: { ruta, tipo } } con tipo video | animacion | foto | audio.
function catalogo() {
  const cat = {};
  const meter = (ruta, tipo) => { const k = path.basename(ruta); if (!cat[k]) cat[k] = { ruta, tipo }; };
  const ls = d => { try { return fs.readdirSync(d); } catch { return []; } };
  for (const d of [...RUTAS.medios, RUTAS.audio]) {
    for (const f of ls(d)) {
      const ruta = path.join(d, f);
      if (EXT_VIDEO.test(f)) meter(ruta, tieneAlfa(ruta) ? "animacion" : "video");
      else if (EXT_FOTO.test(f)) meter(ruta, "foto");
      else if (EXT_AUDIO.test(f)) meter(ruta, "audio");
    }
  }
  return cat;
}

function rutaProxy(clave, tipo) {
  const base = clave.replace(/\.[^.]+$/, "");
  if (tipo === "video") return path.join(PROXIES, base + ".mp4");
  if (tipo === "animacion") return path.join(PROXIES, base + ".webm");
  if (tipo === "foto") return path.join(PROXIES, base + ".jpg");
  return null; // el audio se sirve tal cual
}

// Ruta que puede reproducir el navegador, o null si su proxy aún no está hecho.
function rutaReproducible(clave) {
  const m = catalogo()[clave];
  if (!m) return null;
  if (m.tipo === "audio") return m.ruta;
  const p = rutaProxy(clave, m.tipo);
  return fs.existsSync(p) ? p : null;
}

const ejecutar = (cmd, args) => new Promise((ok, mal) =>
  execFile(cmd, args, { maxBuffer: 64 << 20, windowsHide: true }, (e, so, se) => e ? mal(new Error((se || e.message).trim().split("\n").slice(-3).join("\n"))) : ok(so)));

// Duración en segundos (cacheada en cache/duraciones.json)
const FICH_DUR = path.join(CACHE, "duraciones.json");
let duraciones = {};
try { duraciones = JSON.parse(fs.readFileSync(FICH_DUR, "utf8")); } catch {}
// Cada entrada guarda { d, m }: la duración y la fecha del fichero, para recalcularla si el fichero cambia
async function duracion(clave) {
  const m = catalogo()[clave];
  if (!m || m.tipo === "foto") return null;
  let mt = 0;
  try { mt = Math.round(fs.statSync(m.ruta).mtimeMs); } catch {}
  const g = duraciones[clave];
  if (g && typeof g === "object" && g.m === mt) return g.d;
  if (typeof g === "number" && m.tipo !== "audio") return g; // entradas antiguas de vídeos, que no cambian
  const so = await ejecutar("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", m.ruta]);
  duraciones[clave] = { d: Math.round(parseFloat(so) * 1000) / 1000, m: mt };
  fs.writeFileSync(FICH_DUR, JSON.stringify(duraciones, null, 1));
  return duraciones[clave].d;
}

// porCPU: segundo intento sin la GPU, por si NVENC/CUDA no se llevan con ese archivo
function argsProxy(m, salida, porCPU) {
  if (m.tipo === "video") return ["-y", ...(porCPU ? [] : ["-hwaccel", "cuda"]), "-i", m.ruta,
    "-vf", "scale=960:960:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
    ...(porCPU ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26"] : ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "30"]),
    "-g", "15", "-bf", "0", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", "-f", "mp4", salida];
  if (m.tipo === "animacion") return ["-y", "-i", m.ruta,
    "-vf", "scale=960:960:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuva420p",
    "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", "32", "-b:v", "0", "-auto-alt-ref", "0",
    "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-g", "15", "-an", "-f", "webm", salida];
  if (m.tipo === "foto") return ["-y", "-i", m.ruta, "-vf", "scale=1600:1600:force_original_aspect_ratio=decrease",
    "-q:v", "3", "-f", "image2", salida];
}

// Cola de proxies: dos a la vez. Devuelve una promesa que se cumple cuando el proxy existe.
const cola = [], enCurso = new Map();
const PARALELO = 2;
function pedirProxy(clave) {
  const m = catalogo()[clave];
  if (!m) return Promise.reject(new Error("No existe el medio " + clave));
  const salida = rutaProxy(clave, m.tipo);
  if (!salida || fs.existsSync(salida)) return Promise.resolve(salida || m.ruta);
  if (enCurso.has(clave)) return enCurso.get(clave).promesa;
  // Otro proceso (el servidor, el MCP o node medios.js) ya lo está haciendo: esperar a que termine
  const reciente = f => { try { return Date.now() - fs.statSync(f).mtimeMs < 30000; } catch { return false; } };
  if (reciente(salida + ".tmp")) return new Promise((ok, mal) => {
    const iv = setInterval(() => {
      if (fs.existsSync(salida)) { clearInterval(iv); ok(salida); }
      else if (!reciente(salida + ".tmp")) { clearInterval(iv); mal(new Error("El proxy de " + clave + " se quedó a medias")); }
    }, 2000);
  });
  let ok, mal;
  const promesa = new Promise((a, b) => { ok = a; mal = b; });
  enCurso.set(clave, { promesa, empezado: false });
  const tmp = salida + ".tmp";
  const lanzar = porCPU => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...argsProxy(m, tmp, porCPU)], { windowsHide: true });
    let err = "";
    p.stderr.on("data", d => err += d);
    p.on("close", code => {
      if (code !== 0 && m.tipo === "video" && !porCPU) return lanzar(true);
      enCurso.delete(clave);
      if (code === 0) { fs.renameSync(tmp, salida); ok(salida); }
      else { try { fs.unlinkSync(tmp); } catch {} mal(new Error("ffmpeg falló con " + clave + ": " + err.slice(-500))); }
      siguiente();
    });
  };
  cola.push(() => { enCurso.get(clave).empezado = true; lanzar(false); });
  siguiente();
  return promesa;
}
let activos = 0;
function siguiente() {
  activos = [...enCurso.values()].filter(x => x.empezado).length;
  while (activos < PARALELO && cola.length) { cola.shift()(); activos++; }
}
function estadoProxies() {
  return { pendientes: [...enCurso.entries()].filter(([, v]) => !v.empezado).map(([k]) => k),
           haciendo: [...enCurso.entries()].filter(([, v]) => v.empezado).map(([k]) => k) };
}

// Como mucho tres ffmpeg de fotogramas a la vez (la línea de tiempo pide muchas miniaturas de golpe)
let fotogramasActivos = 0;
const esperando = [];
async function turno(f) {
  if (fotogramasActivos >= 3) await new Promise(r => esperando.push(r));
  fotogramasActivos++;
  try { return await f(); } finally { fotogramasActivos--; if (esperando.length) esperando.shift()(); }
}

// Fotograma JPEG de un medio en el segundo t (desde el proxy si existe; si no, desde el original).
async function fotograma(clave, t, ancho = 640) {
  const m = catalogo()[clave];
  if (!m) throw new Error("No existe el medio " + clave);
  if (m.tipo === "audio") throw new Error("Un audio no tiene fotogramas");
  const fuente = rutaReproducible(clave) || m.ruta;
  if (m.tipo === "foto") t = 0;
  const salida = path.join(CACHE, `${clave}_${Math.round(t * 100)}_${ancho}.jpg`);
  if (!fs.existsSync(salida)) await turno(() => ejecutar("ffmpeg", ["-y", "-loglevel", "error",
    ...(m.tipo === "foto" ? [] : ["-ss", String(Math.max(0, t))]),
    "-i", fuente, "-frames:v", "1", "-vf", `scale=${ancho}:-2`, "-q:v", "4", salida]));
  return salida;
}

// Frases transcritas de un vídeo que se solapan con [desde, hasta]
// Transcripciones (opcional, ruta en clauditor.json): { "nombre_sin_extension": [{ inicio, fin, texto }] }
let transcripciones;
function transcripcion(clave, desde = 0, hasta = Infinity) {
  if (!transcripciones) { try { transcripciones = JSON.parse(fs.readFileSync(RUTAS.transcripciones, "utf8")); } catch { transcripciones = {}; } }
  return (transcripciones[clave.replace(/\.mp4$/i, "")] || []).filter(s => s.fin > desde && s.inicio < hasta);
}

// Hoja de contactos: n fotogramas repartidos entre desde y hasta, en una cuadrícula de 4 columnas.
async function hojaContactos(clave, desde, hasta, n = 12) {
  const m = catalogo()[clave];
  if (!m || m.tipo === "foto" || m.tipo === "audio") throw new Error("Hoja de contactos solo para vídeo o animación");
  const dur = await duracion(clave);
  desde = Math.max(0, desde || 0);
  hasta = Math.min(dur, hasta || dur);
  const paso = (hasta - desde) / n;
  const tiempos = Array.from({ length: n }, (_, i) => Math.round((desde + paso * (i + 0.5)) * 10) / 10);
  const salida = path.join(CACHE, `hoja_${clave}_${Math.round(desde * 10)}_${Math.round(hasta * 10)}_${n}.jpg`);
  if (!fs.existsSync(salida)) {
    const marcos = await Promise.all(tiempos.map(t => fotograma(clave, t, 320)));
    // Si sobran huecos en la última fila se repite el último fotograma para que la cuadrícula quede completa
    const sobran = Math.ceil(n / 4) * 4 - n;
    const todos = [...marcos, ...Array(sobran).fill(marcos[marcos.length - 1])];
    const ent = todos.flatMap(f => ["-i", f]);
    const filtro = todos.map((_, i) => `[${i}:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2[f${i}]`).join(";") +
      ";" + todos.map((_, i) => `[f${i}]`).join("") + `xstack=inputs=${todos.length}:layout=` +
      todos.map((_, i) => `${(i % 4) * 320}_${Math.floor(i / 4) * 180}`).join("|") + `[out]`;
    await ejecutar("ffmpeg", ["-y", "-loglevel", "error", ...ent, "-filter_complex", filtro, "-map", "[out]", "-q:v", "4", salida]);
  }
  return { ruta: salida, tiempos };
}

module.exports = { catalogo, rutaProxy, rutaReproducible, duracion, pedirProxy, estadoProxies, fotograma, hojaContactos, transcripcion, ejecutar };

// node src/medios.js --proyecto <carpeta>  → genera todos los proxies que falten
if (require.main === module) {
  const cat = catalogo();
  const claves = Object.keys(cat).filter(k => cat[k].tipo !== "audio" && !fs.existsSync(rutaProxy(k, cat[k].tipo)));
  // Primero fotos y vídeos (lo que más se usa), al final las animaciones pesadas
  const orden = { foto: 0, video: 1, animacion: 2 };
  claves.sort((a, b) => orden[cat[a].tipo] - orden[cat[b].tipo]);
  console.log(`Proxies por hacer: ${claves.length}`);
  let hechos = 0;
  const t0 = Date.now();
  Promise.all(claves.map(k => pedirProxy(k).then(() => {
    hechos++;
    console.log(`[${hechos}/${claves.length}] ${k}  (${Math.round((Date.now() - t0) / 1000)} s)`);
  }, e => console.log("ERROR " + e.message)))).then(async () => {
    for (const k of Object.keys(cat)) if (cat[k].tipo !== "foto") await duracion(k).catch(() => {});
    console.log("Proxies terminados");
  });
}
