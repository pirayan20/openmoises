"""OpenMoises: paste a YouTube link, get drums/bass/vocals/other in a browser mixer.

Run from the repo root: uv run backend/server.py  ->  http://localhost:8000
"""
import json
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SONGS = ROOT / "songs"
WEB = ROOT / "web"
# fast 4-stem (~25s/song), HQ 4-stem (~4x slower), 6-stem (+guitar, piano). Default is HQ.
MODELS = ("htdemucs", "htdemucs_ft", "htdemucs_6s")
ID_RE = re.compile(r"^[0-9a-f]+$")
STEM_RE = re.compile(r"^[a-z]+$")
STATIC = {"/": ("index.html", "text/html; charset=utf-8"),
          "/app.js": ("app.js", "text/javascript; charset=utf-8"),
          "/style.css": ("style.css", "text/css; charset=utf-8"),
          "/home-bg.js": ("home-bg.js", "text/javascript; charset=utf-8"),
          "/vendor/three.min.js": ("vendor/three.min.js", "text/javascript; charset=utf-8"),
          "/assets/logo.png": ("assets/logo.png", "image/png"),
          "/vendor/SignalsmithStretch.js": ("vendor/SignalsmithStretch.js", "text/javascript; charset=utf-8")}
jobs = {}  # song id -> (status, error) while a job runs or after it failed (lost on restart, songs on disk stay)
# ponytail: one demucs at a time, so parallel adds don't stack models in GPU memory; downloads stay parallel
gpu_lock = threading.Lock()


def device():
    # Apple Silicon GPU; checked without importing torch (~180 MB) into the server
    return "mps" if sys.platform == "darwin" and platform.machine() == "arm64" else "cpu"


def write_json(path, obj):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj))
    tmp.replace(path)  # atomic, so a concurrent /api/songs never reads half a file


def read_meta(d):
    return json.loads((d / "meta.json").read_text())


