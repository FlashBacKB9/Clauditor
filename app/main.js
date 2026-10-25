// Programa de escritorio de Clauditor (Electron). Elige la carpeta del proyecto, arranca el servidor dentro del
// propio programa (o usa el que ya esté abierto, por ejemplo el que levanta el MCP de Claude) y muestra el editor.
//
// Carpeta del proyecto, por este orden: `--proyecto <carpeta>`, CLAUDITOR_PROYECTO, la última que se abrió
// o, si no hay ninguna, se pregunta con un diálogo.
const { app, BrowserWindow, Menu, dialog } = require("electron");
const fs = require("fs");
const path = require("path");

if (!app.requestSingleInstanceLock()) app.quit();

let ventana = null;
app.on("second-instance", () => { if (ventana) { if (ventana.isMinimized()) ventana.restore(); ventana.focus(); } });

const FICH_ULTIMO = () => path.join(app.getPath("userData"), "ultimo_proyecto.txt");

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

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const dir = await elegirProyecto();
  if (!dir) return app.quit();
  process.env.CLAUDITOR_PROYECTO = dir;
  try { fs.writeFileSync(FICH_ULTIMO(), dir); } catch {}
  const { PUERTO, listo, cfg } = require("../src/servidor");
  await listo;
  ventana = new BrowserWindow({
    width: 1600, height: 950, show: false, title: `Clauditor · ${cfg.nombre}`, backgroundColor: "#16171b",
    icon: path.join(__dirname, "icono.png"),
    webPreferences: { backgroundThrottling: false, autoplayPolicy: "no-user-gesture-required" },
  });
  ventana.maximize();
  ventana.once("ready-to-show", () => ventana.show());
  const url = `http://127.0.0.1:${PUERTO}/`;
  // Si la página no carga (servidor reiniciándose), se reintenta en un segundo
  ventana.webContents.on("did-fail-load", () => setTimeout(() => ventana && ventana.loadURL(url), 1000));
  ventana.webContents.on("render-process-gone", () => setTimeout(() => ventana && ventana.reload(), 500));
  // F5 recarga y F12 abre las herramientas de depuración, aunque no haya menú
  ventana.webContents.on("before-input-event", (e, i) => {
    if (i.type !== "keyDown") return;
    if (i.key === "F5") { ventana.reload(); e.preventDefault(); }
    if (i.key === "F12") { ventana.webContents.toggleDevTools(); e.preventDefault(); }
  });
  ventana.on("page-title-updated", e => e.preventDefault());
  ventana.on("closed", () => { ventana = null; });
  ventana.loadURL(url);
}).catch(e => { dialog.showErrorBox("Clauditor", String(e && e.stack || e)); app.quit(); });

app.on("window-all-closed", () => app.quit());
