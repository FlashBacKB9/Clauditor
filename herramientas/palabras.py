"""Tiempos palabra a palabra de un tramo de un vídeo, con Whisper large-v3 (GPU si se puede).
Necesita faster-whisper (pip install faster-whisper).
Uso: python herramientas/palabras.py <video> <desde> <segundos>   → imprime palabra@segundo del vídeo"""
import os, site, subprocess, sys, tempfile
from pathlib import Path
dirs = list(site.getsitepackages()) + [site.getusersitepackages()]
for sp in dirs:
    for sub in ("cublas", "cudnn"):
        b = Path(sp) / "nvidia" / sub / "bin"
        if b.is_dir():
            os.add_dll_directory(str(b)); os.environ["PATH"] = str(b) + os.pathsep + os.environ["PATH"]
from faster_whisper import WhisperModel
video, desde, dur = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
wav = os.path.join(tempfile.gettempdir(), "palabras_tramo.wav")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(desde), "-t", str(dur), "-i", video, "-vn", "-ac", "1", "-ar", "16000", wav], check=True)
try:
    m = WhisperModel("large-v3", device="cuda", compute_type="float16")
    segs, _ = m.transcribe(wav, language="es", word_timestamps=True)
    segs = list(segs)
except Exception as e:
    print("(sin GPU, en CPU:", str(e)[:80], ")")
    m = WhisperModel("large-v3", device="cpu", compute_type="int8")
    segs = list(m.transcribe(wav, language="es", word_timestamps=True)[0])
for s in segs:
    print(" ".join(f"{w.word.strip()}@{desde + w.start:.2f}" for w in s.words))
