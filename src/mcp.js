// Servidor MCP (stdio) de Clauditor: deja a Claude leer y cambiar el montaje que ves en el editor.
// Uso (p. ej. en .mcp.json): node <clauditor>/src/mcp.js --proyecto <carpeta del proyecto>
// Trabaja sobre los mismos ficheros que el servidor web (proyecto.json / estado.json), que avisa al navegador
// de cada cambio. Al arrancar, levanta el servidor web si no está ya en marcha.
const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const { cfg } = require("./config");
const P = require("./proyecto");
const M = require("./medios");

const PUERTO = cfg.puerto;
const log = (...a) => process.stderr.write(a.join(" ") + "\n");

function asegurarServidor() {
  const s = net.connect(PUERTO, "127.0.0.1");
  s.on("connect", () => s.end());
  s.on("error", () => {
    const hijo = spawn(process.execPath, [path.join(__dirname, "servidor.js")], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
    hijo.unref();
    log("Servidor de Clauditor arrancado en http://localhost:" + PUERTO);
  });
}

// ---------- formato ----------
const r2 = x => Math.round(x * 100) / 100;
function tc(s) {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${String(m).padStart(2, "0")}:${r.toFixed(2).padStart(5, "0")}`;
}
function lineaClip(c) {
  const partes = [c.id.padEnd(5), c.pista.padEnd(3), `${tc(c.inicio)}→${tc(P.fin(c))} (${r2(c.duracion)}s)`];
  if (c.medio) partes.push(c.medio + (c.entrada !== undefined && !/\.jpe?g$/i.test(c.medio) ? ` @${r2(c.entrada)}s` : ""));
  if (c.texto) partes.push(`«${c.texto.length > 90 ? c.texto.slice(0, 90) + "…" : c.texto}»`);
  const marcas = [c.mute && "mute", c.oculto && "solo-audio", c.opcional && "opcional", c.volumen !== undefined && c.volumen !== 1 && `vol ${c.volumen}`, c.zoom && `zoom ${c.zoom}`, c.posicion && c.posicion].filter(Boolean);
  if (marcas.length) partes.push(`[${marcas.join(", ")}]`);
  if (c.nota) partes.push(`nota: ${c.nota.replace(/\n/g, " | ").slice(0, 140)}`);
  return partes.join("  ");
}
function lineaComentario(k, p) {
  const c = k.clip && p.clips.find(x => x.id === k.clip);
  return `${k.id} [${k.estado}] en ${tc(k.t)}${c ? ` sobre ${lineaClip(c)}` : ""}\n   «${k.texto}»${k.respuesta ? `\n   respuesta: ${k.respuesta}` : ""}`;
}
const texto = s => ({ content: [{ type: "text", text: s }] });
const imagen = ruta => ({ type: "image", data: fs.readFileSync(ruta).toString("base64"), mimeType: "image/jpeg" });
function aplicar(ops, motivo) {
  const r = P.aplicar(ops, "claude", motivo);
  return texto(`Hecho (rev ${r.rev}): ${r.hechos.join("; ")}`);
}

// ---------- herramientas ----------
const num = d => ({ type: "number", description: d });
const str = d => ({ type: "string", description: d });
const ids = { type: "array", items: { type: "string" }, description: "Ids de clip (c12, c40…)" };
const CAMPOS_CLIP = "Campos: pista, inicio, duracion, medio, entrada (s del medio donde empieza), texto, volumen (0-1), mute, oculto (solo audio, imagen negra), zoom (fotos: zoom final, p.ej. 1.08), nota, color (rosa/amarillo/rojo/cian/azul para rótulos), opcional, posicion ('abajo' | 'centro' | 'arriba'), estilo ('etiqueta' = cartel de etiqueta de recambio escrita a máquina), ref (línea pequeña encima del texto del cartel), tamano (escala del cartel, 1 normal, 1.6 título), eco (true: el sonido del clip resuena y deja cola al acabar), realce (true: compresor que sube la voz baja y frena golpes), desplaza_x (vídeos o animaciones: desplazamiento horizontal en fracción del ancho, p. ej. -0.6 para llevar a la izquierda una animación dibujada a la derecha). null borra el campo.";

const HERRAMIENTAS = [
  { name: "estado", description: "Qué está mirando el usuario ahora: cabezal, clips seleccionados, clips bajo el cabezal y comentarios pendientes. Empieza por aquí cuando te pida algo sobre 'esto', 'aquí' o 'lo seleccionado'.",
    inputSchema: { type: "object", properties: {} },
    run() {
      const p = P.cargar(), e = P.cargarEstado();
      const cab = e.cabezal || 0;
      const bajo = p.clips.filter(c => c.inicio <= cab && cab < P.fin(c));
      const seleccion = (e.seleccion || []).map(id => p.clips.find(c => c.id === id)).filter(Boolean);
      const pend = p.comentarios.filter(k => k.estado !== "hecho");
      const esc = [...p.marcadores].reverse().find(m => m.t <= cab);
      return texto([
        `Proyecto «${p.nombre}», rev ${p.rev}, duración ${tc(P.duracionTotal(p))}, ${p.clips.length} clips.`,
        `Pistas (arriba→abajo): ${p.pistas.map(x => `${x.id} ${x.tipo} «${x.nombre}»${x.mute ? " (silenciada)" : ""}${x.oculta ? " (oculta)" : ""}`).join(", ")}`,
        `Cabezal: ${tc(cab)}${esc ? ` (escena «${esc.texto}»)` : ""}`,
        `Bajo el cabezal:\n${bajo.map(c => "  " + lineaClip(c)).join("\n") || "  (nada)"}`,
        `Seleccionados (${seleccion.length}):\n${seleccion.map(c => "  " + lineaClip(c)).join("\n") || "  (ninguno)"}`,
        `Comentarios pendientes (${pend.length}):\n${pend.map(k => lineaComentario(k, p)).join("\n") || "  (ninguno)"}`,
      ].join("\n"));
    } },
  { name: "ver_linea_tiempo", description: "Lista los clips (id, pista, tiempos, medio, entrada, marcas, nota) y las escenas, opcionalmente entre dos segundos o solo de unas pistas.",
    inputSchema: { type: "object", properties: { desde: num("Segundo inicial"), hasta: num("Segundo final"), pistas: { type: "array", items: { type: "string" } } } },
    run({ desde = 0, hasta = Infinity, pistas }) {
      const p = P.cargar();
      const cs = p.clips.filter(c => P.fin(c) > desde && c.inicio < hasta && (!pistas || pistas.includes(c.pista)));
      const ms = p.marcadores.filter(m => m.t >= desde && m.t < hasta);
      const filas = [...ms.map(m => ({ t: m.t, s: `── ${tc(m.t)} ESCENA ${m.texto} ──` })), ...cs.map(c => ({ t: c.inicio + 0.0001, s: lineaClip(c) }))].sort((a, b) => a.t - b.t);
      return texto(filas.map(f => f.s).join("\n") || "No hay clips en ese tramo");
    } },
  { name: "ver_clip", description: "Detalle de un clip: todos sus campos, lo que se dice en ese tramo (transcripción) y, si quieres, fotogramas del principio, mitad y final.",
    inputSchema: { type: "object", properties: { id: str("Id del clip"), imagenes: { type: "boolean", description: "Incluir fotogramas (por defecto sí)" } }, required: ["id"] },
    async run({ id, imagenes = true }) {
      const p = P.cargar();
      const c = p.clips.find(x => x.id === id);
      if (!c) throw new Error("No existe " + id);
      const out = [JSON.stringify(c, null, 1)];
      const contenido = [];
      if (c.medio) {
        const tipo = M.catalogo()[c.medio]?.tipo;
        if (tipo === "video") {
          const fr = M.transcripcion(c.medio, (c.entrada || 0) - 5, (c.entrada || 0) + c.duracion + 5);
          if (fr.length) out.push("Transcripción alrededor (* = dentro del clip):\n" + fr.map(f => `${f.fin > c.entrada && f.inicio < c.entrada + c.duracion ? "*" : " "} ${r2(f.inicio)}-${r2(f.fin)}s: ${f.texto}`).join("\n"));
        }
        if (imagenes && tipo !== "audio") {
          const ts = tipo === "foto" ? [0] : [0.05, c.duracion / 2, c.duracion - 0.1].map(x => (c.entrada || 0) + Math.max(0, x));
          for (const s of ts) contenido.push(imagen(await M.fotograma(c.medio, s, 640)));
          out.push(`Fotogramas en ${ts.map(r2).join(", ")}s del medio`);
        }
      }
      return { content: [{ type: "text", text: out.join("\n\n") }, ...contenido] };
    } },
  { name: "leer_comentarios", description: "Comentarios que el usuario ha escrito en la línea de tiempo (por defecto solo los pendientes), con el clip al que se refieren.",
    inputSchema: { type: "object", properties: { todos: { type: "boolean" } } },
    run({ todos }) {
      const p = P.cargar();
      const ks = p.comentarios.filter(k => todos || k.estado !== "hecho").sort((a, b) => a.t - b.t);
      return texto(ks.map(k => lineaComentario(k, p)).join("\n") || "No hay comentarios" + (todos ? "" : " pendientes"));
    } },
  { name: "responder_comentario", description: "Escribe tu respuesta en un comentario (el usuario la ve en el editor) y, si ya está resuelto, márcalo como hecho.",
    inputSchema: { type: "object", properties: { id: str("Id del comentario (k3…)"), respuesta: str("Qué has hecho o qué propones"), hecho: { type: "boolean", description: "Marcar como hecho (por defecto sí)" } }, required: ["id", "respuesta"] },
    run({ id, respuesta, hecho = true }) { return aplicar([{ op: "modificar_comentario", id, respuesta, ...(hecho ? { estado: "hecho" } : {}) }]); } },
  { name: "anadir_clip", description: "Añade un clip de un medio (vídeo, foto, animación, audio) o un rótulo de texto. " + CAMPOS_CLIP,
    inputSchema: { type: "object", properties: { pista: str("V1, V2, A1…"), medio: str("Nombre de archivo, ver la herramienta medios"), texto: str("Para rótulos o notas sin medio"),
      inicio: num("Segundo de la línea de tiempo"), entrada: num("Segundo del medio donde empieza"), duracion: num("Segundos"), volumen: num("0-1"), mute: { type: "boolean" },
      oculto: { type: "boolean" }, zoom: num("Fotos"), nota: str(""), color: str(""), posicion: str(""), estilo: str("'etiqueta' para carteles"), ref: str("Línea pequeña del cartel"), tamano: num("Escala del cartel") }, required: ["pista", "inicio", "duracion"] },
    run(a) { return aplicar([{ op: "anadir_clip", ...a }]); } },
  { name: "modificar_clips", description: "Cambia campos de uno o varios clips. " + CAMPOS_CLIP,
    inputSchema: { type: "object", properties: { ids, cambios: { type: "object", description: "{campo: valor}" } }, required: ["ids", "cambios"] },
    run(a) { return aplicar([{ op: "modificar_clips", ...a }]); } },
  { name: "mover_clips", description: "Mueve clips sumando delta segundos a su inicio y, opcionalmente, los cambia de pista. No empuja a los demás (usa desplazar para eso).",
    inputSchema: { type: "object", properties: { ids, delta: num("Segundos (negativo = antes)"), pista: str("Nueva pista") }, required: ["ids"] },
    run(a) { return aplicar([{ op: "mover_clips", ...a }]); } },
  { name: "recortar", description: "Recorta un clip por el inicio (conserva la sincronía: la entrada avanza lo mismo) o por el fin. delta positivo acorta por el inicio y alarga por el fin.",
    inputSchema: { type: "object", properties: { id: str(""), lado: { type: "string", enum: ["inicio", "fin"] }, delta: num("Segundos") }, required: ["id", "lado", "delta"] },
    run(a) { return aplicar([{ op: "recortar", ...a }]); } },
  { name: "borrar_clips", description: "Borra clips. Con cerrar_hueco, todo lo posterior (en todas las pistas) se adelanta lo que duraba cada clip borrado.",
    inputSchema: { type: "object", properties: { ids, cerrar_hueco: { type: "boolean" } }, required: ["ids"] },
    run(a) { return aplicar([{ op: "borrar_clips", ...a }]); } },
  { name: "dividir", description: "Corta un clip en dos en el segundo t de la línea de tiempo.",
    inputSchema: { type: "object", properties: { id: str(""), t: num("Segundo de la línea de tiempo") }, required: ["id", "t"] },
    run(a) { return aplicar([{ op: "dividir", ...a }]); } },
  { name: "desplazar", description: "Mueve todo lo que empieza en 'desde' o después: delta > 0 abre un hueco, delta < 0 lo cierra. Arrastra también escenas y comentarios si no limitas pistas.",
    inputSchema: { type: "object", properties: { desde: num("Segundo"), delta: num("Segundos"), pistas: { type: "array", items: { type: "string" } } }, required: ["desde", "delta"] },
    run(a) { return aplicar([{ op: "desplazar", ...a }]); } },
  { name: "operaciones", description: "Varias operaciones en un solo paso (un único deshacer). Cada una: {op, ...args} con op en anadir_clip, modificar_clips, mover_clips, recortar, borrar_clips, dividir, desplazar, anadir_pista {tipo, nombre}, modificar_pista {id, nombre, mute, oculta}, anadir_comentario {t, clip, texto, autor}, modificar_comentario, borrar_comentario, anadir_marcador {t, texto, color}, borrar_marcador. Úsala para reorganizar una escena entera.",
    inputSchema: { type: "object", properties: { ops: { type: "array", items: { type: "object" } }, motivo: str("Resumen corto que verá el usuario") }, required: ["ops"] },
    run({ ops, motivo }) { return aplicar(ops, motivo); } },
  { name: "seleccionar", description: "Enseña algo en el editor: selecciona clips, lleva el cabezal a un segundo y/o abre un comentario. Úsalo para señalar al usuario de qué hablas.",
    inputSchema: { type: "object", properties: { ids, cabezal: num("Segundo"), comentario: str("Id de comentario") } },
    run({ ids: sel, cabezal, comentario }) {
      const orden = { id: Date.now() };
      if (sel) orden.seleccion = sel;
      if (cabezal !== undefined) orden.cabezal = cabezal;
      if (comentario) orden.comentario = comentario;
      P.guardarEstado({ orden });
      return texto("Mostrado en el editor");
    } },
  { name: "deshacer", description: "Deshace los últimos cambios (de cualquiera de los dos).",
    inputSchema: { type: "object", properties: { pasos: num("Por defecto 1") } },
    run({ pasos = 1 }) { return texto("Deshecho, rev " + P.deshacer(pasos, "claude")); } },
  { name: "medios", description: "Lista los medios disponibles (vídeos, fotos, animaciones con transparencia y audios de las carpetas del proyecto) con duración, si su proxy está listo y si ya se usa en el montaje.",
    inputSchema: { type: "object", properties: { filtro: str("Texto a buscar en el nombre"), tipo: { type: "string", enum: ["video", "foto", "animacion", "audio"] } } },
    async run({ filtro = "", tipo }) {
      const p = P.cargar();
      const usos = {};
      for (const c of p.clips) if (c.medio) (usos[c.medio] = usos[c.medio] || []).push(c.id);
      const filas = [];
      for (const [k, m] of Object.entries(M.catalogo())) {
        if ((tipo && m.tipo !== tipo) || !k.toLowerCase().includes(filtro.toLowerCase())) continue;
        const d = m.tipo === "foto" ? null : await M.duracion(k).catch(() => null);
        filas.push(`${k}  ${m.tipo}${d ? "  " + r2(d) + "s" : ""}${M.rutaReproducible(k) ? "" : "  (proxy pendiente)"}${usos[k] ? "  usado en " + usos[k].join(",") : ""}`);
      }
      return texto(filas.sort().join("\n") || "Nada");
    } },
  { name: "transcripcion", description: "Lo que se dice en un vídeo (transcripción con tiempos del propio vídeo), entero o en un tramo.",
    inputSchema: { type: "object", properties: { medio: str("VID_….mp4"), desde: num(""), hasta: num("") }, required: ["medio"] },
    run({ medio, desde = 0, hasta = Infinity }) {
      const fr = M.transcripcion(medio, desde, hasta);
      return texto(fr.map(f => `${r2(f.inicio)}-${r2(f.fin)}s: ${f.texto}`).join("\n") || "Sin transcripción en ese tramo");
    } },
  { name: "ver_fotograma", description: "Imagen de un medio en un segundo concreto, o lo que se ve en la línea de tiempo en el segundo 'linea' (un fotograma por capa visible, de arriba abajo).",
    inputSchema: { type: "object", properties: { medio: str(""), t: num("Segundo del medio"), linea: num("Segundo de la línea de tiempo") } },
    async run({ medio, t = 0, linea }) {
      if (medio) return { content: [{ type: "text", text: `${medio} en ${t}s` }, imagen(await M.fotograma(medio, t, 960))] };
      if (linea === undefined) throw new Error("Pasa medio+t o linea");
      const p = P.cargar();
      const out = [], imgs = [];
      for (const pi of p.pistas.filter(x => x.tipo === "video" && !x.oculta)) {
        const c = p.clips.filter(c => c.pista === pi.id && c.inicio <= linea && linea < P.fin(c)).pop();
        if (!c) continue;
        if (!c.medio) { out.push(`${pi.id}: rótulo «${c.texto}»`); continue; }
        if (c.oculto) { out.push(`${pi.id}: ${c.id} solo audio (negro)`); continue; }
        const s = (c.entrada || 0) + (linea - c.inicio);
        out.push(`${pi.id}: ${c.id} ${c.medio} en ${r2(s)}s`);
        imgs.push(imagen(await M.fotograma(c.medio, s, 960)));
      }
      return { content: [{ type: "text", text: `En ${tc(linea)}:\n` + (out.join("\n") || "negro") }, ...imgs] };
    } },
  { name: "hoja_contactos", description: "Cuadrícula de fotogramas repartidos por un vídeo o animación (o un tramo) para ver de un vistazo qué hay y elegir trozos.",
    inputSchema: { type: "object", properties: { medio: str(""), desde: num(""), hasta: num(""), n: num("Número de fotogramas (4-24, por defecto 12)") }, required: ["medio"] },
    async run({ medio, desde, hasta, n = 12 }) {
      n = Math.max(4, Math.min(24, Math.round(n)));
      const h = await M.hojaContactos(medio, desde, hasta, n);
      return { content: [{ type: "text", text: `${medio}: fotogramas en ${h.tiempos.join(", ")} s (de izquierda a derecha y de arriba abajo, 4 por fila)` }, imagen(h.ruta)] };
    } },
];

// ---------- protocolo MCP sobre stdio (JSON-RPC, un mensaje por línea) ----------
const enviar = m => process.stdout.write(JSON.stringify(m) + "\n");
async function atender(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notificaciones
  try {
    if (method === "initialize") return enviar({ jsonrpc: "2.0", id, result: {
      protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} },
      serverInfo: { name: "clauditor", version: "0.1.0" },
      instructions: "Clauditor: editor de vídeo que el usuario tiene abierto con el proyecto «" + cfg.nombre + "» (http://localhost:" + PUERTO + "). Lee 'estado' para saber qué mira y qué ha seleccionado, 'leer_comentarios' para sus peticiones, haz los cambios con las herramientas de edición (se ven al instante en su editor), señala con 'seleccionar' y contesta con 'responder_comentario'. Tiempos en segundos." } });
    if (method === "ping") return enviar({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return enviar({ jsonrpc: "2.0", id, result: { tools: HERRAMIENTAS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
    if (method === "tools/call") {
      const h = HERRAMIENTAS.find(x => x.name === params.name);
      if (!h) throw new Error("Herramienta desconocida: " + params.name);
      try { return enviar({ jsonrpc: "2.0", id, result: await h.run(params.arguments || {}) }); }
      catch (e) { return enviar({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Error: " + e.message }], isError: true } }); }
    }
    enviar({ jsonrpc: "2.0", id, error: { code: -32601, message: "Método no soportado: " + method } });
  } catch (e) {
    enviar({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
  }
}
let buf = "";
const pendientes = new Set();
process.stdin.setEncoding("utf8");
process.stdin.on("data", d => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const linea = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!linea) continue;
    let msg;
    try { msg = JSON.parse(linea); } catch (e) { log("Mensaje no válido: " + e.message); continue; }
    const pr = atender(msg).finally(() => pendientes.delete(pr));
    pendientes.add(pr);
  }
});
process.stdin.on("end", async () => { await Promise.allSettled([...pendientes]); process.exit(0); });
asegurarServidor();
