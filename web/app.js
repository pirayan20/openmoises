// Tables. Key order of STEMS is lane order.
const STEMS = { bass: '#ff9f0a', drums: '#ff453a', vocals: '#30d158', other: '#40c8e0', guitar: '#ff375f', piano: '#5e5ce6' };
const MODELS = {
  htdemucs:    { label: 'Fast', name: 'Demucs Fast', badge: '4 stems', hint: 'Four stems. Faster processing.' },
  htdemucs_ft: { label: 'HQ', name: 'Demucs HQ', badge: 'Recommended', hint: 'Fine-tuned four stems. Slower, more detailed.' },
  htdemucs_6s: { label: '6 stems', name: 'Demucs 6 stems', badge: '6 stems', hint: 'Six stems, including guitar and piano.' },
};
const STATUS = { queued: 'Queued', downloading: 'Downloading', separating: 'Separating stems', analyzing: 'Detecting key and tempo' };
const PRESETS = {
  bass:   { label: 'Bass practice', vol: n => n === 'bass' || n === 'drums' ? 1 : 0.25 },
  noBass: { label: 'Play along',    vol: n => n === 'bass' ? 0 : 1 },
  all:    { label: 'Full mix',      vol: () => 1 },
};
const NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const signed = n => (n > 0 ? '+' : '') + n;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const icon = id => `<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;
const keyName = (tonic, mode) => `${NOTES[tonic]} ${mode}`;
// a key the user set by hand wins over the detected one
const keyOf = s => s.keyOverride ?? s.analysis;
const rank = n => n in STEMS ? Object.keys(STEMS).indexOf(n) : 99;
const defaultPreset = () => localStorage.preset in PRESETS ? localStorage.preset : 'bass';
// the preset a mix matches exactly, if any
const presetOf = (mix, stems) => Object.keys(PRESETS).find(k => stems.every(n => {
  const m = mix[n];
  return m && !m.mute && !m.solo && m.vol === PRESETS[k].vol(n);
}));

const PEAKS = 2048; // more than any lane has bars, so drawWave only ever merges peaks
function peaksOf(buf) {
  const data = buf.getChannelData(0), step = Math.floor(data.length / PEAKS), out = new Float32Array(PEAKS);
  for (let i = 0; i < PEAKS; i++) {
    let m = 0;
    for (let j = i * step, e = j + step; j < e; j += 16) m = Math.max(m, Math.abs(data[j])); // ponytail: every 16th sample, plenty for display
    out[i] = m;
  }
  return out;
}

// ---------- engine: the one player every view reads ----------
// Each stem plays through its own Signalsmith Stretch node, which time-stretches and pitch-shifts
// in real time, so tempo/key changes are instant and nothing is re-rendered or stored.
// Positions are in song seconds, which is also the nodes' input time.
const engine = {
  phase: 'empty', // 'empty' | 'loading' | 'paused' | 'playing'
  song: null,
  stems: [],
  duration: 0,
  peaks: null,    // stem -> Float32Array of PEAKS max-abs values, for waveforms
  want: { tempo: 1, pitch: 0 },
  loop: { on: false, a: 0, b: 0 },
  mix: {},        // stem -> { vol, mute, solo }
  volume: 1,
  resume: false,  // whether to play once the current load finishes
  ended: null,
  ctx: null, master: null, gains: {}, nodes: {}, meters: {}, lead: 0.1,
  startedAt: 0, startPos: 0, gen: 0, endTimer: 0,

  wantsPlay() { return this.phase === 'playing' || (this.phase === 'loading' && this.resume); },

  // stem -> loudness (RMS, 0..1) of what is audible right now, after mute/solo/volume; read by the Home visuals
  levels() {
    const out = {}, buf = this.levelBuf ??= new Float32Array(512);
    if (this.phase !== 'playing') return out;
    for (const [n, m] of Object.entries(this.meters)) {
      m.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      out[n] = Math.sqrt(sum / buf.length);
    }
    return out;
  },

  pos() {
    if (this.phase !== 'playing') return this.startPos;
    let p = this.startPos + Math.max(0, this.ctx.currentTime - this.startedAt) * this.want.tempo;
    const { on, a, b } = this.loop;
    if (on && p >= b) p = a + (p - a) % (b - a);
    return clamp(p, 0, this.duration);
  },

  // `settings` ({tempo, pitch, mix, loop}, from a playlist entry) replaces the defaults the song opens with
  async load(song, autoplay, settings = null) {
    this.pause();
    const gen = ++this.gen;
    if (!this.ctx) {
      // Buffers decode at the context rate; the stems are 44.1 kHz, so a 96 kHz device default would double their memory.
      // 'playback' = bigger output buffer, so the stretch worklets survive the scheduling jitter
      // Chrome/macOS add when the window loses focus (the default 'interactive' buffer underruns and crackles).
      this.ctx = new AudioContext({ sampleRate: 44100, latencyHint: 'playback' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (autoplay) this.ctx.resume(); // still inside the click, so the autoplay policy allows it
    this.release();
    this.song = song;
    this.stems = [...song.stems].sort((x, y) => rank(x) - rank(y));
    this.gains = Object.fromEntries(this.stems.map(n => {
      const g = this.ctx.createGain();
      g.connect(this.master);
      return [n, g];
    }));
    this.meters = Object.fromEntries(this.stems.map(n => {
      const m = this.ctx.createAnalyser();
      m.fftSize = 512;
      this.gains[n].connect(m);
      return [n, m];
    }));
    Object.assign(this, {
      duration: song.duration ?? 0, peaks: null, want: { tempo: 1, pitch: 0 },
      loop: { on: false, a: 0, b: 0 }, startPos: 0, phase: 'loading', resume: autoplay,
    });
    this.applyPreset(defaultPreset());
    if (settings) this.applySettings(settings);
    if (!song.analysis) {
      fetch(`/api/analysis/${song.id}`).then(r => r.ok ? r.json() : null).then(a => { song.analysis ??= a; }, () => {});
    }
    const loaded = await Promise.all(this.stems.map(n => this.loadStem(n))).catch(err => { console.error(err); return null; });
    if (gen !== this.gen) {
      for (const node of loaded ?? []) node?.disconnect();
      return;
    }
    if (!loaded) return this.unload();
    this.nodes = Object.fromEntries(this.stems.map((n, i) => [n, loaded[i].node]));
    this.peaks = Object.fromEntries(this.stems.map((n, i) => [n, loaded[i].peaks]));
    this.duration = loaded[0].duration;
    this.lead = Math.max(0.05, await this.nodes[this.stems[0]].latency());
    this.settle();
  },

  async loadStem(n) {
    const r = await fetch(`/stems/${this.song.id}/${n}.wav`);
    if (!r.ok) throw new Error(`${n}.wav: HTTP ${r.status}`);
    const buf = await this.ctx.decodeAudioData(await r.arrayBuffer());
    const node = await SignalsmithStretch(this.ctx);
    // copies are transferred to the worklet, so the decoded AudioBuffer can be garbage-collected
    const chans = [0, 1].map(c => new Float32Array(buf.getChannelData(Math.min(c, buf.numberOfChannels - 1))));
    await node.addBuffers(chans, chans.map(c => c.buffer));
    node.connect(this.gains[n]);
    return { node, peaks: peaksOf(buf), duration: buf.duration };
  },

  release() {
    for (const node of Object.values(this.nodes)) { node.schedule({ active: false }); node.dropBuffers(); node.disconnect(); }
    for (const g of Object.values(this.gains)) g.disconnect();
    this.nodes = {};
    this.meters = {};
  },

  unload() {
    this.pause();
    this.gen++;
    this.release();
    Object.assign(this, { song: null, peaks: null, phase: 'empty' });
  },

  settle() {
    this.phase = 'paused';
    if (this.resume) this.play();
  },

  // Tell every node to play from `input` at context time `at` with the current tempo, key and loop.
  // One shared schedule keeps the stems locked together.
  run(at, input) {
    const { on, a, b } = this.loop;
    for (const node of Object.values(this.nodes)) {
      node.schedule({ active: true, output: at, input, rate: this.want.tempo, semitones: this.want.pitch,
        loopStart: on ? a : 0, loopEnd: on ? b : 0 });
    }
    Object.assign(this, { startedAt: at, startPos: input, phase: 'playing' });
    clearTimeout(this.endTimer);
    if (!on) this.endTimer = setTimeout(() => this.end(), ((this.duration - input) / this.want.tempo + at - this.ctx.currentTime) * 1000);
  },

  play() {
    if (this.phase !== 'paused') return;
    this.ctx.resume();
    const { on, a, b } = this.loop;
    if (on && (this.startPos < a || this.startPos >= b)) this.startPos = a;
    if (this.startPos >= this.duration) this.startPos = 0;
    this.run(this.ctx.currentTime + this.lead, this.startPos);
  },

  pause() {
    if (this.phase !== 'playing') return;
    clearTimeout(this.endTimer);
    this.startPos = this.pos();
    const at = this.ctx.currentTime;
    for (const node of Object.values(this.nodes)) node.schedule({ active: false, output: at });
    this.phase = 'paused';
  },

  toggle() {
    if (this.phase === 'playing') this.pause();
    else if (this.phase === 'paused') this.play();
    else if (this.phase === 'loading') this.resume = !this.resume;
  },

  end() {
    this.pause();
    this.startPos = 0;
    this.ended?.();
  },

  seek(p) {
    const was = this.phase === 'playing';
    this.pause();
    this.startPos = clamp(p, 0, this.duration);
    if (was) this.play();
  },

  restart() {
    if (this.phase === 'playing') { this.pause(); this.play(); }
  },

  setLoop(a, b) {
    this.loop = { on: Math.abs(b - a) > 0.2, a: Math.min(a, b), b: Math.max(a, b) };
    this.restart();
  },
  toggleLoop() {
    if (this.loop.b <= this.loop.a) return;
    this.loop.on = !this.loop.on;
    this.restart();
  },
  setA() { const p = this.pos(); this.setLoop(p, Math.max(p + 1, this.loop.b)); },
  setB() { const p = this.pos(); this.setLoop(Math.min(this.loop.a, p), p); },

  nudgeTempo(d) {
    if (!this.peaks) return;
    // with a detected BPM step 1 BPM at a time, otherwise 5%
    const bpm = this.song.analysis?.bpm;
    const next = bpm ? (Math.round(bpm * this.want.tempo) + d) / bpm : this.want.tempo + d * 0.05;
    this.retune({ tempo: clamp(next, 0.5, 1.5) });
  },
  nudgePitch(d) {
    if (!this.peaks) return;
    this.retune({ pitch: clamp(this.want.pitch + d, -6, 6) });
  },
  // Change tempo/key in place: the nodes pick up the new rate from where the song is right now.
  retune(patch) {
    const p = this.pos();
    this.want = { ...this.want, ...patch };
    if (this.phase === 'playing') this.run(this.ctx.currentTime, p);
  },

  gain(n) {
    const m = this.mix[n], solo = this.stems.some(s => this.mix[s].solo);
    return m.mute || (solo && !m.solo) ? 0 : m.vol;
  },
  applyMix() {
    for (const n of this.stems) this.gains[n].gain.setTargetAtTime(this.gain(n), this.ctx.currentTime, 0.01);
  },
  setMix(n, patch) {
    Object.assign(this.mix[n], patch);
    this.applyMix();
  },
  applyPreset(name) {
    localStorage.preset = name;
    this.mix = Object.fromEntries(this.stems.map(n => [n, { vol: PRESETS[name].vol(n), mute: false, solo: false }]));
    this.applyMix();
  },
  preset() { return presetOf(this.mix, this.stems); },

  // What a playlist entry stores, and how it comes back. A null mix means "the default preset".
  snapshot() {
    const { a, b, on } = this.loop;
    return { tempo: +this.want.tempo.toFixed(4), pitch: this.want.pitch, mix: structuredClone(this.mix), loop: b > a ? { on, a, b } : null };
  },
  applySettings({ tempo = 1, pitch = 0, mix = null, loop = null }) {
    this.want = { tempo, pitch };
    this.loop = loop ? { ...loop } : { on: false, a: 0, b: 0 };
    this.mix = Object.fromEntries(this.stems.map(n => [n, mix?.[n] ? { ...mix[n] } : { vol: PRESETS[defaultPreset()].vol(n), mute: false, solo: false }]));
    if (this.ctx) this.applyMix();
  },
  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  },
};

// ---------- library ----------
const library = {
  songs: [],
  rev: 0,  // bumps when the server's list changed, so views rebuild lists only then
  text: '',
  timer: 0,
  async refresh() {
    clearTimeout(this.timer);
    try {
      const text = await (await fetch('/api/songs')).text();
      if (text !== this.text) Object.assign(this, { text, songs: JSON.parse(text), rev: this.rev + 1 });
    } catch (err) {
      console.error(err);
    }
    if (this.songs.some(s => s.status in STATUS)) this.timer = setTimeout(() => this.refresh(), 2000);
  },
  get(id) { return this.songs.find(s => s.id === id); },
  playable() { return this.songs.filter(s => s.status === 'done'); },
};

// Playlists are setlists: each entry is a song plus the tempo, key, mix and loop it opens with.
const playlists = {
  items: [],
  rev: 0,
  async refresh() {
    try {
      this.items = await (await fetch('/api/playlists')).json();
      this.rev++;
    } catch (err) {
      console.error(err);
    }
  },
  get(id) { return this.items.find(p => p.id === id); },
  async send(method, url, body) {
    const r = await fetch(url, { method, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
    await this.refresh();
    return out;
  },
  create(name, entries = []) { return this.send('POST', '/api/playlists', { name, entries }); },
  update(id, patch) { return this.send('PUT', `/api/playlists/${id}`, patch); },
  remove(id) { return this.send('DELETE', `/api/playlists/${id}`); },
  add(id, entry) { return this.update(id, { entries: [...this.get(id).entries, entry] }); },
};

// ---------- route ----------
const parseRoute = () => {
  const m = location.hash.match(/^#\/(studio|playlist)\/([0-9a-f]+)$/);
  return m ? { view: m[1], id: m[2] } : { view: location.hash === '#/library' ? 'library' : 'home' };
};
let route = parseRoute();
let mainView = route.view === 'library' ? 'library' : 'home';

let studioReturnFocus = null;
let studioExit = '#/library';
// below 600px the sidebar is a top bar hidden under the Studio page, so it must not take focus
const phone = matchMedia('(max-width: 600px)');
function syncStudioLayout() {
  const open = route.view === 'studio';
  if (open !== document.body.hasAttribute('data-studio')) {
    document.body.toggleAttribute('data-studio-motion', !matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  document.body.toggleAttribute('data-studio', open);
  if (open) ui.modelPicker.open = false;
  ui.home.hidden = mainView !== 'home';
  ui.libraryView.hidden = mainView !== 'library';
  ui.playlistView.hidden = mainView !== 'playlist';
  ui.studio.inert = !open;
  ui.studio.setAttribute('aria-hidden', String(!open));
  ui.main.inert = open;
  ui.sidebar.inert = open && phone.matches;
  for (const node of [ui.heroStudio, ui.barStudio]) {
    node.setAttribute('aria-controls', 'studio');
    node.setAttribute('aria-expanded', String(open));
  }
  setSidebarWidth(sidebarWidth);
  if (open && !ui.studio.contains(document.activeElement) && !ui.bar.contains(document.activeElement) && !ui.sidebar.contains(document.activeElement)) ui.closeStudio.focus();
}
addEventListener('transitionend', e => {
  if (e.target === document.body && e.propertyName === 'grid-template-columns') document.body.removeAttribute('data-studio-motion');
});

phone.addEventListener('change', syncStudioLayout);

function openRoute() {
  const wasOpen = document.body.hasAttribute('data-studio');
  route = parseRoute();
  if (route.view === 'playlist' && !playlists.get(route.id)) {
    location.replace('#/library');
    return;
  }
  if (route.view !== 'studio') {
    studioExit = route.view === 'playlist' ? '#/playlist/' + route.id : route.view === 'library' ? '#/library' : '#/';
    if (mainView !== route.view || route.view === 'playlist') ui.main.scrollTop = 0;
    mainView = route.view;
    ui.modelPicker.open = false;
  }
  if (route.view === 'studio') {
    const s = library.get(route.id);
    if (s?.status !== 'done') {
      location.replace(studioExit);
      return;
    }
    if (!wasOpen) {
      studioReturnFocus = document.activeElement;
    }
    if (engine.song?.id !== route.id) engine.load(s, false);
  }
  syncStudioLayout();
  if (route.view === 'studio' && !wasOpen) ui.closeStudio.focus();
  else if (wasOpen && route.view !== 'studio') {
    const target = studioReturnFocus?.isConnected && studioReturnFocus !== document.body && studioReturnFocus.getClientRects().length ? studioReturnFocus : route.view === 'home' ? ui.navHome : ui.navLibrary;
    target.focus();
  }
}

// ---------- commands ----------
// What prev/next/end walk through: a playlist while one is playing, otherwise the library.
// The queue points at an entry id, so reordering or editing the playlist doesn't lose the place.
let queue = null; // { playlistId, entryId }

function followStudio(s) {
  if (route.view === 'studio') {
    history.replaceState(null, '', '#/studio/' + s.id);
    route = parseRoute();
  }
}

function play(s) {
  if (engine.song?.id === s.id && !queue) return engine.toggle();
  queue = null;
  engine.load(s, true);
  followStudio(s);
}

const queueIndex = () => {
  const pl = queue && playlists.get(queue.playlistId);
  return pl ? pl.entries.findIndex(e => e.id === queue.entryId) : -1;
};

function playEntry(playlistId, index, autoplay = true) {
  const e = playlists.get(playlistId)?.entries[index], s = e && library.get(e.songId);
  if (s?.status !== 'done') return;
  queue = { playlistId, entryId: e.id };
  if (engine.song?.id === s.id && engine.peaks) { // same song already decoded: just swap its settings
    engine.pause();
    engine.applySettings(e);
    engine.startPos = e.loop?.on ? e.loop.a : 0;
    if (autoplay) engine.play();
  } else engine.load(s, autoplay, e);
  followStudio(s);
}

function neighbor(d) {
  const list = library.playable();
  const index = list.findIndex(s => s.id === engine.song?.id);
  return index < 0 ? undefined : list[index + d];
}

// a function that plays the previous (-1) or next (+1) item, or null at either end
function step(d) {
  if (queue) {
    const pl = playlists.get(queue.playlistId), i = queueIndex() + d;
    return pl && i >= 0 && i < pl.entries.length && library.get(pl.entries[i].songId)?.status === 'done'
      ? () => playEntry(queue.playlistId, i) : null;
  }
  const s = neighbor(d);
  return s ? () => play(s) : null;
}

engine.ended = () => {
  const go = step(1);
  if (queue) go ? go() : (queue = null);
  else if (route.view !== 'studio' && go) go();
};

// Add an entry from the menu: to an existing playlist, or to a new one named after it.
async function addToPlaylist(playlistId, entry) {
  try {
    const pl = playlistId
      ? await playlists.add(playlistId, entry)
      : await playlists.create(nextPlaylistName(), [entry]);
    toast(`Saved to <a href="#/playlist/${pl.id}">${esc(pl.name)}</a>`);
  } catch (err) {
    toast(`Couldn't save: ${esc(err.message)}`);
  }
}
const nextPlaylistName = () => {
  const names = new Set(playlists.items.map(p => p.name));
  let n = playlists.items.length + 1;
  while (names.has(`Setlist ${n}`)) n++;
  return `Setlist ${n}`;
};

