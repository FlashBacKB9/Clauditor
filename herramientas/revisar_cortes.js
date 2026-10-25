// Revisa los cortes de los clips con sonido directo usando la transcripción y propone alargarlos para que
// no se pierdan explicaciones:
//   - si empiezan o terminan a media frase, hasta el principio o el final de esa frase;
//   - si empiezan justo después de que se hable (la explicación ya había empezado), hacia atrás hasta el
//     principio de esa explicación (frases seguidas sin pausa), como mucho MAX_INI segundos;
//   - si terminan y la explicación sigue sin pausa, hacia delante hasta que acabe, como mucho MAX_FIN.
// No repite material: si el clip anterior o el siguiente del mismo vídeo ya cubre ese trozo, se para ahí.
// Con --aplicar lo hace en un solo paso deshacible, desplazando lo que viene detrás para no pisar nada.
// Necesita las transcripciones del proyecto (clauditor.json → transcripciones).
// Uso: node herramientas/revisar_cortes.js --proyecto <carpeta> [--aplicar]
const { RUTAS } = require("../src/config");
const P = require("../src/proyecto");
const M = require("../src/medios");

const MAX_INI = 12, MAX_FIN = 10;       // segundos que como mucho se alarga por cada lado
const PAUSA_INI = 1.0, PAUSA_FIN = 0.6; // pausa máxima entre frases para considerarlas la misma explicación
const r2 = x => Math.round(x * 100) / 100;
const tc = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

const p = P.cargar();
const v1 = p.clips.filter(c => c.pista === "V1").sort((a, b) => a.inicio - b.inicio);
let durs = {};   // duraciones que ya ha medido el editor (si falta alguna, no se limita por el final del vídeo)
try { durs = JSON.parse(require("fs").readFileSync(require("path").join(RUTAS.cache, "duraciones.json"), "utf8")); } catch {}
const cambios = [];
for (const [i, c] of v1.entries()) {
  if (!c.medio || !/\.mp4$/i.test(c.medio) || c.mute) continue;
  const g = durs[c.medio], durMedio = (g && typeof g === "object" ? g.d : g) || Infinity;
  const ini = c.entrada, fin = c.entrada + c.duracion;
  const frases = M.transcripcion(c.medio, ini - MAX_INI - 10, fin + MAX_FIN + 10).sort((a, b) => a.inicio - b.inicio);
  const motivos = [];

  // ----- principio -----
  let nIni = ini;
  const partida = frases.find(f => f.inicio < ini - 0.3 && f.fin > ini + 0.3);
  if (partida && ini - partida.inicio <= MAX_INI) { nIni = partida.inicio; motivos.push(`empezaba a media frase: «${partida.texto.slice(0, 70)}»`); }
  const hablabaAntes = frases.some(f => f.fin <= nIni + 0.3 && f.fin >= nIni - PAUSA_INI);
  if (hablabaAntes) {
    let cur = nIni, primera = null;
    for (;;) {
      const prev = frases.filter(f => f.fin <= cur + 0.3 && f.fin >= cur - PAUSA_INI && f.inicio < cur - 0.1).pop();
      if (!prev || ini - prev.inicio > MAX_INI) break;
      cur = prev.inicio; primera = prev;
    }
    if (primera) { nIni = cur; motivos.push(`la explicación empezaba antes: «${primera.texto.slice(0, 70)}»`); }
  }
  // no repetir lo que ya enseña el clip anterior del mismo vídeo
  const ant = v1[i - 1];
  if (ant && ant.medio === c.medio && ant.entrada < ini) nIni = Math.max(nIni, ant.entrada + ant.duracion);
  nIni = Math.max(0, nIni < ini ? nIni - 0.2 : nIni);

  // ----- final -----
  let nFin = fin;
  const cortada = frases.find(f => f.inicio < fin - 0.3 && f.fin > fin + 0.15);
  if (cortada && cortada.fin - fin <= MAX_FIN) { nFin = cortada.fin; motivos.push(`cortaba a media frase: «${cortada.texto.slice(0, 70)}»`); }
  let cur = nFin, ultima = null;
  for (;;) {
    const sig = frases.find(f => f.inicio >= cur - 0.3 && f.inicio <= cur + PAUSA_FIN && f.fin > cur + 0.1);
    if (!sig || sig.fin - fin > MAX_FIN) break;
    cur = sig.fin; ultima = sig;
  }
  if (ultima) { nFin = cur; motivos.push(`la explicación seguía: «${ultima.texto.slice(0, 70)}»`); }
  const sigC = v1[i + 1];
  if (sigC && sigC.medio === c.medio && sigC.entrada > ini) nFin = Math.min(nFin, sigC.entrada);
  nFin = Math.min(durMedio, nFin > fin ? nFin + 0.25 : nFin);

  const mas = r2((ini - nIni) + (nFin - fin));
  if (mas > 0.15) cambios.push({ c, nIni: r2(nIni), nFin: r2(nFin), mas, menosIni: r2(ini - nIni), masFin: r2(nFin - fin), motivos });
}

for (const x of cambios)
  console.log(`${x.c.id} en ${tc(x.c.inicio)}  +${x.mas}s (antes ${x.menosIni}s, después ${x.masFin}s)\n   ${x.motivos.join("\n   ")}`);
const totalMas = cambios.reduce((a, x) => a + x.mas, 0);
console.log(`\n${cambios.length} clips, +${r2(totalMas)} s en total`);

if (process.argv.includes("--aplicar") && cambios.length) {
  // De atrás adelante, para que cada desplazamiento no mueva los puntos que quedan por tratar
  const ops = [];
  for (const x of cambios.sort((a, b) => b.c.inicio - a.c.inicio)) {
    ops.push({ op: "desplazar", desde: r2(x.c.inicio + x.c.duracion - 0.001), delta: x.mas });
    ops.push({ op: "modificar_clips", ids: [x.c.id], cambios: { entrada: x.nIni, duracion: r2(x.nFin - x.nIni) } });
  }
  const r = P.aplicar(ops, "claude", `Explicaciones completas: ${cambios.length} clips alargados (+${Math.round(totalMas)} s)`);
  console.log("Aplicado, rev " + r.rev);
}
