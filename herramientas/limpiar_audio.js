// Limpia el sonido de uno o varios clips de V1 con DeepFilterNet (IA, quita ruidos: soldadura, motores,
// golpes, voces lejanas) a partir del vídeo ORIGINAL, lo nivela y lo pone en la pista «Directo limpio»
// alineado con el clip, que queda silenciado. Se puede volver al sonido original quitando el clip de A3
// y desmarcando «Sin sonido».
// Necesita DeepFilterNet (deepFilter y su modelo; rutas en clauditor.json → herramientas).
// Uso: node herramientas/limpiar_audio.js --proyecto <carpeta> c100 c108 ...   [--fondo -20]  (mezcla algo del original, en dB)
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { RUTAS } = require("../src/config");
const P = require("../src/proyecto");
const M = require("../src/medios");

const TMP = path.join(RUTAS.cache, "limpieza");
const DF = RUTAS.deepfilter || "deepFilter", MODELO = RUTAS.modeloDeepFilter;
fs.mkdirSync(TMP, { recursive: true });
const args = process.argv.slice(2);
const iFondo = args.indexOf("--fondo");
const fondo = iFondo >= 0 ? parseFloat(args[iFondo + 1]) : null;
const ids = args.filter((a, i) => /^c\d+$/.test(a) && !(iFondo >= 0 && i === iFondo + 1));
const MARGEN = 3;   // segundos de más por delante para que el nivelador arranque ya asentado
const ff = a => execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...a]);

const p = P.cargar();
const pistaLimpia = p.pistas.find(x => x.nombre === "Directo limpio");
if (!pistaLimpia) throw new Error("No existe la pista «Directo limpio»");
const ops = [];
for (const id of ids) {
  const c = p.clips.find(x => x.id === id);
  if (!c || !c.medio) { console.log("salto " + id); continue; }
  const original = M.catalogo()[c.medio].ruta;
  const desde = Math.max(0, c.entrada - MARGEN), pre = c.entrada - desde;
  const base = path.join(TMP, `${id}_${Math.round(c.entrada * 10)}`);
  ff(["-ss", String(desde), "-t", String(c.duracion + pre), "-i", original, "-vn", "-ac", "1", "-ar", "48000", base + ".wav"]);
  execFileSync(DF, ["-m", MODELO, base + ".wav", "-o", TMP], { stdio: "ignore" });
  const limpio = base + "_DeepFilterNet3.wav", salida = `directo_${id}_limpio.wav`;
  const voz = `highpass=f=70,dynaudnorm=f=250:g=15:p=0.5:m=6`;
  const final = `alimiter=limit=0.35:attack=1:release=50:level=false,atrim=start=${pre}:duration=${c.duracion},asetpts=PTS-STARTPTS,aformat=channel_layouts=stereo`;
  if (fondo === null) ff(["-i", limpio, "-af", `${voz},${final}`, "-ar", "48000", path.join(RUTAS.audio, salida)]);
  else ff(["-i", limpio, "-i", base + ".wav", "-filter_complex", `[0]${voz}[v];[1]volume=${fondo}dB[f];[v][f]amix=inputs=2:normalize=0,${final}`, "-ar", "48000", path.join(RUTAS.audio, salida)]);
  // sustituye un limpio anterior de ese clip, si lo había
  const viejo = p.clips.filter(x => x.pista === pistaLimpia.id && x.medio === salida).map(x => x.id);
  if (viejo.length) ops.push({ op: "borrar_clips", ids: viejo });
  ops.push({ op: "anadir_clip", pista: pistaLimpia.id, medio: salida, inicio: c.inicio, entrada: 0, duracion: c.duracion,
    nota: `Sonido de ${id} limpiado con DeepFilterNet desde el original (${c.medio} ${c.entrada.toFixed(1)}–${(c.entrada + c.duracion).toFixed(1)} s)` });
  ops.push({ op: "modificar_clips", ids: [id], cambios: { mute: true, realce: null } });
  console.log(`${id}: limpio → audio/${salida}`);
}
if (ops.length) console.log("rev " + P.aplicar(ops, "claude", `Sonido limpio en ${ids.join(", ")}`).rev);