async function newPlaylist() {
  const pl = await playlists.create(nextPlaylistName());
  location.hash = '#/playlist/' + pl.id;
  requestAnimationFrame(() => { ui.plName.focus(); ui.plName.select(); });
}

async function savePlaylist(id, entries) {
  try {
    await playlists.update(id, { entries });
  } catch (err) {
    toast(`Couldn't save: ${esc(err.message)}`);
  }
}

// One menu for "add this song to a playlist", opened from a song card or Studio.
let menuEntry = null;
function openPlaylistMenu(anchor, entry, title) {
  menuEntry = entry;
  ui.plMenu.innerHTML = `<p class="menu-title">${esc(title)}</p>`
    + playlists.items.map(p => `<button class="menu-item" data-act="menuPick" data-id="${p.id}">${esc(p.name)}<small>${p.entries.length}</small></button>`).join('')
    + `<hr><button class="menu-item" data-act="menuPick" data-id="">${icon('plus')}New setlist</button>`;
  ui.plMenu.hidden = false;
  const a = anchor.getBoundingClientRect(), m = ui.plMenu.getBoundingClientRect();
  ui.plMenu.style.left = clamp(a.right - m.width, 8, innerWidth - m.width - 8) + 'px';
  ui.plMenu.style.top = (a.bottom + 6 + m.height > innerHeight ? a.top - m.height - 6 : a.bottom + 6) + 'px';
  ui.plMenu.querySelector('.menu-item').focus();
}
function closePlaylistMenu() { ui.plMenu.hidden = true; menuEntry = null; }

