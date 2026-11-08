"""Exporta el montaje de Clauditor a un vídeo (por defecto 1920x1080, 30 fps, H.264 + AAC).

Reproduce lo que se ve en el editor:
  - Pistas de vídeo de abajo arriba (V1 la base). En cada pista suena/se ve un solo clip a la vez: si dos se
    pisan, manda el que empieza después (como en el editor).
  - Vídeos y fotos enteros con bandas, o llenando el 16:9 si el proyecto tiene «encuadre». Fotos con su zoom lento.
  - Animaciones con transparencia (.mov con alfa), carteles de etiqueta (con su caída y su fundido) y rótulos.
  - Audio: el sonido de los vídeos que no están silenciados y los clips de audio, con volumen y fundidos.
  - No salen las notas de guion (pista de notas) ni los marcadores de «gráfico por hacer» o «material por subir».
Trabaja en tres pasadas (imagen base, capas de encima por tramos, mezcla de audio) para no hacer un único filtro
gigante. Usa NVENC si hay tarjeta NVIDIA.

Uso: python herramientas/exportar_video.py --proyecto <carpeta> [--salida fichero.mp4] [--alto 1080] [--desde s --hasta s]
"""
import argparse, json, math, os, subprocess, sys, tempfile, urllib.request, shutil, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

AQUI = Path(__file__).parent
ap = argparse.ArgumentParser()
ap.add_argument("--proyecto", required=True)
ap.add_argument("--salida")
ap.add_argument("--alto", type=int, default=1080)
ap.add_argument("--desde", type=float, default=0)
ap.add_argument("--hasta", type=float)
ap.add_argument("--desde-pasada", type=int, default=1, help="retomar: 2 = capas, 3 = audio")
ap.add_argument("--tramo", type=float, default=120, help="segundos por tramo en la pasada de capas y de audio")
args = ap.parse_args()

DIR = Path(args.proyecto)
cfg = json.loads((DIR / "clauditor.json").read_text(encoding="utf-8")) if (DIR / "clauditor.json").exists() else {}
API = f"http://localhost:{cfg.get('puerto', 4310)}"
P = json.load(urllib.request.urlopen(API + "/api/proyecto"))
FPS = P.get("fps") or cfg.get("fps") or 30
H = args.alto; W = round(H * 16 / 9 / 2) * 2
cq = lambda x: x * H / 100              # unidades cqh del editor → píxeles
ENCUADRE = cfg.get("encuadre")
CAT = json.loads(subprocess.run(["node", "-e",
    f"process.argv.push('--proyecto',{json.dumps(str(DIR))});const M=require({json.dumps(str(AQUI.parent / 'src' / 'medios.js'))});"
    "console.log(JSON.stringify(Object.fromEntries(Object.entries(M.catalogo()).map(([k,v])=>[k,{ruta:v.ruta,tipo:v.tipo}]))))"],
    capture_output=True, text=True).stdout)
TRABAJO = DIR / ".clauditor" / "export"
TRABAJO.mkdir(parents=True, exist_ok=True)
SALIDA = Path(args.salida) if args.salida else DIR / f"{cfg.get('nombre', 'montaje')}_{H}p.mp4"
FUENTE_CARTEL = str(AQUI / "fuentes" / "SpecialElite-Regular.ttf")
FUENTE_ROTULO = "C:/Windows/Fonts/segoeuib.ttf" if os.path.exists("C:/Windows/Fonts/segoeuib.ttf") else "DejaVuSans-Bold.ttf"

def nvenc_ok():
    r = subprocess.run(["ffmpeg", "-hide_banner", "-f", "lavfi", "-i", "nullsrc=s=256x256:d=0.1", "-c:v", "h264_nvenc", "-f", "null", "-"], capture_output=True)
    return r.returncode == 0
VCODEC = ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "19", "-b:v", "12M", "-maxrate", "20M", "-bufsize", "40M", "-g", str(FPS * 2)] if nvenc_ok() \
    else ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-g", str(FPS * 2)]
