// Programa de escritorio de Clauditor (Electron). Elige la carpeta del proyecto, arranca el servidor dentro del
// propio programa (o usa el que ya esté abierto, por ejemplo el que levanta el MCP de Claude) y muestra el editor.
//
// Carpeta del proyecto, por este orden: `--proyecto <carpeta>`, CLAUDITOR_PROYECTO, la última que se abrió
// o, si no hay ninguna, se pregunta con un diálogo. Abrir otro proyecto desde el menú reinicia el programa
// con esa carpeta (el servidor y la configuración se fijan al arrancar).
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");

if (!app.requestSingleInstanceLock()) app.quit();

let ventana = null;
app.on("second-instance", () => { if (ventana) { if (ventana.isMinimized()) ventana.restore(); ventana.focus(); } });

const FICH_ULTIMO = () => path.join(app.getPath("userData"), "ultimo_proyecto.txt");
const FICH_RECIENTES = () => path.join(app.getPath("userData"), "recientes.json");
const leerRecientes = () => { try { return JSON.parse(fs.readFileSync(FICH_RECIENTES(), "utf8")).filter(d => fs.existsSync(d)); } catch { return []; } };
function apuntarReciente(dir) {
  try { fs.writeFileSync(FICH_ULTIMO(), dir); } catch {}
  try { fs.writeFileSync(FICH_RECIENTES(), JSON.stringify([dir, ...leerRecientes().filter(d => path.resolve(d) !== path.resolve(dir))].slice(0, 8))); } catch {}
}

