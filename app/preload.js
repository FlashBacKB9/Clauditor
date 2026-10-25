// Puente entre la página del editor y el programa de escritorio: lo que una web no puede hacer sola
// (elegir carpetas, guardar ficheros donde diga el usuario, abrir el explorador, cerrar la ventana).
// En el navegador `window.clauditor` no existe y el menú esconde estas opciones o usa una alternativa.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clauditor", {
  escritorio: true,
  nuevoProyecto: () => ipcRenderer.invoke("nuevo-proyecto"),
  abrirProyecto: () => ipcRenderer.invoke("abrir-proyecto"),
  abrirReciente: dir => ipcRenderer.invoke("abrir-reciente", dir),
  recientes: () => ipcRenderer.invoke("recientes"),
  guardarArchivo: (nombre, texto) => ipcRenderer.invoke("guardar-archivo", nombre, texto),
  abrirArchivoProyecto: () => ipcRenderer.invoke("abrir-archivo-proyecto"),
  abrirCarpeta: ruta => ipcRenderer.invoke("abrir-carpeta", ruta),
  abrirEnlace: url => ipcRenderer.invoke("abrir-enlace", url),
  pantallaCompleta: () => ipcRenderer.invoke("pantalla-completa"),
  depuracion: () => ipcRenderer.invoke("depuracion"),
  salir: () => ipcRenderer.invoke("salir"),
});