let toastTimer = 0;
function toast(html, ms = 3200) {
  ui.toast.innerHTML = html;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, ms);
}

async function remove(s) {
  if (!confirm(`Delete "${s.title}"? Its stems are removed from your Mac.`)) return;
  const r = await fetch('/api/songs/' + s.id, { method: 'DELETE' });
  if (r.ok && engine.song?.id === s.id) {
    engine.unload();
    queue = null;
    if (route.view === 'studio') location.replace(studioExit);
  }
  library.refresh();
  playlists.refresh(); // the server drops the song from every playlist
}

const ACTIONS = {
  play: el => {
    const s = library.get(el.dataset.id);
    if (s?.status === 'done') play(s);
  },
  closeStudio: () => { location.hash = studioExit; },
  scrollDown: () => ui.main.scrollTo({
    top: document.querySelector('.home-shortcuts').offsetTop - 32,
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  }),
  toggle: () => engine.toggle(),
  prev: () => { const go = step(-1); engine.pos() > 3 || !go ? engine.seek(0) : go(); },
  next: () => step(1)?.(),
  newPlaylist: () => newPlaylist(),
  plMore: () => { sideExpanded = !sideExpanded; },
  addTo: el => openPlaylistMenu(el, { songId: el.dataset.id, tempo: 1, pitch: 0, mix: null, loop: null }, 'Add to playlist'),
  saveTo: el => openPlaylistMenu(el, { songId: engine.song.id, ...engine.snapshot() }, 'Save with current settings to'),
  menuPick: el => { const entry = menuEntry; closePlaylistMenu(); if (entry) addToPlaylist(el.dataset.id, entry); },
  plPlay: () => {
    const id = route.id, mine = queue?.playlistId === id && engine.song;
    if (mine) engine.toggle();
    else playEntry(id, 0);
  },
  plStudio: () => {
    const id = route.id;
    if (queue?.playlistId !== id || !engine.song) playEntry(id, 0, false);
    if (engine.song) location.hash = '#/studio/' + engine.song.id;
  },
  plEntry: el => {
    const i = +el.closest('.pl-row').dataset.index;
    if (queue?.playlistId === route.id && queueIndex() === i && engine.song) engine.toggle();
    else playEntry(route.id, i);
  },
  plEntryStudio: el => {
    const i = +el.closest('.pl-row').dataset.index;
    if (!(queue?.playlistId === route.id && queueIndex() === i && engine.song)) playEntry(route.id, i, false);
    const e = playlists.get(route.id).entries[i];
    location.hash = '#/studio/' + e.songId;
  },
  plRemove: el => {
    const pl = playlists.get(route.id), i = +el.closest('.pl-row').dataset.index;
    savePlaylist(pl.id, pl.entries.filter((_, j) => j !== i));
  },
  pickerOpen: () => openPicker(),
  plDelete: async () => {
    const pl = playlists.get(route.id);
    if (!confirm(`Delete "${pl.name}"? The songs stay in your library.`)) return;
    if (queue?.playlistId === pl.id) queue = null;
    await playlists.remove(pl.id);
    location.hash = '#/library';
  },
  delete: el => remove(library.get(el.dataset.id)),
  preset: el => engine.applyPreset(el.dataset.preset),
  mute: el => { const n = el.closest('.lane').dataset.stem; engine.setMix(n, { mute: !engine.mix[n].mute }); },
  solo: el => { const n = el.closest('.lane').dataset.stem; engine.setMix(n, { solo: !engine.mix[n].solo }); },
  loop: () => engine.toggleLoop(),
  setA: () => engine.setA(),
  setB: () => engine.setB(),
  tempo: el => engine.nudgeTempo(+el.dataset.d),
  pitch: el => engine.nudgePitch(+el.dataset.d),
};

