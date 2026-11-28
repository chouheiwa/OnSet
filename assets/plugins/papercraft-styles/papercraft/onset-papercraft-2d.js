// onset-papercraft-2d.js：片场为 xikhar/papercraft（v0.7.0，MIT）写的 2D 确定性 HyperFrames 接头。
// - 强制全部 2D 画布走 CPU 软件光栅（willReadFrequently: true），保证跨次渲染逐像素一致；
// - 对接 HyperFrames hf-seek 与 window.__hf.buildReady，任意乱序时间点均从 t=0 固定步长步进；
// - 自动读取 window.ONSET_SCENE 画幅并兼容 16:9 / 9:16 / 3:4 / 1:1，无 WebAudio、无 rAF、无真时钟。
import * as P2 from './paperkit-2d.js';
import { FlapSpring, WalkField, windSway } from './paper-motion.js';

(() => {
  const patch = (proto) => {
    if (!proto || proto.__onsetPapercraft2DPatched) return;
    const orig = proto.getContext;
    proto.getContext = function (type, opts) {
      return type === '2d'
        ? orig.call(this, type, { willReadFrequently: true, ...(opts || {}) })
        : orig.call(this, type, opts);
    };
    proto.__onsetPapercraft2DPatched = true;
  };
  if (typeof HTMLCanvasElement !== 'undefined') patch(HTMLCanvasElement.prototype);
  if (typeof OffscreenCanvas !== 'undefined') patch(OffscreenCanvas.prototype);
})();

let _lightsCache = null;

/** 从同目录加载离线光照预设（lights.json）；失败时返回空对象以便独立运行。 */
export async function loadLights(url = './papercraft/lights.json') {
  if (_lightsCache) return _lightsCache;
  try {
    const res = await fetch(url);
    if (res.ok) _lightsCache = await res.json();
  } catch {
    // 离线容错：调用方仍可直接传自定义色值。
  }
  return _lightsCache || {};
}

/** 读取本镜头画布尺寸（优先 ONSET_SCENE / data-width / innerWidth）。 */
export function resolveCanvasSize(opts = {}) {
  const sc = typeof window !== 'undefined' ? window.ONSET_SCENE?.canvas : null;
  const root = typeof document !== 'undefined' ? document.querySelector('[data-composition-id]') : null;
  const w = Number(opts.width) || Number(sc?.width_px) || Number(root?.dataset?.width) || (typeof innerWidth === 'number' ? innerWidth : 1920);
  const h = Number(opts.height) || Number(sc?.height_px) || Number(root?.dataset?.height) || (typeof innerHeight === 'number' ? innerHeight : 1080);
  const fps = Number(opts.fps) || Number(sc?.fps) || 30;
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), fps };
}

/**
 * 创建 2D 折纸立体书确定性世界。
 * 支持无主角纯场景/叙事镜头（不强制 setHero），通过 seek(seconds) 确定性渲染任意时刻。
 */
