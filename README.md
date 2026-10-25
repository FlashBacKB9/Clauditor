# Clauditor

Editor de vídeo por capas, sin render, pensado para montar **junto con Claude**. Tú ves el montaje en la
ventana del programa y dejas comentarios en la línea de tiempo; Claude los lee por **MCP**, hace los cambios
y tú los ves al momento. Todo cambio se puede deshacer.

No usa la API de Claude: es un servidor MCP local que Claude Code (o cualquier cliente MCP) arranca por su cuenta.

## Qué hace

- Previsualización por capas en tiempo real (vídeo, fotos con zoom, animaciones con transparencia, rótulos,
  carteles y varias pistas de audio), sin renderizar: el navegador mezcla los proxies al vuelo.
- Proxies ligeros automáticos con ffmpeg (NVENC si hay tarjeta NVIDIA; si no, CPU). Las animaciones con
  canal alfa se convierten a VP9 con transparencia.
- Comentarios anclados al material: si mueves o recortas clips, el comentario sigue al plano que comentaste.
- Cambios en directo: el servidor vigila `proyecto.json` y avisa a la ventana por SSE.
- Historial: una copia antes de cada cambio, con Ctrl+Z / «deshaz eso».
- Efectos de audio sencillos (eco, realce de voz) y recorte con arrastre (Mayús para cerrar huecos).
- Editor de cada clip (doble clic): alarga o acorta el corte por delante y por detrás, o desliza el trozo
  que se ve, sobre el vídeo original con miniaturas y transcripción; lo que va detrás se mueve para que encaje.

**Todavía no exporta el vídeo final.** Sirve para decidir el montaje; el render se hace aparte
(Archivo › Exportar › Para DaVinci Resolve / Final Cut genera un FCPXML con los originales).

## Menús

- **Archivo**: proyecto nuevo, abrir y recientes (programa de escritorio), guardar versión (Ctrl+S: copia con
  fecha en `versiones/`; el montaje ya se guarda solo con cada cambio), versiones guardadas para restaurar,
  importar un proyecto `.json` y exportar: proyecto completo (`.json`), FCPXML para DaVinci Resolve / Final Cut,
  comentarios (`.md`) y guion y notas (`.txt`).
- **Editar**: deshacer y rehacer, editar clip, dividir, borrar (con o sin cerrar hueco), seleccionar, comentar y marcadores.
- **Ver**: zoom, ir al principio o al final, guion en el visor, gráficos por hacer, paneles, pantalla completa.
- **Ayuda**: atajos de teclado y acerca de.

## Requisitos