const SHORTCUTS = {
  Space: () => engine.toggle(),
  ArrowLeft: () => engine.seek(engine.pos() - 5),
  ArrowRight: () => engine.seek(engine.pos() + 5),
  KeyL: () => engine.toggleLoop(),
};

// ---------- views ----------
const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, el]));

// The views run every frame, so every write is skipped unless its value changed.
function changed(node, key, v) {
  const memo = (node.memo ??= {});
  if (memo[key] === v) return false;
  memo[key] = v;
  return true;
}
const text = (node, v) => changed(node, 'text', v) && (node.textContent = v);
const css = (node, name, v) => changed(node, name, v) && node.style.setProperty(name, v);
const attr = (node, name, v) => changed(node, name, v) && (v == null ? node.removeAttribute(name) : node.setAttribute(name, v));
const prop = (node, name, v) => changed(node, name, v) && (node[name] = v);

// what a search matches against, shared by the Library search and the Add songs picker
const searchText = s => `${s.title} ${s.artist ?? ''}`.toLowerCase();
const art = s => s.cover ? `<img src="${s.cover}" alt="" loading="lazy">` : `<span class="no-art">${icon('music')}</span>`;
const heroSong = () => engine.song ?? library.playable()[0];
const playingId = () => engine.wantsPlay() ? engine.song.id : null;

function libItemHtml(s) {
  const sub = s.status === 'error' ? 'Failed' : STATUS[s.status] ?? s.artist ?? '';
  return `<li data-id="${s.id}">
    <button class="lib-item" data-act="play" data-id="${s.id}" ${s.status === 'done' ? '' : 'disabled'} title="${esc(s.title)}">
      <span class="lib-art">${art(s)}</span>
      <span class="lib-text"><span class="lib-title">${esc(s.title)}</span><span class="lib-sub">${esc(sub)}</span></span>
      <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
    </button></li>`;
}

// Up to four different song covers in a 2×2 grid; one cover fills the tile; none shows the note icon.
function mosaicHtml(pl) {
  const covers = [...new Set(pl.entries.map(e => library.get(e.songId)?.cover).filter(Boolean))];
  if (covers.length >= 4) return `<span class="mosaic">${covers.slice(0, 4).map(c => `<img src="${c}" alt="" loading="lazy">`).join('')}</span>`;
  return covers.length ? `<img src="${covers[0]}" alt="" loading="lazy">` : `<span class="no-art">${icon('music')}</span>`;
}

function sidePlaylistHtml(pl) {
  const n = pl.entries.length;
  return `<li data-id="${pl.id}">
    <a class="lib-item" href="#/playlist/${pl.id}" title="${esc(pl.name)}">
      <span class="lib-art">${mosaicHtml(pl)}</span>
      <span class="lib-text"><span class="lib-title">${esc(pl.name)}</span><span class="lib-sub">${n} song${n === 1 ? '' : 's'}</span></span>
      <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
    </a></li>`;
}

// The chips that say how an entry opens: tempo, key shift, mix and loop.
function entryChips(e, s) {
  const pct = Math.round(e.tempo * 100), preset = e.mix ? presetOf(e.mix, s.stems) : defaultPreset();
  const chips = [
    [pct === 100 ? '' : 'amber', `${pct}%`],
    [e.pitch ? 'blue' : '', `Key ${e.pitch ? signed(e.pitch) : '0'}`],
    [preset === 'bass' ? 'red' : '', preset ? PRESETS[preset].label : 'Custom mix'],
  ];
  if (e.loop) chips.push(['', `Loop ${fmt(e.loop.a)}–${fmt(e.loop.b)}`]);
  return chips.map(([tone, label]) => `<span class="chip ${tone}">${label}</span>`).join('');
}

function entryRowHtml(e, i) {
  const s = library.get(e.songId);
  if (!s) return '';
  const k = keyOf(s), bpm = s.analysis?.bpm;
  const sub = [k && NOTES[(k.tonic + e.pitch + 12) % 12] + (k.mode === 'minor' ? 'm' : ''), bpm && Math.round(bpm * e.tempo) + ' BPM', s.artist]
    .filter(Boolean).join(' · ');
  return `<li class="pl-row" data-index="${i}" draggable="true">
    <span class="pl-num"><span class="pl-n">${i + 1}</span><span class="eq" aria-hidden="true"><i></i><i></i><i></i></span></span>
    <button class="pl-main" data-act="plEntry" aria-label="Play ${esc(s.title)}">
      <span class="pl-art">${art(s)}</span>
      <span class="pl-text"><span class="pl-title">${esc(s.title)}</span><span class="pl-sub">${esc(sub)}</span></span>
    </button>
    <span class="chips">${entryChips(e, s)}</span>
    <span class="pl-len">${s.duration ? fmt(s.duration / e.tempo) : ''}</span>
    <span class="pl-tools">
      <button class="ctrl" data-act="plEntryStudio" aria-label="Open ${esc(s.title)} in Studio with these settings" title="Open in Studio">${icon('studio')}</button>
      <button class="ctrl" data-act="plRemove" aria-label="Remove ${esc(s.title)} from playlist" title="Remove">${icon('minus')}</button>
    </span>
  </li>`;
}

