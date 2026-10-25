// El montaje vive en proyecto.json, dentro de la carpeta del proyecto. Lo cambian el editor (tú) y el servidor
// MCP (Claude), siempre a través de aplicar(), que guarda una copia en historial/ antes de cada cambio para
// poder deshacer. estado.json guarda lo efímero: selección, cabezal y el último aviso.
//
// Formato:
//   pistas: [{ id, tipo: "video"|"audio"|"notas", nombre }]   orden de arriba abajo; las de vídeo de abajo tapan menos
//   clips:  [{ id, pista, inicio, duracion, medio?, entrada?, texto?, volumen, mute, oculto, zoom, nota, color, opcional }]
//           inicio/duracion en segundos de la línea de tiempo; entrada = segundo del medio en que empieza
//           texto sin medio = rótulo (en pista de vídeo se ve encima de la imagen; en pista de notas solo se lee)
//           estilo "etiqueta" = cartel con aspecto de etiqueta de cartulina: texto, ref (línea pequeña de arriba),
//           posicion (abajo | centro | arriba) y tamano (1 = normal)
//   marcadores: [{ id, t, texto, color }]
//   comentarios: [{ id, t, clip?, texto, estado: "abierto"|"hecho", respuesta, creado }]
const fs = require("fs");
const path = require("path");
const { RUTAS, cfg } = require("./config");

const FICH = RUTAS.proyecto;
const ESTADO = RUTAS.estado;
const HIST = RUTAS.historial;

// Montaje vacío para una carpeta de proyecto nueva
function proyectoNuevo() {
  return {
    nombre: cfg.nombre, fps: cfg.fps, rev: 1, siguienteId: 1,
    pistas: [
      { id: "N1", tipo: "notas", nombre: "Notas y guion" },
      { id: "V3", tipo: "video", nombre: "Rótulos" },
      { id: "V2", tipo: "video", nombre: "Gráficos" },
      { id: "V1", tipo: "video", nombre: "Imagen" },
      { id: "A1", tipo: "audio", nombre: "Voz en off" },
      { id: "A2", tipo: "audio", nombre: "Música" },
      { id: "A3", tipo: "audio", nombre: "Directo limpio" },
    ],
    clips: [], marcadores: [], comentarios: [],
  };
}
if (!fs.existsSync(FICH)) fs.writeFileSync(FICH, JSON.stringify(proyectoNuevo(), null, 1));

const r3 = x => Math.round(x * 1000) / 1000;

function cargar() { return JSON.parse(fs.readFileSync(FICH, "utf8")); }
function escribir(p) {
  const tmp = FICH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(p, null, 1));
  fs.renameSync(tmp, FICH);
}

function cargarEstado() {
  try { return JSON.parse(fs.readFileSync(ESTADO, "utf8")); } catch { return { seleccion: [], cabezal: 0 }; }
}
function guardarEstado(cambios) {
  const e = { ...cargarEstado(), ...cambios, rev: Date.now() };
  fs.writeFileSync(ESTADO, JSON.stringify(e, null, 1));
  return e;
}

function nuevoId(p, prefijo) {
  p.siguienteId = (p.siguienteId || 1);
  return prefijo + p.siguienteId++;
}
const fin = c => r3(c.inicio + c.duracion);
const duracionTotal = p => p.clips.reduce((m, c) => Math.max(m, fin(c)), 0);

function clip(p, id) {
  const c = p.clips.find(x => x.id === id);
  if (!c) throw new Error(`No hay ningún clip con id ${id}`);
  return c;
}
function ordenar(p) { p.clips.sort((a, b) => a.inicio - b.inicio || a.pista.localeCompare(b.pista)); }