def new_meta(song_id, title, url=None):
    """meta.json before yt-dlp fills in the details. Song ids are time.time_ns() in hex."""
    return {"title": title, "artist": None, "videoId": None, "url": url, "duration": None,
            "addedAt": int(song_id, 16) // 10**6}


def fetch(d, target, *args):
    """One yt-dlp run: save the video's thumbnail as d/cover.jpg and return its meta.json fields."""
    out = subprocess.run(
        [sys.executable, "-m", "yt_dlp", *args, "--no-simulate", "--write-thumbnail", "--convert-thumbnails", "jpg",
         "-o", f"thumbnail:{d / 'cover.%(ext)s'}",
         "-O", "%(.{id,title,track,artist,channel,uploader,duration,webpage_url})j", target],
        check=True, capture_output=True, text=True).stdout
    v = json.loads(out.strip().splitlines()[-1])
    return {"title": v.get("track") or v["title"], "artist": v.get("artist") or v.get("channel") or v.get("uploader"),
            "videoId": v["id"], "url": v["webpage_url"], "duration": v.get("duration")}


def analysis(sd):
    """Key and tempo of a stem folder, computed once in a subprocess so librosa's memory is freed."""
    cache = sd.parent / "analysis.json"
    if not cache.exists():
        out = subprocess.run([sys.executable, str(HERE / "analyze.py"), str(sd)],
                             check=True, capture_output=True, text=True).stdout
        write_json(cache, json.loads(out.strip().splitlines()[-1]))
    return json.loads(cache.read_text())


def separate(song_id, url, model):
    d = SONGS / song_id
    try:
        jobs[song_id] = ("downloading", None)
        info = fetch(d, url, "--no-playlist", "-x", "--audio-format", "wav", "-o", str(d / "source.%(ext)s"))
        write_json(d / "meta.json", {**read_meta(d), **info})
        jobs[song_id] = ("queued", None)
        with gpu_lock:
            jobs[song_id] = ("separating", None)
            subprocess.run(
                [sys.executable, "-m", "demucs", "-n", model, "-d", device(), "-o", str(d),
                 "--filename", "{stem}.{ext}", str(d / "source.wav")],
                check=True, capture_output=True, text=True)
        (d / "source.wav").unlink()
    except subprocess.CalledProcessError as e:
        tail = (e.stderr or "").strip().splitlines()
        jobs[song_id] = ("error", tail[-1] if tail else "failed")
        return
    except Exception as e:  # keep the failure visible in the UI instead of a dead thread
        jobs[song_id] = ("error", str(e))
        return
    jobs[song_id] = ("analyzing", None)
    try:
        analysis(stem_dir(d))
    except Exception as e:  # the song still plays without key/BPM, and /api/analysis retries lazily
        print(f"analysis failed for {song_id}: {e}", file=sys.stderr)
    jobs.pop(song_id)


def stem_dir(d):
    """Each song folder holds the output of whichever model split it."""
    return next((d / m for m in MODELS if (d / m).exists()), None)


def song_dirs():
    # POST writes meta.json right after mkdir; requiring it hides a folder caught in between
    return [d for d in SONGS.iterdir() if ID_RE.match(d.name) and (d / "meta.json").exists()]


def song(d):
    """The API's Song for one song folder."""
    meta, sd = read_meta(d), stem_dir(d)
    stems = sorted(p.stem for p in sd.glob("*.wav")) if sd else []
    status, error = jobs.get(d.name) or (("done", None) if stems else ("error", "interrupted"))
    cached = d / "analysis.json"
    return {"id": d.name, "title": meta["title"], "artist": meta["artist"],
            "cover": f"/covers/{d.name}.jpg" if (d / "cover.jpg").exists() else None,
            "duration": meta["duration"], "addedAt": meta["addedAt"], "status": status, "error": error,
            "model": sd.name if sd else None, "stems": stems,
            "analysis": json.loads(cached.read_text()) if cached.exists() else None,
            "keyOverride": meta.get("keyOverride")}


# ---------- playlists ----------
# One JSON file holds every playlist. An entry is a song plus the practice settings it opens with.
PLAYLISTS = SONGS / "playlists.json"
playlists_lock = threading.Lock()  # handlers run on threads; read-modify-write must not interleave


def load_playlists():
    return json.loads(PLAYLISTS.read_text()) if PLAYLISTS.exists() else []


def number(v, lo, hi):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not lo <= v <= hi:
        raise ValueError(f"expected a number from {lo} to {hi}")
    return v


def clean_entry(e):
    """Validate one entry from the browser and return only the known fields."""
    sid = e.get("songId")
    if not (isinstance(sid, str) and ID_RE.match(sid) and (SONGS / sid / "meta.json").exists()):
        raise ValueError("unknown song")
    pitch = e.get("pitch", 0)
    if type(pitch) is not int or not -6 <= pitch <= 6:
        raise ValueError("pitch must be a whole number from -6 to 6")
    mix = e.get("mix")
    if mix is not None:
        if not isinstance(mix, dict) or len(mix) > 6 or not all(isinstance(k, str) and STEM_RE.match(k) for k in mix):
            raise ValueError("bad mix")
        mix = {k: {"vol": number(m.get("vol"), 0, 1), "mute": m.get("mute") is True, "solo": m.get("solo") is True}
               for k, m in mix.items()}
    loop = e.get("loop")
    if loop is not None:
        a, b = number(loop.get("a"), 0, 3600), number(loop.get("b"), 0, 3600)
        if a >= b:
            raise ValueError("loop start must be before its end")
        loop = {"on": loop.get("on") is not False, "a": a, "b": b}
    eid = e.get("id")
    return {"id": eid if isinstance(eid, str) and ID_RE.match(eid) else f"{time.time_ns():x}",
            "songId": sid, "tempo": number(e.get("tempo", 1), 0.5, 1.5), "pitch": pitch, "mix": mix, "loop": loop}


def clean_playlist(body, current=None):
    name = body.get("name", current and current["name"])
    if not isinstance(name, str) or not name.strip() or len(name) > 100:
        raise ValueError("name must be 1 to 100 characters")
    entries = body.get("entries", current["entries"] if current else [])
    if not isinstance(entries, list) or len(entries) > 500:
        raise ValueError("entries must be a list of at most 500")
    return {"id": current["id"] if current else f"{time.time_ns():x}", "name": name.strip(),
            "createdAt": current["createdAt"] if current else int(time.time() * 1000),
            "entries": [clean_entry(e) for e in entries]}


def migrate():
    """Turn title.txt folders into meta.json ones, then look their videos up in the background."""
    for t in SONGS.glob("*/title.txt"):
        if not (t.parent / "meta.json").exists():
            write_json(t.parent / "meta.json", new_meta(t.parent.name, t.read_text().strip()))
        t.unlink()
    # songs added through POST store their url from the start, so a missing one marks a migrated song
    legacy = [d for d in song_dirs() if read_meta(d)["url"] is None]
    threading.Thread(target=backfill, args=(legacy,), daemon=True).start()


def backfill(dirs):
    for d in dirs:
        meta = read_meta(d)
        try:
            info = fetch(d, f"ytsearch1:{meta['title']}", "--skip-download")
            # keep the title the song was downloaded under; the search hit may be another upload
            write_json(d / "meta.json", {**meta, **info, "title": meta["title"]})
        except Exception as e:  # cosmetic, so the song just stays coverless
            print(f"cover lookup failed for {d.name}: {e}", file=sys.stderr)


class Handler(BaseHTTPRequestHandler):
    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, ctype):
        if not path.is_file():
            return self.send_error(404)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(path.stat().st_size))
        self.end_headers()
        with path.open("rb") as f:  # stream instead of holding a ~50 MB WAV in memory
            shutil.copyfileobj(f, self.wfile)

    def do_GET(self):
        path = self.path.partition("?")[0]
        if path in STATIC:
            name, ctype = STATIC[path]
            return self.send_file(WEB / name, ctype)
        if path == "/api/playlists":
            return self.send_json(load_playlists())
        if path == "/api/songs":
            return self.send_json(sorted(map(song, song_dirs()), key=lambda s: s["addedAt"], reverse=True))
        m = re.match(r"^/covers/([^/]+)\.jpg$", path)
        if m and ID_RE.match(m[1]):
            return self.send_file(SONGS / m[1] / "cover.jpg", "image/jpeg")
        m = re.match(r"^/api/analysis/([^/]+)$", path)
        if m and ID_RE.match(m[1]) and (sd := stem_dir(SONGS / m[1])):
            return self.send_json(analysis(sd))
        m = re.match(r"^/stems/([^/]+)/([^/]+)\.wav$", path)
        if m and ID_RE.match(m[1]) and STEM_RE.match(m[2]):
            sd = stem_dir(SONGS / m[1])
            src = sd / f"{m[2]}.wav" if sd else None
            if not src or not src.exists():
                return self.send_error(404)
            return self.send_file(src, "audio/wav")
        self.send_error(404)

    def body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"null")

    def edit_playlists(self, change):
        """Run change(playlists) -> (playlists, reply) under the lock and save; ValueError becomes a 400."""
        try:
            with playlists_lock:
                pls, reply = change(load_playlists())
                write_json(PLAYLISTS, pls)
        except (ValueError, AttributeError, TypeError) as e:
            return self.send_json({"error": str(e)}, 400)
        except LookupError:
            return self.send_error(404)
        self.send_json(reply)

    def do_POST(self):
        if self.path == "/api/playlists":
            def create(pls):
                pl = clean_playlist(self.body() or {})
                return [*pls, pl], pl
            return self.edit_playlists(create)
        if self.path != "/api/separate":
            return self.send_error(404)
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        url = str(body.get("url", "")).strip()
        model = body.get("model", "htdemucs_ft")
        if model not in MODELS:
            return self.send_json({"error": "unknown model"}, 400)
        if not url.startswith(("http://", "https://")):
            return self.send_json({"error": "need an http(s) URL"}, 400)
        song_id = f"{time.time_ns():x}"
        (SONGS / song_id).mkdir(parents=True)
        write_json(SONGS / song_id / "meta.json", new_meta(song_id, url, url))
        jobs[song_id] = ("queued", None)
        threading.Thread(target=separate, args=(song_id, url, model), daemon=True).start()
        self.send_json({"id": song_id})

    def do_PUT(self):
        """Replace a playlist's name/entries, or set a song's key by hand ({tonic: 0-11, mode}, null clears it)."""
        p = re.match(r"^/api/playlists/([0-9a-f]+)$", self.path)
        if p:
            def update(pls):
                i = next((i for i, pl in enumerate(pls) if pl["id"] == p[1]), None)
                if i is None:
                    raise LookupError(p[1])
                pls[i] = clean_playlist(self.body() or {}, pls[i])
                return pls, pls[i]
            return self.edit_playlists(update)
        m = re.match(r"^/api/songs/([^/]+)/key$", self.path)
        d = SONGS / m[1] if m and ID_RE.match(m[1]) else None
        if not (d and (d / "meta.json").exists()):
            return self.send_error(404)
        try:
            key = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"null")
        except ValueError:
            return self.send_error(400)
        if key is not None and not (isinstance(key, dict) and key.get("tonic") in range(12)
                                    and type(key["tonic"]) is int and key.get("mode") in ("major", "minor")):
            return self.send_json({"error": "key must be {tonic: 0-11, mode: major|minor} or null"}, 400)
        meta = read_meta(d)
        meta["keyOverride"] = key and {"tonic": key["tonic"], "mode": key["mode"]}
        write_json(d / "meta.json", meta)
        self.send_json(song(d))

    def do_DELETE(self):
        p = re.match(r"^/api/playlists/([0-9a-f]+)$", self.path)
        if p:
            return self.edit_playlists(lambda pls: ([pl for pl in pls if pl["id"] != p[1]], {"ok": True}))
        m = re.match(r"^/api/songs/([^/]+)$", self.path)
        d = SONGS / m[1] if m and ID_RE.match(m[1]) else None
        if not (d and (d / "meta.json").exists()) or song(d)["status"] not in ("done", "error"):
            return self.send_error(400)
        jobs.pop(d.name, None)
        shutil.rmtree(d)
        with playlists_lock:  # a deleted song leaves every playlist it was in
            if PLAYLISTS.exists():
                write_json(PLAYLISTS, [{**pl, "entries": [e for e in pl["entries"] if e["songId"] != d.name]} for pl in load_playlists()])
        self.send_json({"ok": True})


if __name__ == "__main__":
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found (yt-dlp needs it): brew install ffmpeg")
    SONGS.mkdir(exist_ok=True)
    migrate()
    print("http://localhost:8000")
    ThreadingHTTPServer(("127.0.0.1", 8000), Handler).serve_forever()