function cardHtml(s) {
  const state = s.status === 'done' ? 'done' : s.status === 'error' ? 'error' : 'busy';
  const t = esc(s.title);
  return `<article class="card" data-id="${s.id}" data-state="${state}">
    <div class="card-art">
      <button class="card-play" data-act="play" data-id="${s.id}" aria-label="Play ${t}" ${state === 'done' ? '' : 'disabled'}>
        ${art(s)}
        ${state === 'done' ? `<span class="badge" aria-hidden="true">${icon('play')}${icon('pause')}</span>` : ''}
      </button>
      ${state === 'busy' ? `<span class="card-status"><span class="spinner"></span>${STATUS[s.status]}</span>` : ''}
      <div class="card-tools">
        ${state === 'done' ? `<button class="round" data-act="addTo" data-id="${s.id}" aria-label="Add ${t} to a playlist" title="Add to playlist">${icon('plus')}</button>` : ''}
        ${state === 'busy' ? '' : `<button class="round" data-act="delete" data-id="${s.id}" aria-label="Delete ${t}" title="Delete">${icon('trash')}</button>`}
      </div>
    </div>
    <h3 class="card-title" title="${t}">${t}</h3>
    ${state === 'error'
      ? `<p class="card-sub card-error">${esc(s.error || 'Something went wrong')}</p>`
      : `<p class="card-sub">${esc(s.artist ?? '')}</p>`}
  </article>`;
}

const laneHtml = n => `
  <div class="lane" data-stem="${esc(n)}" style="--c:${STEMS[n] ?? '#8e8e93'}">
    <div class="ctl">
      <div class="ctl-row">
        <span class="dot"></span><span class="name">${esc(n)}</span>
        <button class="ms" data-act="mute" aria-pressed="false" aria-label="Mute ${esc(n)}">M</button>
        <button class="ms" data-act="solo" aria-pressed="false" aria-label="Solo ${esc(n)}">S</button>
      </div>
      <div class="vol"><input type="range" min="0" max="1" step="0.01" aria-label="${esc(n)} volume"><output></output></div>
    </div>
    <div class="wave" tabindex="0" role="group" aria-label="${esc(n)} waveform" aria-keyshortcuts="Space"><canvas></canvas></div>
  </div>`;

function songFacts(s) {
  const a = s.analysis, k = keyOf(s);
  return [k && 'Key ' + keyName(k.tonic, k.mode), a && Math.round(a.bpm) + ' BPM',
    s.duration && fmt(s.duration)].filter(Boolean).join(' · ');
}


function tempoText() {
  const bpm = engine.song.analysis?.bpm, t = engine.want.tempo;
  if (!bpm) return Math.round(t * 100) + '%';
  const now = Math.round(bpm * t), d = now - Math.round(bpm);
  return `${now} BPM` + (d ? ` (${signed(d)})` : '');
}

function keyText() {
  const k = keyOf(engine.song), p = engine.want.pitch;
  if (!k) return p ? signed(p) : '0';
  return NOTES[(k.tonic + p + 12) % 12] + (k.mode === 'minor' ? 'm' : '') + (p ? ` (${signed(p)})` : '');
}

function drawWave(cv, peaks, color) {
  const dpr = devicePixelRatio, w = cv.width = cv.clientWidth * dpr, h = cv.height = cv.clientHeight * dpr;
  const c = cv.getContext('2d'), bar = 2 * dpr, gap = dpr, n = Math.floor(w / (bar + gap)), per = peaks.length / n;
  const bars = [];
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = Math.floor(i * per), e = Math.max(j + 1, Math.floor((i + 1) * per)); j < e; j++) m = Math.max(m, peaks[j]);
    bars.push(m);
  }
  const max = Math.max(...bars, 0.01); // normalise so quiet stems are still readable
  c.fillStyle = color;
  bars.forEach((m, i) => {
    const bh = Math.max(dpr, (m / max) * (h - 16 * dpr));
    c.beginPath(); c.roundRect(i * (bar + gap), (h - bh) / 2, bar, bh, dpr); c.fill();
  });
}

function drawRuler(width) {
  const d = engine.duration, step = [5, 10, 15, 30, 60, 120].find(s => s / d * width >= 64) ?? 300;
  let html = '';
  for (let t = 0; t < d - step / 2; t += step) html += `<span style="left:${t / d * 100}%">${fmt(t)}</span>`;
  ui.ruler.innerHTML = html;
}

let lanes = [];         // { el, n, mute, solo, vol, out, canvas } for the lanes on screen
let wavesFor = null;    // the peaks the waveforms and ruler were last drawn for
let dragLoop = null;    // loop preview while dragging across a waveform
let scrubbing = null;   // seek preview while dragging the scrubber
new ResizeObserver(() => { wavesFor = null; }).observe(ui.lanes);

// The sidebar lists at most this many of each, so a big collection doesn't push everything off screen.
const SIDE_PLAYLISTS = 5, SIDE_SONGS = 8;
let sideExpanded = false; // playlists beyond the limit, shown on request

function drawSide() {
  const id = engine.song?.id, playing = playingId();
  attr(ui.navHome, 'aria-current', route.view === 'home' ? 'page' : null);
  attr(ui.navLibrary, 'aria-current', route.view === 'library' ? 'page' : null);
  const pls = playlists.items, shown = sideExpanded ? pls : pls.slice(0, SIDE_PLAYLISTS);
  if (changed(ui.plSide, 'rev', `${playlists.rev}:${library.rev}:${sideExpanded}`)) ui.plSide.innerHTML = shown.map(sidePlaylistHtml).join('');
  prop(ui.plMore, 'hidden', pls.length <= SIDE_PLAYLISTS);
  text(ui.plMore, sideExpanded ? 'Show fewer' : `Show all ${pls.length}`);
  prop(ui.plSideEmpty, 'hidden', pls.length > 0);
  const playingList = queue && engine.wantsPlay() ? queue.playlistId : null;
  for (const li of ui.plSide.children) {
    attr(li.firstElementChild, 'aria-current', route.view === 'playlist' && route.id === li.dataset.id ? 'page' : null);
    attr(li, 'data-playing', li.dataset.id === playingList ? '' : null);
  }
  if (changed(ui.lib, 'rev', library.rev)) ui.lib.innerHTML = library.songs.slice(0, SIDE_SONGS).map(libItemHtml).join('');
  prop(ui.libMore, 'hidden', library.songs.length <= SIDE_SONGS);
  text(ui.libMore, `All ${library.songs.length} songs`);
  for (const li of ui.lib.children) {
    attr(li, 'data-current', li.dataset.id === id ? '' : null);
    attr(li, 'data-playing', li.dataset.id === playing ? '' : null);
  }
}