VCOMUN = VCODEC + ["-pix_fmt", "yuv420p", "-r", str(FPS), "-video_track_timescale", "15360"]

def ff(argv, **kw):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"] + argv, capture_output=True, text=True, **kw)
    if r.returncode: raise RuntimeError(r.stderr[-2000:])

# ---------------- qué se ve y qué suena ----------------
pistas = {p["id"]: p for p in P["pistas"]}
vid_pistas = [p["id"] for p in P["pistas"] if p["tipo"] == "video"][::-1]       # de abajo (V1) arriba
aud_pistas = [p["id"] for p in P["pistas"] if p["tipo"] == "audio"]
def efectivos(pid):
    """Clips de una pista con su fin recortado al empezar el siguiente (en el editor solo se ve/oye uno)."""
    cs = sorted([c for c in P["clips"] if c["pista"] == pid], key=lambda c: c["inicio"])
    out = []
    for i, c in enumerate(cs):
        fin = c["inicio"] + c["duracion"]
        if i + 1 < len(cs): fin = min(fin, cs[i + 1]["inicio"])
        if fin - c["inicio"] > 1 / FPS / 2: out.append({**c, "_fin": fin})
    return out
TOTAL = max(c["inicio"] + c["duracion"] for c in P["clips"])
T0, T1 = args.desde, min(args.hasta or TOTAL, TOTAL)
tipo = lambda c: CAT.get(c.get("medio") or "", {}).get("tipo") or ("texto" if not c.get("medio") else None)
def visible_texto(c):
    t = c.get("texto") or ""
    return t and not t.startswith("GRÁFICO") and not t.startswith("POR SUBIR")
ajuste = (f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}" if ENCUADRE
          else f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:black")

