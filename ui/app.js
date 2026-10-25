// Clauditor: visor por capas sin render + línea de tiempo. Todo cambio pasa por el servidor
// (/api/ops), que lo guarda en proyecto.json; el servidor nos devuelve el proyecto por SSE, venga el cambio
// de aquí o de Claude por MCP.
const $ = s => document.querySelector(s);
const FPS = 30;
const ALTO = { video: 52, notas: 40, audio: 40 };
const enc = encodeURIComponent;

let P = null;                 // proyecto
let medios = {};              // clave -> { tipo, dur, listo }
let sel = new Set();          // ids de clips seleccionados
let t = 0, reproduciendo = false, relojPerf = 0, relojT = 0;
let pps = +localStorage.pps || 12;   // píxeles por segundo en la línea de tiempo
let comentarioActivo = null;
let ultimoAviso = 0, ultimaOrden = 0;
const actividad = [];

// ---------- utilidades ----------
async function api(ruta, cuerpo) {
  const r = await fetch(ruta, cuerpo === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) });
  const j = await r.json();
  if (j.error) { avisar("Error: " + j.error); throw new Error(j.error); }
  return j;
}
const ops = (lista, motivo) => api("/api/ops", { ops: lista, motivo });
const finC = c => c.inicio + c.duracion;
const total = () => P ? P.clips.reduce((m, c) => Math.max(m, finC(c)), 0) : 0;
const pista = id => P.pistas.find(p => p.id === id);
const clipPorId = id => P.clips.find(c => c.id === id);
function tc(s, conFrames = true) {
  s = Math.max(0, s);
  const f = Math.floor((s % 1) * FPS + 1e-6), seg = Math.floor(s) % 60, min = Math.floor(s / 60) % 60, h = Math.floor(s / 3600);
  const dd = n => String(n).padStart(2, "0");
  return (h ? h + ":" : "") + dd(min) + ":" + dd(seg) + (conFrames ? ":" + dd(f) : "");
}
function nombreCorto(m) {
  if (!m) return "";
  const x = m.match(/^(VID|IMG)_\d{4}(\d\d)(\d\d)_(\d\d)(\d\d)(\d\d)/);
  if (x) return `${x[1] === "IMG" ? "📷 " : ""}${x[3]}/${x[2]} ${x[4]}:${x[5]}:${x[6]}`;
  return m.replace(/\.[^.]+$/, "");
}
function tipoMedio(m) {
  if (medios[m]) return medios[m].tipo;
  if (/\.jpe?g$/i.test(m)) return "foto";
  if (/\.(mov|webm)$/i.test(m)) return "animacion";
  if (/\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(m)) return "audio";
  return "video";
}
const tipoClip = c => c.medio ? tipoMedio(c.medio) : "texto";
function etiquetaClip(c) {
  if (!c.medio) return c.texto || "";
  return nombreCorto(c.medio) + (c.entrada !== undefined && tipoClip(c) !== "foto" ? ` · ${c.entrada.toFixed(1)}s` : "");
}
const compatible = (tipoPista, c) => tipoPista === "notas" ? !c.medio : tipoPista === "audio" ? tipoClip(c) === "audio" : tipoClip(c) !== "audio";
function avisar(texto) {
  const a = $("#aviso");
  a.textContent = texto;
  a.classList.add("ver");
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => a.classList.remove("ver"), 4500);
}
function registrar(origen, texto) {
  actividad.unshift({ origen, texto, cuando: new Date() });
  actividad.length = Math.min(actividad.length, 200);
  $("#listaActividad").innerHTML = actividad.map(a =>
    `<div class="act"><span class="quien ${a.origen === "claude" ? "claude" : ""}">${a.origen === "claude" ? "Claude" : "Tú"}</span>${esc(a.texto)} <span class="tenue">${a.cuando.toLocaleTimeString()}</span></div>`).join("");
}
const esc = s => String(s ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

// ---------- visor por capas ----------
let capas = {}, firmaCapas = "";
function crearVideo(audio) {
  const v = document.createElement(audio ? "audio" : "video");
  v.preload = "auto";
  v.playsInline = true;
  v.addEventListener("error", () => {
    if (!v.dataset.medio) return;
    v.dataset.error = "1";
    clearTimeout(v._reintento);
    v._reintento = setTimeout(() => recargar(v), 5000); // el servidor responde 503 mientras genera el proxy
  });
  v.addEventListener("loadeddata", () => { v.dataset.error = ""; });
  return v;
}
function recargar(v) {
  if (!v.dataset.medio) return;
  const m = v.dataset.medio;
  v.dataset.medio = "";
  cargar(v, m, v._desde || 0);
}
const urlMedio = m => "/medio/" + enc(m) + "?v=" + (medios[m]?.v || 0);
function cargar(el, medio, desde) {
  if (el.dataset.medio === medio && el.dataset.url === urlMedio(medio)) return;
  el.dataset.medio = medio;
  el.dataset.url = urlMedio(medio);
  el.dataset.error = "";
  el._desde = desde;
  el.src = el.dataset.url + "#t=" + (desde || 0).toFixed(3);
}
function construirCapas() {
  const firma = P.pistas.map(p => p.id + p.tipo).join();
  if (firma === firmaCapas) return;
  firmaCapas = firma;
  for (const L of Object.values(capas)) L.v.forEach(v => { v.pause(); v.removeAttribute("src"); v.load(); });
  $("#capas").innerHTML = "";
  capas = {};
  P.pistas.filter(p => p.tipo === "video").reverse().forEach((p, i) => {
    const div = document.createElement("div");
    div.className = "capa";
    div.style.zIndex = i + 1;
    const v = [crearVideo(), crearVideo()];
    const img = new Image();
    const rot = document.createElement("div");
    rot.className = "rotulo";
    const cartel = document.createElement("div");
    cartel.className = "cartel";
    cartel.innerHTML = `<div class="ref"></div><div class="txt"></div>`;
    div.append(v[0], v[1], img, rot, cartel);
    $("#capas").append(div);
    capas[p.id] = { v, img, rot, cartel };
  });
  for (const p of P.pistas.filter(p => p.tipo === "audio")) capas[p.id] = { v: [crearVideo(true), crearVideo(true)], audio: true };
}
function clipEn(pid, s) {
  let r = null;
  for (const c of P.clips) if (c.pista === pid && c.inicio <= s + 1e-6 && s < finC(c) - 1e-6) r = c;
  return r;
}
function elegir(vs, medio) {
  const e = vs.find(v => v.dataset.medio === medio) || vs.find(v => v.dataset.uso !== "actual") || vs[0];
  vs.forEach(v => v.dataset.uso = v === e ? "actual" : "libre");
  return e;
}
// Efectos por Web Audio. El grafo de un elemento se crea la primera vez que lo necesita:
//   seco ─────────────────────────────→ salida
//   realce: compresor (frena golpes) → ganancia (sube lo bajo) → salida
//   eco: envío a un retardo con realimentación, que sigue sonando un poco tras acabar el clip
let ctxAudio = null, busEco = null;
function grafoAudio(el) {
  if (el._g) return el._g;
  if (!ctxAudio) {
    ctxAudio = new AudioContext();
    const retardo = ctxAudio.createDelay(2), realim = ctxAudio.createGain(), filtro = ctxAudio.createBiquadFilter(), salida = ctxAudio.createGain();
    retardo.delayTime.value = 0.34;
    realim.gain.value = 0.5;
    filtro.type = "lowpass"; filtro.frequency.value = 2600;
    salida.gain.value = 0.75;
    retardo.connect(filtro).connect(realim).connect(retardo);
    filtro.connect(salida).connect(ctxAudio.destination);
    busEco = retardo;
  }
  const fuente = ctxAudio.createMediaElementSource(el);
  const seco = ctxAudio.createGain(), comp = ctxAudio.createDynamicsCompressor(), subida = ctxAudio.createGain(), eco = ctxAudio.createGain();
  comp.threshold.value = -24; comp.knee.value = 6; comp.ratio.value = 20; comp.attack.value = 0.002; comp.release.value = 0.2;
  subida.gain.value = 0; eco.gain.value = 0;
  fuente.connect(seco).connect(ctxAudio.destination);
  fuente.connect(comp).connect(subida).connect(ctxAudio.destination);
  fuente.connect(eco).connect(busEco);
  el._g = { seco, subida, eco };
  return el._g;
}
function sincronizar(el, objetivo, c, p) {
  if (c.eco || c.realce || el._g) {
    const g = grafoAudio(el);
    g.eco.gain.value = c.eco ? 1 : 0;
    g.seco.gain.value = c.realce ? 0 : 1;
    g.subida.gain.value = c.realce ? 6 : 0;   // +15 dB a lo que queda por debajo del umbral
    if (ctxAudio.state === "suspended" && reproduciendo) ctxAudio.resume();
  }
  const vol = (p.mute || c.mute) ? 0 : (c.volumen ?? 1);
  el.muted = vol === 0;
  el.volume = Math.max(0, Math.min(1, vol));
  if (el.readyState < 1) return;
  const ahora = performance.now();
  if (reproduciendo) {
    if (Math.abs(el.currentTime - objetivo) > 0.3 && !el.seeking && ahora - (el._salto || 0) > 800) { el.currentTime = objetivo; el._salto = ahora; }
    if (el.paused) el.play().catch(() => {});
  } else {
    if (!el.paused) el.pause();
    if (Math.abs(el.currentTime - objetivo) > 0.017 && !el.seeking) el.currentTime = objetivo;
  }
}
function precargar(L, pid, c, actual) {
  const desde = c ? finC(c) - 0.01 : t;
  let sig = null;
  for (const x of P.clips) if (x.pista === pid && x.medio && x.inicio >= desde && x.inicio - t < 3 && ["video", "animacion", "audio"].includes(tipoClip(x)) && (!sig || x.inicio < sig.inicio)) sig = x;
  if (!sig || (actual && actual.dataset.medio === sig.medio)) return;
  const libre = L.v.find(v => v !== actual);
  if (!libre) return;
  if (libre.dataset.medio !== sig.medio) cargar(libre, sig.medio, sig.entrada);
  else if (libre.readyState >= 1 && libre.paused && !libre.seeking && Math.abs(libre.currentTime - sig.entrada) > 0.1) libre.currentTime = sig.entrada;
}
// Cartel de etiqueta de recambio: entra cayendo con un pequeño giro y sale fundiendo. Depende solo del
// tiempo dentro del clip, así se ve igual reproduciendo que moviendo el cabezal a mano.
function pintarCartel(el, c) {
  if (!c) { if (el.classList.contains("vis")) el.classList.remove("vis"); return; }
  const firma = [c.id, c.texto, c.ref, c.posicion, c.tamano].join("|");
  if (el.dataset.firma !== firma) {
    el.dataset.firma = firma;
    el.querySelector(".ref").textContent = c.ref || "";
    el.querySelector(".txt").textContent = c.texto || "";
    el.className = "cartel vis " + (c.posicion || "abajo");
    el.style.fontSize = 3.4 * (c.tamano || 1) + "cqh";
  }
  el.classList.add("vis");
  const dt = t - c.inicio, resto = finC(c) - t;
  const ent = Math.min(1, dt / 0.5), sal = Math.min(1, resto / 0.35);
  const suave = 1 - Math.pow(1 - ent, 3);
  const giro = -1.2 - 5 * (1 - suave), baja = (1 - suave) * -6;
  const base = c.posicion === "centro" ? "translate(-50%,-50%) " : "";
  el.style.transform = `${base}translateY(${baja}cqh) rotate(${giro}deg)`;
  el.style.opacity = Math.min(suave * 1.4, sal, 1);
}
function pintarVisor() {
  for (const p of P.pistas) {
    const L = capas[p.id];
    if (!L) continue;
    const c = p.oculta ? null : clipEn(p.id, t);
    let mostrar = null;
    if (L.audio) {
      if (c && c.medio) { mostrar = elegir(L.v, c.medio); cargar(mostrar, c.medio, c.entrada); sincronizar(mostrar, (c.entrada || 0) + (t - c.inicio), c, p); }
    } else {
      let clase = "rotulo";
      const pendiente = c && !c.medio && /^GRÁFICO/.test(c.texto || "");
      pintarCartel(L.cartel, c && !c.medio && c.estilo === "etiqueta" ? c : null);
      if (c && c.estilo === "etiqueta") {
        // lo pinta pintarCartel
      } else if (pendiente && !$("#chkGraficos").checked) {
        // gráfico por hacer oculto
      } else if (pendiente) {
        L.rot.textContent = c.texto.replace(/^GRÁFICO (NUEVO|HECHO) · /, "");
        L.rot.title = c.texto;
        clase += " vis pendiente";
      } else if (c && !c.medio && /^POR SUBIR/.test(c.texto || "")) {
        L.rot.textContent = c.texto.replace(/^POR SUBIR · /, "");
        clase += " vis porsubir";
      } else if (c && !c.medio) {
        L.rot.textContent = c.texto;
        clase += " vis" + (c.posicion === "abajo" ? " abajo" : "");
      } else if (c && tipoClip(c) === "foto") {
        if (L.img.dataset.url !== urlMedio(c.medio)) { L.img.dataset.medio = c.medio; L.img.dataset.url = urlMedio(c.medio); L.img.src = L.img.dataset.url; }
        const z = 1 + ((c.zoom || 1) - 1) * ((t - c.inicio) / c.duracion);
        L.img.style.transform = `scale(${z})`;
        mostrar = L.img;
      } else if (c) {
        mostrar = elegir(L.v, c.medio);
        cargar(mostrar, c.medio, c.entrada);
        sincronizar(mostrar, (c.entrada || 0) + (t - c.inicio), c, p);
        const tr = c.desplaza_x ? `translateX(${c.desplaza_x * 100}%)` : "";
        if (mostrar.style.transform !== tr) mostrar.style.transform = tr;
        if (mostrar.dataset.error) { L.rot.textContent = "Preparando el proxy de " + nombreCorto(c.medio) + "…"; clase += " vis cargando"; }
      }
      if (L.rot.className !== clase) L.rot.className = clase;
      for (const el of [...L.v, L.img]) el.classList.toggle("vis", el === mostrar && !(c && c.oculto));
    }
    for (const v of L.v) if (v !== mostrar && !v.paused) v.pause();
    if (!p.oculta && L.v) precargar(L, p.id, c, mostrar && mostrar.tagName !== "IMG" ? mostrar : null);
  }
  // Voz en off del guion como subtítulo y nota del plano debajo del visor
  let sub = "";
  if ($("#chkSubs").checked) for (const p of P.pistas.filter(p => p.tipo === "notas")) {
    const c = clipEn(p.id, t);
    if (c && c.texto && /^VOZ:/.test(c.texto)) sub = c.texto.replace(/^VOZ:\s*/, "");
  }
  if ($("#subtitulo").textContent !== sub) $("#subtitulo").textContent = sub;
  const base = clipEn("V1", t);
  const info = base ? `${base.id} · ${etiquetaClip(base)}${base.nota ? " — " + base.nota.replace(/\n/g, " · ") : ""}` : "";
  if ($("#infoPlano").textContent !== info) { $("#infoPlano").textContent = info; $("#infoPlano").title = base?.nota || ""; }
}

// ---------- reproducción ----------
function irA(s, centrar) {
  t = Math.max(0, Math.min(s, total()));
  if (reproduciendo) { relojT = t; relojPerf = performance.now(); }
  if (centrar) centrarEn(t);
  guardarCabezal();
}
function play() {
  if (reproduciendo) return parar();
  if (t >= total() - 0.05) t = 0;
  reproduciendo = true; relojT = t; relojPerf = performance.now();
  if (ctxAudio && ctxAudio.state === "suspended") ctxAudio.resume();
  $("#bPlay").textContent = "⏸";
}
function parar() {
  reproduciendo = false;
  $("#bPlay").textContent = "▶";
  for (const L of Object.values(capas)) L.v.forEach(v => v.pause());
  t = Math.round(t * FPS) / FPS;
  guardarCabezal();
}
let tGuardar;
function guardarCabezal() {
  clearTimeout(tGuardar);
  if (!reproduciendo) tGuardar = setTimeout(() => api("/api/estado", { cabezal: Math.round(t * 1000) / 1000 }).catch(() => {}), 400);
}
let ultimoTc = "";
function bucle() {
  if (P) {
    if (reproduciendo) {
      t = relojT + (performance.now() - relojPerf) / 1000;
      if (t >= total()) { t = total(); parar(); }
    }
    pintarVisor();
    const x = t * pps;
    $("#cabezal").style.left = x + "px";
    const s = tc(t);
    if (s !== ultimoTc) { $("#tc").textContent = s; ultimoTc = s; }
    if (reproduciendo) {
      const sc = $("#scrollLinea");
      if (x > sc.scrollLeft + sc.clientWidth - 40 || x < sc.scrollLeft) sc.scrollLeft = x - 60;
    }
  }
  requestAnimationFrame(bucle);
}
function centrarEn(s) {
  const sc = $("#scrollLinea"), x = s * pps;
  if (x < sc.scrollLeft + 20 || x > sc.scrollLeft + sc.clientWidth - 20) sc.scrollLeft = x - sc.clientWidth / 3;
}

// ---------- línea de tiempo ----------
function dibujarLinea() {
  const ancho = (total() + 90) * pps;
  $("#lienzo").style.width = ancho + "px";
  // Regla
  const pasos = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const paso = pasos.find(p => p * pps >= 70) || 600;
  const menor = paso / 5;
  let h = "";
  for (let s = 0; s * pps < ancho; s += menor) {
    const mayor = Math.abs(s / paso - Math.round(s / paso)) < 1e-6;
    h += `<div class="marca ${mayor ? "" : "menor"}" style="left:${s * pps}px">${mayor ? tc(s, false) : ""}</div>`;
  }
  for (const m of P.marcadores) h += `<div class="escena" style="left:${m.t * pps}px;background:var(--${m.color || "azul"})" title="${esc(m.texto)}">${esc(m.texto)}</div>`;
  for (const k of P.comentarios) h += `<div class="pin ${k.estado === "hecho" ? "hecho" : ""}" data-k="${k.id}" style="left:${k.t * pps}px" title="${esc(k.texto)}"></div>`;
  $("#regla").innerHTML = h;
  // Cabezas y pistas
  const comentados = new Set(P.comentarios.filter(k => k.estado !== "hecho" && k.clip).map(k => k.clip));
  let cab = `<div class="regla-hueco"></div>`, pis = "";
  for (const p of P.pistas) {
    const alto = ALTO[p.tipo];
    cab += `<div class="cabeza" style="height:${alto}px"><span class="id">${p.id}</span><span class="n" title="${esc(p.nombre)}">${esc(p.nombre)}</span>` +
      (p.tipo !== "notas" ? `<button data-pista="${p.id}" data-acc="mute" class="${p.mute ? "off" : ""}" title="Silenciar pista">🔊</button>` : "") +
      (p.tipo === "video" ? `<button data-pista="${p.id}" data-acc="oculta" class="${p.oculta ? "off" : ""}" title="Ocultar pista">👁</button>` : "") + `</div>`;
    pis += `<div class="pista ${p.tipo}" data-pista="${p.id}" style="height:${alto}px">`;
    for (const c of P.clips.filter(c => c.pista === p.id)) {
      const tipo = tipoClip(c), w = c.duracion * pps;
      const clases = ["clip", tipo === "texto" ? (c.estilo === "etiqueta" ? "etiqueta" : c.color || "rosa") : tipo, sel.has(c.id) ? "sel" : "", c.opcional ? "opcional" : "", c.oculto ? "oculto-img" : "", comentados.has(c.id) ? "comentado" : ""].join(" ");
      const mini = ["video", "foto", "animacion"].includes(tipo) && w > 30 && p.tipo === "video"
        ? `<img loading="lazy" src="/miniatura/${enc(c.medio)}?t=${((c.entrada || 0) + 0.1).toFixed(1)}&w=160" alt="">` : "";
      const iconos = (c.mute ? "🔇 " : "") + (c.oculto ? "◌ " : "") + (c.volumen !== undefined && c.volumen !== 1 ? `vol ${Math.round(c.volumen * 100)}% ` : "");
      pis += `<div class="${clases}" data-id="${c.id}" style="left:${c.inicio * pps}px;width:${Math.max(w, 2)}px" title="${esc(c.id + " · " + etiquetaClip(c) + "\n" + (c.nota || ""))}">` +
        `${mini}<div class="et">${esc(etiquetaClip(c))}</div><div class="et2">${iconos}${c.duracion.toFixed(1)} s · ${c.id}</div>` +
        `<div class="asa i"></div><div class="asa d"></div></div>`;
    }
    pis += `</div>`;
  }
  $("#cabezasPistas").innerHTML = cab;
  $("#pistas").innerHTML = pis;
  $("#tcTotal").textContent = "/ " + tc(total());
}
function pintarSeleccion() {
  document.querySelectorAll(".clip").forEach(d => d.classList.toggle("sel", sel.has(d.dataset.id)));
}
function seleccionar(ids, avisarServidor = true) {
  sel = new Set(ids);
  pintarSeleccion();
  pintarInspector(true);
  pintarDonde();
  if (avisarServidor) api("/api/estado", { seleccion: [...sel] }).catch(() => {});
}
function zoom(nuevo, anclaX) {
  const sc = $("#scrollLinea");
  const ax = anclaX ?? sc.clientWidth / 2;
  const s = (sc.scrollLeft + ax) / pps;
  pps = Math.max(0.3, Math.min(300, nuevo));
  localStorage.pps = pps;
  dibujarLinea();
  sc.scrollLeft = s * pps - ax;
}

// Arrastres en la línea de tiempo: mover clips, recortar bordes, mover el cabezal
function puntosImán(excluir) {
  const ps = [t, 0];
  for (const c of P.clips) if (!excluir.has(c.id)) ps.push(c.inicio, finC(c));
  for (const k of P.comentarios) ps.push(k.t);
  return ps;
}
function imantar(bordes, delta, puntos, sinImán) {
  if (sinImán) return { delta };
  const lim = 8 / pps;
  let mejor = null, donde = null;
  for (const b of bordes) for (const q of puntos) {
    const d = q - (b + delta);
    if (Math.abs(d) < lim && (mejor === null || Math.abs(d) < Math.abs(mejor))) { mejor = d; donde = q; }
  }
  return mejor === null ? { delta } : { delta: delta + mejor, donde };
}
function guia(s) {
  let g = $("#guiaSnap");
  if (s === undefined || s === null) { if (g) g.remove(); return; }
  if (!g) { g = document.createElement("div"); g.id = "guiaSnap"; $("#lienzo").append(g); }
  g.style.left = s * pps + "px";
}
function tiempoDeEvento(e) {
  const r = $("#lienzo").getBoundingClientRect();
  return (e.clientX - r.left) / pps;
}

$("#pistas").addEventListener("mousedown", e => {
  if (e.button !== 0) return;
  const div = e.target.closest(".clip");
  if (!div) {
    seleccionar([]);
    irA(tiempoDeEvento(e));
    return arrastrarCabezal(e);
  }
  const id = div.dataset.id, c = clipPorId(id);
  const asa = e.target.classList.contains("asa") ? (e.target.classList.contains("i") ? "inicio" : "fin") : null;
  // Doble clic: editor del clip. Va aquí y no en «dblclick» porque el primer clic repinta la línea de tiempo
  // y el navegador ya no ve los dos clics sobre el mismo elemento
  if (e.detail === 2 && !asa && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); seleccionar([id]); return abrirEditorClip(id); }
  // Mayús/Ctrl sobre el clip suma o quita de la selección; Mayús sobre un borde es el recorte en cadena
  const multiple = (e.shiftKey || e.ctrlKey) && !asa;
  if (multiple) { const s = new Set(sel); s.has(id) ? s.delete(id) : s.add(id); seleccionar([...s]); }
  else if (!sel.has(id) || asa) seleccionar([id]);
  if (multiple) return;
  e.preventDefault();
  const x0 = e.clientX;
  const moviendo = asa ? [c] : [...sel].map(clipPorId).filter(Boolean);
  const excl = new Set(moviendo.map(m => m.id));
  const puntos = puntosImán(excl);
  const orig = new Map(moviendo.map(m => [m.id, { ...m }]));
  let delta = 0, empezado = false, pistaDestino = null;
  const durMedio = c.medio ? medios[c.medio]?.dur : null;

  const mover = ev => {
    const dx = ev.clientX - x0;
    if (!empezado && Math.abs(dx) < 3 && !asa) {
      if (Math.abs(ev.clientY - e.clientY) < 3) return;
    }
    empezado = true;
    let d = dx / pps;
    if (asa === "inicio") {
      const o = orig.get(c.id);
      d = Math.min(d, o.duracion - 1 / FPS);
      d = Math.max(d, -o.inicio, o.entrada !== undefined && tipoClip(c) !== "foto" ? -o.entrada : -Infinity);
      const r = imantar([o.inicio], d, puntos, ev.altKey);
      d = Math.min(Math.max(r.delta, -o.inicio), o.duracion - 1 / FPS);
      guia(r.donde);
      const el = document.querySelector(`.clip[data-id="${c.id}"]`);
      el.style.left = (o.inicio + d) * pps + "px"; el.style.width = (o.duracion - d) * pps + "px";
    } else if (asa === "fin") {
      const o = orig.get(c.id);
      const r = imantar([finC(o)], d, puntos, ev.altKey);
      d = Math.max(r.delta, -o.duracion + 1 / FPS);
      if (durMedio && o.entrada !== undefined && tipoClip(c) !== "foto") d = Math.min(d, durMedio - o.entrada - o.duracion);
      guia(r.donde);
      document.querySelector(`.clip[data-id="${c.id}"]`).style.width = (o.duracion + d) * pps + "px";
    } else {
      const minIni = Math.min(...moviendo.map(m => orig.get(m.id).inicio));
      d = Math.max(d, -minIni);
      const bordes = moviendo.flatMap(m => [orig.get(m.id).inicio, finC(orig.get(m.id))]);
      const r = imantar(bordes, d, puntos, ev.altKey);
      d = Math.max(r.delta, -minIni);
      guia(r.donde);
      for (const m of moviendo) document.querySelector(`.clip[data-id="${m.id}"]`).style.left = (orig.get(m.id).inicio + d) * pps + "px";
      // Cambiar de pista (solo si se mueve un clip y la pista admite ese tipo)
      if (moviendo.length === 1) {
        const bajo = document.elementsFromPoint(ev.clientX, ev.clientY).find(n => n.classList?.contains("pista"));
        document.querySelectorAll(".pista.sobre").forEach(n => n.classList.remove("sobre"));
        pistaDestino = null;
        if (bajo && bajo.dataset.pista !== c.pista && compatible(pista(bajo.dataset.pista).tipo, c)) {
          pistaDestino = bajo.dataset.pista;
          bajo.classList.add("sobre");
          bajo.append(document.querySelector(`.clip[data-id="${c.id}"]`));
        }
      }
    }
    delta = d;
  };
  const soltar = ev => {
    window.removeEventListener("mousemove", mover);
    window.removeEventListener("mouseup", soltar);
    guia(null);
    document.querySelectorAll(".pista.sobre").forEach(n => n.classList.remove("sobre"));
    if (!empezado || (Math.abs(delta) < 1e-4 && !pistaDestino)) { dibujarLinea(); return; }
    const r = Math.round(delta * FPS) / FPS;
    // Con Mayús, recorte «en cadena»: el clip conserva su inicio y todo lo que va detrás se mueve lo mismo
    if (asa && ev.shiftKey) {
      const o = orig.get(c.id), finViejo = o.inicio + o.duracion, cambio = asa === "fin" ? r : -r;
      const lista = [{ op: "desplazar", desde: Math.round((finViejo - 0.001) * 1000) / 1000, delta: cambio }];
      if (asa === "fin") lista.push({ op: "recortar", id: c.id, lado: "fin", delta: r });
      else lista.push({ op: "recortar", id: c.id, lado: "inicio", delta: r }, { op: "mover_clips", ids: [c.id], delta: -r });
      ops(lista, `recortado ${c.id} en cadena (${cambio >= 0 ? "+" : ""}${cambio.toFixed(2)} s)`);
      return;
    }
    if (asa) ops([{ op: "recortar", id: c.id, lado: asa, delta: r }]);
    else ops([{ op: "mover_clips", ids: moviendo.map(m => m.id), delta: r, ...(pistaDestino ? { pista: pistaDestino } : {}) }]);
  };
  window.addEventListener("mousemove", mover);
  window.addEventListener("mouseup", soltar);
});
function arrastrarCabezal() {
  const mover = ev => irA(tiempoDeEvento(ev));
  const soltar = () => { window.removeEventListener("mousemove", mover); window.removeEventListener("mouseup", soltar); };
  window.addEventListener("mousemove", mover);
  window.addEventListener("mouseup", soltar);
}
$("#regla").addEventListener("mousedown", e => {
  const pin = e.target.closest(".pin");
  if (pin) { const k = P.comentarios.find(x => x.id === pin.dataset.k); irA(k.t); verComentario(k.id); return; }
  irA(tiempoDeEvento(e));
  arrastrarCabezal();
});
$("#scrollLinea").addEventListener("wheel", e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  zoom(pps * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX - $("#scrollLinea").getBoundingClientRect().left);
}, { passive: false });
$("#scrollLinea").addEventListener("scroll", () => { $("#cabezasPistas").scrollTop = $("#scrollLinea").scrollTop; });
$("#cabezasPistas").addEventListener("click", e => {
  const b = e.target.closest("button[data-acc]");
  if (!b) return;
  const p = pista(b.dataset.pista);
  ops([{ op: "modificar_pista", id: p.id, [b.dataset.acc]: !p[b.dataset.acc] }]);
});