function drawBar() {
  const s = engine.song;
  prop(ui.bar, 'hidden', !s);
  if (!s) return;
  attr(ui.barArt, 'src', s.cover);
  prop(ui.barArt, 'hidden', !s.cover);
  text(ui.barTitle, s.title);
  text(ui.barArtist, s.artist ?? '');
  const on = engine.wantsPlay();
  attr(ui.playIcon, 'href', on ? '#i-pause' : '#i-play');
  attr(ui.playBtn, 'aria-label', on ? 'Pause' : 'Play');
  attr(ui.playBtn, 'data-loading', engine.phase === 'loading' ? '' : null);
  prop(ui.next, 'disabled', !step(1));
  // the toast that says what plays next, in a playlist's last 10 seconds
  const nextUp = queue && engine.phase === 'playing' && !engine.loop.on && engine.duration - engine.pos() < 10
    && playlists.get(queue.playlistId)?.entries[queueIndex() + 1];
  const nextSong = nextUp && library.get(nextUp.songId);
  prop(ui.upNext, 'hidden', !nextSong);
  if (nextSong) {
    attr(ui.upNextArt, 'src', nextSong.cover);
    text(ui.upNextTitle, nextSong.title);
  }
  const d = engine.duration, p = scrubbing ?? engine.pos();
  css(ui.scrub, '--p', d ? (p / d).toFixed(4) : '0');
  attr(ui.scrub, 'data-active', scrubbing == null ? null : '');
  text(ui.elapsed, fmt(p));
  text(ui.total, fmt(d));
  attr(ui.scrub, 'aria-valuemax', String(Math.floor(d)));
  attr(ui.scrub, 'aria-valuenow', String(Math.floor(p)));
  attr(ui.scrub, 'aria-valuetext', `${fmt(p)} of ${fmt(d)}`);
  attr(ui.barStudio, 'href', route.view === 'studio' ? studioExit : '#/studio/' + s.id);
  attr(ui.barStudio, 'aria-current', route.view === 'studio' ? 'page' : null);
  attr(ui.barStudio, 'aria-label', route.view === 'studio' ? 'Close Studio and return to previous page' : 'Open current song in Studio');
  attr(ui.barStudio, 'title', route.view === 'studio' ? 'Close Studio' : 'Open Studio');
  prop(ui.volume, 'value', engine.volume);
}

function drawHome() {
  const s = heroSong();
  text(ui.homeLibraryCount, library.songs.length ? `${library.songs.length} song${library.songs.length === 1 ? '' : 's'} in your library.` : 'Your library starts here.');
  attr(ui.homeStudio, 'href', s ? '#/studio/' + s.id : '#/library');
  text(ui.homeStudioTitle, s ? s.title : 'A space to practice.');
  text(ui.homeStudioDescription, s ? s.artist || 'Open the stems and make your mix.' : 'Choose a song from your library to open its stems.');
  text(ui.homeStudioLink, s ? 'Open Studio ↗' : 'Browse songs ↗');
  prop(ui.homeStudioArt, 'hidden', !s?.cover);
  attr(ui.homeStudioArt, 'src', s?.cover ?? null);
  prop(ui.homeRecent, 'hidden', !library.songs.length);
  if (changed(ui.homeGrid, 'rev', library.rev)) ui.homeGrid.innerHTML = library.songs.slice(0, 4).map(cardHtml).join('');
  for (const card of ui.homeGrid.children) {
    attr(card, 'data-current', card.dataset.id === engine.song?.id ? '' : null);
    attr(card, 'data-playing', card.dataset.id === playingId() ? '' : null);
  }
}

function drawLibrary() {
  const s = heroSong(), playing = playingId(), q = ui.libSearch.value.trim().toLowerCase();
  prop(ui.hero, 'hidden', !s || !!q); // while searching, results move up where the highlight was
  text(ui.gridTitle, q ? 'Results' : 'Recently added');
  prop(ui.welcome, 'hidden', library.songs.length > 0);
  prop(ui.recent, 'hidden', !library.songs.length);
  if (s) {
    attr(ui.heroArt, 'src', s.cover);
    prop(ui.heroArt, 'hidden', !s.cover);
    text(ui.heroTitle, s.title);
    text(ui.heroArtist, s.artist ?? '');
    text(ui.heroMeta, songFacts(s));
    attr(ui.heroModel, 'data-model', s.model);
    text(ui.heroModel, MODELS[s.model]?.label ?? '');
    attr(ui.heroPlay, 'data-id', s.id);
    attr(ui.heroPlayIcon, 'href', s.id === playing ? '#i-pause' : '#i-play');
    text(ui.heroPlayLabel, s.id === playing ? 'Pause' : 'Play');
    attr(ui.heroStudio, 'href', '#/studio/' + s.id);
  }
  if (changed(ui.grid, 'rev', library.rev)) ui.grid.innerHTML = library.songs.map(cardHtml).join('');
  let shown = 0;
  for (const card of ui.grid.children) {
    attr(card, 'data-current', card.dataset.id === engine.song?.id ? '' : null);
    attr(card, 'data-playing', card.dataset.id === playing ? '' : null);
    const hide = !!q && !searchText(library.get(card.dataset.id) ?? { title: '' }).includes(q);
    prop(card, 'hidden', hide);
    shown += !hide;
  }
  prop(ui.libNone, 'hidden', !q || shown > 0);
}

function drawPlaylist() {
  const pl = playlists.get(route.id);
  if (!pl) return;
  const songs = pl.entries.map(e => library.get(e.songId)).filter(Boolean);
  const minutes = Math.round(pl.entries.reduce((t, e) => t + (library.get(e.songId)?.duration ?? 0) / e.tempo, 0) / 60);
  if (changed(ui.plArt, 'rev', `${pl.id}:${playlists.rev}:${library.rev}`)) {
    ui.plArt.innerHTML = mosaicHtml(pl);
    ui.plList.innerHTML = pl.entries.map(entryRowHtml).join('');
  }
  if (document.activeElement !== ui.plName) prop(ui.plName, 'value', pl.name);
  text(ui.plMeta, `${songs.length} song${songs.length === 1 ? '' : 's'}${minutes ? ` · ${minutes} min` : ''}`);
  prop(ui.plEmpty, 'hidden', pl.entries.length > 0);
  prop(ui.plPlay, 'disabled', !songs.length);
  prop(ui.plStudioBtn, 'disabled', !songs.length);
  const mine = queue?.playlistId === pl.id, on = mine && engine.wantsPlay(), current = mine ? queueIndex() : -1;
  attr(ui.plPlayIcon, 'href', on ? '#i-pause' : '#i-play');
  text(ui.plPlayLabel, on ? 'Pause' : 'Play');
  for (const row of ui.plList.children) {
    attr(row, 'data-current', +row.dataset.index === current ? '' : null);
    attr(row, 'data-playing', on && +row.dataset.index === current ? '' : null);
  }
}

