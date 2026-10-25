// Para cada comentario pendiente: qué hay en ese punto del montaje y lo que se dice alrededor
// Uso: node herramientas/ver_comentarios.js --proyecto <carpeta> [segundos de contexto]
const P = require("../src/proyecto");
const M = require("../src/medios");
const p = P.cargar(), ctx = +(process.argv.slice(2).find(a => /^\d+(\.\d+)?$/.test(a)) || 6);
const tc = s => Math.floor(s / 60) + ":" + (s % 60).toFixed(1).padStart(4, "0");
const en = (pi, t) => p.clips.filter(c => c.pista === pi && c.inicio <= t && t < c.inicio + c.duracion).pop();
const v1 = p.clips.filter(c => c.pista === "V1").sort((a, b) => a.inicio - b.inicio);
for (const k of p.comentarios.filter(k => k.estado !== "hecho").sort((a, b) => a.t - b.t)) {
  const v = en("V1", k.t), i = v1.indexOf(v), src = v && v.medio ? v.entrada + (k.t - v.inicio) : null;
  console.log(`\n## ${k.id} ${tc(k.t)} «${k.texto.replace(/\n/g, " ")}»`);
  if (v) console.log(`   V1 ${v.id} ${tc(v.inicio)}→${tc(v.inicio + v.duracion)} ${(v.medio || v.texto || "").slice(0, 28)}` + (src !== null ? ` ent ${v.entrada.toFixed(1)} fin ${(v.entrada + v.duracion).toFixed(1)} (aquí ${src.toFixed(1)})` : "") + (v.mute ? " mute" : ""));
  for (const [n, x] of [["anterior", v1[i - 1]], ["siguiente", v1[i + 1]]]) if (x) console.log(`   ${n} ${x.id} ${(x.medio || x.texto || "").slice(0, 28)} ent ${(x.entrada ?? 0).toFixed(1)} fin ${((x.entrada ?? 0) + x.duracion).toFixed(1)}`);
  for (const pi of ["V2", "V3", "N1", "A1", "A3"]) { const x = en(pi, k.t); if (x) console.log(`   ${pi} ${x.id} ${(x.medio || x.texto || "").replace(/\n/g, " ").slice(0, 70)}`); }
  if (src !== null && /mp4$/.test(v.medio)) M.transcripcion(v.medio, src - ctx, src + ctx).forEach(f => console.log(`     ${f.inicio <= src && src < f.fin ? ">>" : "  "}${f.inicio.toFixed(1)}-${f.fin.toFixed(1)}: ${f.texto.slice(0, 110)}`));
}