// Soltar un medio desde la lista sobre una pista
$("#pistas").addEventListener("dragover", e => {
  const pi = e.target.closest(".pista");
  if (pi && e.dataTransfer.types.includes("text/medio")) { e.preventDefault(); document.querySelectorAll(".pista.sobre").forEach(n => n.classList.remove("sobre")); pi.classList.add("sobre"); }
});
$("#pistas").addEventListener("dragleave", e => e.target.closest?.(".pista")?.classList.remove("sobre"));
$("#pistas").addEventListener("drop", e => {
  const pi = e.target.closest(".pista");
  document.querySelectorAll(".pista.sobre").forEach(n => n.classList.remove("sobre"));
  const medio = e.dataTransfer.getData("text/medio");
  if (!pi || !medio) return;
  e.preventDefault();
  anadirMedio(medio, pi.dataset.pista, Math.round(tiempoDeEvento(e) * FPS) / FPS);
});
function anadirMedio(medio, pid, inicio) {
  const tipo = tipoMedio(medio);
  const tp = pista(pid)?.tipo;
  if (!compatible(tp, { medio })) return avisar(tipo === "audio" ? "El audio va en una pista de audio" : "Ese medio va en una pista de vídeo");
  const dur = medios[medio]?.dur;
  ops([{ op: "anadir_clip", pista: pid, medio, inicio, entrada: 0, duracion: tipo === "foto" ? 4 : Math.min(dur || 6, tipo === "audio" ? dur || 30 : 6), ...(tipo === "foto" ? { zoom: 1.08 } : {}) }]);
}