function drawStudio() {
  const s = engine.song;
  if (!s) return;
  attr(ui.stArt, 'src', s.cover);
  prop(ui.stArt, 'hidden', !s.cover);
  text(ui.stTitle, s.title);
  text(ui.stArtist, s.artist ?? '');
  const a = s.analysis;
  text(ui.stKeySel.options[0], a ? `${keyName(a.tonic, a.mode)} (detected)` : 'Detecting…');
  if (document.activeElement !== ui.stKeySel) prop(ui.stKeySel, 'value', s.keyOverride ? `${s.keyOverride.tonic}:${s.keyOverride.mode}` : '');
  text(ui.stAlt, !s.keyOverride && a?.alt && a.alt.gap < 0.05 ? ' or ' + keyName(a.alt.tonic, a.alt.mode) : '');
  text(ui.stBpm, a ? ` · ${Math.round(a.bpm)} BPM` : '');

  const preset = engine.preset();
  for (const b of ui.presets.children) attr(b, 'aria-pressed', String(b.dataset.preset === preset));
  attr(ui.loopBtn, 'aria-pressed', String(engine.loop.on));
  prop(ui.loopBtn, 'disabled', engine.loop.b <= engine.loop.a);
  text(ui.tempoV, tempoText());
  text(ui.keyV, keyText());
  prop(ui.stStatus, 'hidden', engine.phase !== 'loading');
  text(ui.stStatusText, 'Loading stems');

  if (changed(ui.lanes, 'song', s)) {
    ui.lanes.innerHTML = engine.stems.map(laneHtml).join('');
    lanes = [...ui.lanes.children].map(el => ({
      el, n: el.dataset.stem, mute: el.querySelector('[data-act=mute]'), solo: el.querySelector('[data-act=solo]'),
      vol: el.querySelector('input'), out: el.querySelector('output'), canvas: el.querySelector('canvas'),
    }));
    wavesFor = null;
    ui.ruler.innerHTML = '';
  }
  const width = engine.peaks && wavesFor !== engine.peaks && lanes[0]?.canvas.clientWidth;
  if (width) {
    for (const L of lanes) drawWave(L.canvas, engine.peaks[L.n], STEMS[L.n] ?? '#8e8e93');
    drawRuler(width);
    wavesFor = engine.peaks;
  }
  for (const L of lanes) {
    const m = engine.mix[L.n];
    attr(L.mute, 'aria-pressed', String(m.mute));
    attr(L.solo, 'aria-pressed', String(m.solo));
    prop(L.vol, 'value', m.vol);
    text(L.out, Math.round(m.vol * 100) + '%');
    attr(L.el, 'data-off', engine.gain(L.n) === 0 ? '' : null);
  }

  const d = engine.duration || 1, loop = dragLoop ?? engine.loop;
  css(ui.tracks, '--p', (engine.pos() / d).toFixed(5));
  css(ui.tracks, '--a', (loop.a / d).toFixed(5));
  css(ui.tracks, '--b', (loop.b / d).toFixed(5));
  attr(ui.tracks, 'data-loop', loop.b > loop.a ? (loop.on ? 'on' : 'off') : null);
}

function frame() {
  drawSide();
  drawBar();
  if (mainView === 'home') drawHome();
  else if (mainView === 'playlist') drawPlaylist();
  else drawLibrary();
  if (route.view === 'studio') drawStudio();
  requestAnimationFrame(frame);
}

// ---------- input ----------
const frac = (x, node) => {
  const r = node.getBoundingClientRect();
  return clamp((x - r.left) / r.width, 0, 1);
};

// Window listeners rather than pointer capture so a drag that leaves the element still ends.
function track(move, up) {
  const end = e => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    up(e);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled) ACTIONS[el.dataset.act](el);
});

document.addEventListener('pointerdown', e => {
  if (!ui.plMenu.hidden && !ui.plMenu.contains(e.target) && !e.target.closest('[data-act=addTo], [data-act=saveTo]')) closePlaylistMenu();
});

addEventListener('keydown', e => {
  if (e.key === 'Escape' && !ui.plMenu.hidden) {
    e.preventDefault();
    closePlaylistMenu();
    return;
  }
  if (e.key === 'Escape' && ui.modelPicker.open) {
    e.preventDefault();
    ui.modelPicker.open = false;
    ui.modelPicker.querySelector('summary').focus();
    return;
  }
  if (e.key === 'Escape' && route.view === 'studio') {
    e.preventDefault();
    location.hash = studioExit;
    return;
  }
  const run = SHORTCUTS[e.code], t = e.target;
  if (!run || !engine.song || e.metaKey || e.ctrlKey || e.altKey) return;
  if (route.view === 'studio' && e.code === 'Space' && !t.closest('#bar')) {
    e.preventDefault();
    if (!e.repeat) engine.toggle();
    return;
  }
  if (t.closest('#sidebarResize, #tracksScroll') && !t.closest('.lane')) return;
  if (t.matches('input:not([type=range]), select, textarea, button, a, summary')) return;
  if (t.type === 'range' && e.code.startsWith('Arrow')) return;
  e.preventDefault();
  if (e.code === 'Space' && e.repeat) return;
  run();
});

ui.lanes.addEventListener('pointerdown', e => {
  const wave = e.target.closest('.wave');
  if (!wave || e.button !== 0 || !engine.peaks || e.pointerType === 'touch') return;
  e.preventDefault();
  wave.focus({ preventScroll: true });
  const at = x => frac(x, wave) * engine.duration, x0 = e.clientX, a = at(x0);
  track(
    m => { if (Math.abs(m.clientX - x0) > 5) dragLoop = { on: true, a: Math.min(a, at(m.clientX)), b: Math.max(a, at(m.clientX)) }; },
    () => { dragLoop ? engine.setLoop(dragLoop.a, dragLoop.b) : engine.seek(a); dragLoop = null; },
  );
});

ui.lanes.addEventListener('click', e => {
  const wave = e.target.closest('.wave');
  if (wave && e.pointerType === 'touch' && engine.peaks) {
    wave.focus({ preventScroll: true });
    engine.seek(frac(e.clientX, wave) * engine.duration);
  }
});
ui.ruler.addEventListener('click', e => engine.seek(frac(e.clientX, ui.ruler) * engine.duration));

ui.scrub.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !engine.duration) return;
  const at = x => frac(x, ui.scrub) * engine.duration;
  scrubbing = at(e.clientX);
  track(m => { scrubbing = at(m.clientX); }, () => { engine.seek(scrubbing); scrubbing = null; });
});

// The "Add songs" picker: tick songs from the library; they join the playlist in the order ticked.
let picked = [];
function openPicker() {
  const inList = new Set(playlists.get(route.id).entries.map(e => e.songId));
  picked = [];
  ui.pickerList.innerHTML = library.playable().map(s => `
    <li data-q="${esc(searchText(s))}">
      <label class="picker-row">
        <input type="checkbox" value="${s.id}">
        <span class="pl-art">${art(s)}</span>
        <span class="pl-text"><span class="pl-title">${esc(s.title)}</span><span class="pl-sub">${esc(s.artist ?? '')}</span></span>
        ${inList.has(s.id) ? '<span class="chip">In playlist</span>' : ''}
      </label></li>`).join('');
  ui.pickerSearch.value = '';
  filterPicker();
  syncPicker();
  ui.picker.showModal();
  ui.pickerSearch.focus();
}
function filterPicker() {
  const q = ui.pickerSearch.value.trim().toLowerCase();
  let shown = 0;
  for (const li of ui.pickerList.children) shown += !(li.hidden = !li.dataset.q.includes(q));
  ui.pickerNone.hidden = shown > 0;
}
function syncPicker() {
  ui.pickerAdd.disabled = !picked.length;
  ui.pickerAdd.textContent = picked.length ? `Add ${picked.length} song${picked.length === 1 ? '' : 's'}` : 'Add';
}
ui.pickerSearch.addEventListener('input', filterPicker);
ui.pickerSearch.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); }); // Enter shouldn't submit the dialog
ui.pickerList.addEventListener('change', e => {
  picked = e.target.checked ? [...picked, e.target.value] : picked.filter(id => id !== e.target.value);
  syncPicker();
});
ui.picker.addEventListener('click', e => { if (e.target === ui.picker) ui.picker.close('cancel'); }); // backdrop
ui.picker.addEventListener('close', async () => {
  const pl = playlists.get(route.id);
  if (ui.picker.returnValue !== 'add' || !pl || !picked.length) return;
  const n = picked.length;
  await savePlaylist(pl.id, [...pl.entries, ...picked.map(songId => ({ songId, tempo: 1, pitch: 0, mix: null, loop: null }))]);
  toast(`Added ${n} song${n === 1 ? '' : 's'} to ${esc(pl.name)}`);
});