export function createWorld2D({
  canvas = null,
  width = 0,
  height = 0,
  view = {},
  light = [-0.7, 1.1, 0.4],
  grade = 'saturate(1.26) contrast(1.06)',
  ground = '#d9d2c2',
  shadow = '#6e3010',
  kraft = '#c9a77c',
  stock = '#fbf4e8',
  walk: walkOpts = { step: 0.6, radius: 0.45 },
  subject = null,
  autoOpen = true,
  prewarmSeconds = 0,
  stepHz = 60,
} = {}) {
  const dim = resolveCanvasSize({ width, height });
  const VIEW = { pitch: 40, dist: 70, across: 54, focus: 0.55, band: 0.28, ramp: 0.3, maxBlur: 9, ...view };
  const sinP = Math.sin((VIEW.pitch * Math.PI) / 180);
  const cosP = Math.cos((VIEW.pitch * Math.PI) / 180);
  const L = (() => {
    const n = Math.hypot(...light) || 1;
    return light.map((v) => v / n);
  })();

  let cv = canvas || document.getElementById('c');
  if (!cv) {
    cv = document.createElement('canvas');
    cv.id = 'c';
    document.body.prepend(cv);
  }
  cv.width = dim.w;
  cv.height = dim.h;
  const g = cv.getContext('2d', { willReadFrequently: true });

  // 按短边保持景别比例：9:16 竖屏自动拉近（closer）并把清晰带抬至上方 ~42%，为底部字幕留白。
  const REF = 16 / 9;
  const REF_H = (9 / 16) * VIEW.across;
  const A = dim.w / dim.h;
  const MAG = A < 1 ? Math.min(1 / A, Math.max(1, VIEW.closer ?? 1.33) ** (Math.log(1 / A) / Math.log(REF))) : 1;
  const FW = A >= 1 ? REF_H * A : REF_H / MAG;
  const FH = FW / A;
  const LAT = Math.min(1, A / REF) * Math.min(1, FW / VIEW.across);
  const AX = subject ? subject[0] * (1 - LAT) : 0;
  const vF = (VIEW.focus - 0.5) * REF_H;
  const wL = Math.min(1, Math.max(0, (1 - A) / (1 - 9 / 16)));
  const FOCUS = A >= 1 ? VIEW.focus : VIEW.subjectY != null ? 0.5 - VIEW.subjectY / 2 : 0.5 + vF / FH + (0.42 - (0.5 + vF / FH)) * wL;
  const BAND = (VIEW.band * REF_H) / FH;
  const RAMP = (VIEW.ramp * REF_H) / FH;

  const S = dim.w / FW;
  const CX = dim.w / 2 - AX * S;
  const CY = FOCUS * dim.h - vF * S;
  const SHORT0 = Math.min(dim.w, dim.h);
  const BLUR = VIEW.maxBlur * (SHORT0 / 1080) * MAG;
  const Q = Math.min(48 * Math.max(1, (SHORT0 / 1080) * MAG), Math.max(16, S * 1.25));
  const CAM = { x: 0, z: 0, zoom: 1 };

  const depthK = (z) => VIEW.dist / (VIEW.dist - z * cosP);
  const proj = (x, y, z) => {
    const k = depthK(z - CAM.z) * CAM.zoom;
    return [CX + (x - CAM.x) * S * k, CY + ((z - CAM.z) * sinP - y * cosP) * S * k, k];
  };
  const mk = (w, h) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  };
  const blurAt = (fy) => {
    const d = Math.max(0, Math.abs(fy - FOCUS) - BAND / 2);
    return BLUR * Math.min(1, d / Math.max(1e-4, RAMP));
  };
  const sheet = P2.paperSheet({ size: 512, color: stock, seed: 9 });
  const zAt = (fy) => {
    const v = (fy * dim.h - CY) / S;
    return (v * VIEW.dist) / (sinP * VIEW.dist + v * cosP);
  };
  const zTop = zAt(0);
  const zBot = zAt(1);
  const halfAt = (z) => (FW / 2 + Math.abs(AX)) / depthK(z);
  const frame = { w: dim.w, h: dim.h, aspect: A, mag: MAG, focusY: FOCUS, cx: AX, half: (z) => FW / 2 / depthK(z) };

  const GX0 = -Math.ceil(halfAt(zTop) + 8);
  const GX1 = -GX0;
  const GZ0 = Math.floor(zTop - 8);
  const GZ1 = Math.ceil(zBot + 6);
  const GQ = Math.min(20, Q);
  let groundSheet = null;
  let groundLayer = null;
  let groundCamKey = '';

  function printGround(draw, { seed = 31 } = {}) {
    const rnd = P2.rng(seed);
    const c = mk((GX1 - GX0) * GQ, (GZ1 - GZ0) * GQ);
    const x = c.getContext('2d', { willReadFrequently: true });
    const W = c.width;
    const H = c.height;
    const X = (wx) => (wx - GX0) * GQ;
    const Z = (wz) => (wz - GZ0) * GQ;
    x.fillStyle = ground;
    x.fillRect(0, 0, W, H);
    const washes = (cols) => {
      for (const [n, r0, r1, a] of [[50, 8, 20, 0.3], [180, 2.5, 7, 0.2], [600, 0.5, 1.6, 0.12]]) {
        for (let i = 0; i < n; i++) {
          const px = rnd() * W;
          const py = rnd() * H;
          const r = (r0 + rnd() * (r1 - r0)) * GQ;
          const col = cols[Math.floor(rnd() * cols.length)];
          const gr = x.createRadialGradient(px, py, 0, px, py, r);
          gr.addColorStop(0, P2.rgba(col, a * 0.6));
          gr.addColorStop(0.78, P2.rgba(col, a));
          gr.addColorStop(0.9, P2.rgba(P2.shade(col, -0.15), a * 1.2));
          gr.addColorStop(1, P2.rgba(col, 0));
          x.fillStyle = gr;
          x.fillRect(px - r, py - r, 2 * r, 2 * r);
        }
      }
    };
    const ribbon = (fx, w, col, wob = 0) => {
      x.strokeStyle = col;
      x.lineWidth = w * GQ;
      x.lineCap = x.lineJoin = 'round';
      x.beginPath();
      for (let z = GZ0; z <= GZ1; z += 0.5) {
        (z === GZ0 ? x.moveTo : x.lineTo).call(x, X(fx(z) + wob * Math.sin(z * 1.1 + w)), Z(z));
      }
      x.stroke();
    };
    const line = (pts, w, col) => {
      x.strokeStyle = col;
      x.lineWidth = w * GQ;
      x.lineCap = x.lineJoin = 'round';
      x.beginPath();
      pts.forEach(([wx, wz], i) => (i ? x.lineTo(X(wx), Z(wz)) : x.moveTo(X(wx), Z(wz))));
      x.stroke();
    };
    const drifts = (fn, { n = 10000, inside = 0.55, outside = 0.02, threshold = 0.6 } = {}) => {
      const mask = P2.tileNoise(128, 7, rnd);
      const at = (px, py) => mask[(Math.floor((py / H) * 128) & 127) * 128 + (Math.floor((px / W) * 128) & 127)];
      for (let k = 0; k < n; k++) {
        const px = rnd() * W;
        const py = rnd() * H;
        if (rnd() > (at(px, py) > threshold ? inside : outside)) continue;
        fn(px, py);
      }
    };
    draw({ x, W, H, GQ, X, Z, GX0, GX1, GZ0, GZ1, rnd, washes, ribbon, line, drifts });
    x.globalCompositeOperation = 'multiply';
    x.fillStyle = x.createPattern(sheet, 'repeat');
    x.fillRect(0, 0, W, H);
    groundSheet = c;
    groundLayer = null;
  }

  function buildGroundLayer() {
    const c = mk(cv.width, cv.height);
    const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = ground;
    x.fillRect(0, 0, c.width, c.height);
    if (groundSheet) {
      x.imageSmoothingQuality = 'medium';
      x.filter = grade;
      const N = 160;
      const dz = (GZ1 - GZ0) / N;
      for (let i = 0; i < N; i++) {
        const z0 = GZ0 + i * dz;
        const z1 = z0 + dz;
        const [, y0] = proj(0, 0, z0);
        const [, , k] = proj(0, 0, (z0 + z1) / 2);
        const [, y2] = proj(0, 0, z1);
        x.drawImage(
          groundSheet,
          0,
          (z0 - GZ0) * GQ,
          groundSheet.width,
          dz * GQ,
          CX + (GX0 - CAM.x) * S * k,
          y0,
          (GX1 - GX0) * S * k,
          y2 - y0 + 0.75,
        );
      }
      x.filter = 'none';
    }
    if (BLUR > 0.4) {
      const b = mk(cv.width, cv.height);
      const bx = b.getContext('2d', { willReadFrequently: true });
      bx.filter = `blur(${BLUR}px)`;
      bx.drawImage(c, 0, 0);
      bx.filter = 'none';
      bx.globalCompositeOperation = 'destination-in';
      const gr = bx.createLinearGradient(0, 0, 0, cv.height);
      for (let i = 0; i <= 24; i++) gr.addColorStop(i / 24, `rgba(0,0,0,${blurAt(i / 24) / BLUR})`);
      bx.fillStyle = gr;
      bx.fillRect(0, 0, cv.width, cv.height);
      x.drawImage(b, 0, 0);
    }
    groundLayer = c;
    groundCamKey = `${CAM.x.toFixed(4)},${CAM.z.toFixed(4)},${CAM.zoom.toFixed(4)}`;
  }

  let rnd = P2.rng(31);
  const pieces = [];
  const decks = [];
  const walk = new WalkField(walkOpts);
  let hero = null;
  let HERO0 = [0, 0];

  function piece(
    pts,
    paint,
    { x = 0, z = 0, y = 0, seed = pieces.length * 7 + 3, sway = 0, yaw = 0, slotted = false, sharp = false, holes = null, float = false, bob = 0, reflect = false, open = 0 } = {},
  ) {
    const pr = P2.printCard(pts, {
      pxPerUnit: Q,
      sheet,
      seed,
      holes,
      paint: (P) => {
        paint(P);
        P.draw((gg) => {
          const gr = gg.createLinearGradient(0, P.box.y0, 0, P.box.y0 + 0.4);
          gr.addColorStop(0, 'rgba(60,34,14,0.14)');
          gr.addColorStop(1, 'rgba(60,34,14,0)');
          gg.fillStyle = gr;
          gg.fillRect(P.box.x0 - 1, P.box.y0 - 1, P.box.w + 2, 1.4);
        });
        P.rim({ width: 0.08, skip: (x0, y0, x1, y1) => Math.abs(y0 - P.box.y0) < 1e-6 && Math.abs(y1 - P.box.y0) < 1e-6 });
      },
    });
    const q = pr.pxPerUnit;
    const box = pr.box;
    const [, by0, k0] = proj(x, 0, z);
    const fy = (by0 - box.h * 0.5 * cosP * S * k0) / dim.h;
    const blur = sharp ? 0 : (blurAt(fy) * q) / (S * k0);
    const pad = Math.ceil(blur * 2 + 4);
    const img = mk(pr.canvas.width + 2 * pad, pr.canvas.height + 2 * pad);
    {
      const c = img.getContext('2d', { willReadFrequently: true });
      c.filter = (blur > 0.4 ? `blur(${blur}px) ` : '') + grade;
      c.drawImage(pr.canvas, pad, pad);
    }
    const tint = (src, col) => {
      const c = mk(src.width, src.height);
      const xx = c.getContext('2d', { willReadFrequently: true });
      xx.drawImage(src, 0, 0);
      xx.globalCompositeOperation = 'source-in';
      xx.fillStyle = col;
      xx.fillRect(0, 0, c.width, c.height);
      return c;
    };
    const dark = tint(img, '#2a1608');
    const back = tint(img, P2.mix(pr.mean || kraft, kraft, 0.6));
    {
      const xx = back.getContext('2d', { willReadFrequently: true });
      xx.globalCompositeOperation = 'multiply';
      xx.fillStyle = xx.createPattern(sheet, 'repeat');
      xx.fillRect(0, 0, back.width, back.height);
      xx.globalCompositeOperation = 'destination-in';
      xx.drawImage(img, 0, 0);
    }
    const sb = Math.max(1.5, (0.05 * box.h * q) / 2) + blur / 2;
    const sp = Math.ceil(sb * 2 + 3);
    const shadowImg = mk(pr.canvas.width / 2 + 2 * sp, pr.canvas.height / 2 + 2 * sp);
    {
      const xx = shadowImg.getContext('2d', { willReadFrequently: true });
      xx.filter = `blur(${sb}px)`;
      xx.drawImage(pr.canvas, sp, sp, pr.canvas.width / 2, pr.canvas.height / 2);
      xx.filter = 'none';
      xx.globalCompositeOperation = 'source-in';
      xx.fillStyle = shadow;
      xx.fillRect(0, 0, shadowImg.width, shadowImg.height);
    }
    const p = {
      id: pieces.length,
      x,
      z,
      y,
      x0: x,
      z0: z,
      y0: y,
      box,
      q,
      pad,
      img,
      dark,
      back,
      shadow: shadowImg,
      sp,
      sway,
      slotted,
      yaw,
      float,
      bob,
      reflect,
      cy: Math.cos(yaw),
      jit: rnd() * 0.04,
      initOpen: open,
      spring: new FlapSpring({ p: open, size: Math.min(1, box.h / 12) }),
      wait: 0,
      pending: false,
      targetOpen: open >= 1,
    };
    pieces.push(p);
    return p;
  }

  function setHero(h, { parts = [], step = 0.9 } = {}) {
    hero = h;
    hero.parts = parts;
    hero.step = step;
    hero.flip = 1;
    hero.face = 1;
    hero.walked = 0;
    hero.gait = 0;
    hero.y = hero.y || 0;
    for (const d of parts) d.p.rider = hero;
    HERO0 = [hero.x, hero.z];
  }

  const cues = [];
  const stepHooks = [];
  const restartHooks = [];
  let cameraFn = null;
  let t = 0;
  let openState = false;

  function fold(p, open = true, delay = 0) {
    p.targetOpen = Boolean(open);
    if (delay > 0) {
      p.wait = delay;
      p.pending = true;
    } else {
      p.pending = false;
      p.wait = 0;
      p.spring.set(p.targetOpen ? 1 : 0);
    }
  }

  function setOpen(o) {
    openState = Boolean(o);
    if (!pieces.length) return;
    const zMin = Math.min(...pieces.map((p) => p.z));
    const zMax = Math.max(...pieces.map((p) => p.z));
    for (const p of pieces) {
      if (p.rider) continue;
      const k = (p.z - zMin) / Math.max(1e-6, zMax - zMin);
      fold(p, openState, 0.12 + (openState ? k * 0.95 : (1 - k) * 0.55) + p.jit);
    }
  }

  const wrap = (d) => Math.max(0, (d + 0.3) / 1.3);
  const pool = (() => {
    const c = mk(64, 64);
    const x = c.getContext('2d', { willReadFrequently: true });
    const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, P2.rgba(shadow, 0.9));
    gr.addColorStop(0.55, P2.rgba(shadow, 0.45));
    gr.addColorStop(1, P2.rgba(shadow, 0));
    x.fillStyle = gr;
    x.fillRect(0, 0, 64, 64);
    return c;
  })();

  function drawShadow(s) {
    const { p, phi, bx, by } = s;
    const open01 = Math.min(1, Math.max(0, p.spring.p));
    if (open01 < 0.02) return;
    const a = (-Math.cos(phi) * L[0]) / L[1];
    const bz = Math.sin(phi) - (Math.cos(phi) * L[2]) / L[1];
    const qs = p.q / 2;
    const sp = p.sp;
    const { box } = p;
    const Sk = s.s;
    const f = p.flip ?? 1;
    const A0 = (Sk * p.cy * f) / qs;
    const Cc = (-Sk * a) / qs;
    const Dd = (-Sk * sinP * bz) / qs;
    g.globalAlpha = 0.5 * open01;
    g.setTransform(
      A0,
      0,
      Cc,
      Dd,
      bx + Sk * p.cy * f * box.x0 + Sk * a * box.y1 - sp * A0 - sp * Cc,
      by + Sk * sinP * bz * box.y1 - sp * Dd,
    );
    g.drawImage(p.shadow, 0, 0);
  }

  function drawContact(s) {
    const o = Math.min(1, Math.max(0, s.p.spring.p));
    if (o < 0.05) return;
    const w = s.p.box.w * s.s * s.p.cy * 0.52;
    const h = Math.max(2, 0.4 * s.s * sinP);
    const cx = s.bx + (s.s * s.p.cy * (s.p.box.x0 + s.p.box.x1)) / 2 + w * 0.1;
    g.setTransform(w, 0, 0, h, cx, s.by);
    g.globalAlpha = 0.68 * o;
    g.drawImage(pool, -1, -1, 2, 2);
  }

  function drawReflection(s) {
    const { p, k, bx, by } = s;
    const o = Math.min(1, Math.max(0, p.spring.p));
    if (o < 0.05 || k <= 0) return;
    const { box, q, pad } = p;
    const Sk = s.s;
    const sx = Sk * p.cy * (p.flip ?? 1);
    g.globalAlpha = 0.22 * o;
    g.setTransform(sx / q, 0, 0, (-k * Sk * 0.7) / q, bx + sx * box.x0 - (pad * sx) / q, by + k * Sk * 0.7 * box.y1 + (k * pad * Sk * 0.7) / q);
    g.drawImage(p.dark, 0, 0);
  }

  function render() {
    const camKey = `${CAM.x.toFixed(4)},${CAM.z.toFixed(4)},${CAM.zoom.toFixed(4)}`;
    if (!groundLayer || groundCamKey !== camKey) buildGroundLayer();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.imageSmoothingQuality = 'medium';
    g.drawImage(groundLayer, 0, 0);

    const st = pieces.map((p) => {
      const sway = p.sway ? windSway(t, p.x, p.z, { amp: 1.4 * p.sway, heroHeight: 3.2 }) : 0;
      const phi = ((1 - p.spring.p) * Math.PI) / 2 + sway * Math.min(1, p.spring.p);
      const y = (p.y || 0) + (p.bob ? Math.sin(t * 1.3 + p.jit * 150) * p.bob : 0);
      const [bx, by, k] = proj(p.x, y, p.z);
      return { p, phi, k: Math.cos(phi + (VIEW.pitch * Math.PI) / 180), bx, by, s: S * k };
    });

    for (const s of st) if (s.p.reflect) drawReflection(s);
    for (const s of st) if (!(s.p.y > 0.01) && !s.p.float) drawShadow(s);
    for (const s of st) if (!(s.p.y > 0.01) && !s.p.float) drawContact(s);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    for (const d of decks) {
      if (d.shadow) {
        g.save();
        d.shadow();
        g.restore();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = 1;
      }
    }

    const flat = st.filter((s) => s.k <= 0).sort((a, b) => b.p.z - a.p.z);
    const up = st.filter((s) => s.k > 0).sort((a, b) => a.p.z - b.p.z);
    const order = [...flat, ...up];
    for (const d of decks) {
      const at = order.findIndex((s) => !s.deck && s.k > 0 && s.p.z > d.z + 1e-3);
      order.splice(at < 0 ? order.length : at, 0, { deck: d });
    }
    for (const s of order) {
      if (s.deck) {
        g.save();
        s.deck.draw();
        g.restore();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = 1;
        continue;
      }
      if (s.p.y > 0.01 && !s.p.float) {
        drawShadow(s);
        drawContact(s);
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = 1;
      }
      const { p, phi, k, bx, by } = s;
      const { box, q, pad } = p;
      const Sk = s.s;
      const sx = Sk * p.cy * (p.flip ?? 1);
      if (Math.abs(k) < 0.004) continue;
      const front = k > 0;
      const nL = front ? -Math.sin(phi) * L[1] + Math.cos(phi) * L[2] * p.cy - Math.sin(p.yaw) * L[0] : Math.sin(phi) * L[1] - Math.cos(phi) * L[2];
      const lit = Math.min(1, 0.62 + 0.3 * wrap(nL) + 0.12 * Math.max(0, k));
      const drawCard = (scaleX, darkK) => {
        g.setTransform((sx * scaleX) / q, 0, 0, (k * Sk) / q, bx + sx * scaleX * box.x0 - (pad * sx * scaleX) / q, by - k * Sk * box.y1 - (k * pad * Sk) / q);
        g.drawImage(front ? p.img : p.back, 0, 0);
        const a = Math.min(0.9, (1 - lit) * 0.9 + darkK);
        if (a > 0.005) {
          g.globalAlpha = a;
          g.drawImage(p.dark, 0, 0);
          g.globalAlpha = 1;
        }
      };
      drawCard(1, 0);
      if (p.slotted && front && k > 0.2) drawCard(0.16, 0.22);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    const vg = g.createRadialGradient(cv.width / 2, cv.height / 2, cv.height * 0.45, cv.width / 2, cv.height / 2, cv.height);
    vg.addColorStop(0, 'rgba(42,23,11,0)');
    vg.addColorStop(1, 'rgba(42,23,11,0.08)');
    g.fillStyle = vg;
    g.fillRect(0, 0, cv.width, cv.height);
  }

  function update(dt) {
    t += dt;
    for (const c of cues) {
      if (!c.done && t >= c.t) {
        c.done = true;
        c.fn(t);
      }
    }
    for (const fn of stepHooks) fn(t, dt);
    if (hero) {
      const ph = hero.walked / hero.step;
      const phase = (u) => (u >= 1 ? 3 - 2 * u : 2 * (u * u * (3 - 2 * u)) - 1);
      const legX = [0, 1].map((i) => ((phase((ph + i) % 2) * hero.step) / 2) * hero.gait);
      for (const d of hero.parts) {
        d.p.x = hero.x + (d.dx + (d.leg !== undefined ? legX[d.leg] : 0)) * hero.flip;
        d.p.z = hero.z + d.dz;
        d.p.y = hero.y + d.dy;
        d.p.flip = hero.flip;
      }
    }
    for (const p of pieces) {
      if (p.rider) {
        p.spring.p = p.rider.spring.p;
        continue;
      }
      if (p.pending) {
        p.wait -= dt;
        if (p.wait <= 0) {
          p.pending = false;
          p.spring.set(p.targetOpen ? 1 : 0);
        }
      }
      p.spring.step(dt);
    }
    if (cameraFn) cameraFn(t, CAM);
  }

  function restart() {
    t = 0;
    CAM.x = 0;
    CAM.z = 0;
    CAM.zoom = 1;
    for (const c of cues) c.done = false;
    for (const p of pieces) {
      p.x = p.x0;
      p.z = p.z0;
      p.y = p.y0;
      p.spring.reset(p.initOpen);
      p.wait = 0;
      p.pending = false;
      p.targetOpen = p.initOpen >= 1;
    }
    if (hero) {
      [hero.x, hero.z] = HERO0;
      hero.y = 0;
      hero.face = hero.flip = 1;
      hero.walked = hero.gait = 0;
    }
    for (const fn of restartHooks) fn();
    if (autoOpen) setOpen(true);
    for (const c of cues) {
      if (!c.done && c.t <= 0) {
        c.done = true;
        c.fn(0);
      }
    }
    if (cameraFn) cameraFn(0, CAM);
  }

  /** 确定性跳转：无论多 worker 乱序 seek 到哪一帧，总是从 t=0 固定步长推进，逐像素可复现。 */
  function seek(seconds) {
    restart();
    const targetSec = Math.max(0, Number(seconds) || 0) + Math.max(0, Number(prewarmSeconds) || 0);
    const steps = Math.round(targetSec * stepHz);
    const dt = 1 / stepHz;
    for (let i = 0; i < steps; i++) update(dt);
    render();
    return t;
  }

  return {
    P2,
    canvas: cv,
    g,
    proj,
    view: VIEW,
    L,
    frame,
    zTop,
    zBot,
    zAt,
    halfAt,
    sheet,
    Q,
    mk,
    grade,
    printGround,
    piece,
    decks,
    walk,
    setHero,
    fold,
    setOpen,
    cue: (at, fn) => cues.push({ t: at, fn, done: false }),
    onStep: (fn) => stepHooks.push(fn),
    onRestart: (fn) => restartHooks.push(fn),
    setCamera: (fn) => {
      cameraFn = fn;
    },
    get rnd() {
      return rnd;
    },
    reseed: (n) => {
      rnd = P2.rng(n);
      return rnd;
    },
    get time() {
      return t;
    },
    restart,
    seek,
    render,
  };
}

/** 接入 HyperFrames：登记 window.__hf.buildReady，先画第 0 帧，每次 hf-seek 确定性渲染。 */
export function play(worldOrFactory, options = {}) {
  const key = options.key ?? 'papercraft';
  const hf = (window.__hf = window.__hf || {});
  hf.buildReady = hf.buildReady || {};
  let world = null;
  const ready = (hf.buildReady[key] = (async () => {
    const lights = await loadLights(options.lightsUrl);
    if (document.fonts && document.fonts.size) await document.fonts.ready;
    world = typeof worldOrFactory === 'function' ? await worldOrFactory({ lights }) : worldOrFactory;
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