// ---------- editor de un clip (modal) ----------
// Doble clic en un clip: se ve su medio original con el corte marcado y se cambian entrada y salida
// (alargar o acortar por delante y por detrás, o deslizar el corte). El clip conserva su sitio en la línea
// de tiempo; con «Mover lo que va detrás» todo lo que empieza después se corre lo que cambie su duración.
const EC = { c: null, ent: 0, sal: 0, D: 0, v0: 0, v1: 1, el: null, hastaSalida: false, conMedio: false };
const redF = s => Math.round(s * FPS) / FPS;
const leerTc = s => {   // admite «12.5», «1:02.5» o «1:02:15» (min:seg:fotogramas)
  const p = String(s).trim().replace(",", ".").split(":").map(Number);
  if (p.some(isNaN)) return null;
  if (p.length === 1) return p[0];
  if (p.length === 2) return p[0] * 60 + p[1];
  return p[0] * 60 + p[1] + p[2] / FPS;
};
function abrirEditorClip(id) {
  const c = clipPorId(id);
  if (!c) return;
  if (reproduciendo) parar();
  const tipo = tipoClip(c);
  EC.c = { ...c };
  EC.conMedio = !!c.medio && tipo !== "foto" && c.entrada !== undefined;
  EC.ent = EC.conMedio ? c.entrada : 0;
  EC.sal = EC.ent + c.duracion;
  EC.D = EC.conMedio ? (medios[c.medio]?.dur || Math.max(EC.sal + 30, 60)) : Math.max(EC.sal * 3, 30);
  $("#mcTitulo").textContent = c.medio ? nombreCorto(c.medio) : (c.texto || "").split("\n")[0].slice(0, 60) || "Clip";
  $("#mcSub").textContent = `${c.id} · ${pista(c.pista)?.nombre || c.pista} · empieza en ${tc(c.inicio)}`;
  const v = $("#mcVideo"), a = $("#mcAudio");
  [v, a].forEach(x => { x.pause(); x.removeAttribute("src"); });
  $("#mcFoto").classList.add("oculto"); v.classList.add("oculto"); $("#mcTexto").classList.add("oculto");
  EC.el = null;
  if (tipo === "video" || tipo === "animacion") { EC.el = v; v.classList.remove("oculto"); }
  else if (tipo === "audio") { EC.el = a; $("#mcTexto").classList.remove("oculto"); $("#mcTexto").textContent = "Audio · " + c.medio; }
  else if (tipo === "foto") { $("#mcFoto").src = urlMedio(c.medio); $("#mcFoto").classList.remove("oculto"); }
  else { $("#mcTexto").classList.remove("oculto"); $("#mcTexto").textContent = c.texto || ""; }
  if (EC.el) {
    EC.el.src = urlMedio(c.medio) + "#t=" + EC.ent.toFixed(3);
    EC.el.volume = Math.min(1, c.volumen ?? 1);
    EC.el.onloadedmetadata = () => { if (isFinite(EC.el.duration) && EC.el.duration > 0 && !medios[c.medio]?.dur) { EC.D = EC.el.duration; encuadrar(); } };
  }
  $("#mcLadoEntrada").classList.toggle("oculto", !EC.conMedio);
  $("#mcRango .asa.i").classList.toggle("oculto", !EC.conMedio);   // sin medio solo se cambia el largo
  $("#mcVerCorte").classList.toggle("oculto", !EC.el);
  $("#mcPlay").classList.toggle("oculto", !EC.el);
  $("#mcCadena").checked = localStorage.mcCadena !== "0";
  $("#modalClip").classList.remove("oculto");
  encuadrar();
  irEC(EC.ent);
}
function cerrarEditorClip() {
  if (!EC.c) return;
  [$("#mcVideo"), $("#mcAudio")].forEach(x => { x.pause(); x.removeAttribute("src"); x.load(); });
  $("#modalClip").classList.add("oculto");
  EC.c = null;
}
const tEC = () => EC.el ? EC.el.currentTime : EC._t || 0;
function irEC(s) {
  s = Math.max(0, Math.min(EC.D, s));
  if (EC.el) EC.el.currentTime = s; else EC._t = s;
  pintarEC();
}
// Ventana visible de la tira: el corte con margen a los lados (se recalcula al soltar, no mientras se arrastra)
function encuadrar(factor = 1) {
  const len = EC.sal - EC.ent, pad = Math.max(4, len * 0.6) * factor;
  EC.v0 = Math.max(0, EC.ent - pad);
  EC.v1 = Math.min(EC.D, EC.sal + pad);
  if (EC.v1 - EC.v0 < 2) EC.v1 = Math.min(EC.D, EC.v0 + 2);
  pintarTira();
}
const xEC = s => (s - EC.v0) / (EC.v1 - EC.v0) * 100 + "%";
const sDeX = clientX => { const r = $("#mcTira").getBoundingClientRect(); return EC.v0 + (clientX - r.left) / r.width * (EC.v1 - EC.v0); };
function pintarTira() {
  const c = EC.c, tipo = tipoClip(c), n = 10, paso = (EC.v1 - EC.v0) / n;
  $("#mcMinis").innerHTML = EC.conMedio && tipo !== "audio"
    ? Array.from({ length: n }, (_, i) => `<div style="background-image:url('/miniatura/${enc(c.medio)}?t=${(EC.v0 + paso * (i + 0.5)).toFixed(1)}&w=160')"></div>`).join("")
    : "";
  // escala con marcas «redondas» según el zoom
  const span = EC.v1 - EC.v0, marca = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find(m => span / m <= 12) || 600;
  let h = "";
  for (let s = Math.ceil(EC.v0 / marca) * marca; s <= EC.v1; s += marca) h += `<span style="left:${xEC(s)}">${tc(s, marca < 1)}</span>`;
  $("#mcEscala").innerHTML = h;
  $("#mcFrases").innerHTML = "";
  if (EC.conMedio && tipo === "video") {
    const pedido = `${c.medio}|${EC.v0}|${EC.v1}`;
    EC._pedido = pedido;
    fetch(`/api/transcripcion?medio=${enc(c.medio)}&desde=${EC.v0}&hasta=${EC.v1}`).then(r => r.json()).then(fr => {
      if (EC._pedido !== pedido || !Array.isArray(fr)) return;
      $("#mcFrases").innerHTML = fr.map(f => `<div style="left:${xEC(Math.max(f.inicio, EC.v0))};width:calc(${xEC(Math.min(f.fin, EC.v1))} - ${xEC(Math.max(f.inicio, EC.v0))})" title="${esc(tc(f.inicio) + "  " + f.texto)}">${esc(f.texto)}</div>`).join("");
    }).catch(() => {});
  }
  pintarEC();
}
function pintarEC() {
  if (!EC.c) return;
  const r = $("#mcRango");
  r.style.left = xEC(EC.ent);
  r.style.width = `calc(${xEC(EC.sal)} - ${xEC(EC.ent)})`;
  $("#mcCabezal").style.left = xEC(tEC());
  $("#mcTc").textContent = EC.conMedio || EC.el ? tc(tEC()) : "";
  if (document.activeElement !== $("#mcEntrada")) $("#mcEntrada").value = tc(EC.ent);
  if (document.activeElement !== $("#mcSalida")) $("#mcSalida").value = tc(EC.sal);
  const dur = EC.sal - EC.ent, cambio = dur - EC.c.duracion;
  const signo = cambio > 1e-4 ? "mas" : cambio < -1e-4 ? "menos" : "";
  $("#mcDuracion").innerHTML = `Duración ${tc(EC.c.duracion)} → ${tc(dur)}` + (signo ? ` <span class="${signo}">(${cambio > 0 ? "+" : "−"}${Math.abs(cambio).toFixed(2)} s)</span>` : "");
  const detras = P.clips.filter(x => x.id !== EC.c.id && x.inicio >= finC(EC.c) - 0.002).length;
  $("#mcEfecto").textContent = !signo ? (Math.abs(EC.ent - (EC.c.entrada || 0)) > 1e-4 ? "Mismo largo: solo cambia qué trozo se ve" : "Sin cambios")
    : $("#mcCadena").checked ? `${detras} clips de detrás se ${cambio > 0 ? "retrasan" : "adelantan"} ${Math.abs(cambio).toFixed(2)} s`
    : cambio > 0 ? "Puede pisar al clip siguiente" : "Quedará un hueco detrás";
  $("#mcPlay").textContent = EC.el && !EC.el.paused ? "❚❚" : "▶";
}
// Cambiar entrada / salida respetando el medio (0…D) y un largo mínimo de un fotograma
function fijarEC(lado, s) {
  s = redF(s);
  if (lado === "entrada") EC.ent = Math.max(0, Math.min(s, EC.sal - 1 / FPS));
  else EC.sal = Math.min(EC.D, Math.max(s, EC.ent + 1 / FPS));
  pintarEC();
}
function aplicarEditorClip() {
  const c = EC.c, dur = redF(EC.sal - EC.ent), cambio = Math.round((dur - c.duracion) * 1000) / 1000;
  const cambios = { duracion: dur };
  if (EC.conMedio) cambios.entrada = redF(EC.ent);
  const igual = Math.abs(cambio) < 1e-4 && (!EC.conMedio || Math.abs(cambios.entrada - c.entrada) < 1e-4);
  if (igual) return cerrarEditorClip();
  const lista = [];
  if ($("#mcCadena").checked && Math.abs(cambio) >= 1e-4) lista.push({ op: "desplazar", desde: Math.round((finC(c) - 0.001) * 1000) / 1000, delta: cambio });
  lista.push({ op: "modificar_clips", ids: [c.id], cambios });
  ops(lista, `nuevo corte de ${c.id}` + (Math.abs(cambio) >= 1e-4 ? ` (${cambio > 0 ? "+" : ""}${cambio.toFixed(2)} s${$("#mcCadena").checked ? ", desplazando lo de detrás" : ""})` : ""))
    .then(() => { seleccionar([c.id]); cerrarEditorClip(); }).catch(() => {});
}
function reproducirEC(soloCorte) {
  if (!EC.el) return;
  if (!EC.el.paused) { EC.el.pause(); return pintarEC(); }
  if (soloCorte || tEC() >= EC.sal - 0.02 || tEC() < EC.ent - 0.02) EC.el.currentTime = EC.ent;
  EC.hastaSalida = true;
  EC.el.play().catch(() => {});
  const paso = () => {
    if (!EC.c || EC.el.paused) return pintarEC();
    if (EC.hastaSalida && EC.el.currentTime >= EC.sal) { EC.el.pause(); EC.el.currentTime = EC.sal; return pintarEC(); }
    pintarEC();
    requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
}
$("#mcTira").addEventListener("mousedown", e => {
  if (e.button !== 0) return;
  e.preventDefault();
  const asa = e.target.classList.contains("asa") ? (e.target.classList.contains("i") ? "entrada" : "salida") : null;
  const enRango = !asa && e.target.closest("#mcRango");
  const s0 = sDeX(e.clientX), ent0 = EC.ent, sal0 = EC.sal;
  let movido = false;
  if (!asa && !enRango) irEC(s0);
  const mover = ev => {
    movido = true;
    const s = sDeX(ev.clientX);
    if (asa === "entrada" && EC.conMedio) { fijarEC("entrada", s); irEC(EC.ent); }
    else if (asa === "salida") { fijarEC("salida", s); irEC(EC.sal); }
    else if (enRango && EC.conMedio) {   // deslizar: mismo largo, otro trozo del medio
      const d = Math.max(-ent0, Math.min(EC.D - sal0, s - s0));
      EC.ent = redF(ent0 + d); EC.sal = redF(sal0 + d);
      irEC(EC.ent);
    } else irEC(s);
  };
  const soltar = () => {
    window.removeEventListener("mousemove", mover);
    window.removeEventListener("mouseup", soltar);
    if (enRango && !movido) irEC(s0);
    if (movido && (asa || enRango) && (EC.ent < EC.v0 || EC.sal > EC.v1 || EC.sal - EC.ent < (EC.v1 - EC.v0) * 0.25)) encuadrar();
  };
  window.addEventListener("mousemove", mover);
  window.addEventListener("mouseup", soltar);
});
$("#mcTira").addEventListener("wheel", e => {
  e.preventDefault();
  const s = sDeX(e.clientX), span = EC.v1 - EC.v0;
  if (e.ctrlKey) {   // zoom alrededor del ratón
    const nuevo = Math.max(1, Math.min(EC.D, span * (e.deltaY < 0 ? 0.8 : 1.25))), f = (s - EC.v0) / span;
    EC.v0 = Math.max(0, s - nuevo * f); EC.v1 = Math.min(EC.D, EC.v0 + nuevo);
  } else {           // desplazar la ventana
    const d = span * 0.15 * Math.sign(e.deltaY || e.deltaX);
    const d2 = Math.max(-EC.v0, Math.min(EC.D - EC.v1, d));
    EC.v0 += d2; EC.v1 += d2;
  }
  pintarTira();
}, { passive: false });
document.querySelectorAll("[data-mc]").forEach(b => b.addEventListener("click", () => {
  const lado = b.dataset.mc, d = b.dataset.d === "-f" ? -1 / FPS : b.dataset.d === "+f" ? 1 / FPS : +b.dataset.d;
  fijarEC(lado, (lado === "entrada" ? EC.ent : EC.sal) + d);
  irEC(lado === "entrada" ? EC.ent : EC.sal);
  if (EC.ent < EC.v0 || EC.sal > EC.v1) encuadrar();
}));
for (const [id, lado] of [["#mcEntrada", "entrada"], ["#mcSalida", "salida"]]) {
  $(id).addEventListener("change", () => { const s = leerTc($(id).value); if (s !== null) { fijarEC(lado, s); encuadrar(); } else pintarEC(); });
  $(id).addEventListener("keydown", e => { if (e.key === "Enter") { e.stopPropagation(); $(id).blur(); } });
}
$("#mcMarcarEntrada").onclick = () => fijarEC("entrada", tEC());
$("#mcMarcarSalida").onclick = () => fijarEC("salida", tEC());
$("#mcIrEntrada").onclick = () => irEC(EC.ent);
$("#mcIrSalida").onclick = () => irEC(EC.sal);
$("#mcPlay").onclick = () => reproducirEC(false);
$("#mcVerCorte").onclick = () => { if (EC.el && !EC.el.paused) EC.el.pause(); reproducirEC(true); };
$("#mcCadena").onchange = () => { localStorage.mcCadena = $("#mcCadena").checked ? "1" : "0"; pintarEC(); };
$("#mcCerrar").onclick = $("#mcCancelar").onclick = cerrarEditorClip;
$("#mcAplicar").onclick = aplicarEditorClip;
$("#modalClip").addEventListener("mousedown", e => { if (e.target.id === "modalClip") cerrarEditorClip(); });
$("#mcVideo").addEventListener("seeked", pintarEC);
// Teclado del modal: va antes que el de la línea de tiempo y no lo deja pasar
document.addEventListener("keydown", e => {
  if (!EC.c) return;
  const k = e.key, enCampo = e.target.closest("input, textarea, select");
  if (k === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); return cerrarEditorClip(); }
  if (enCampo) return;   // los campos se tratan solos (Intro confirma) y la línea de tiempo ya los ignora
  e.stopImmediatePropagation();
  if (k === " ") { e.preventDefault(); reproducirEC(false); }
  else if (k === "Enter") { e.preventDefault(); aplicarEditorClip(); }
  else if (k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); if (EC.el) EC.el.pause(); EC.hastaSalida = false; irEC(tEC() + (k === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 1 / FPS)); }
  else if (k === "i" || k === "I") { if (EC.conMedio) fijarEC("entrada", tEC()); }
  else if (k === "o" || k === "O") fijarEC("salida", tEC());
  else if (k === "Home") irEC(EC.ent);
  else if (k === "End") irEC(EC.sal);
}, true);

