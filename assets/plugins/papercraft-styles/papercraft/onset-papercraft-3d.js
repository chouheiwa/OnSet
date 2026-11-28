// onset-papercraft-3d.js：片场为 xikhar/papercraft（v0.7.0，MIT）写的 3D 确定性 HyperFrames 接头。
// - WebGLRenderer 启用 preserveDrawingBuffer: true 并在每次 seek 后同步 render + flush，防无头截到黑帧；
// - 全部 2D 纹理画布强制 willReadFrequently: true，保证程序化印刷贴图确定性；
// - 对接 HyperFrames hf-seek 与 window.__hf.buildReady，任意乱序时间点均从 t=0 固定步长步进；
// - 自动读取 window.ONSET_SCENE 画幅并兼容 16:9 / 9:16 / 3:4 / 1:1，无 WebAudio、无 rAF、无真时钟。
import * as THREE from 'three';
import * as P2 from './paperkit-2d.js';
import {
  PAPER_LIGHT,
  PaperPost,
  WalkField,
  crossCard,
  enableSoftShadows,
  fitShadow,
  hinge,
  makeCard,
  paperLights,
  paperMaterial,
  paperTextures,
  setPrintScale,
} from './paperkit-3d.js';
import { createLife } from './paper-life.js';
import { windSway } from './paper-motion.js';

(() => {
  const patch = (proto) => {
    if (!proto || proto.__onsetPapercraft3DPatched) return;
    const orig = proto.getContext;
    proto.getContext = function (type, opts) {
      return type === '2d'
        ? orig.call(this, type, { willReadFrequently: true, ...(opts || {}) })
        : orig.call(this, type, opts);
    };
    proto.__onsetPapercraft3DPatched = true;
  };
  if (typeof HTMLCanvasElement !== 'undefined') patch(HTMLCanvasElement.prototype);
  if (typeof OffscreenCanvas !== 'undefined') patch(OffscreenCanvas.prototype);
})();

export const MOODS = {
  day: { key: '#ffdcb2', ki: 3.0, dir: [-0.8, 0.95, 0.55], fill: '#f2dcc2', fi: 0.8, sky: '#fff0da', skyG: '#b39a78', si: 0.42, leak: '#a0602c', post: { exposure: 0.82, tint: [1.03, 0.985, 0.98], saturation: 0.96, haze: '#d8bf8e' } },
  'golden-hour': { key: '#ffc890', ki: 3.4, dir: [-0.85, 0.52, 0.5], fill: '#b9bcd8', fi: 0.8, sky: '#ffe6c8', skyG: '#8a7a70', si: 0.4, leak: '#8f5034', post: { exposure: 0.86, tint: [1.02, 0.99, 0.98], saturation: 1.0, haze: '#e6c08a' } },
  golden: { key: '#ffc890', ki: 3.4, dir: [-0.85, 0.52, 0.5], fill: '#b9bcd8', fi: 0.8, sky: '#ffe6c8', skyG: '#8a7a70', si: 0.4, leak: '#8f5034', post: { exposure: 0.86, tint: [1.02, 0.99, 0.98], saturation: 1.0, haze: '#e6c08a' } },
  dusk: { key: '#ffb38a', ki: 3.2, dir: [-0.866, 0.45, 0.5], fill: '#6f63a8', fi: 1.3, sky: '#a898d0', skyG: '#5a4a78', si: 1.0, leak: '#6a4a8a', glow: 1.1, lamp: 6, post: { exposure: 1.0, tint: [1.02, 0.97, 1.0], saturation: 0.95, haze: '#c98fa0', hazeStart: 24, hazeEnd: 80, hazeAmount: 0.4, vignette: 0.12, vignetteColor: '#1a1430', shadowTint: '#1e2050' } },
  night: { key: '#c8d6ff', ki: 1.6, fill: '#7890d0', fi: 0.7, sky: '#3a56b0', skyG: '#22243a', si: 0.85, leak: '#26368a', wrap: 0.4, glow: 1.4, lamp: 4.5, post: { exposure: 0.95, tint: [0.98, 0.98, 1.03], saturation: 1.12, haze: '#0e1a44', hazeStart: 14, hazeEnd: 55, hazeAmount: 0.9, vignette: 0.12, vignetteColor: '#0a0c24', shadowTint: '#141c48', shadowLift: 0.04 } },
};