// rename on Enter or when the field loses focus
ui.plName.addEventListener('keydown', e => { if (e.key === 'Enter') ui.plName.blur(); });
ui.plName.addEventListener('change', async () => {
  const pl = playlists.get(route.id), name = ui.plName.value.trim();
  if (!pl || !name || name === pl.name) return void (ui.plName.value = pl?.name ?? '');
  try { await playlists.update(pl.id, { name }); } catch (err) { toast(`Couldn't rename: ${esc(err.message)}`); }
});

// drag a row onto another to move it there
let dragFrom = -1;
ui.plList.addEventListener('dragstart', e => {
  const row = e.target.closest('.pl-row');
  dragFrom = +row.dataset.index;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragFrom));
  row.dataset.dragging = '';
});
ui.plList.addEventListener('dragover', e => {
  const row = e.target.closest('.pl-row');
  if (dragFrom < 0 || !row) return;
  e.preventDefault();
  for (const r of ui.plList.children) delete r.dataset.dropBefore, delete r.dataset.dropAfter;
  const before = +row.dataset.index < dragFrom;
  row.dataset[before ? 'dropBefore' : 'dropAfter'] = '';
});
ui.plList.addEventListener('drop', e => {
  const row = e.target.closest('.pl-row'), pl = playlists.get(route.id);
  e.preventDefault();
  const to = row ? +row.dataset.index : -1;
  if (pl && to >= 0 && to !== dragFrom) {
    const entries = [...pl.entries];
    entries.splice(to, 0, ...entries.splice(dragFrom, 1));
    savePlaylist(pl.id, entries);
  }
});
ui.plList.addEventListener('dragend', () => {
  dragFrom = -1;
  for (const r of ui.plList.children) delete r.dataset.dragging, delete r.dataset.dropBefore, delete r.dataset.dropAfter;
});

ui.lanes.addEventListener('input', e => engine.setMix(e.target.closest('.lane').dataset.stem, { vol: +e.target.value }));
ui.volume.addEventListener('input', () => engine.setVolume(+ui.volume.value));

let sidebarWidth = 240;
try {
  const saved = Number(localStorage.getItem('stemMixer.sidebarWidth'));
  if (Number.isFinite(saved) && saved >= 180 && saved <= 420) sidebarWidth = saved;
} catch {}
const sidebarMax = () => Math.max(180, Math.min(420, innerWidth - 280));
function setSidebarWidth(value, save = false) {
  const width = Math.round(clamp(value, 180, sidebarMax()));
  document.documentElement.style.setProperty('--sidebar-width', width + 'px');
  ui.sidebarResize.setAttribute('aria-valuenow', String(width));
  ui.sidebarResize.setAttribute('aria-valuemax', String(sidebarMax()));
  ui.sidebarResize.setAttribute('aria-valuetext', width + ' pixels');
  if (save) {
    sidebarWidth = width;
    try { localStorage.setItem('stemMixer.sidebarWidth', String(width)); } catch {}
  }
}
let sidebarDrag = null;
ui.sidebarResize.addEventListener('pointerdown', e => {
  if (e.button !== 0 || sidebarDrag) return;
  e.preventDefault();
  sidebarDrag = { id: e.pointerId, x: e.clientX, width: ui.sidebar.getBoundingClientRect().width };
  ui.sidebarResize.setPointerCapture(e.pointerId);
  document.body.dataset.resizing = '';
});
ui.sidebarResize.addEventListener('pointermove', e => {
  if (sidebarDrag?.id !== e.pointerId) return;
  setSidebarWidth(sidebarDrag.width + e.clientX - sidebarDrag.x);
});
function endSidebarResize(e) {
  if (sidebarDrag?.id !== e.pointerId) return;
  if (e.type === 'pointerup') setSidebarWidth(ui.sidebar.getBoundingClientRect().width, true);
  else setSidebarWidth(sidebarWidth);
  sidebarDrag = null;
  delete document.body.dataset.resizing;
  if (ui.sidebarResize.hasPointerCapture(e.pointerId)) ui.sidebarResize.releasePointerCapture(e.pointerId);
}
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) ui.sidebarResize.addEventListener(event, endSidebarResize);
ui.sidebarResize.addEventListener('keydown', e => {
  const width = ui.sidebar.getBoundingClientRect().width;
  const values = { ArrowLeft: width - 10, ArrowRight: width + 10, Home: 180, End: sidebarMax() };
  if (!(e.key in values)) return;
  e.preventDefault();
  e.stopPropagation();
  setSidebarWidth(values[e.key], true);
});
addEventListener('resize', () => setSidebarWidth(sidebarWidth));
setSidebarWidth(sidebarWidth);

// ---------- add a song ----------
let selectedModel = 'htdemucs_ft';
ui.modelOptions.insertAdjacentHTML('beforeend', Object.entries(MODELS).map(([id, m]) => `
  <label class="model-option">
    <input type="radio" name="model" value="${id}" ${id === selectedModel ? 'checked' : ''}>
    <span><span class="model-option-title">${m.name}<small>${m.badge}</small></span><span class="model-description">${m.hint}</span></span>
  </label>`).join(''));
ui.stKeySel.innerHTML = '<option value=""></option>' + ['major', 'minor'].flatMap(mode =>
  NOTES.map((n, t) => `<option value="${t}:${mode}">${keyName(t, mode)}</option>`)).join('');
ui.stKeySel.addEventListener('change', async () => {
  const s = engine.song, [t, mode] = ui.stKeySel.value.split(':');
  const key = ui.stKeySel.value ? { tonic: +t, mode } : null;
  const r = await fetch(`/api/songs/${s.id}/key`, { method: 'PUT', body: JSON.stringify(key) });
  if (r.ok) s.keyOverride = key;
  library.refresh();
});

ui.modelOptions.addEventListener('change', e => {
  if (!(e.target.value in MODELS)) return;
  selectedModel = e.target.value;
  ui.modelLabel.textContent = MODELS[selectedModel].name;
  ui.modelPicker.open = false;
  ui.modelPicker.querySelector('summary').focus();
  note();
});
document.addEventListener('click', e => {
  if (!ui.modelPicker.contains(e.target)) ui.modelPicker.open = false;
});

function note(error) {
  ui.hint.textContent = error ?? MODELS[selectedModel].hint;
  ui.hint.classList.toggle('error', !!error);
}
ui.url.addEventListener('input', () => note());

ui.add.addEventListener('submit', async e => {
  e.preventDefault();
  ui.addBtn.disabled = true;
  try {
    const r = await fetch('/api/separate', {
      method: 'POST',
      body: JSON.stringify({ url: ui.url.value.trim(), model: selectedModel }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error);
    ui.url.value = '';
    note();
    await library.refresh();
    location.hash = '#/library';
  } catch (err) {
    note(err instanceof TypeError ? "Couldn't reach the server" : err.message);
  } finally {
    ui.addBtn.disabled = false;
  }
});

// ---------- start ----------
ui.presets.innerHTML = Object.entries(PRESETS)
  .map(([k, p]) => `<button data-act="preset" data-preset="${k}" aria-pressed="false">${p.label}</button>`).join('');
note();
addEventListener('hashchange', openRoute);
Promise.all([library.refresh(), playlists.refresh()]).then(() => {
  openRoute();
  if (!library.songs.length) ui.url.focus();
  requestAnimationFrame(frame);
});