// ---------- inspector ----------
let inspeccionado = "";
function pintarInspector(forzar) {
  const panel = $("#pClip");
  const clave = [...sel].join(",");
  if (!forzar && clave === inspeccionado && panel.contains(document.activeElement)) return;
  inspeccionado = clave;
  if (!sel.size) {
    panel.innerHTML = `<h3>Nada seleccionado</h3><div class="tenue">
      Haz clic en un clip para verlo aquí. Mayús/Ctrl+clic para varios.<br><br>
      <b>Atajos</b><br>Espacio: reproducir · ←/→: fotograma (Mayús: 1 s)<br>S: dividir en el cabezal · Supr: borrar (Mayús+Supr cierra hueco)<br>
      C: comentar · Ctrl+Z: deshacer · Ctrl+rueda: zoom · Alt al arrastrar: sin imán<br>Mayús al arrastrar un borde: recorta y mueve todo lo que va detrás<br>
      Arrastra un medio de la izquierda a una pista para añadirlo; doble clic lo pone en el cabezal.</div>`;
    return;
  }
  if (sel.size > 1) {
    const cs = [...sel].map(clipPorId).filter(Boolean);
    panel.innerHTML = `<h3>${cs.length} clips seleccionados</h3><div class="tenue">${cs.map(c => c.id).join(", ")}</div>
      <div class="bloque"><button id="iSilenciar">Silenciar todos</button> <button id="iSonido">Con sonido</button> <button id="iBorrarVarios">Borrar</button></div>`;
    $("#iSilenciar").onclick = () => ops([{ op: "modificar_clips", ids: [...sel], cambios: { mute: true } }]);
    $("#iSonido").onclick = () => ops([{ op: "modificar_clips", ids: [...sel], cambios: { mute: null } }]);
    $("#iBorrarVarios").onclick = () => borrarSeleccion(false);
    return;
  }
  const c = clipPorId([...sel][0]);
  if (!c) { panel.innerHTML = ""; return; }
  const tipo = tipoClip(c);
  const tp = pista(c.pista)?.tipo;
  const opcPistas = P.pistas.filter(p => compatible(p.tipo, c)).map(p => `<option value="${p.id}" ${p.id === c.pista ? "selected" : ""}>${p.id} · ${esc(p.nombre)}</option>`).join("");
  const num = (k, et, v, paso = 0.1) => `<div class="campo"><label>${et}</label><input type="number" step="${paso}" data-k="${k}" value="${v}"></div>`;
  panel.innerHTML = `
    <h3>${c.id} · ${esc(tipo === "texto" ? "Rótulo / nota" : nombreCorto(c.medio))}</h3>
    <div class="tenue">${esc(c.medio || "")}</div>
    <div class="bloque">
      <div class="campo"><label>Pista</label><select data-k="pista">${opcPistas}</select></div>
      ${num("inicio", "Empieza en", c.inicio)}<div class="campo"><label></label><span class="tenue">${tc(c.inicio)} → ${tc(finC(c))}</span></div>
      ${num("duracion", "Duración", c.duracion)}
      ${c.medio && tipo !== "foto" ? num("entrada", "Entrada (s del clip)", c.entrada ?? 0) : ""}
      ${tipo === "video" || tipo === "audio" ? `<div class="campo"><label>Volumen</label><input type="range" min="0" max="1" step="0.05" data-k="volumen" value="${c.volumen ?? 1}"></div>
        <div class="campo"><label></label><label class="chk"><input type="checkbox" data-k="mute" ${c.mute ? "checked" : ""}> Sin sonido</label></div>
        <div class="campo"><label></label><label class="chk"><input type="checkbox" data-k="eco" ${c.eco ? "checked" : ""}> Eco (la frase resuena al final)</label></div>
        <div class="campo"><label></label><label class="chk"><input type="checkbox" data-k="realce" ${c.realce ? "checked" : ""}> Realzar voz (sube lo bajo, frena golpes)</label></div>` : ""}
      ${tp === "video" && c.medio ? `<div class="campo"><label></label><label class="chk"><input type="checkbox" data-k="oculto" ${c.oculto ? "checked" : ""}> Solo audio (imagen en negro)</label></div>` : ""}
      ${tipo === "foto" ? num("zoom", "Zoom final", c.zoom ?? 1, 0.01) : ""}
      ${tipo === "animacion" || (tp === "video" && c.pista !== "V1" && c.medio) ? num("desplaza_x", "Mover a los lados", c.desplaza_x ?? 0, 0.05) : ""}
      <div class="campo"><label></label><label class="chk"><input type="checkbox" data-k="opcional" ${c.opcional ? "checked" : ""}> Opcional (fuera en la versión corta)</label></div>
      ${!c.medio ? `<div class="campo"><label>Texto</label><textarea data-k="texto" rows="3">${esc(c.texto)}</textarea></div>
        ${tp === "video" ? `<div class="campo"><label>Estilo</label><select data-k="estilo"><option value="">Rótulo simple</option><option value="etiqueta" ${c.estilo === "etiqueta" ? "selected" : ""}>Etiqueta de recambio</option></select></div>
        ${c.estilo === "etiqueta" ? `<div class="campo"><label>Referencia</label><input data-k="ref" value="${esc(c.ref)}" placeholder="Línea pequeña de arriba"></div>${num("tamano", "Tamaño", c.tamano ?? 1, 0.1)}` : ""}
        <div class="campo"><label>Posición</label><select data-k="posicion"><option value="centro" ${c.posicion === "centro" ? "selected" : ""}>Centro</option><option value="abajo" ${c.posicion === "abajo" ? "selected" : ""}>Abajo</option><option value="arriba" ${c.posicion === "arriba" ? "selected" : ""}>Arriba</option></select></div>` : ""}` : ""}
      <div class="campo"><label>Nota</label><textarea data-k="nota" rows="4">${esc(c.nota)}</textarea></div>
    </div>
    <div class="bloque"><button id="iIr">Ir al inicio</button> <button id="iComentar" class="acento">💬 Comentar este clip</button></div>
    <div class="bloque" id="iTrans"></div>`;
  panel.querySelectorAll("[data-k]").forEach(inp => inp.addEventListener("change", () => {
    const k = inp.dataset.k;
    let v = inp.type === "checkbox" ? (inp.checked || null) : inp.type === "number" || inp.type === "range" ? +inp.value : inp.value;
    if (v === "" && ["posicion", "estilo", "ref"].includes(k)) v = null;
    ops([{ op: "modificar_clips", ids: [c.id], cambios: { [k]: v } }]);
  }));
  $("#iIr").onclick = () => irA(c.inicio, true);
  $("#iComentar").onclick = () => { irA(Math.max(t, c.inicio) < finC(c) ? Math.max(t, c.inicio) : c.inicio); abrirComentario(); };
  if (tipo === "video") {
    const ini = c.entrada ?? 0, fin = ini + c.duracion;
    fetch(`/api/transcripcion?medio=${enc(c.medio)}&desde=${ini - 8}&hasta=${fin + 8}`).then(r => r.json()).then(fr => {
      if (inspeccionado !== c.id || !fr.length) return;
      $("#iTrans").innerHTML = `<div class="tenue">Lo que se dice (en blanco, lo que entra en el clip):</div>` + fr.map(f =>
        `<div class="frase ${f.fin > ini && f.inicio < fin ? "dentro" : ""}" title="Clic: ir a esta frase en la línea de tiempo"><span class="t">${f.inicio.toFixed(1)}</span>${esc(f.texto)}</div>`).join("");
      $("#iTrans").querySelectorAll(".frase").forEach((d, i) => d.onclick = () => {
        const s = c.inicio + (fr[i].inicio - ini);
        if (s >= c.inicio && s < finC(c)) irA(s); else avisar("Esa frase queda fuera del clip");
      });
    });
  }
}

