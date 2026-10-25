// Exportaciones del montaje: el proyecto tal cual (JSON), una línea de tiempo para DaVinci Resolve / Final Cut
// (FCPXML 1.9 con los ORIGINALES, no los proxies), los comentarios y el guion de la pista de notas.
// Cada una devuelve { nombre, tipo, texto } para que la interfaz lo guarde donde diga el usuario.
const path = require("path");
const { cfg } = require("./config");
const P = require("./proyecto");
const M = require("./medios");

const seguro = s => String(s || "proyecto").replace(/[\\/:*?"<>|]+/g, "_").trim() || "proyecto";
const tc = s => {
  s = Math.max(0, s);
  const dd = n => String(n).padStart(2, "0");
  return `${dd(Math.floor(s / 3600))}:${dd(Math.floor(s / 60) % 60)}:${dd(Math.floor(s) % 60)}`;
};
const xml = s => String(s ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

function json() {
  const p = P.cargar();
  return { nombre: `${seguro(cfg.nombre)}.clauditor.json`, tipo: "application/json", texto: JSON.stringify(p, null, 1) };
}

// Todos los clips como «connected clips» sobre un único hueco que ocupa el montaje entero: así cada pista
// conserva sus tiempos exactos sin tener que rellenar huecos. Vídeo en carriles 1, 2, 3… (de abajo arriba) y
// audio en −1, −2… Los rótulos y notas van como marcadores con su texto, igual que los comentarios abiertos.
async function fcpxml() {
  const p = P.cargar();
  const fps = p.fps || cfg.fps || 30;
  const t = s => `${Math.round(s * fps)}/${fps}s`;
  const cat = M.catalogo();
  const total = P.duracionTotal ? P.duracionTotal(p) : p.clips.reduce((m, c) => Math.max(m, c.inicio + c.duracion), 0);
  const vid = p.pistas.filter(x => x.tipo === "video").reverse();   // V1 abajo = carril 1
  const aud = p.pistas.filter(x => x.tipo === "audio");
  const carril = id => { const v = vid.findIndex(x => x.id === id); if (v >= 0) return v + 1; const a = aud.findIndex(x => x.id === id); return a >= 0 ? -(a + 1) : null; };
  const assets = new Map();
  for (const c of p.clips) {
    if (!c.medio || assets.has(c.medio) || !cat[c.medio]) continue;
    const m = cat[c.medio];
    const dur = m.tipo === "foto" ? 0 : await M.duracion(c.medio).catch(() => null);
    assets.set(c.medio, { id: "a" + (assets.size + 1), m, dur });
  }
  const res = [`    <format id="f1" name="FFVideoFormat1080p${fps}" frameDuration="1/${fps}s" width="1920" height="1080"/>`];
  for (const [clave, a] of assets) {
    const url = "file:///" + a.m.ruta.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/").replace(/^([A-Za-z])%3A/, "$1:");
    const tieneV = a.m.tipo !== "audio" ? 1 : 0, tieneA = a.m.tipo === "video" || a.m.tipo === "audio" ? 1 : 0;
    res.push(`    <asset id="${a.id}" name="${xml(clave)}" start="0s" duration="${a.dur ? t(a.dur) : "0s"}" hasVideo="${tieneV}" hasAudio="${tieneA}"${tieneV ? ' format="f1"' : ""}${tieneA ? ' audioSources="1" audioChannels="2"' : ""}>`,
      `      <media-rep kind="original-media" src="${xml(url)}"/>`, `    </asset>`);
  }
  const hijos = [];
  for (const c of p.clips) {
    const lane = carril(c.pista);
    if (!c.medio) {
      if (c.texto) hijos.push(`          <marker start="${t(c.inicio)}" duration="${t(Math.max(c.duracion, 1 / fps))}" value="${xml(`[${c.pista}] ${c.texto}`.slice(0, 250))}"/>`);
      continue;
    }
    const a = assets.get(c.medio);
    if (!a || lane === null) continue;
    const vol = c.mute ? -96 : c.volumen !== undefined && c.volumen !== 1 ? Math.max(-96, 20 * Math.log10(Math.max(c.volumen, 1e-5))) : null;
    const ajuste = vol !== null && a.m.tipo !== "foto" && a.m.tipo !== "animacion" ? `<adjust-volume amount="${vol.toFixed(1)}dB"/>` : "";
    const comun = `ref="${a.id}" lane="${lane}" offset="${t(c.inicio)}" duration="${t(c.duracion)}" name="${xml(c.id + " · " + c.medio)}"`;
    if (a.m.tipo === "foto") hijos.push(`          <video ${comun} start="0s"/>`);
    else hijos.push(`          <asset-clip ${comun} start="${t(c.entrada || 0)}">${ajuste}</asset-clip>`);
  }
  for (const k of p.comentarios.filter(k => k.estado !== "hecho"))
    hijos.push(`          <marker start="${t(k.t)}" duration="${t(1 / fps)}" value="${xml(("Comentario: " + k.texto).slice(0, 250))}"/>`);
  const texto = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
${res.join("\n")}
  </resources>
  <library>
    <event name="Clauditor">
      <project name="${xml(cfg.nombre)}">
        <sequence format="f1" duration="${t(total)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
            <gap name="Montaje" offset="0s" start="0s" duration="${t(total)}">
${hijos.map(h => "  " + h).join("\n")}
            </gap>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
  return { nombre: `${seguro(cfg.nombre)}.fcpxml`, tipo: "application/xml", texto };
}

function comentarios() {
  const p = P.cargar();
  const ks = [...p.comentarios].sort((a, b) => a.t - b.t);
  const lin = [`# Comentarios · ${cfg.nombre}`, "", `${ks.filter(k => k.estado !== "hecho").length} abiertos · ${ks.filter(k => k.estado === "hecho").length} hechos`, ""];
  for (const k of ks) {
    lin.push(`## ${tc(k.t)} · ${k.estado === "hecho" ? "hecho" : "abierto"}${k.clip ? ` · ${k.clip}` : ""}`, "", k.texto, "");
    if (k.respuesta) lin.push(`> ${String(k.respuesta).replace(/\n/g, "\n> ")}`, "");
  }
  return { nombre: `${seguro(cfg.nombre)}_comentarios.md`, tipo: "text/markdown", texto: lin.join("\n") };
}

function guion() {
  const p = P.cargar();
  const notas = p.pistas.filter(x => x.tipo === "notas").map(x => x.id);
  const marc = [...(p.marcadores || [])].map(m => ({ t: m.t, txt: `\n=== ${m.texto} ===\n` }));
  const cs = p.clips.filter(c => notas.includes(c.pista) && c.texto).map(c => ({ t: c.inicio, txt: `[${tc(c.inicio)}] ${c.texto}` }));
  const lin = [...marc, ...cs].sort((a, b) => a.t - b.t).map(x => x.txt);
  return { nombre: `${seguro(cfg.nombre)}_guion.txt`, tipo: "text/plain", texto: `${cfg.nombre} · guion y notas\n${lin.join("\n")}\n` };
}

const FORMATOS = { json, fcpxml, comentarios, guion };
async function exportar(formato) {
  const f = FORMATOS[formato];
  if (!f) throw new Error("Formato de exportación desconocido: " + formato);
  return f();
}

module.exports = { exportar, FORMATOS };