// Operaciones. Cada una recibe el proyecto, lo modifica y devuelve un texto que describe lo hecho.
const OPS = {
  anadir_clip(p, a) {
    if (!p.pistas.some(x => x.id === a.pista)) throw new Error(`No existe la pista ${a.pista}`);
    if (!a.medio && !a.texto) throw new Error("Hace falta medio o texto");
    const c = {
      id: nuevoId(p, "c"), pista: a.pista, inicio: r3(a.inicio ?? 0), duracion: r3(a.duracion ?? 5),
      ...(a.medio ? { medio: a.medio, entrada: r3(a.entrada ?? 0) } : {}),
      ...(a.texto ? { texto: a.texto } : {}),
    };
    for (const k of ["volumen", "mute", "oculto", "zoom", "nota", "color", "opcional", "posicion", "estilo", "ref", "tamano", "eco", "realce", "desplaza_x"]) if (a[k] !== undefined) c[k] = a[k];
    p.clips.push(c);
    ordenar(p);
    return `añadido ${c.id} (${c.medio || "rótulo"}) en ${c.pista} a ${c.inicio}s`;
  },
  modificar_clips(p, { ids, cambios }) {
    const permitidos = ["pista", "inicio", "duracion", "medio", "entrada", "texto", "volumen", "mute", "oculto", "zoom", "nota", "color", "opcional", "posicion", "estilo", "ref", "tamano", "eco", "realce", "desplaza_x"];
    for (const id of ids) {
      const c = clip(p, id);
      for (const [k, v] of Object.entries(cambios)) {
        if (!permitidos.includes(k)) throw new Error(`Campo no editable: ${k}`);
        if (v === null) delete c[k];
        else c[k] = ["inicio", "duracion", "entrada"].includes(k) ? r3(Math.max(k === "duracion" ? 0.04 : 0, v)) : v;
      }
    }
    ordenar(p);
    return `modificados ${ids.join(", ")}: ${Object.keys(cambios).join(", ")}`;
  },
  // Mueve clips sumando delta segundos a su inicio (y opcionalmente cambia de pista)
  mover_clips(p, { ids, delta = 0, pista }) {
    for (const id of ids) {
      const c = clip(p, id);
      c.inicio = r3(Math.max(0, c.inicio + delta));
      if (pista) c.pista = pista;
    }
    ordenar(p);
    return `movidos ${ids.join(", ")} ${delta >= 0 ? "+" : ""}${r3(delta)}s${pista ? " a " + pista : ""}`;
  },
  // Recorta por la izquierda o la derecha. lado "inicio": el clip empieza más tarde/antes conservando la sincronía.
  recortar(p, { id, lado, delta }) {
    const c = clip(p, id);
    if (lado === "inicio") {
      const d = Math.max(-c.inicio, Math.min(delta, c.duracion - 0.04));
      const dd = c.medio && c.entrada !== undefined ? Math.max(d, -c.entrada) : d;
      c.inicio = r3(c.inicio + dd); c.duracion = r3(c.duracion - dd);
      if (c.entrada !== undefined) c.entrada = r3(c.entrada + dd);
    } else c.duracion = r3(Math.max(0.04, c.duracion + delta));
    return `recortado ${id} por el ${lado} ${r3(delta)}s`;
  },
  borrar_clips(p, { ids, cerrar_hueco = false }) {
    const quitados = ids.map(id => clip(p, id));
    p.clips = p.clips.filter(c => !ids.includes(c.id));
    if (cerrar_hueco) {
      // Por cada clip borrado, todo lo que empieza después en cualquier pista se adelanta lo que duraba
      for (const q of quitados.sort((a, b) => b.inicio - a.inicio))
        for (const c of p.clips) if (c.inicio >= fin(q) - 0.001) c.inicio = r3(c.inicio - q.duracion);
    }
    p.comentarios.forEach(k => { if (ids.includes(k.clip)) delete k.clip; });
    return `borrados ${ids.join(", ")}${cerrar_hueco ? " cerrando el hueco" : ""}`;
  },
  dividir(p, { id, t }) {
    const c = clip(p, id);
    if (t <= c.inicio + 0.02 || t >= fin(c) - 0.02) throw new Error(`El segundo ${t} no cae dentro de ${id}`);
    const b = { ...c, id: nuevoId(p, "c"), inicio: r3(t), duracion: r3(fin(c) - t) };
    if (c.entrada !== undefined) b.entrada = r3(c.entrada + (t - c.inicio));
    c.duracion = r3(t - c.inicio);
    p.clips.push(b);
    ordenar(p);
    return `dividido ${id} en ${r3(t)}s → ${id} y ${b.id}`;
  },
  // Desplaza todo lo que empieza en desde o después (abre hueco si delta > 0, lo cierra si < 0)
  desplazar(p, { desde, delta, pistas }) {
    let n = 0;
    for (const c of p.clips) if (c.inicio >= desde - 0.001 && (!pistas || pistas.includes(c.pista))) { c.inicio = r3(Math.max(0, c.inicio + delta)); n++; }
    for (const m of p.marcadores) if (m.t >= desde - 0.001) m.t = r3(Math.max(0, m.t + delta));
    if (!pistas) for (const k of p.comentarios) if (k.t >= desde - 0.001) k.t = r3(Math.max(0, k.t + delta));
    ordenar(p);
    return `desplazados ${n} clips desde ${desde}s ${delta >= 0 ? "+" : ""}${r3(delta)}s`;
  },
  anadir_pista(p, { tipo, nombre, posicion }) {
    const n = p.pistas.filter(x => x.tipo === tipo).length + 1;
    const pre = { video: "V", audio: "A", notas: "N" }[tipo];
    let id = pre + n; while (p.pistas.some(x => x.id === id)) id += "b";
    const pista = { id, tipo, nombre: nombre || id };
    p.pistas.splice(posicion ?? (tipo === "video" ? 0 : p.pistas.length), 0, pista);
    return `añadida pista ${id}`;
  },
  modificar_pista(p, { id, nombre, mute, oculta }) {
    const x = p.pistas.find(y => y.id === id);
    if (!x) throw new Error(`No existe la pista ${id}`);
    if (nombre !== undefined) x.nombre = nombre;
    if (mute !== undefined) x.mute = mute;
    if (oculta !== undefined) x.oculta = oculta;
    return `pista ${id} modificada`;
  },
  anadir_comentario(p, { t, clip: cid, texto, autor = "tú" }) {
    const k = { id: nuevoId(p, "k"), t: r3(t), texto, autor, estado: "abierto", respuesta: "", creado: new Date().toISOString() };
    if (cid) k.clip = cid;
    p.comentarios.push(k);
    return `comentario ${k.id} en ${k.t}s`;
  },
  modificar_comentario(p, { id, texto, respuesta, estado, t }) {
    const k = p.comentarios.find(x => x.id === id);
    if (!k) throw new Error(`No hay comentario ${id}`);
    if (texto !== undefined) k.texto = texto;
    if (respuesta !== undefined) k.respuesta = respuesta;
    if (estado !== undefined) k.estado = estado;
    if (t !== undefined) { k.t = r3(t); delete k.ancla; }   // se vuelve a anclar donde se ha puesto
    return `comentario ${id} actualizado`;
  },
  borrar_comentario(p, { id }) {
    p.comentarios = p.comentarios.filter(k => k.id !== id);
    return `comentario ${id} borrado`;
  },
  anadir_marcador(p, { t, texto, color = "azul" }) {
    const m = { id: nuevoId(p, "m"), t: r3(t), texto, color };
    p.marcadores.push(m);
    p.marcadores.sort((a, b) => a.t - b.t);
    return `marcador ${m.id} en ${m.t}s`;
  },
  borrar_marcador(p, { id }) {
    p.marcadores = p.marcadores.filter(m => m.id !== id);
    return `marcador ${id} borrado`;
  },
};