// ---------- comentarios ----------
function pintarDonde() {
  const c = sel.size === 1 ? clipPorId([...sel][0]) : null;
  $("#dondeComentario").textContent = `En ${tc(t)}` + (c ? ` · sobre ${c.id} (${etiquetaClip(c)})` : " · sin clip concreto (selecciona uno para asociarlo)");
}
function abrirComentario() {
  pestana("comentarios");
  pintarDonde();
  $("#textoComentario").focus();
}
$("#formComentario").addEventListener("submit", e => {
  e.preventDefault();
  const texto = $("#textoComentario").value.trim();
  if (!texto) return;
  const c = sel.size === 1 ? [...sel][0] : undefined;
  ops([{ op: "anadir_comentario", t: Math.round(t * 1000) / 1000, clip: c, texto }]).then(() => { $("#textoComentario").value = ""; });
});
$("#textoComentario").addEventListener("focus", pintarDonde);
$("#textoComentario").addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#formComentario").requestSubmit(); });
$("#chkHechos").addEventListener("change", pintarComentarios);
function pintarComentarios() {
  const abiertos = P.comentarios.filter(k => k.estado !== "hecho");
  $("#nComentarios").textContent = abiertos.length || "";
  const lista = ($("#chkHechos").checked ? P.comentarios : abiertos).slice().sort((a, b) => a.t - b.t);
  $("#listaComentarios").innerHTML = lista.length ? lista.map(k => `
    <div class="comentario ${k.estado === "hecho" ? "hecho" : ""} ${k.id === comentarioActivo ? "activo" : ""}" data-k="${k.id}">
      <div class="cab"><a data-ir="${k.t}">${tc(k.t)}</a>${k.clip ? `<span>· ${k.clip}</span>` : ""}<span>· ${esc(k.autor || "tú")}</span><span>· ${k.estado === "hecho" ? "hecho" : "pendiente"}</span></div>
      <div class="texto">${esc(k.texto)}</div>
      ${k.respuesta ? `<div class="resp">${esc(k.respuesta)}</div>` : ""}
      <div class="acc"><button data-acc="estado">${k.estado === "hecho" ? "Reabrir" : "Marcar hecho"}</button><button data-acc="editar">Editar</button><button data-acc="borrar">Borrar</button></div>
    </div>`).join("") : `<div class="tenue">No hay comentarios pendientes. Pon el cabezal donde quieras un cambio, pulsa C y escríbelo.</div>`;
}
$("#listaComentarios").addEventListener("click", e => {
  const caja = e.target.closest(".comentario");
  if (!caja) return;
  const k = P.comentarios.find(x => x.id === caja.dataset.k);
  if (e.target.dataset.ir) { irA(+e.target.dataset.ir, true); if (k.clip && clipPorId(k.clip)) seleccionar([k.clip]); return; }
  const acc = e.target.dataset.acc;
  if (acc === "estado") ops([{ op: "modificar_comentario", id: k.id, estado: k.estado === "hecho" ? "abierto" : "hecho" }]);
  if (acc === "borrar" && confirm("¿Borrar este comentario?")) ops([{ op: "borrar_comentario", id: k.id }]);
  if (acc === "editar") { const n = prompt("Comentario:", k.texto); if (n !== null) ops([{ op: "modificar_comentario", id: k.id, texto: n }]); }
});
function verComentario(id) {
  comentarioActivo = id;
  pestana("comentarios");
  pintarComentarios();
  document.querySelector(`.comentario[data-k="${id}"]`)?.scrollIntoView({ block: "nearest" });
}
function pestana(n) {
  document.querySelectorAll(".pestanas button").forEach(b => b.classList.toggle("activa", b.dataset.p === n));
  for (const x of ["clip", "comentarios", "actividad"]) $("#p" + x[0].toUpperCase() + x.slice(1)).classList.toggle("oculto", x !== n);
}
document.querySelectorAll(".pestanas button").forEach(b => b.onclick = () => pestana(b.dataset.p));