# ---------------- pasada 1: imagen base (V1) ----------------
def tramo_base(i, c, a, b):
    """Un trozo de la pista base de a a b (tiempo del montaje) como vídeo sin audio."""
    sal = TRABAJO / f"base_{i:04d}.mp4"
    d = b - a
    if c is None or c.get("oculto") or tipo(c) in (None, "audio", "texto"):
        ff(["-f", "lavfi", "-i", f"color=black:s={W}x{H}:r={FPS}:d={d:.4f}"] + VCOMUN + ["-t", f"{d:.4f}", str(sal)])
        return sal
    src = CAT[c["medio"]]["ruta"]
    if tipo(c) == "foto":
        # foto girada según EXIF y encajada en un lienzo al doble de tamaño, para que el zoom no tiemble
        tmp = TRABAJO / f"foto_{i:04d}.png"
        im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
        lienzo = Image.new("RGB", (2 * W, 2 * H))
        im = ImageOps.fit(im, (2 * W, 2 * H), Image.LANCZOS) if ENCUADRE else ImageOps.contain(im, (2 * W, 2 * H), Image.LANCZOS)
        lienzo.paste(im, ((2 * W - im.width) // 2, (2 * H - im.height) // 2)); lienzo.save(tmp)
        z = c.get("zoom") or 1
        n = max(1, round(d * FPS)); off = (a - c["inicio"]) * FPS; tot = c["duracion"] * FPS
        zexp = f"1+({z}-1)*({off:.3f}+on)/{tot:.3f}"
        ff(["-loop", "1", "-framerate", str(FPS), "-t", f"{d:.4f}", "-i", str(tmp),
            "-vf", f"zoompan=z='{zexp}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={W}x{H}:fps={FPS},setsar=1"]
           + VCOMUN + ["-frames:v", str(n), str(sal)])
        tmp.unlink(missing_ok=True)
        return sal
    ent = (c.get("entrada") or 0) + (a - c["inicio"])
    dx = c.get("desplaza_x") or 0
    vf = ajuste + (f",crop=iw:ih:{-dx}*iw:0,pad={W}:{H}:{dx}*{W}:0" if False else "") + f",setsar=1,fps={FPS}"
    if dx:   # desplazamiento horizontal: se corre la imagen y entra negro por el otro lado
        vf = ajuste + f",pad={2 * W}:{H}:{W // 2}:0,crop={W}:{H}:{W // 2}-({dx})*{W}:0,setsar=1,fps={FPS}"
    ff(["-ss", f"{ent:.4f}", "-t", f"{d + 0.5:.4f}", "-i", src, "-vf", vf, "-an"] + VCOMUN + ["-t", f"{d:.4f}", str(sal)])
    return sal

def pasada_base():
    cs = [c for c in efectivos("V1") if c["_fin"] > T0 and c["inicio"] < T1 and not pistas["V1"].get("oculta")]
    trozos, t = [], T0
    for c in cs:
        a, b = max(c["inicio"], T0), min(c["_fin"], T1)
        if a - t > 1 / FPS / 2: trozos.append((None, t, a))
        trozos.append((c, a, b)); t = b
    if T1 - t > 1 / FPS / 2: trozos.append((None, t, T1))
    print(f"[1/3] imagen base: {len(trozos)} trozos", flush=True)
    hechos = [0]
    def uno(x):
        i, (c, a, b) = x
        r = tramo_base(i, c, a, b); hechos[0] += 1
        if hechos[0] % 20 == 0: print(f"   {hechos[0]}/{len(trozos)}", flush=True)
        return r
    with ThreadPoolExecutor(3) as ex: res = list(ex.map(uno, enumerate(trozos)))
    lista = TRABAJO / "base.txt"
    lista.write_text("".join(f"file '{r.as_posix()}'\n" for r in res), encoding="utf-8")
    ff(["-f", "concat", "-safe", "0", "-i", str(lista), "-c", "copy", str(TRABAJO / "base.mp4")])
    for r in res: r.unlink(missing_ok=True)

# ---------------- carteles y rótulos como imágenes ----------------
def cartel_png(c, ruta):
    """Cartel de etiqueta como en el editor (cartulina, letra de máquina, ojal), ya girado −1,2°. Devuelve (png, x, y)."""
    fs = cq(3.4) * (c.get("tamano") or 1)
    f = ImageFont.truetype(FUENTE_CARTEL, round(fs)); fr = ImageFont.truetype(FUENTE_CARTEL, round(fs * 0.5))
    lineas = (c.get("texto") or "").split("\n")
    ref = " ".join((c.get("ref") or "").upper())   # letter-spacing aproximado
    lh = fs * 1.25
    anchos = [f.getlength(l) for l in lineas] + ([fr.getlength(ref)] if ref else [])
    pl, pr, pt, pb = 2.1 * fs, 1.0 * fs, 0.5 * fs, 0.55 * fs
    alto_ref = fs * 0.5 * 1.25 + fs * 0.5 * 0.25 if ref else 0
    w = int(max(anchos) + pl + pr); h = int(pt + alto_ref + lh * len(lineas) + pb)
    m = int(fs * 1.6)   # margen para la sombra y el giro
    im = Image.new("RGBA", (w + 2 * m, h + 2 * m), (0, 0, 0, 0))
    sombra = Image.new("RGBA", im.size, (0, 0, 0, 0))
    ImageDraw.Draw(sombra).rectangle((m, m + cq(0.5), m + w, m + h + cq(0.5)), fill=(0, 0, 0, 115))
    im = Image.alpha_composite(im, sombra.filter(ImageFilter.GaussianBlur(cq(1.4) / 2)))
    d = ImageDraw.Draw(im)
    # cartulina con un degradado suave
    for yy in range(h):
        k = yy / max(1, h - 1)
        col = tuple(int(v) for v in (239 + 4 * (1 - k) - 6 * k, 230 + 4 * (1 - k) - 6 * k, 207 + 3 * (1 - k) - 8 * k))
        d.line((m, m + yy, m + w, m + yy), fill=col + (255,))
    d.rectangle((m, m, m + w, m + h), outline=(201, 188, 152, 255), width=max(1, round(H / 1080)))
    # ojal reforzado
    cx, cy, r = m + 0.7 * fs + 0.31 * fs, m + h / 2, 0.31 * fs
    d.ellipse((cx - r - 0.2 * fs, cy - r - 0.2 * fs, cx + r + 0.2 * fs, cy + r + 0.2 * fs), fill=(185, 170, 130, 255))
    d.ellipse((cx - r - 0.14 * fs, cy - r - 0.14 * fs, cx + r + 0.14 * fs, cy + r + 0.14 * fs), fill=(216, 203, 166, 255))
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(43, 42, 40, 255))
    y = m + pt
    if ref:
        d.text((m + pl, y), ref, font=fr, fill=(138, 125, 92, 255)); y += alto_ref
    for l in lineas:
        d.text((m + pl, y + (lh - fs) / 2), l, font=f, fill=(43, 38, 28, 255)); y += lh
    # giro de −1,2° alrededor del 20 % del ancho, arriba (como transform-origin del editor)
    im = im.rotate(1.2, resample=Image.BICUBIC, center=(m + 0.2 * w, m))
    im.save(ruta)
    pos = c.get("posicion") or "abajo"
    if pos == "centro": x, yy = W / 2 - w / 2, H / 2 - h / 2
    elif pos == "arriba": x, yy = W * 0.06, H * 0.07
    else: x, yy = W * 0.06, H * (1 - 0.09) - h
    return ruta, round(x - m), round(yy - m)

def rotulo_png(c, ruta):
    """Rótulo de texto blanco con sombra (centro o abajo a la izquierda)."""
    abajo = c.get("posicion") == "abajo"
    fs = cq(3 if abajo else 4.2)
    f = ImageFont.truetype(FUENTE_ROTULO, round(fs))
    lineas = (c.get("texto") or "").split("\n"); lh = fs * 1.35
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    alto = lh * len(lineas)
    y0 = H * (1 - 0.07) - alto - cq(1.2) if abajo else H / 2 - alto / 2
    capa = Image.new("RGBA", (W, H), (0, 0, 0, 0)); dc = ImageDraw.Draw(capa)
    for i, l in enumerate(lineas):
        w = f.getlength(l); x = W * 0.06 + cq(2) if abajo else (W - w) / 2
        dc.text((x, y0 + i * lh + 2), l, font=f, fill=(0, 0, 0, 230))
        d.text((x, y0 + i * lh), l, font=f, fill=(255, 255, 255, 255))
    im = Image.alpha_composite(capa.filter(ImageFilter.GaussianBlur(4)), im)
    im.save(ruta)
    return ruta, 0, 0

# ---------------- pasada 2: capas de encima, por tramos ----------------
def capas():
    out = []
    for pid in vid_pistas[1:]:
        if pistas[pid].get("oculta"): continue
        for c in efectivos(pid):
            tp = tipo(c)
            if tp in ("video", "animacion", "foto"): out.append(("medio", c))
            elif tp == "texto" and visible_texto(c): out.append(("cartel" if c.get("estilo") == "etiqueta" else "rotulo", c))
    return out

def pasada_capas():
    lista_capas = capas()
    pngs = {}
    for k, c in lista_capas:
        if k in ("cartel", "rotulo"):
            ruta = TRABAJO / f"capa_{c['id']}.png"
            pngs[c["id"]] = (cartel_png if k == "cartel" else rotulo_png)(c, ruta)
    tramos, t = [], T0
    while t < T1 - 1e-6:
        tramos.append((t, min(T1, t + args.tramo))); t += args.tramo
    print(f"[2/3] capas: {len(lista_capas)} ({sum(1 for k, _ in lista_capas if k == 'cartel')} carteles) en {len(tramos)} tramos", flush=True)
    res = []
    for i, (a, b) in enumerate(tramos):
        sal = TRABAJO / f"capas_{i:03d}.mp4"
        dentro = [(k, c) for k, c in lista_capas if c["_fin"] > a and c["inicio"] < b]
        argv = ["-ss", f"{a - T0:.4f}", "-t", f"{b - a:.4f}", "-i", str(TRABAJO / "base.mp4")]
        filtros, ult = [], "[0:v]"
        for j, (k, c) in enumerate(dentro, start=1):
            ca, cb = max(c["inicio"], a), min(c["_fin"], b)
            off = ca - a
            if k == "medio":
                ent = (c.get("entrada") or 0) + (ca - c["inicio"])
                src = CAT[c["medio"]]["ruta"]
                if tipo(c) == "foto":
                    argv += ["-loop", "1", "-t", f"{cb - ca:.4f}", "-i", src]
                else:
                    argv += ["-ss", f"{ent:.4f}", "-t", f"{cb - ca:.4f}", "-i", src]
                filtros.append(f"[{j}:v]{ajuste.replace('black', 'black@0') if tipo(c) == 'animacion' else ajuste},format=rgba,fps={FPS},setpts=PTS-STARTPTS,tpad=start_duration={off:.4f}:color=black@0[c{j}]")
                xy = f"x={(c.get('desplaza_x') or 0) * W:.1f}:y=0"
            else:
                png, x, y = pngs[c["id"]]
                argv += ["-loop", "1", "-framerate", str(FPS), "-t", f"{b - a:.4f}", "-i", str(png)]   # dura todo el tramo: va al paso de la base
                # entrada: aparece en ~0,36 s y cae 6 % del alto con frenado; salida: se funde en 0,35 s
                t_in = ca - c["inicio"]; resto = c["_fin"] - ca
                fade = []
                if t_in < 0.36: fade.append(f"fade=t=in:st={off:.3f}:d={0.36 - t_in:.3f}:alpha=1")
                if resto > 0: fade.append(f"fade=t=out:st={off + max(0, resto - 0.35):.3f}:d={min(0.35, resto):.3f}:alpha=1")
                filtros.append(f"[{j}:v]format=rgba,{','.join(fade) + ',' if fade else ''}setpts=PTS-STARTPTS[c{j}]")
                if k == "cartel":
                    ini_rel = c["inicio"] - a   # inicio del cartel en tiempo del tramo (puede ser negativo)
                    xy = f"x={x}:y='{y}-{cq(6):.1f}*pow(1-min(1,max(0,(t-({ini_rel:.4f}))/0.5)),3)'"
                else:
                    xy = f"x={x}:y={y}"
            filtros.append(f"{ult}[c{j}]overlay={xy}:eof_action=pass:enable='between(t,{off:.4f},{off + cb - ca:.4f})'[v{j}]")
            ult = f"[v{j}]"
        if filtros:
            argv += ["-filter_complex", ";".join(filtros), "-map", ult]
        else:
            argv += ["-map", "0:v"]
        ff(argv + ["-an"] + VCOMUN + ["-t", f"{b - a:.4f}", str(sal)])
        res.append(sal)
        print(f"   tramo {i + 1}/{len(tramos)} ({len(dentro)} capas)", flush=True)
    lista = TRABAJO / "capas.txt"
    lista.write_text("".join(f"file '{r.as_posix()}'\n" for r in res), encoding="utf-8")
    ff(["-f", "concat", "-safe", "0", "-i", str(lista), "-c", "copy", str(TRABAJO / "video.mp4")])
    for r in res: r.unlink(missing_ok=True)

# ---------------- pasada 3: audio ----------------
def fuentes_audio():
    out = []
    for pid in vid_pistas:
        if pistas[pid].get("oculta") or pistas[pid].get("mute"): continue
        for c in efectivos(pid):
            if tipo(c) == "video" and not c.get("mute"): out.append(c)
    for pid in aud_pistas:
        if pistas[pid].get("mute"): continue
        for c in efectivos(pid):
            if c.get("medio") in CAT and not c.get("mute"): out.append(c)
    return out

def pasada_audio():
    cs = fuentes_audio()
    tramos, t = [], T0
    while t < T1 - 1e-6:
        tramos.append((t, min(T1, t + args.tramo))); t += args.tramo
    print(f"[3/3] audio: {len(cs)} clips con sonido en {len(tramos)} tramos", flush=True)
    res = []
    for i, (a, b) in enumerate(tramos):
        sal = TRABAJO / f"audio_{i:03d}.wav"
        dentro = [c for c in cs if c["_fin"] > a and c["inicio"] < b]
        argv, filtros, etiq = [], [], []
        for j, c in enumerate(dentro):
            ca, cb = max(c["inicio"], a), min(c["_fin"], b)
            ent = (c.get("entrada") or 0) + (ca - c["inicio"])
            argv += ["-ss", f"{ent:.4f}", "-t", f"{cb - ca:.4f}", "-i", CAT[c["medio"]]["ruta"]]
            v = c.get("volumen", 1); fe = c.get("fundido_entrada") or 0; fs_ = c.get("fundido_salida") or 0
            # t del filtro = segundos desde el principio de este trozo del clip
            g = f"{v}"
            if fe: g += f"*min(1,max(0,({ca - c['inicio']:.4f}+t)/{fe}))"
            if fs_: g += f"*min(1,max(0,({c['_fin'] - ca:.4f}-t)/{fs_}))"
            ef = []
            if c.get("realce"): ef.append("acompressor=threshold=0.06:ratio=4:attack=5:release=120:makeup=4")
            if c.get("eco"): ef.append("aecho=0.8:0.6:180:0.25")
            ms = round((ca - a) * 1000)
            filtros.append(f"[{j}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,{','.join(ef) + ',' if ef else ''}volume='{g}':eval=frame,adelay={ms}|{ms}[a{j}]")
            etiq.append(f"[a{j}]")
        d = b - a
        if dentro:
            # un silencio de la duración exacta del tramo va primero y manda en la duración de la mezcla
            n = len(dentro)
            argv += ["-f", "lavfi", "-t", f"{d:.4f}", "-i", "anullsrc=r=48000:cl=stereo"]
            filtros.append(f"[{n}:a]{''.join(etiq)}amix=inputs={n + 1}:normalize=0:duration=first:dropout_transition=0[mix]")
            ff(argv + ["-filter_complex", ";".join(filtros), "-map", "[mix]", "-t", f"{d:.4f}", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(sal)])
        else:
            ff(["-f", "lavfi", "-i", f"anullsrc=r=48000:cl=stereo", "-t", f"{d:.4f}", "-c:a", "pcm_s16le", str(sal)])
        res.append(sal)
        print(f"   tramo {i + 1}/{len(tramos)} ({len(dentro)} sonidos)", flush=True)
    lista = TRABAJO / "audio.txt"
    lista.write_text("".join(f"file '{r.as_posix()}'\n" for r in res), encoding="utf-8")
    ff(["-f", "concat", "-safe", "0", "-i", str(lista), "-af", "alimiter=limit=0.89:level=false", "-c:a", "pcm_s16le", str(TRABAJO / "audio.wav")])
    if not os.environ.get('CLAUDITOR_DEPURAR'):
        for r in res: r.unlink(missing_ok=True)

inicio = time.time()
if args.desde_pasada <= 1: pasada_base(); print(f"   ({time.time() - inicio:.0f} s)", flush=True)
if args.desde_pasada <= 2: pasada_capas(); print(f"   ({time.time() - inicio:.0f} s)", flush=True)
pasada_audio(); print(f"   ({time.time() - inicio:.0f} s)", flush=True)
ff(["-i", str(TRABAJO / "video.mp4"), "-i", str(TRABAJO / "audio.wav"), "-map", "0:v", "-map", "1:a", "-c:v", "copy",
    "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", "-shortest", str(SALIDA)])
print(f"HECHO {SALIDA} · {T1 - T0:.1f} s de montaje en {(time.time() - inicio) / 60:.1f} min", flush=True)