async function elegirProyecto() {
  const i = process.argv.indexOf("--proyecto");
  if (i >= 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  if (process.env.CLAUDITOR_PROYECTO) return path.resolve(process.env.CLAUDITOR_PROYECTO);
  try {
    const ultimo = fs.readFileSync(FICH_ULTIMO(), "utf8").trim();
    if (ultimo && fs.existsSync(ultimo)) return ultimo;
  } catch {}
  const r = await dialog.showOpenDialog({
    title: "Clauditor · elige la carpeta del proyecto",
    properties: ["openDirectory", "createDirectory"],
  });
  return r.canceled ? null : r.filePaths[0];
}

// Reinicia el programa con otra carpeta de proyecto
function reabrirCon(dir) {
  apuntarReciente(dir);
  const args = process.argv.slice(1).filter((a, i, l) => a !== "--proyecto" && l[i - 1] !== "--proyecto");
  app.relaunch({ args: [...args, "--proyecto", dir] });
  app.exit(0);
}

ipcMain.handle("abrir-proyecto", async () => {
  const r = await dialog.showOpenDialog(ventana, { title: "Abrir proyecto · elige su carpeta", properties: ["openDirectory"] });
  if (r.canceled) return false;
  const dir = r.filePaths[0];
  if (!fs.existsSync(path.join(dir, "proyecto.json")) && !fs.existsSync(path.join(dir, "clauditor.json"))) {
    const { response } = await dialog.showMessageBox(ventana, { type: "question", buttons: ["Crear proyecto aquí", "Cancelar"], defaultId: 0, cancelId: 1,
      title: "Clauditor", message: "Esa carpeta aún no es un proyecto de Clauditor.", detail: "Se creará un montaje vacío y una carpeta «medios» para el material." });
    if (response !== 0) return false;
    fs.mkdirSync(path.join(dir, "medios"), { recursive: true });
  }
  reabrirCon(dir);
  return true;
});
ipcMain.handle("nuevo-proyecto", async () => {
  const r = await dialog.showOpenDialog(ventana, { title: "Proyecto nuevo · elige o crea una carpeta vacía", buttonLabel: "Crear aquí", properties: ["openDirectory", "createDirectory"] });
  if (r.canceled) return false;
  const dir = r.filePaths[0];
  if (fs.existsSync(path.join(dir, "proyecto.json"))) {
    await dialog.showMessageBox(ventana, { type: "info", title: "Clauditor", message: "Esa carpeta ya tiene un proyecto: se abre tal cual." });
  } else {
    fs.mkdirSync(path.join(dir, "medios"), { recursive: true });
    if (!fs.existsSync(path.join(dir, "clauditor.json")))
      fs.writeFileSync(path.join(dir, "clauditor.json"), JSON.stringify({ nombre: path.basename(dir), medios: ["medios"] }, null, 2));
  }
  reabrirCon(dir);
  return true;
});
ipcMain.handle("abrir-reciente", (e, dir) => { if (dir && fs.existsSync(dir)) reabrirCon(dir); return false; });
ipcMain.handle("recientes", () => leerRecientes());
ipcMain.handle("guardar-archivo", async (e, nombre, texto) => {
  const r = await dialog.showSaveDialog(ventana, { title: "Guardar como", defaultPath: path.join(app.getPath("documents"), nombre) });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, texto);
  return r.filePath;
});
ipcMain.handle("abrir-archivo-proyecto", async () => {
  const r = await dialog.showOpenDialog(ventana, { title: "Importar proyecto (.json)", filters: [{ name: "Proyecto de Clauditor", extensions: ["json"] }], properties: ["openFile"] });
  if (r.canceled) return null;
  return fs.readFileSync(r.filePaths[0], "utf8");
});
ipcMain.handle("abrir-carpeta", (e, ruta) => ruta && shell.openPath(ruta));
ipcMain.handle("abrir-enlace", (e, url) => /^https:\/\//.test(url) && shell.openExternal(url));
ipcMain.handle("pantalla-completa", () => ventana && ventana.setFullScreen(!ventana.isFullScreen()));
ipcMain.handle("depuracion", () => ventana && ventana.webContents.toggleDevTools());
ipcMain.handle("salir", () => app.quit());

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const dir = await elegirProyecto();
  if (!dir) return app.quit();
  process.env.CLAUDITOR_PROYECTO = dir;
  apuntarReciente(dir);
  const { PUERTO, listo, cfg } = require("../src/servidor");
  const modo = await listo;
  // Si el puerto lo tenía ya otro servidor, comprobar que es de este mismo proyecto
  if (modo === "existente") {
    const info = await fetch(`http://127.0.0.1:${PUERTO}/api/info`).then(r => r.json()).catch(() => null);
    if (info && path.resolve(info.carpeta) !== path.resolve(dir)) {
      dialog.showErrorBox("Clauditor", `El puerto ${PUERTO} ya lo usa otro proyecto abierto:\n${info.carpeta}\n\nCiérralo o pon otro "puerto" en el clauditor.json de este proyecto.`);
      return app.quit();
    }
  }
  ventana = new BrowserWindow({
    width: 1600, height: 950, show: false, title: `Clauditor · ${cfg.nombre}`, backgroundColor: "#16171b",
    icon: path.join(__dirname, "icono.png"),
    webPreferences: { backgroundThrottling: false, autoplayPolicy: "no-user-gesture-required", preload: path.join(__dirname, "preload.js") },
  });
  ventana.maximize();
  ventana.once("ready-to-show", () => ventana.show());
  const url = `http://127.0.0.1:${PUERTO}/`;
  // Si la página no carga (servidor reiniciándose), se reintenta en un segundo
  ventana.webContents.on("did-fail-load", () => setTimeout(() => ventana && ventana.loadURL(url), 1000));
  ventana.webContents.on("render-process-gone", () => setTimeout(() => ventana && ventana.reload(), 500));
  // F5, F11 y F12 funcionan aunque no haya menú nativo (el menú está dentro de la página)
  ventana.webContents.on("before-input-event", (e, i) => {
    if (i.type !== "keyDown") return;
    if (i.key === "F5") { ventana.reload(); e.preventDefault(); }
    if (i.key === "F11") { ventana.setFullScreen(!ventana.isFullScreen()); e.preventDefault(); }
    if (i.key === "F12") { ventana.webContents.toggleDevTools(); e.preventDefault(); }
  });
  // Los enlaces externos se abren en el navegador, no en la ventana del editor
  ventana.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https:\/\//.test(u)) shell.openExternal(u); return { action: "deny" }; });
  ventana.on("page-title-updated", e => e.preventDefault());
  ventana.on("closed", () => { ventana = null; });
  ventana.loadURL(url);
}).catch(e => { dialog.showErrorBox("Clauditor", String(e && e.stack || e)); app.quit(); });

app.on("window-all-closed", () => app.quit());