// ---------- medios ----------
async function cargarMedios() {
  const r = await fetch("/api/medios").then(r => r.json());
  medios = Object.fromEntries(r.medios.map(m => [m.clave, m]));
  const listos = r.medios.filter(m => m.listo).length;
  const faltan = r.medios.length - listos;
  $("#estadoProxies").textContent = faltan ? `Proxies: ${listos} de ${r.medios.length} listos (los que faltan se están haciendo)` : `${r.medios.length} medios, todos listos para previsualizar`;
  pintarMedios();
}
function pintarMedios() {
  const f = $("#filtro").value.toLowerCase(), ft = $("#filtroTipo").value;
  const usados = new Set(P ? P.clips.map(c => c.medio).filter(Boolean) : []);
  $("#listaMedios").innerHTML = Object.values(medios).filter(m => (!ft || m.tipo === ft) && (!f || (m.clave + " " + nombreCorto(m.clave)).toLowerCase().includes(f))).map(m => `
    <div class="medio" draggable="true" data-m="${esc(m.clave)}" title="${esc(m.clave)}\nArrastra a una pista o haz doble clic para ponerlo en el cabezal">
      ${m.tipo === "audio" ? `<div class="sinimg"></div>` : `<img loading="lazy" src="/miniatura/${enc(m.clave)}?t=${m.tipo === "foto" ? 0 : 1}&w=128" alt="">`}
      <div style="min-width:0"><div class="nom">${esc(nombreCorto(m.clave))}</div>
      <div class="sub">${m.tipo}${m.dur ? " · " + tc(m.dur, false) : ""}${m.listo ? "" : " · preparando"} ${usados.has(m.clave) ? `<span class="usado">● en uso</span>` : ""}</div></div>
    </div>`).join("");
}
$("#filtro").addEventListener("input", pintarMedios);
$("#filtroTipo").addEventListener("change", pintarMedios);
$("#listaMedios").addEventListener("dragstart", e => {
  const m = e.target.closest(".medio");
  if (m) e.dataTransfer.setData("text/medio", m.dataset.m);
});
$("#listaMedios").addEventListener("dblclick", e => {
  const m = e.target.closest(".medio");
  if (!m) return;
  const tipo = tipoMedio(m.dataset.m);
  const pid = tipo === "audio" ? (P.pistas.find(p => p.tipo === "audio")?.id) : "V1";
  anadirMedio(m.dataset.m, pid, Math.round(t * FPS) / FPS);
});