let _lightsCache = null;

export async function loadLights(url = './papercraft/lights.json') {
  if (_lightsCache) return _lightsCache;
  try {
    const res = await fetch(url);
    if (res.ok) _lightsCache = await res.json();
  } catch {
    // 离线容错
  }
  return _lightsCache || {};
}

export function resolveCanvasSize(opts = {}) {
  const sc = typeof window !== 'undefined' ? window.ONSET_SCENE?.canvas : null;
  const root = typeof document !== 'undefined' ? document.querySelector('[data-composition-id]') : null;
  const w = Number(opts.width) || Number(sc?.width_px) || Number(root?.dataset?.width) || (typeof innerWidth === 'number' ? innerWidth : 1920);
  const h = Number(opts.height) || Number(sc?.height_px) || Number(root?.dataset?.height) || (typeof innerHeight === 'number' ? innerHeight : 1080);
  const fps = Number(opts.fps) || Number(sc?.fps) || 30;
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), fps };
}

/**
 * 创建 3D 离线 Three.js 折纸立体书确定性世界。
 * 支持无主角纯 diorama / 轨道运镜镜头，通过 seek(seconds) 确定性渲染任意时刻。
 */
export function createWorld3D({
  canvas = null,
  width = 0,
  height = 0,
  bounds: bounds0 = { x0: -60, x1: 60, z0: -58, z1: 36 },
  ground = '#d9d2c2',
  stock = '#f7f0e2',
  view: view0 = {},
  heroHeight = 3.6,
  light = {},
  lens = {},
  moods: extraMoods = {},
  mood = 'day',
  focus = null,
  subject = null,
  autoOpen = true,
  prewarmSeconds = 0,
  roam = true,
  crossTurn = 28,
  stepHz = 60,
} = {}) {
  const dim = resolveCanvasSize({ width, height });
  const cv = canvas || document.getElementById('c') || Object.assign(document.createElement('canvas'), { id: 'c' });
  if (!cv.parentNode) document.body.prepend(cv);

  const renderer = new THREE.WebGLRenderer({
    canvas: cv,
    antialias: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.BasicShadowMap;
  renderer.setPixelRatio(1);
  renderer.setSize(dim.w, dim.h, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(ground);
  const view = { yaw: 0, pitch: 47, dist: 62, fov: 26, ...view0 };
  const REF = 16 / 9;
  const rad = THREE.MathUtils.degToRad;
  const lensFor = (a, closer = view.closer ?? 1.33) => {
    const z = a < 1 ? Math.min(1 / a, Math.max(1, closer) ** (Math.log(1 / a) / Math.log(REF))) : 1;
    const ty0 = Math.tan(rad(view.fov / 2));
    const ty = a >= 1 ? ty0 : ty0 / a / z;
    const wide = (ty * a) / (ty0 * REF);
    return { aspect: a, fovY: THREE.MathUtils.radToDeg(2 * Math.atan(ty)), wide, tall: ty / ty0, lat: Math.min(1, a / REF) * Math.min(1, wide), mag: z };
  };
  const LENS = lensFor(dim.w / dim.h);
  const placeOn = (cam, t, yawDeg, pitchDeg, dist = view.dist) => {
    const yaw = rad(yawDeg);
    const pit = rad(pitchDeg);
    cam.position.set(t.x + Math.sin(yaw) * Math.cos(pit) * dist, t.y + Math.sin(pit) * dist, t.z + Math.cos(yaw) * Math.cos(pit) * dist);
    cam.lookAt(t);
    cam.updateMatrixWorld();
  };
  const subj = subject || (focus ? [focus[0], focus[2]] : null);
  const yawR = () => {
    const yaw = rad(view.yaw);
    return [Math.cos(yaw), -Math.sin(yaw)];
  };
  const _aim = new THREE.PerspectiveCamera();
  const _p = new THREE.Vector3();
  const liftFor = (L, s, t, y) => {
    _aim.fov = L.fovY;
    _aim.aspect = L.aspect;
    _aim.updateProjectionMatrix();
    const yaw = rad(view.yaw);
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const t2 = new THREE.Vector3();
    const f = (d) => {
      placeOn(_aim, t2.set(t.x + fx * d, t.y, t.z + fz * d), view.yaw, view.pitch);
      return _p.copy(s).project(_aim).y - y;
    };
    let d0 = 0;
    let d1 = 2;
    let f0 = f(d0);
    let f1 = f(d1);
    for (let i = 0; i < 6 && Math.abs(f1) > 1e-4 && Math.abs(f1 - f0) > 1e-9; i++) {
      const d2 = d1 - (f1 * (d1 - d0)) / (f1 - f0);
      d0 = d1;
      f0 = f1;
      d1 = d2;
      f1 = f(d1);
    }
    return d1;
  };
  const aimed = (L) => {
    const t = new THREE.Vector3(...(view0.target || [0, 1.5, -4]));
    if (!subj) return t;
    const [rx, rz] = yawR();
    const side = (subj[0] - t.x) * rx + (subj[subj.length - 1] - t.z) * rz;
    const k = side * (1 - L.lat);
    t.set(t.x + rx * k, t.y, t.z + rz * k);
    if (L.aspect < 1) {
      const s = new THREE.Vector3(subj[0], subj.length > 2 ? subj[1] : 1.8, subj[subj.length - 1]);
      _aim.fov = L.fovY;
      _aim.aspect = L.aspect;
      _aim.updateProjectionMatrix();
      placeOn(_aim, t, view.yaw, view.pitch);
      const y0 = _p.copy(s).project(_aim).y;
      const w = Math.min(1, (1 - L.aspect) / (1 - 9 / 16));
      const d = liftFor(L, s, t, view.subjectY ?? y0 + (0.15 - y0) * w);
      const yaw = rad(view.yaw);
      t.set(t.x - Math.sin(yaw) * d, t.y, t.z - Math.cos(yaw) * d);
    }
    return t;
  };

  const target = aimed(LENS);
  const TARGET0 = target.clone();
  const camera = new THREE.PerspectiveCamera(LENS.fovY, LENS.aspect, 5, 600);
  const PRINT = Math.min(2, Math.max(1, (LENS.mag * Math.min(dim.w, dim.h)) / (2 * view.dist * Math.tan(rad(view.fov / 2))) / 35.4));
  setPrintScale(PRINT);
  const frame = { w: dim.w, h: dim.h, aspect: LENS.aspect, fovY: LENS.fovY, wide: LENS.wide, tall: LENS.tall, lat: LENS.lat, mag: LENS.mag, printScale: PRINT };
  const paper = paperTextures(renderer, { color: stock, seed: 4, unitsPerTile: 5, fibres: 1.5, mottle: 0.08, normalStrength: 3 });
  placeOn(camera, target, view.yaw, view.pitch);

  const _v = new THREE.Vector3();
  const _ray = new THREE.Raycaster();
  const _pl = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const groundAt = (sx, sy) => {
    camera.updateMatrixWorld();
    _ray.setFromCamera({ x: sx, y: sy }, camera);
    const p = new THREE.Vector3();
    return _ray.ray.intersectPlane(_pl, p) ? p : null;
  };
  const inFrame = (x, z, m = 0.12, y = 1) => {
    _v.set(x, y, z).project(camera);
    return Math.abs(_v.x) < 1 + 2 * m && _v.y > -1 - m && _v.y < 1 + m;
  };
  const sharpAt = (x, z, y = 1) => {
    _v.set(x, y, z).project(camera);
    const s = _v.y * LENS.tall;
    return s > -0.95 && s < 0.7;
  };

  const bounds = { ...bounds0 };
  const AREA0 = (bounds.x1 - bounds.x0) * (bounds.z1 - bounds.z0);
  const hinges = [];
  const walk = new WalkField({ step: 0.75, radius: 0.6 });
  const lamps = [];
  const glowers = [];
  const leanRng = P2.rng(7);
  const turnRng = P2.rng(11);
  let seedN = 1;
  const DEG = Math.PI / 180;
  const CROSS = { full: {}, half: { halves: 'back', second: { scale: 0.8 } }, 'half-front': { halves: 'front' }, quarter: { main: 'right', halves: 'front' } };

  const autoYaw = (x, z, kind, angle = 90) => {
    const phi = Math.atan2(camera.position.x - x, camera.position.z - z);
    if (!kind) return phi + (turnRng() - 0.5) * 2 * 14 * DEG;
    if (kind === 'quarter') return phi - (90 - angle / 2) * DEG + (turnRng() - 0.5) * 2 * 10 * DEG;
    const base = kind === 'full' ? crossTurn : 24;
    return phi + (turnRng() < 0.5 ? -1 : 1) * (base + (turnRng() - 0.5) * (base > 30 ? 12 : 16)) * DEG;
  };

  function printGround(draw, { ppu = 18, seed = 20 } = {}) {
    const G = bounds;
    const gw = G.x1 - G.x0;
    const gd = G.z1 - G.z0;
    const W = Math.round(gw * ppu);
    const H = Math.round(gd * ppu);
    const rnd = P2.rng(seed);
    const k = Math.min(PRINT, 8192 / Math.max(W, H), Math.sqrt(3.6e7 / (W * H)));
    const dens = (gw * gd) / AREA0;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W * k));
    c.height = Math.max(1, Math.round(H * k));
    const g = c.getContext('2d', { willReadFrequently: true });
    g.setTransform(k, 0, 0, k, 0, 0);
    const X = (x) => (x - G.x0) * ppu;
    const Z = (z) => (z - G.z0) * ppu;
    g.fillStyle = ground;
    g.fillRect(0, 0, W, H);
    const washes = (cols, { scales = [[45, 160, 420, 0.3], [160, 45, 130, 0.2], [500, 10, 30, 0.12]] } = {}) => {
      for (const [n0, r0, r1, a] of scales) {
        for (let i = 0, n = Math.round(n0 * dens); i < n; i++) {
          const x = rnd() * W;
          const y = rnd() * H;
          const r = r0 + rnd() * (r1 - r0);
          const col = cols[Math.floor(rnd() * cols.length)];
          const gr = g.createRadialGradient(x, y, 0, x, y, r);
          gr.addColorStop(0, P2.rgba(col, a * 0.6));
          gr.addColorStop(0.78, P2.rgba(col, a));
          gr.addColorStop(0.9, P2.rgba(P2.shade(col, -0.15), a * 1.2));
          gr.addColorStop(1, P2.rgba(col, 0));
          g.fillStyle = gr;
          g.fillRect(x - r, y - r, 2 * r, 2 * r);
        }
      }
    };
    const torn = (pts, fill, fringe = 'rgba(255,248,230,0.7)') => {
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        const [x0, z0] = pts[i];
        const [x1, z1] = pts[(i + 1) % pts.length];
        const len = Math.hypot(x1 - x0, z1 - z0);
        const n = Math.max(1, Math.ceil(len / 0.2));
        for (let m = 0; m < n; m++) {
          const u = m / n;
          const j = (rnd() - 0.5) * 0.12 + Math.sin((x0 + z0 + u * len) * 1.7) * 0.05;
          out.push([x0 + (x1 - x0) * u + j, z0 + (z1 - z0) * u + j]);
        }
      }
      g.beginPath();
      out.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))));
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      g.strokeStyle = fringe;
      g.lineWidth = 0.15 * ppu;
      g.stroke();
    };
    const band = (fx, half, z0 = G.z0, z1 = G.z1) => {
      const Lf = [];
      const Rt = [];
      for (let z = z0; z <= z1; z += 0.4) {
        const w = typeof half === 'function' ? half(z) : half;
        const dx = fx(z + 0.2) - fx(z - 0.2);
        const n = Math.hypot(dx, 0.4);
        Lf.push([fx(z) - (w * 0.4) / n, z + (w * dx) / n]);
        Rt.push([fx(z) + (w * 0.4) / n, z - (w * dx) / n]);
      }
      return [...Lf, ...Rt.reverse()];
    };
    const ribbon = (fx, w, col, z0 = G.z0, z1 = G.z1, wob = 0) => {
      g.strokeStyle = col;
      g.lineWidth = w * ppu;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      for (let z = z0; z <= z1; z += 0.5) {
        (z === z0 ? g.moveTo : g.lineTo).call(g, X(fx(z) + wob * (Math.sin(z * 1.1 + w) * 0.6 + Math.sin(z * 2.7) * 0.4)), Z(z));
      }
      g.stroke();
    };
    const line = (pts, w, col) => {
      g.strokeStyle = col;
      g.lineWidth = w * ppu;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      pts.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))));
      g.stroke();
    };
    const drifts = (fn, { n = 6000, inside = 0.5, outside = 0.005, threshold = 0.68 } = {}) => {
      const mask = P2.tileNoise(256, 9, rnd);
      const at = (x, y) => mask[(Math.floor((y / H) * 256) & 255) * 256 + (Math.floor((x / W) * 256) & 255)];
      for (let m = 0, N = Math.round(n * dens); m < N; m++) {
        const x = rnd() * W;
        const y = rnd() * H;
        if (rnd() > (at(x, y) > threshold ? inside : outside)) continue;
        fn(x, y);
      }
    };
    draw({ g, W, H, ppu, X, Z, rnd, washes, torn, band, ribbon, line, drifts });
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = g.createPattern(paper.sheet, 'repeat');
    g.fillRect(0, 0, W, H);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const mat = paperMaterial({ map: tex, normalMap: paper.normalMap.clone(), normalScale: 0.9 });
    mat.normalMap.repeat.set(gw / 5, gd / 5);
    mat.normalMap.needsUpdate = true;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(gw, gd), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((G.x0 + G.x1) / 2, 0, (G.z0 + G.z1) / 2);
    mesh.receiveShadow = true;
    const farMap = paper.map.clone();
    farMap.repeat.set(160, 160);
    farMap.needsUpdate = true;
    const beyond = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), paperMaterial({ color: ground, map: farMap }));
    beyond.rotation.x = -Math.PI / 2;
    beyond.position.y = -0.02;
    beyond.receiveShadow = true;
    scene.add(mesh, beyond);
    return mesh;
  }

  const Z_NEAR = bounds.z1 - 12;
  function popup(
    pts,
    paint,
    { x = 0, z = 0, yaw = null, cross = false, second = null, angle = 90, sway = 0, scale = 1, node = null, height = 0, edge = 0.08, self = false, parent = null, order = null, level = false, effects = null, holes = null, res = 1, materials = null, open = 0 } = {},
  ) {
    const box = pts ? P2.bbox(pts) : { h: height };
    const sharp = effects ?? (parent || roam || sharpAt(x, z) ? 1 : 0);
    const opts = { paint, paper, seed: seedN++, thickness: 0.08, edgeWidth: edge / scale, pxPerUnit: ((sharp ? 40 : 28) * res) / scale, effects: sharp, materials };
    const kind = cross === true ? 'full' : cross || null;
    if (kind && !CROSS[kind]) throw new Error(`papercraft popup: unknown cross kind ${cross}`);
    const finalYaw = yaw === null ? (node || parent ? 0 : autoYaw(x, z, kind, angle)) : yaw;
    const card =
      node ||
      (kind
        ? crossCard(pts, { ...opts, ...CROSS[kind], angle, second: { ...(CROSS[kind].second || {}), ...(second || {}) } })
        : makeCard(pts, { ...opts, holes }));
    card.scale.setScalar(scale);
    const size = Math.min(1, (box.h * scale) / 12);
    const h = hinge(card, {
      at: new THREE.Vector3(x, parent ? 0.01 : 0.02 + (z - bounds.z0) * 0.0006, z),
      yaw: finalYaw,
      open,
      size,
      ...(self ? { flat: 0, rest: 0 } : { rest: level ? 0 : (leanRng() - 0.5) * 0.07 }),
    });
    h.order = order ?? (Z_NEAR - z) / 5 + leanRng() * 0.4;
    h.swayAmp = sway;
    h.size = size;
    h.x = x;
    h.z = z;
    h.jit = leanRng() * 0.035;
    h.initOpen = open;
    h.id = hinges.length;
    hinges.push(h);
    (parent || scene).add(h.group);
    return h;
  }

  function stack(x, z, layers, { yaw = null, ...o } = {}) {
    const y0 = yaw ?? autoYaw(x, z, null);
    const nx = Math.sin(y0);
    const nz = Math.cos(y0);
    return layers.map((L) =>
      popup(L.pts, L.paint, {
        ...o,
        x: x + nx * (L.d || 0) + nz * (L.dx || 0),
        z: z + nz * (L.d || 0) - nx * (L.dx || 0),
        yaw: y0 + (L.yaw || 0),
        scale: (o.scale ?? 1) * (L.scale ?? 1),
      }),
    );
  }

  function dome(x, z, { r = 3, h = r, n = 5, paint = null, ...o } = {}) {
    const layers = [];
    for (let i = 0; i < n; i++) {
      const d = -r + ((2 * i + 1) * r) / n;
      const k = Math.sqrt(Math.max(0, 1 - (d / r) ** 2));
      const w = r * k;
      const hh = h * k;
      const pts = [];
      for (let s = 0; s <= 16; s++) {
        const a = (Math.PI * s) / 16;
        pts.push([-Math.cos(a) * w, Math.sin(a) * hh]);
      }
      layers.push({ pts, paint: Array.isArray(paint) ? paint[i % paint.length] : paint, d });
    }
    return stack(x, z, layers, o);
  }

  const printed = (pts, paint, { res = 1, cross = false, holes = null } = {}) =>
    makeCard(pts, { paint, paper, seed: seedN++, thickness: 0.08, edgeWidth: 0.08, pxPerUnit: 40 * res, effects: 1, back: cross ? 'mirror' : 'kraft', holes }).material;
  const cardOpts = (x, z, scale = 1, parent = null, res = 1) => {
    const sharp = parent || roam || sharpAt(x, z) ? 1 : 0;
    return { paper, seed: seedN++, thickness: 0.08, edgeWidth: 0.08 / scale, pxPerUnit: ((sharp ? 40 : 28) * res) / scale, effects: sharp };
  };
  const lamp = (x, y, z, k = 1, dist = 10) => lamps.push([x, y, z, k, dist]);
  const glowing = (group) => {
    glowers.push(group);
    group.traverse((o) => o.userData.setGlow?.(0.35));
  };

  // 光照、软阴影与移轴微距后期
  const L = {
    target: new THREE.Vector3(0, 0, -6),
    keyDir: [-0.8, 0.95, 0.55],
    key: '#ffdcb2',
    keyIntensity: 3.0,
    fill: '#f2dcc2',
    fillIntensity: 0.8,
    fillDir: [0.45, 0.5, 1.0],
    sky: '#fff0da',
    ground: '#b39a78',
    skyIntensity: 0.42,
    shadowExtent: 46,
    distance: 90,
    mapSize: 2048,
    leak: '#a0602c',
    softness: 0.26,
    maxPenumbra: 1.4,
    ...light,
  };
  const lights = paperLights(scene, L);
  PAPER_LIGHT.leak.value.set(L.leak);
  enableSoftShadows(lights.key, { softness: L.softness, maxPenumbra: L.maxPenumbra });
  const post = new PaperPost(renderer, scene, camera, {
    haze: '#d8bf8e',
    hazeStart: 34,
    hazeEnd: 95,
    hazeAmount: 0.28,
    focusBand: 0.3,
    ramp: 0.3,
    maxBlur: 16,
    tint: [1.03, 0.985, 0.98],
    saturation: 0.96,
    greenDesat: 0.3,
    exposure: 0.82,
    contrast: 1.18,
    vignette: 0.03,
    ...lens,
  });
  post.setSize(dim.w, dim.h);
  post.bandScale = 1 / LENS.tall;
  post.magnify = LENS.mag;

  const moodMap = { ...MOODS, ...extraMoods };
  const DAY = { key: L.key, ki: L.keyIntensity, dir: L.keyDir, fill: L.fill, fi: L.fillIntensity, sky: L.sky, skyG: L.ground, si: L.skyIntensity, leak: L.leak, wrap: PAPER_LIGHT.wrap.value, glow: 0.35, lamp: 0, post: {} };
  const post0 = { ...post.o, tint: [...post.o.tint] };
  const postTouched = new Set();
  const lampLights = [];
  const _ma = new THREE.Color();
  const _mb = new THREE.Color();
  const _mc = new THREE.Color();
  const _da = new THREE.Vector3();
  const _db = new THREE.Vector3();
  const mixCol = (out, a, b, k) => out.copy(_ma.set(a)).lerp(_mb.set(b), k);
  const moodOf = (m) => {
    const o = typeof m === 'string' ? moodMap[m] || DAY : m;
    const r = { ...DAY };
    for (const key in o || {}) if (o[key] != null) r[key] = o[key];
    return r;
  };

  function mixMood(a, b = a, k = 0) {
    const A0 = moodOf(a);
    const B0 = moodOf(b);
    const t0 = THREE.MathUtils.clamp(+k || 0, 0, 1);
    const lerp = THREE.MathUtils.lerp;
    mixCol(lights.key.color, A0.key, B0.key, t0);
    lights.key.intensity = lerp(A0.ki, B0.ki, t0);
    mixCol(lights.fill.color, A0.fill, B0.fill, t0);
    lights.fill.intensity = lerp(A0.fi, B0.fi, t0);
    mixCol(lights.sky.color, A0.sky, B0.sky, t0);
    mixCol(lights.sky.groundColor, A0.skyG, B0.skyG, t0);
    lights.sky.intensity = lerp(A0.si, B0.si, t0);
    _da.set(...A0.dir).normalize().lerp(_db.set(...B0.dir).normalize(), t0).normalize();
    lights.key.position.copy(lights.key.target.position).addScaledVector(_da, L.distance);
    mixCol(PAPER_LIGHT.leak.value, A0.leak, B0.leak, t0);
    PAPER_LIGHT.wrap.value = lerp(A0.wrap, B0.wrap, t0);
    const glow = lerp(A0.glow, B0.glow, t0);
    for (const gr of glowers) gr.traverse((o) => o.userData.setGlow?.(glow));
    const lampInt = lerp(A0.lamp, B0.lamp, t0);
    if (A0.lamp > 0 || B0.lamp > 0) {
      for (let i = lampLights.length; i < lamps.length; i++) {
        const [x, y, z, kk, d] = lamps[i];
        const P = new THREE.PointLight('#ffb070', 0, d, 1.0);
        P.position.set(x, y, z);
        P.userData.k = kk;
        scene.add(P);
        lampLights.push(P);
      }
    }
    for (const P of lampLights) P.intensity = lampInt * P.userData.k;
    for (const key of new Set([...Object.keys(A0.post || {}), ...Object.keys(B0.post || {}), ...postTouched])) {
      const va = A0.post?.[key] ?? post0[key];
      const vb = B0.post?.[key] ?? post0[key];
      post.o[key] =
        typeof va === 'number'
          ? lerp(va, vb, t0)
          : Array.isArray(va)
            ? va.map((v, i) => lerp(v, vb[i], t0))
            : t0 <= 0 || va === vb
              ? va
              : t0 >= 1
                ? vb
                : '#' + mixCol(_mc, va, vb, t0).getHexString();
      postTouched.add(key);
    }
    post.apply();
  }

  const cues = [];
  const stepHooks = [];
  const restartHooks = [];
  let cameraController = null;
  const shadowAt = target.clone();
  let time = 0;

  const fold = (h, open = true, delay = 0) => h.set(open ? 1 : 0, delay);
  const setOpen = (open) => {
    const maxOrder = hinges.length ? Math.max(...hinges.map((h) => h.order)) : 0;
    for (const h of hinges) {
      const k = open ? h.order : maxOrder - h.order;
      fold(h, open, 0.1 + k * (open ? 0.08 : 0.045) + h.jit);
    }
  };
  const camCtx = { camera, target, post, lights, fitShadow, view, frame, shadowAt, setFocus: (x, y, z) => post.focus.set(x, y, z) };

  function stepOne(dt) {
    time += dt;
    for (const h of hinges) {
      h.update(dt);
      h.sway = h.swayAmp ? windSway(time, h.x, h.z, { amp: 1.6 * h.swayAmp, heroHeight }) : 0;
    }
    for (const c of cues) {
      if (!c.done && time >= c.t) {
        c.done = true;
        c.fn(time);
      }
    }
    for (const fn of stepHooks) fn(time, dt);
    if (cameraController) {
      post.focus.copy(target);
      cameraController(time, dt, camCtx);
      camera.updateMatrixWorld();
    } else {
      placeOn(camera, target, view.yaw + Math.sin(time * 0.21) * 0.5, view.pitch + Math.sin(time * 0.17) * 0.3);
    }
  }

  function renderNow() {
    if (!cameraController) {
      if (focus) post.focus.set(...focus);
      else post.focus.copy(target);
    }
    post.render(time);
    renderer.getContext().flush();
  }

  function restart() {
    time = 0;
    for (const h of hinges) h.reset(h.initOpen);
    for (const c of cues) c.done = false;
    target.copy(TARGET0);
    shadowAt.copy(TARGET0);
    fitShadow(lights, shadowAt);
    mixMood(mood || 'day');
    for (const fn of restartHooks) fn();
    if (autoOpen) setOpen(true);
    for (const c of cues) {
      if (!c.done && c.t <= 0) {
        c.done = true;
        c.fn(0);
      }
    }
    if (cameraController) {
      post.focus.copy(target);
      cameraController(0, 0, camCtx);
      camera.updateMatrixWorld();
    } else {
      placeOn(camera, target, view.yaw, view.pitch);
    }
  }

  /** 确定性跳转：每次从 t=0 以固定步长重放至目标时刻，同步渲染并 flush WebGL 缓冲。 */
  function seek(seconds) {
    restart();
    const targetSec = Math.max(0, Number(seconds) || 0) + Math.max(0, Number(prewarmSeconds) || 0);
    const steps = Math.round(targetSec * stepHz);
    const dt = 1 / stepHz;
    for (let i = 0; i < steps; i++) stepOne(dt);
    renderNow();
    return time;
  }

  /** 快捷挂载 paper-life.js 微生态（fallers/motes/flyers/flock/puffs/cloudShadows），自动挂接 onStep 与 onRestart。 */
  function attachLife(opts = {}) {
    const life = createLife({ scene, camera, heroHeight, ...opts });
    stepHooks.push((_t, dt) => life.update(dt, target));
    restartHooks.push(() => life.reset(target));
    return life;
  }

  return {
    THREE,
    P2,
    canvas: cv,
    renderer,
    scene,
    camera,
    paper,
    lights,
    post,
    view,
    target,
    walk,
    hinges,
    bounds,
    frame,
    heroHeight,
    groundAt,
    inFrame,
    sharpAt,
    printGround,
    popup,
    stack,
    dome,
    printed,
    cardOpts,
    lamp,
    glowing,
    mixMood,
    fold,
    setOpen,
    cue: (at, fn) => cues.push({ t: at, fn, done: false }),
    onStep: (fn) => stepHooks.push(fn),
    onRestart: (fn) => restartHooks.push(fn),
    setCameraController: (fn) => {
      cameraController = fn;
    },
    attachLife,
    registerLights: (presets) => {
      for (const [name, p] of Object.entries(presets || {})) {
        if (!p || typeof p !== 'object' || name.startsWith('_') || moodMap[name]) continue;
        moodMap[name] = { key: p.key, fill: p.fill, leak: p.leak, post: { haze: p.haze } };
      }
    },
    get time() {
      return time;
    },
    restart,
    seek,
    render: renderNow,
  };
}

/** 接入 HyperFrames：加载 lights.json 与字体、预热首帧 WebGL 着色器并挂接 hf-seek。 */
export function play(worldOrFactory, options = {}) {
  const key = options.key ?? 'papercraft';
  const hf = (window.__hf = window.__hf || {});
  hf.buildReady = hf.buildReady || {};
  let world = null;
  const ready = (hf.buildReady[key] = (async () => {
    const lights = await loadLights(options.lightsUrl);
    if (document.fonts && document.fonts.size) await document.fonts.ready;
    world = typeof worldOrFactory === 'function' ? await worldOrFactory({ lights }) : worldOrFactory;
    if (typeof world.registerLights === 'function') world.registerLights(lights);
    world.seek(0);
    window.__papercraft = { seek: (sec) => world.seek(sec), restart: () => world.restart(), frame: world.frame, ready: true };
    return world;
  })());
  window.addEventListener('hf-seek', (e) => {
    const done = ready.then(() => world.seek(e.detail.time));
    if (typeof e.detail.waitUntil === 'function') e.detail.waitUntil(done);
  });
  return { ready };
}