// Cada comentario se ancla a la imagen sobre la que se escribió: el clip de V1 que había debajo y el segundo
// de su vídeo (ancla = { clip, medio, src }). Tras cualquier cambio se recoloca sobre esa misma imagen, así
// recortar, desplazar o reordenar no descoloca los comentarios respecto a lo que comentan.
function anclar(p, k) {
  const c = p.clips.find(x => x.pista === "V1" && x.inicio <= k.t + 1e-6 && k.t < x.inicio + x.duracion - 1e-6);
  if (!c) { delete k.ancla; return; }
  k.ancla = { clip: c.id, medio: c.medio || null, src: r3((c.medio ? (c.entrada || 0) : 0) + (k.t - c.inicio)) };
}
function recolocarComentarios(p) {
  for (const k of p.comentarios) {
    const a = k.ancla;
    if (!a) { anclar(p, k); continue; }
    const contiene = c => c.medio === a.medio && (c.entrada || 0) - 0.01 <= a.src && a.src < (c.entrada || 0) + c.duracion + 0.01;
    // su clip, o si se dividió o recortó, el trozo del mismo vídeo que contiene ese segundo (mejor en V1)
    let c = p.clips.find(x => x.id === a.clip);
    if (a.medio && !(c && contiene(c))) c = p.clips.find(x => x.pista === "V1" && contiene(x)) || p.clips.find(contiene) || c;
    if (!c) { anclar(p, k); continue; }   // su imagen ya no está en el montaje: se queda donde lo dejaron las operaciones
    const off = clamp(a.medio ? a.src - (c.entrada || 0) : a.src, 0, Math.max(0, c.duracion - 0.04));
    k.t = r3(c.inicio + off);
    a.clip = c.id;
  }
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// Aplica una lista de operaciones [{ op, ...args }] como un solo paso deshacible.
function aplicar(ops, origen, motivo) {
  const p = cargar();
  const antes = JSON.stringify(p);
  const hechos = [];
  for (const k of p.comentarios) if (!k.ancla) anclar(p, k);
  for (const o of ops) {
    const f = OPS[o.op];
    if (!f) throw new Error(`Operación desconocida: ${o.op}`);
    hechos.push(f(p, o));
  }
  recolocarComentarios(p);
  fs.writeFileSync(path.join(HIST, `${sello()}.json`), antes);
  podarHistorial();
  vaciarRehacer();   // un cambio nuevo invalida lo que se podía rehacer
  p.rev = (p.rev || 0) + 1;
  escribir(p);
  const texto = motivo || hechos.join("; ");
  guardarEstado({ aviso: { origen, texto, rev: p.rev, cuando: Date.now() } });
  return { rev: p.rev, hechos };
}

const sello = () => new Date().toISOString().replace(/[:.]/g, "-");
const REHACER = path.join(HIST, "rehacer");
function vaciarRehacer() {
  try { for (const f of fs.readdirSync(REHACER)) fs.unlinkSync(path.join(REHACER, f)); } catch {}
}

function podarHistorial() {
  const fs_ = fs.readdirSync(HIST).filter(f => f.endsWith(".json")).sort();
  for (const f of fs_.slice(0, Math.max(0, fs_.length - 300))) fs.unlinkSync(path.join(HIST, f));
}

// Vuelve a la versión guardada antes del último cambio (n pasos). La versión deshecha se guarda en historial/deshecho.
function deshacer(n = 1, origen = "tú") {
  const copias = fs.readdirSync(HIST).filter(f => f.endsWith(".json")).sort();
  if (!copias.length) throw new Error("No hay nada que deshacer");
  n = Math.min(n, copias.length);
  const elegida = copias[copias.length - n];
  const actual = cargar();
  fs.mkdirSync(path.join(HIST, "deshecho"), { recursive: true });
  fs.writeFileSync(path.join(HIST, "deshecho", new Date().toISOString().replace(/[:.]/g, "-") + ".json"), JSON.stringify(actual));
  const p = JSON.parse(fs.readFileSync(path.join(HIST, elegida), "utf8"));
  // Lo deshecho se puede rehacer: cada paso quitado va a historial/rehacer (el más reciente, el último)
  fs.mkdirSync(REHACER, { recursive: true });
  const pasos = [...copias.slice(copias.length - n + 1).map(f => fs.readFileSync(path.join(HIST, f), "utf8")), JSON.stringify(actual)];
  pasos.reverse().forEach((txt, i) => fs.writeFileSync(path.join(REHACER, `${sello()}_${String(i).padStart(3, "0")}.json`), txt));
  for (const f of copias.slice(copias.length - n)) fs.unlinkSync(path.join(HIST, f));
  p.rev = (actual.rev || 0) + 1;
  escribir(p);
  guardarEstado({ aviso: { origen, texto: `deshecho${n > 1 ? " " + n + " pasos" : ""}`, rev: p.rev, cuando: Date.now() } });
  return p.rev;
}

// Rehace el último paso deshecho (si desde entonces no ha habido cambios nuevos)
function rehacer(origen = "tú") {
  let fs_ = [];
  try { fs_ = fs.readdirSync(REHACER).filter(f => f.endsWith(".json")).sort(); } catch {}
  if (!fs_.length) throw new Error("No hay nada que rehacer");
  const actual = cargar();
  // el último por nombre es el estado más cercano al actual (deshacer los escribe así)
  const elegido = fs_[fs_.length - 1];
  const p = JSON.parse(fs.readFileSync(path.join(REHACER, elegido), "utf8"));
  fs.unlinkSync(path.join(REHACER, elegido));
  fs.writeFileSync(path.join(HIST, `${sello()}.json`), JSON.stringify(actual));
  p.rev = (actual.rev || 0) + 1;
  escribir(p);
  guardarEstado({ aviso: { origen, texto: "rehecho", rev: p.rev, cuando: Date.now() } });
  return p.rev;
}

// Sustituye el montaje entero (restaurar una versión guardada) como un paso deshacible más
function restaurar(nuevo, origen, motivo) {
  const actual = cargar();
  if (!nuevo || !Array.isArray(nuevo.clips) || !Array.isArray(nuevo.pistas)) throw new Error("Ese fichero no es un proyecto de Clauditor");
  fs.writeFileSync(path.join(HIST, `${sello()}.json`), JSON.stringify(actual));
  vaciarRehacer();
  const p = { ...nuevo, rev: (actual.rev || 0) + 1 };
  escribir(p);
  guardarEstado({ aviso: { origen, texto: motivo, rev: p.rev, cuando: Date.now() } });
  return p.rev;
}

module.exports = { FICH, ESTADO, cargar, cargarEstado, guardarEstado, aplicar, deshacer, rehacer, restaurar, duracionTotal, fin, r3, OPS };