// ---------- acciones ----------
function borrarSeleccion(cerrar) {
  if (!sel.size) return;
  const ids = [...sel];
  sel.clear();
  ops([{ op: "borrar_clips", ids, cerrar_hueco: cerrar }]);
}
function dividir() {
  const ids = (sel.size ? [...sel].map(clipPorId) : P.clips).filter(c => c && c.inicio + 0.02 < t && t < finC(c) - 0.02).map(c => c.id);
  const lista = sel.size ? ids : ids.filter(id => clipPorId(id).pista === "V1");
  if (!lista.length) return avisar("No hay ningún clip bajo el cabezal" + (sel.size ? " entre los seleccionados" : " en V1"));
  ops(lista.map(id => ({ op: "dividir", id, t: Math.round(t * FPS) / FPS })));
}
const deshacer = () => api("/api/deshacer", {});
$("#bPlay").onclick = play;
$("#bInicio").onclick = () => irA(0, true);
$("#bAtras").onclick = () => irA(t - 1 / FPS);
$("#bAdelante").onclick = () => irA(t + 1 / FPS);
$("#bDividir").onclick = dividir;
$("#bBorrar").onclick = e => borrarSeleccion(e.shiftKey);
$("#bDeshacer").onclick = deshacer;
$("#bComentar").onclick = abrirComentario;
$("#bMas").onclick = () => zoom(pps * 1.5);
$("#bMenos").onclick = () => zoom(pps / 1.5);
$("#bAjustar").onclick = () => { zoom(($("#scrollLinea").clientWidth - 30) / Math.max(total(), 1), 0); $("#scrollLinea").scrollLeft = 0; };
$("#chkSubs").onchange = () => localStorage.subs = $("#chkSubs").checked ? "1" : "0";
if (localStorage.subs === "0") $("#chkSubs").checked = false;
$("#chkGraficos").onchange = () => localStorage.graficos = $("#chkGraficos").checked ? "1" : "0";
if (localStorage.graficos === "0") $("#chkGraficos").checked = false;

