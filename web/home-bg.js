// Animated light behind the Home heading: one glowing waveform per stem, merged at the edges and
// fanning out in the middle, like a song being split. While a song plays, each strand follows that
// stem's real loudness. It only renders while Home is on screen, and draws one still frame when
// the user prefers reduced motion.
import { WebGLRenderer, Scene, OrthographicCamera, PlaneGeometry, ShaderMaterial, Mesh, Vector2, Color } from './vendor/three.min.js';

const host = document.getElementById('homeBg');
const home = document.getElementById('home');
const still = matchMedia('(prefers-reduced-motion: reduce)');

const MAX = 6; // the 6-stem model is the most a song can have
const IDLE_STEMS = ['bass', 'drums', 'vocals', 'other'];

const fragmentShader = /* glsl */ `
  precision highp float;
  #define N ${MAX}
  uniform vec2 uRes;
  uniform float uTime;
  uniform vec2 uMouse;
  uniform int uCount;
  uniform float uAmp[N];
  uniform vec3 uCol[N];
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y + uMouse * 0.03;
    float half_w = 0.5 * uRes.x / uRes.y;
    float u = clamp((p.x + half_w) / (2.0 * half_w), 0.0, 1.0);
    float spread = pow(sin(3.14159 * u), 1.5); // one mixed line at each edge, separate stems in the middle
    float count = float(uCount);
    vec3 col = vec3(0.0);
    for (int i = 0; i < N; i++) {
      if (i >= uCount) break;
      float fi = float(i), a = uAmp[i];
      float lane = (fi - (count - 1.0) * 0.5) * 0.075 * spread;
      float y = 0.14 + lane
        + (0.04 + 0.09 * a) * (0.4 + 0.6 * spread) * sin(p.x * (3.0 + fi * 0.6) + uTime * (0.8 + fi * 0.21) + fi * 1.7)
        + 0.025 * a * sin(p.x * 13.0 - uTime * 2.4 + fi * 4.0);
      float d = abs(p.y - y);
      float core = exp(-d * d * 12000.0);
      float glow = 0.0035 / (d + 0.006);
      col += uCol[i] * (core * 0.9 + glow * 0.5) * (0.3 + 1.3 * a);
    }
    col *= 1.0 - 0.45 * exp(-p.x * p.x * 3.0 - (p.y - 0.2) * (p.y - 0.2) * 14.0); // keep the heading readable
    col *= smoothstep(0.0, 0.08, u) * smoothstep(1.0, 0.9, u) * smoothstep(0.0, 0.45, vUv.y);
    col += (hash(gl_FragCoord.xy + uTime) - 0.5) / 255.0; // dither, so the glow doesn't band
    col = max(col, 0.0);
    gl_FragColor = vec4(col, min(1.0, max(col.r, max(col.g, col.b)))); // premultiplied: black is transparent
  }
`;

function start() {
  const renderer = new WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setClearColor(0x000000, 0);
  host.append(renderer.domElement);

  const uniforms = {
    uRes: { value: new Vector2() }, uTime: { value: 8 }, uMouse: { value: new Vector2() },
    uCount: { value: 0 }, uAmp: { value: new Array(MAX).fill(0) }, uCol: { value: Array.from({ length: MAX }, () => new Color()) },
  };
  // strand heights follow the stems: fast to rise, slow to fall, like a level meter
  const amps = new Array(MAX).fill(0);
  const strands = () => {
    const names = (engine.song ? engine.stems : IDLE_STEMS).slice(0, MAX);
    const levels = engine.levels();
    uniforms.uCount.value = names.length;
    names.forEach((n, i) => {
      uniforms.uCol.value[i].set(STEMS[n] ?? '#ffffff');
      const target = n in levels ? Math.min(1, levels[n] * 5) : 0.3 + 0.15 * Math.sin(uniforms.uTime.value * 0.7 + i);
      amps[i] += (target - amps[i]) * (target > amps[i] ? 0.35 : 0.06);
      uniforms.uAmp.value[i] = amps[i];
    });
  };
  const scene = new Scene();
  scene.add(new Mesh(new PlaneGeometry(2, 2), new ShaderMaterial({
    uniforms, fragmentShader, transparent: true, depthTest: false,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position, 1.0); }',
  })));
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const draw = () => { strands(); renderer.render(scene, camera); };
  new ResizeObserver(() => {
    const { width, height } = host.getBoundingClientRect();
    renderer.setSize(width, height, false);
    renderer.getDrawingBufferSize(uniforms.uRes.value);
    draw();
  }).observe(host);

  const mouse = new Vector2();
  addEventListener('pointermove', e => mouse.set(e.clientX / innerWidth - 0.5, 0.5 - e.clientY / innerHeight));

  let last = performance.now();
  const frame = now => {
    requestAnimationFrame(frame);
    const dt = Math.min(now - last, 100) / 1000;
    last = now;
    const visible = !home.hidden && !document.body.hasAttribute('data-studio') && document.visibilityState === 'visible';
    if (!visible || still.matches) return;
    uniforms.uTime.value += dt;
    uniforms.uMouse.value.lerp(mouse, 1 - Math.exp(-dt * 3));
    draw();
  };
  requestAnimationFrame(frame);
  still.addEventListener('change', draw);
  home.dataset.bg = '';
}

try {
  start();
} catch (err) {
  console.warn('Home background disabled, WebGL unavailable:', err); // the CSS glow stays as the fallback
}
