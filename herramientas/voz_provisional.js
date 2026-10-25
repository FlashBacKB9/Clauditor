// Locución provisional: lee con la voz de Windows cada texto «VOZ: …» de la pista de guion y lo coloca en A1,
// al principio de su plano. Sirve para juzgar tiempos; se sustituye por la voz grabada cuando la haya.
// Solo Windows (voz del sistema, voz_tts.ps1).
// Uso: node herramientas/voz_provisional.js --proyecto <carpeta> [voz]   (con el editor abierto: los cambios llegan por su API y se pueden deshacer)
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { RUTAS } = require("../src/config");
const P = require("../src/proyecto");
const M = require("../src/medios");

const DIR = RUTAS.audio;
fs.mkdirSync(DIR, { recursive: true });
const p = P.cargar();
const voces = p.clips.filter(c => c.pista === "N1" && /^VOZ:/.test(c.texto || ""));

// Los huecos del guion van entre corchetes: se leen sin corchetes y «19xx» se dice como año sin concretar
const limpiar = s => s.replace(/^VOZ:\s*/, "").replace(/[\[\]]/g, "").replace(/19xx/g, "mil novecientos y pico").replace(/…/g, "...");
const lista = voces.map(c => ({ archivo: path.join(DIR, `voz_${c.id}.wav`), texto: limpiar(c.texto) }));
const fichLista = path.join(DIR, "voz_lista.json");
fs.writeFileSync(fichLista, JSON.stringify(lista));
execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "voz_tts.ps1"), "-Lista", fichLista, "-Voz", process.argv.slice(2).filter((a, i, l) => a !== "--proyecto" && l[i - 1] !== "--proyecto")[0] || "Pablo"], { stdio: "inherit" });
fs.unlinkSync(fichLista);

(async () => {
  const ops = [], informe = [];
  // Quitar la locución provisional anterior, si la hay, recordando cuánto la habías movido respecto a su texto
  const viejos = p.clips.filter(c => c.pista === "A1" && /^voz_c\d+\.wav$/.test(c.medio || ""));
  const desfase = {};
  for (const v of viejos) { const n = voces.find(c => `voz_${c.id}.wav` === v.medio); if (n) desfase[n.id] = v.inicio - n.inicio; }
  if (viejos.length) ops.push({ op: "borrar_clips", ids: viejos.map(c => c.id) });
  for (const c of voces) {
    const medio = `voz_${c.id}.wav`;
    const dur = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(DIR, medio)]).toString());
    const off = desfase[c.id] ?? 0.3;
    ops.push({ op: "anadir_clip", pista: "A1", medio, inicio: Math.round((c.inicio + off) * 1000) / 1000, entrada: 0, duracion: Math.round(dur * 1000) / 1000, nota: "Voz provisional (Windows) de " + c.id });
    const sobra = c.duracion - off - dur;
    informe.push(`${c.id}  ${P.r3(c.inicio)}s  plano ${c.duracion}s  voz ${dur.toFixed(1)}s  ${sobra < 0 ? "SE PASA " + (-sobra).toFixed(1) + "s" : "sobran " + sobra.toFixed(1) + "s"}`);
  }
  const r = await fetch("http://localhost:4310/api/ops", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ops, origen: "claude", motivo: `Voz provisional en A1 (${voces.length} locuciones)` }) }).then(r => r.json());
  console.log(r.error ? "ERROR " + r.error : `rev ${r.rev}`);
  console.log(informe.join("\n"));
})();