document.addEventListener("keydown", e => {
  if (e.target.closest("input, textarea, select")) return;
  const k = e.key;
  if (k === " ") { e.preventDefault(); play(); }
  else if (k === "ArrowLeft") { e.preventDefault(); irA(t - (e.shiftKey ? 1 : 1 / FPS)); }
  else if (k === "ArrowRight") { e.preventDefault(); irA(t + (e.shiftKey ? 1 : 1 / FPS)); }
  else if (k === "Home") irA(0, true);
  else if (k === "End") irA(total(), true);
  else if (k === "Delete" || k === "Backspace") borrarSeleccion(e.shiftKey);
  else if ((k === "z" || k === "Z") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); deshacer(); }
  else if (k === "s" || k === "S" || (k === "b" && e.ctrlKey)) { e.preventDefault(); dividir(); }
  else if (k === "c" || k === "C") { e.preventDefault(); abrirComentario(); }
  else if (k === "+") zoom(pps * 1.5);
  else if (k === "-") zoom(pps / 1.5);
  else if (k === "Escape") seleccionar([]);
});

// Separador entre visor y línea de tiempo
$("#separador").addEventListener("mousedown", e => {
  e.preventDefault();
  const mover = ev => { const h = Math.max(200, Math.min(window.innerHeight - 180, ev.clientY - $("#arriba").getBoundingClientRect().top)); document.documentElement.style.setProperty("--alto-arriba", h + "px"); localStorage.alto = h; };
  const soltar = () => { window.removeEventListener("mousemove", mover); window.removeEventListener("mouseup", soltar); };
  window.addEventListener("mousemove", mover);
  window.addEventListener("mouseup", soltar);
});
if (localStorage.alto) document.documentElement.style.setProperty("--alto-arriba", localStorage.alto + "px");

// ---------- sincronía con el servidor ----------
function alCambiarProyecto() {
  construirCapas();
  for (const id of [...sel]) if (!clipPorId(id)) sel.delete(id);
  dibujarLinea();
  pintarInspector();
  pintarComentarios();
  pintarMedios();
}
function aplicarEstado(s) {
  if (s.aviso && s.aviso.cuando > ultimoAviso) {
    ultimoAviso = s.aviso.cuando;
    registrar(s.aviso.origen, s.aviso.texto);
    if (s.aviso.origen === "claude") avisar("Claude: " + s.aviso.texto);
  }
  // Órdenes de Claude: seleccionar clips o llevar el cabezal a un punto
  if (s.orden && s.orden.id > ultimaOrden) {
    ultimaOrden = s.orden.id;
    if (s.orden.seleccion) { seleccionar(s.orden.seleccion.filter(clipPorId)); const c = clipPorId(s.orden.seleccion[0]); if (c && s.orden.cabezal === undefined) irA(c.inicio, true); }
    if (s.orden.cabezal !== undefined) { if (reproduciendo) parar(); irA(s.orden.cabezal, true); }
    if (s.orden.comentario) verComentario(s.orden.comentario);
  }
}
function conectar() {
  const es = new EventSource("/eventos");
  es.onopen = () => $("#conexion").classList.add("ok");
  es.onerror = () => $("#conexion").classList.remove("ok");
  es.addEventListener("proyecto", e => { P = JSON.parse(e.data); alCambiarProyecto(); });
  es.addEventListener("estado", e => aplicarEstado(JSON.parse(e.data)));
  es.addEventListener("proxy", e => {
    const base = JSON.parse(e.data).archivo.replace(/\.[^.]+$/, "");
    for (const L of Object.values(capas)) for (const v of L.v) if (v.dataset.error && v.dataset.medio.replace(/\.[^.]+$/, "") === base) recargar(v);
    clearTimeout(conectar.tm);
    conectar.tm = setTimeout(cargarMedios, 1500);
  });
}

(async function iniciar() {
  const [proy, est] = await Promise.all([fetch("/api/proyecto").then(r => r.json()), fetch("/api/estado").then(r => r.json())]);
  P = proy;
  ultimoAviso = est.aviso?.cuando || 0;
  ultimaOrden = est.orden?.id || 0;
  t = Math.min(est.cabezal || 0, total());
  sel = new Set((est.seleccion || []).filter(id => P.clips.some(c => c.id === id)));
  $("#titulo").textContent = P.nombre || "Clauditor";
  alCambiarProyecto();
  cargarMedios().then(dibujarLinea, () => {});
  centrarEn(t);
  conectar();
  requestAnimationFrame(bucle);
})();
