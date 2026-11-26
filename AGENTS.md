# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor, Copilot, Gemini CLI and others). People should read [README.md](README.md) instead.

OpenMoises is a local web app. A Python server (`backend/server.py`) downloads a song from YouTube with yt-dlp, separates it into stems with Demucs, and serves a browser mixer from `web/`. Everything runs on the user's machine.

Pick your task:

- **Install and run OpenMoises for a user**: follow [Install for a user](#install-for-a-user).
- **Change the code**: read [Working on the code](#working-on-the-code).

## Install for a user

The user may not be technical. Do each step yourself, explain each one in a sentence of plain language, and ask before anything that needs their password or installs system software. Each step has a check. Move on only when the check passes.

1. **Platform.** Run `uname -sm`. Continue on `Darwin arm64` (Apple Silicon Mac, the only tested platform). On `Darwin x86_64` (Intel Mac), stop and tell the user it isn't supported, because Demucs pins an old torch there. On Linux or Windows, warn that separation runs on the CPU, is slower, and is untested, then continue if they agree.
2. **Homebrew** (macOS only). Check: `brew --version` prints a version. If not, ask the user, then install it from https://brew.sh. The installer needs their password, so they must type it into an interactive terminal. Afterwards run the shell setup lines the installer prints under "Next steps" (on Apple Silicon: `eval "$(/opt/homebrew/bin/brew shellenv)"`, also appended to `~/.zprofile`).
3. **Tools.** Run `brew install uv ffmpeg git`, or the user's package manager on Linux and Windows. Check: `uv --version`, `ffmpeg -version` and `git --version` each print a version.
4. **Code.** Clone into the user's home folder unless they choose a different place: `git clone https://github.com/pirayan20/OpenMoises.git ~/OpenMoises`. If the folder already exists, run `git pull` in it instead. Check: `~/OpenMoises/backend/server.py` exists.
5. **Dependencies.** In the repo root, run `uv sync`. uv installs Python 3.11 and the exact versions in `uv.lock` (about 1 GB, mostly torch). Check: the command exits 0.
6. **Start.** In the repo root, run `uv run backend/server.py` as a long-running background process, or `just start` if `just` is installed. Check: `curl -sf http://localhost:8000/ >/dev/null` succeeds.
7. **Hand over.** Tell the user:
   - Open http://localhost:8000 and paste a YouTube link.
   - The first separation also downloads the Demucs model (up to about 450 MB for all three), so it takes longer.
   - How to start it again later (`cd ~/OpenMoises && uv run backend/server.py`) and how to stop it (Control+C in that terminal, or `just stop`).

If a step fails, see the Troubleshooting section of the README, then report the exact error to the user.

## Working on the code

### Layout

- `backend/server.py`: standard-library HTTP server on `127.0.0.1:8000`. It serves the song API, runs yt-dlp and Demucs as subprocesses, and serves static files.
- `backend/analyze.py`: key and BPM detection. It runs as a subprocess so librosa's memory is freed afterwards.
- `web/`: plain HTML, CSS and ES modules. There is no build step and no framework. `web/vendor/` holds vendored libraries; `web/vendor/README.md` explains how each was built.
- `tests/*.cjs`: Playwright browser tests against the running server.
- `songs/`: the user's library, one folder per song, plus `playlists.json`. It is git-ignored user data.

### Rules

- **Preserve `songs/`.** It holds the user's separated songs and setlists. Read from it freely; move, rewrite or delete only what the user asks for.
- **Register new static files.** The server serves only paths listed in the `STATIC` map in `backend/server.py`. A new file in `web/` returns 404 until you add it there.
- **Change dependencies with uv.** Use `uv add` and `uv remove` so `uv.lock` stays in sync. Keep torch and torchaudio below 2.9: torchaudio 2.9 moved audio saving to torchcodec, which Demucs 4 doesn't use.
- **Match the existing style.** Standard library first, small functions, short comments. Code marks deliberate shortcuts with `ponytail:` comments that name the limit.

### Tests

Start the server first, because the tests load the app from `localhost:8000`.

```bash
uv run backend/server.py &
npm install && npx playwright install chromium   # first time only
npm test                     # UI, Studio animation, setlists (mocked audio)
npm run test:realtime        # optional, needs at least one song in songs/
uv run backend/analyze.py    # key and BPM self-check
```

A change is done when `npm test` and the `analyze.py` self-check pass, and when any UI change has been checked in a browser at http://localhost:8000.