- [Node.js](https://nodejs.org) 20 o superior
- [ffmpeg y ffprobe](https://ffmpeg.org) en el `PATH`
- Windows, macOS o Linux (la voz provisional `voz_provisional.js` solo funciona en Windows)

## Instalación

```bash
git clone https://github.com/FlashBacKB9/Clauditor.git
cd Clauditor
npm install
```

## Uso

### 1. Una carpeta por proyecto

Cada montaje vive en su propia carpeta, fuera de Clauditor:

```
mi-video/
  clauditor.json     configuración (opcional)
  medios/            vídeos, fotos, animaciones y audios
  proyecto.json      el montaje (se crea solo)
  estado.json        selección y cabezal (se crea solo)
  historial/         copias para deshacer
  audio/             audios generados (voces, música, sonido limpio…)
  versiones/         versiones guardadas a mano (Archivo › Guardar versión)
  .clauditor/        proxies y caché (se regeneran)
```

`clauditor.json` (todos los campos son opcionales; mira [`ejemplo/clauditor.json`](ejemplo/clauditor.json)):

| Campo | Para qué |
|---|---|
| `nombre` | Título del proyecto (por defecto, el nombre de la carpeta) |
| `puerto` | Puerto del servidor local (4310) |
| `fps` | Fotogramas por segundo del montaje (30) |
| `medios` | Carpetas con el material, relativas al proyecto o absolutas (`["medios"]`) |
| `transcripciones` | JSON con lo que se dice en cada vídeo: `{ "video_sin_extension": [{ "inicio", "fin", "texto" }] }` |
| `herramientas.deepfilter` | Ruta a `deepFilter` para limpiar el audio con DeepFilterNet |
| `herramientas.modeloDeepFilter` | Carpeta del modelo DeepFilterNet3 |

### 2. Abrir el programa

```bash
npm start -- --proyecto ../mi-video
```

Sin `--proyecto` abre el último proyecto usado o te pregunta la carpeta. También funciona en el navegador:
`node src/servidor.js --proyecto ../mi-video` y abre http://localhost:4310.

### 3. Conectar Claude

En la carpeta del proyecto, un `.mcp.json` como este (ver [`ejemplo/.mcp.json`](ejemplo/.mcp.json)):

```json
{
  "mcpServers": {
    "clauditor": {
      "command": "node",
      "args": ["C:/ruta/a/Clauditor/src/mcp.js", "--proyecto", "."]
    }
  }
}
```

Abre Claude Code en esa carpeta. Si el programa no está abierto, el servidor MCP levanta el servidor web
por su cuenta, así que también puedes trabajar desde el navegador.

### 4. Trabajar

1. Pon el cabezal donde quieras un cambio, pulsa **C** y escribe qué quieres (si tienes un clip
   seleccionado, el comentario queda asociado a él).
2. En el chat: «mira mis comentarios» o «cambia lo que tengo seleccionado».
3. Claude hace los cambios, los ves al momento y te contesta en el propio comentario.
4. Si algo no te gusta: **Ctrl+Z** (o «deshaz eso»).

## Atajos

| Tecla | Acción |
|---|---|
| Espacio | Reproducir / parar |
| ← / → | Fotograma anterior / siguiente (Mayús: 1 s) |
| Inicio / Fin | Principio / final del montaje |
| S o Ctrl+B | Dividir en el cabezal |
| Supr / Retroceso | Borrar (con Mayús cierra el hueco) |
| C | Comentar en el cabezal |
| Doble clic en un clip | Editor del clip: entrada y salida sobre el medio original, con miniaturas y transcripción |
| Ctrl+Z / Ctrl+Y | Deshacer / rehacer |
| Ctrl+S | Guardar versión |
| Intro | Editar el clip seleccionado |
| M | Marcador en el cabezal |
| Ctrl+A | Seleccionar todo |
| + / − o Ctrl+rueda | Zoom de la línea de tiempo |
| Alt al arrastrar | Sin imán |
| F5 / F11 / F12 | Recargar / pantalla completa / depuración |
| Ctrl+N / Ctrl+O / Ctrl+Q | Proyecto nuevo / abrir / salir (programa de escritorio) |

## Herramientas MCP

| Herramienta | Qué hace |
|---|---|
| `estado` | Qué estás mirando: cabezal, selección, clips bajo el cabezal |
| `ver_linea_tiempo` | Resumen de las pistas y los clips de un tramo |
| `ver_clip` | Detalle de un clip |
| `leer_comentarios` / `responder_comentario` | Tus peticiones y las respuestas de Claude |
| `anadir_clip`, `modificar_clips`, `mover_clips`, `recortar`, `borrar_clips`, `dividir`, `desplazar` | Edición |
| `operaciones` | Varias operaciones en un solo paso deshacible |
| `seleccionar` | Señalarte clips o llevar el cabezal a un punto |
| `deshacer` | Volver atrás |
| `medios` | Material disponible, con duración y estado del proxy |
| `transcripcion` | Lo que se dice en un tramo de un vídeo |
| `ver_fotograma` / `hoja_contactos` | Imágenes del montaje o de un vídeo para que Claude las vea |

## Herramientas opcionales (`herramientas/`)

- `limpiar_audio.js` — limpia el sonido directo de unos clips con DeepFilterNet y lo pone en la pista «Directo limpio».
- `revisar_cortes.js` — usa la transcripción para proponer alargar cortes que dejan frases a medias.
- `ver_comentarios.js` — lista los comentarios pendientes con su contexto.
- `voz_provisional.js` — locución provisional con la voz de Windows a partir de los textos «VOZ: …» de la pista de notas.
- `palabras.py` — tiempos palabra a palabra de un tramo con faster-whisper.

Todas aceptan `--proyecto <carpeta>`.

## Licencia

[MIT](LICENSE)
