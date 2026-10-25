// Configuración de Clauditor: qué carpeta de proyecto se está editando y qué dice su clauditor.json.
//
// La carpeta del proyecto la fija quien arranca Clauditor (el programa, el servidor o el servidor MCP),
// por este orden: argumento `--proyecto <carpeta>`, variable de entorno CLAUDITOR_PROYECTO o la carpeta actual.
// En ella viven los datos del montaje:
//   clauditor.json   configuración (opcional; ver ejemplo/clauditor.json)
//   proyecto.json    el montaje: pistas, clips, escenas y comentarios
//   estado.json      selección y cabezal actuales (lo efímero)
//   historial/       copia antes de cada cambio, para deshacer
//   audio/           audios propios del proyecto (voces, música, sonido limpio…)
//   .clauditor/      proxies y caché (se regeneran; no hace falta guardarlos)
const fs = require("fs");
const path = require("path");

function carpetaProyecto() {
  const i = process.argv.indexOf("--proyecto");
  const dir = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : process.env.CLAUDITOR_PROYECTO || process.cwd();
  return path.resolve(dir);
}

const DIR = carpetaProyecto();
process.env.CLAUDITOR_PROYECTO = DIR;   // para que lo hereden los procesos hijos (servidor, herramientas)

const POR_DEFECTO = {
  nombre: path.basename(DIR),
  puerto: 4310,
  fps: 30,
  medios: ["medios"],          // carpetas con vídeos, fotos, animaciones y audios (relativas al proyecto o absolutas)
  transcripciones: null,       // JSON { "nombre_sin_extension": [{ inicio, fin, texto }] } (opcional)
  herramientas: {
    deepfilter: null,          // ruta a deepFilter(.exe) para limpiar audio (opcional)
    modeloDeepFilter: null,    // carpeta del modelo DeepFilterNet3 (opcional)
  },
};

let leido = {};
const FICH_CONFIG = path.join(DIR, "clauditor.json");
try { leido = JSON.parse(fs.readFileSync(FICH_CONFIG, "utf8")); } catch {}
const cfg = { ...POR_DEFECTO, ...leido, herramientas: { ...POR_DEFECTO.herramientas, ...(leido.herramientas || {}) } };
if (process.env.CLAUDITOR_PUERTO) cfg.puerto = +process.env.CLAUDITOR_PUERTO;

const enProyecto = p => (p ? path.resolve(DIR, p) : null);
const INTERNO = path.join(DIR, ".clauditor");
const RUTAS = {
  proyecto: path.join(DIR, "proyecto.json"),
  estado: path.join(DIR, "estado.json"),
  historial: path.join(DIR, "historial"),
  audio: path.join(DIR, "audio"),
  proxies: path.join(INTERNO, "proxies"),
  cache: path.join(INTERNO, "cache"),
  medios: (cfg.medios || []).map(enProyecto),
  transcripciones: enProyecto(cfg.transcripciones),
  deepfilter: enProyecto(cfg.herramientas.deepfilter),
  modeloDeepFilter: enProyecto(cfg.herramientas.modeloDeepFilter),
};
for (const d of [RUTAS.historial, RUTAS.audio, RUTAS.proxies, RUTAS.cache]) fs.mkdirSync(d, { recursive: true });

module.exports = { DIR, cfg, RUTAS, FICH_CONFIG };
