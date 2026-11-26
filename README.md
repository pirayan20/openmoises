<img src="web/assets/openmoises-logo.png" width="96" alt="OpenMoises logo">

# OpenMoises

A local, open-source practice app for musicians. Paste a YouTube link and OpenMoises splits the song into stems (drums, bass, vocals, other, and optionally guitar and piano) on your own machine. Then play along in the browser with per-stem volume, mute and solo, live tempo and key changes, A-B looping, and detected key and BPM. Setlists remember the tempo, key, mix and loop you practise each song with. There are no monthly limits because nothing leaves your computer.

https://github.com/user-attachments/assets/f48e871f-3594-4f7e-a68d-f1b4ca14be57

## If you're an AI agent, read this

Using a coding agent such as Claude Code, Codex or Cursor? Ask it: *"Set up OpenMoises for me by following https://github.com/pirayan20/OpenMoises/blob/main/AGENTS.md"*. Agents working in this repo should follow [AGENTS.md](AGENTS.md).

## Requirements

- A Mac with Apple Silicon (M1, M2, M3, M4 or newer). To check, open the Apple menu > **About This Mac** and look for "Chip: Apple M…". Intel Macs aren't supported because Demucs pins an old torch there. The lockfile also resolves for Linux and Windows, where separation runs on the CPU and is slower, but only Apple Silicon is tested.
- About 2 GB of free disk space for the app and its separation models, plus roughly 40 MB per minute of audio for each song you add.
- An internet connection for the first setup and for downloading songs.

You'll also install three free tools during setup. You don't need to know how they work:

- [Homebrew](https://brew.sh): installs the other tools for you.
- [uv](https://docs.astral.sh/uv/): runs the app and installs the right Python version and libraries.
- [ffmpeg](https://ffmpeg.org): converts audio.

## Setup

You only need to do this once. Every command below goes into **Terminal**. Open it with <kbd>⌘ Command</kbd> + <kbd>Space</kbd>, type `Terminal`, and press <kbd>Return</kbd>. To run a command, copy it, paste it into Terminal, and press <kbd>Return</kbd>.

### 1. Install Homebrew

Skip this step if `brew --version` already prints a version number.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

- When it asks for a password, type your Mac login password and press <kbd>Return</kbd>. Terminal doesn't show the characters as you type. That's normal.
- If a window asks to install the "command line developer tools", click **Install**. These include `git`, which step 3 uses.
- When it finishes, it prints a **Next steps** section. Run the commands it shows there. On Apple Silicon they are usually:

  ```bash
  echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
  eval "$(/opt/homebrew/bin/brew shellenv)"
  ```

### 2. Install uv, ffmpeg and git

```bash
brew install uv ffmpeg git
```

### 3. Download OpenMoises

This puts OpenMoises in a folder called `OpenMoises` in your home folder:

```bash
cd ~
git clone https://github.com/pirayan20/OpenMoises.git
```

No git? Click the green **Code** button on this page, choose **Download ZIP**, and double-click the ZIP to unzip it. Then move the folder to your home folder and rename it to `OpenMoises`.

### 4. Start OpenMoises

```bash
cd ~/OpenMoises
uv run backend/server.py
```

The first start takes a few minutes while uv installs everything. It's ready when Terminal prints `http://localhost:8000`. Then open http://localhost:8000 in your browser.

The first time you separate a song, OpenMoises downloads the separation model, so that song takes a little longer.

## Everyday use

- **Start:** open Terminal and run `cd ~/OpenMoises && uv run backend/server.py`, then open http://localhost:8000.
- **Stop:** click the Terminal window and press <kbd>Control</kbd> + <kbd>C</kbd>, or just close Terminal.
- **Update to the latest version:** run `cd ~/OpenMoises && git pull`, then start it again.

Your songs are stored in `~/OpenMoises/songs`. Updating never deletes them.

### Run in the background (optional)

If you'd rather not keep a Terminal window open, install [just](https://github.com/casey/just) with `brew install just` and use:

```bash
cd ~/OpenMoises
just start   # uv sync, then start the server on :8000 (logs in .run/server.log)
just stop    # stop the server started by just start
```

## Troubleshooting

- **`command not found: brew`:** run the two "Next steps" commands from step 1, or close Terminal and open it again.
- **`command not found: uv` or `ffmpeg`:** run step 2 again.
- **`Address already in use`:** OpenMoises is already running, maybe in another Terminal window or from `just start`. Open http://localhost:8000, or run `just stop` first.
- **The page doesn't load:** make sure Terminal is still open and running the server, and that the address is exactly `http://localhost:8000`.

## Project layout

```
backend/
  server.py     HTTP server: song library API, YouTube download, Demucs separation, static files
  analyze.py    key and BPM detection from the stems (runs as a subprocess)
web/
  index.html    markup
  style.css
  app.js        audio engine, library, routing, views
  home-bg.js    animated WebGL background on the home screen
  vendor/       Signalsmith Stretch (real-time tempo and pitch), three.js
tests/
  ui.cjs                 browser test of routes, Studio, layout, playback (mocked audio)
  studio-animation.cjs   Studio open and close transitions
  playlists.cjs          setlists: sidebar limits, save from Studio, play with saved settings, reorder, delete
  realtime.cjs           real stems stay in sync and keep up in real time (needs a song in the library)
songs/          your library, one folder per song, plus playlists.json (not committed)
pyproject.toml  Python dependencies; uv.lock pins exact versions
justfile        just start / just stop for a background server
```

## Separation models

| Option | Demucs model | Stems | Time for a 4.5 minute song on an M-series Mac |
|---|---|---|---|
| Fast | `htdemucs` | 4 | about 25 s |
| HQ (default) | `htdemucs_ft` | 4, cleaner | about 1.5 min |
| 6 stems | `htdemucs_6s` | adds guitar and piano | about 25 s |

## Tests

```bash
npm install
npx playwright install chromium
uv run backend/server.py &             # the tests load the app from localhost:8000
npm test
npm run test:realtime                  # optional, uses a real song from your library
uv run backend/analyze.py              # key and BPM self-check
```

## Credits

- [Demucs](https://github.com/facebookresearch/demucs) (MIT) separates the stems.
- [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/) (MIT) changes tempo and pitch in real time.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense) downloads the audio.
- [librosa](https://librosa.org/) (ISC) detects key and tempo.
- [three.js](https://threejs.org/) (MIT) draws the home screen background.

## Use responsibly

OpenMoises is for personal practice. Only process music you have the right to use, and respect YouTube's Terms of Service.

## License

[MIT](LICENSE) © 2026 Pirayan Rananand
