// 猫咪黑盒小屋 —— 游戏主逻辑
// three.js CDN（jsdelivr 主 + unpkg 备），pinned r160

const THREE_URLS = [
  'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js',
  'https://unpkg.com/three@0.160.0/build/three.module.js',
];
let THREE = null;
for (const u of THREE_URLS) {
  try { THREE = await import(u); break; } catch (e) { /* 换下一个 CDN */ }
}
if (!THREE) {
  document.getElementById('errorOverlay').classList.remove('hidden');
  document.getElementById('startOverlay').classList.add('hidden');
  throw new Error('three.js load failed');
}

// ============ 配置 ============
const BOX_DEFS = [
  { id: 'A', color: 0x39ff8e, css: '#39ff8e', ruleName: '质数',
    ruleDesc: '只有质数输出 1（2、3、5、7、11、13）',
    rule: new Set([2, 3, 5, 7, 11, 13]), pos: [-4.2, 1.9] },
  { id: 'B', color: 0xa78bfa, css: '#a78bfa', ruleName: '偶数',
    ruleDesc: '只有偶数输出 1（0、2、4、6、8、10、12、14）',
    rule: new Set([0, 2, 4, 6, 8, 10, 12, 14]), pos: [4.2, 1.9] },
  { id: 'C', color: 0xffd166, css: '#ffd166', ruleName: '平方数',
    ruleDesc: '只有平方数输出 1（0、1、4、9）',
    rule: new Set([0, 1, 4, 9]), pos: [0.6, -3.3] },
];
const CAT_COLORS = [0xdd8a3e, 0x23232e, 0xe9e4d8, 0x8f8f9c];
const ROOM = { x: 5.4, z: 3.9 }; // 猫的活动边界

const $ = id => document.getElementById(id);
const G = { mode: 'idle', probes: 0, solved: 0, attempts: 0, startT: 0, elapsed: 0,
            timerId: null, muted: false, catColor: 0, activeBox: null, promptBox: null };
const IS_TOUCH = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

// ============ 极简 tween ============
const tweens = [];
function tween(dur, update, done) { tweens.push({ t: 0, dur, update, done }); }
function stepTweens(dt) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i]; tw.t += dt;
    const k = Math.min(1, tw.t / tw.dur);
    tw.update(k);
    if (k >= 1) { tweens.splice(i, 1); if (tw.done) tw.done(); }
  }
}

// ============ 合成音效 ============
const sfx = (() => {
  let ctx = null;
  function ac() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, dur, type, vol, when, slideTo) {
    if (G.muted) return;
    try {
      const c = ac(), o = c.createOscillator(), g = c.createGain();
      const t0 = c.currentTime + (when || 0);
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.12, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t0); o.stop(t0 + dur + 0.05);
    } catch (e) {}
  }
  return {
    unlock() { try { ac(); } catch (e) {} },
    click() { tone(660, 0.07, 'square', 0.05); },
    probe() { tone(160, 0.28, 'sawtooth', 0.09, 0, 880); },
    good()  { tone(523, 0.12, 'sine', 0.13); tone(784, 0.2, 'sine', 0.13, 0.09); },
    bad()   { tone(200, 0.22, 'sawtooth', 0.09, 0, 105); },
    open()  { tone(392, 0.12, 'triangle', 0.12); tone(587, 0.16, 'triangle', 0.12, 0.1); },
    win()   { [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, 0.3, 'triangle', 0.13, i * 0.12)); },
  };
})();

function toast(msg, ms) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms || 2200);
}
function fmt(s) {
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

// ============ 渲染器 & 场景 ============
const stage = $('stage');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true });
} catch (e) {
  $('errorOverlay').classList.remove('hidden');
  $('startOverlay').classList.add('hidden');
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070a13);
scene.fog = new THREE.FogExp2(0x070a13, 0.028);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 120);
camera.position.set(0, 4.6, 7.5);

scene.add(new THREE.AmbientLight(0x4a5878, 1.1));
const moon = new THREE.DirectionalLight(0x8fb4ff, 0.5);
moon.position.set(-6, 10, -4);
scene.add(moon);
// 吊灯暖光
const pendantLight = new THREE.PointLight(0xffc98a, 26, 14, 1.8);
pendantLight.position.set(0, 3.1, 0);
scene.add(pendantLight);

// 辉光贴图
function makeGlowTex() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,.4)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
const glowTex = makeGlowTex();

// ============ 小屋 ============
const colliders = []; // {x, z, r}
function addCollider(x, z, r) { colliders.push({ x, z, r }); }

const house = new THREE.Group();
scene.add(house);
function mat(color, rough, metal) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough == null ? 0.85 : rough,
    metalness: metal || 0 });
}

// 地板
const floor = new THREE.Mesh(new THREE.PlaneGeometry(13.4, 10.4), mat(0x6e5238, 0.9));
floor.rotation.x = -Math.PI / 2;
house.add(floor);
// 地板条纹
for (let i = -6; i <= 6; i++) {
  const s = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.012, 10.4), mat(0x5d452f, 0.9));
  s.position.set(i, 0.006, 0);
  house.add(s);
}
// 地毯
const rug = new THREE.Mesh(new THREE.CircleGeometry(2.3, 40),
  new THREE.MeshStandardMaterial({ color: 0x51304a, roughness: 1 }));
rug.rotation.x = -Math.PI / 2; rug.position.set(0, 0.012, -0.3);
house.add(rug);
const rugRing = new THREE.Mesh(new THREE.RingGeometry(2.0, 2.3, 40),
  new THREE.MeshBasicMaterial({ color: 0xa78bfa, transparent: true, opacity: 0.35 }));
rugRing.rotation.x = -Math.PI / 2; rugRing.position.set(0, 0.014, -0.3);
house.add(rugRing);

// 墙（后/左/右）
const wallMat = mat(0x232c44, 0.95);
function wall(w, h, x, y, z, ry) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
  m.position.set(x, y, z); m.rotation.y = ry;
  house.add(m); return m;
}
wall(13.4, 4, 0, 2, -4.9, 0);
wall(10.4, 4, -6.4, 2, 0, Math.PI / 2);
wall(10.4, 4, 6.4, 2, 0, -Math.PI / 2);
// 踢脚线
for (const [w, x, z, ry] of [[13.4, 0, -4.88, 0], [10.4, -6.38, 0, Math.PI / 2], [10.4, 6.38, 0, -Math.PI / 2]]) {
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, 0.18, 0.06), mat(0x151b2e, 0.9));
  b.position.set(x, 0.09, z); b.rotation.y = ry;
  house.add(b);
}
// 窗户（后墙，发光）
const winFrame = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.8, 0.12), mat(0x11162a, 0.7));
winFrame.position.set(-1.6, 2.2, -4.86);
house.add(winFrame);
const winGlass = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.5),
  new THREE.MeshBasicMaterial({ color: 0x274a7a }));
winGlass.position.set(-1.6, 2.2, -4.79);
house.add(winGlass);
const winGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x6ea8ff,
  transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
winGlow.position.set(-1.6, 2.2, -4.7); winGlow.scale.setScalar(4);
house.add(winGlow);
// 窗格
for (const px of [-2.35, -0.85]) {
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.5, 0.04), mat(0x11162a, 0.7));
  bar.position.set(px, 2.2, -4.78); house.add(bar);
}
const barH = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.08, 0.04), mat(0x11162a, 0.7));
barH.position.set(-1.6, 2.2, -4.78); house.add(barH);

// ============ 家具 ============
// 沙发
(function sofa() {
  const g = new THREE.Group(); g.position.set(-3.6, 0, -2.7);
  const m = mat(0x8a4a5e, 0.95);
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.55, 1.1), m); base.position.y = 0.35; g.add(base);
  const back = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.8, 0.3), m); back.position.set(0, 0.85, -0.42); g.add(back);
  for (const sx of [-1.05, 1.05]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.75, 1.1), m);
    arm.position.set(sx, 0.6, 0); g.add(arm);
  }
  for (const sx of [-0.55, 0.55]) {
    const cu = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.16, 0.85), mat(0x9c5a6e, 0.95));
    cu.position.set(sx, 0.68, 0.05); cu.rotation.y = sx * 0.06; g.add(cu);
  }
  house.add(g); addCollider(-3.6, -2.7, 1.45);
})();
// 茶几
(function table() {
  const g = new THREE.Group(); g.position.set(-3.6, 0, -1.1);
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.09, 0.9), mat(0x7a5c3a, 0.7));
  top.position.y = 0.48; g.add(top);
  for (const [sx, sz] of [[-0.65, -0.35], [0.65, -0.35], [-0.65, 0.35], [0.65, 0.35]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.48, 0.09), mat(0x5d452f, 0.8));
    leg.position.set(sx, 0.24, sz); g.add(leg);
  }
  // 茶杯
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.07, 0.14, 12), mat(0xd8d2c4, 0.6));
  cup.position.set(-0.3, 0.6, 0.1); g.add(cup);
  house.add(g); addCollider(-3.6, -1.1, 0.95);
})();
// 书架 + 书
(function shelf() {
  const g = new THREE.Group(); g.position.set(5.3, 0, -4.1);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.7, 2.4, 0.45), mat(0x4a3826, 0.85));
  frame.position.y = 1.2; g.add(frame);
  const cols = [0xd16666, 0x66a8d1, 0x9dd166, 0xd1b166, 0xa78bfa, 0x66d1b8];
  for (let s = 0; s < 3; s++) {
    let bx = -0.7;
    while (bx < 0.65) {
      const bw = 0.09 + Math.random() * 0.07, bh = 0.34 + Math.random() * 0.14;
      const book = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.3),
        mat(cols[(Math.random() * cols.length) | 0], 0.9));
      book.position.set(bx + bw / 2, 0.55 + s * 0.62 + bh / 2 - 0.17, 0.05);
      if (Math.random() < 0.12) book.rotation.z = 0.18;
      g.add(book); bx += bw + 0.015;
    }
    const sh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.05, 0.4), mat(0x3a2c1e, 0.85));
    sh.position.set(0, 0.55 + s * 0.62, 0.02); g.add(sh);
  }
  house.add(g); addCollider(5.3, -4.1, 1.0);
})();
// 落地灯
(function floorLamp() {
  const g = new THREE.Group(); g.position.set(5.0, 0, 3.3);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.7, 10), mat(0x2a2f3a, 0.5, 0.6));
  pole.position.y = 0.85; g.add(pole);
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.5, 16, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xffd9a0, roughness: 0.9, side: THREE.DoubleSide,
      emissive: 0xffb45e, emissiveIntensity: 0.55 }));
  shade.position.y = 1.85; g.add(shade);
  const l = new THREE.PointLight(0xffb45e, 14, 8, 1.8);
  l.position.y = 1.7; g.add(l);
  const gl = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffc98a,
    transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
  gl.position.y = 1.75; gl.scale.setScalar(1.6); g.add(gl);
  house.add(g); addCollider(5.0, 3.3, 0.4);
})();
// 绿植
(function plant() {
  const g = new THREE.Group(); g.position.set(-5.2, 0, 3.4);
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.24, 0.42, 14), mat(0xa85f3d, 0.9));
  pot.position.y = 0.21; g.add(pot);
  const leafM = mat(0x2f8f4e, 0.9);
  for (let i = 0; i < 6; i++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.22 + Math.random() * 0.12, 10, 10), leafM);
    const a = (i / 6) * Math.PI * 2;
    s.position.set(Math.cos(a) * 0.22, 0.75 + Math.random() * 0.45, Math.sin(a) * 0.22);
    s.scale.y = 1.5; g.add(s);
  }
  house.add(g); addCollider(-5.2, 3.4, 0.5);
})();
// 吊灯罩（视觉）
(function pendant() {
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.2, 8), mat(0x1a1e28, 0.8));
  cord.position.set(0, 3.9, 0); house.add(cord);
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.6, 18, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x2a3348, roughness: 0.7, side: THREE.DoubleSide,
      emissive: 0xffc98a, emissiveIntensity: 0.25 }));
  shade.position.set(0, 3.25, 0); house.add(shade);
  const gl = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffc98a,
    transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
  gl.position.set(0, 3.05, 0); gl.scale.setScalar(2.2); house.add(gl);
})();

// ============ 黑盒展台 ============
const boxes = [];
function buildBox(def) {
  const [bx, bz] = def.pos;
  const g = new THREE.Group(); g.position.set(bx, 0, bz); scene.add(g);
  // 展台
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 0.5, 20), mat(0x1a2236, 0.5, 0.7));
  ped.position.y = 0.25; g.add(ped);
  const ringMat = new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.85 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.035, 10, 40), ringMat);
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.52; g.add(ring);
  // 盒子
  const cubeG = new THREE.Group(); cubeG.position.y = 1.45; g.add(cubeG);
  const cubeMat = new THREE.MeshStandardMaterial({ color: 0x0a0e16, metalness: 0.85, roughness: 0.32,
    emissive: 0x061208, emissiveIntensity: 0.7, transparent: true });
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1.15, 1.15, 1.15), cubeMat);
  cubeG.add(cube);
  const eMat = new THREE.LineBasicMaterial({ color: def.color, transparent: true, opacity: 0.95 });
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(cube.geometry), eMat);
  e.scale.setScalar(1.004); cubeG.add(e);
  const haloM = new THREE.SpriteMaterial({ map: glowTex, color: def.color, transparent: true,
    opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false });
  const haloS = new THREE.Sprite(haloM); haloS.scale.setScalar(3.6); cubeG.add(haloS);
  const bl = new THREE.PointLight(def.color, 10, 7, 1.8);
  bl.position.y = 1.45; g.add(bl);
  // 破解后的星星标记
  const star = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffd166,
    transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  star.position.y = 2.6; star.scale.setScalar(1.1); g.add(star);

  const box = { def, group: g, cubeG, cubeMat, eMat, ringMat, light: bl, star,
                solved: false, probes: 0, attempts: 0, baseY: 1.45, phase: Math.random() * 6 };
  boxes.push(box);
  addCollider(bx, bz, 0.85);
  return box;
}
BOX_DEFS.forEach(buildBox);

// ============ 粒子 & 冲击波 & 光束 ============
const PMAX = 900;
const pGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(PMAX * 3), pCol = new Float32Array(PMAX * 3);
const pVel = new Float32Array(PMAX * 3), pLife = new Float32Array(PMAX),
      pGrav = new Float32Array(PMAX);
for (let i = 0; i < PMAX; i++) pPos[i * 3 + 1] = -999;
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
const points = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 0.12, vertexColors: true,
  transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
points.frustumCulled = false;
scene.add(points);
let pCursor = 0;
function spawnP(x, y, z, vx, vy, vz, life, grav, r, g, b) {
  const i = pCursor; pCursor = (pCursor + 1) % PMAX;
  pPos[i*3] = x; pPos[i*3+1] = y; pPos[i*3+2] = z;
  pVel[i*3] = vx; pVel[i*3+1] = vy; pVel[i*3+2] = vz;
  pLife[i] = life; pGrav[i] = grav;
  pCol[i*3] = r; pCol[i*3+1] = g; pCol[i*3+2] = b;
}
function hexRgb(h) { return { r: ((h >> 16) & 255) / 255, g: ((h >> 8) & 255) / 255, b: (h & 255) / 255 }; }
function burst(p, colorHex, n, speed, up, life, grav) {
  const c = hexRgb(colorHex);
  for (let k = 0; k < n; k++) {
    const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    const s = speed * (0.35 + Math.random() * 0.85);
    spawnP(p.x, p.y, p.z,
      Math.sin(ph) * Math.cos(th) * s, Math.cos(ph) * s * 0.55 + up, Math.sin(ph) * Math.sin(th) * s,
      life * (0.6 + Math.random() * 0.7), grav == null ? 1.4 : grav, c.r, c.g, c.b);
  }
}
function stepParticles(dt) {
  for (let i = 0; i < PMAX; i++) {
    if (pLife[i] <= 0) continue;
    pLife[i] -= dt;
    if (pLife[i] <= 0) { pPos[i * 3 + 1] = -999; continue; }
    pVel[i*3+1] -= pGrav[i] * dt;
    pVel[i*3] *= (1 - 0.6 * dt); pVel[i*3+2] *= (1 - 0.6 * dt);
    pPos[i*3] += pVel[i*3] * dt; pPos[i*3+1] += pVel[i*3+1] * dt; pPos[i*3+2] += pVel[i*3+2] * dt;
  }
  pGeo.attributes.position.needsUpdate = true;
}

const waves = [];
for (let i = 0; i < 4; i++) {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48),
    new THREE.MeshBasicMaterial({ color: 0x39ff8e, transparent: true, opacity: 0,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.06; m.visible = false;
  scene.add(m); waves.push(m);
}
let wCursor = 0;
function shockwave(x, z, color, maxR, dur) {
  const m = waves[wCursor]; wCursor = (wCursor + 1) % waves.length;
  m.material.color.set(color); m.position.x = x; m.position.z = z; m.visible = true;
  tween(dur || 0.7, k => { m.scale.setScalar(0.3 + k * (maxR || 5)); m.material.opacity = 0.85 * (1 - k); },
    () => { m.visible = false; });
}

const beamMat = new THREE.MeshBasicMaterial({ color: 0xfff2c9, transparent: true, opacity: 0,
  blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.1, 1, 10, 1, true), beamMat);
beam.visible = false;
scene.add(beam);
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
function fireBeam(from, to, done) {
  _v1.subVectors(to, from);
  const len = _v1.length();
  beam.position.copy(from).addScaledVector(_v1, 0.5);
  beam.quaternion.setFromUnitVectors(_up, _v1.normalize());
  beam.visible = true; beamMat.opacity = 0.95;
  beam.scale.set(1, 0.06, 1);
  tween(0.15, k => beam.scale.set(1, 0.06 + k * len, 1), () => {
    if (done) done();
    tween(0.22, k => { beamMat.opacity = 0.95 * (1 - k); }, () => { beam.visible = false; });
  });
}

// ============ 猫 ============
const cat = { group: new THREE.Group(), heading: 0, targetHeading: 0, phase: 0, moving: false, parts: null };
function buildCat(colorHex) {
  if (cat.parts) { scene.remove(cat.group); cat.group.clear(); }
  const g = cat.group;
  const fur = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.85 });
  const dark = new THREE.MeshBasicMaterial({ color: 0x39ff8e }); // 夜光绿眼睛
  // 身体
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.38, 6, 14), fur);
  body.rotation.x = Math.PI / 2; body.position.y = 0.36; g.add(body);
  // 头
  const headG = new THREE.Group(); headG.position.set(0, 0.56, 0.4); g.add(headG);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 18, 18), fur); headG.add(head);
  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.14, 8), fur);
    ear.position.set(sx * 0.11, 0.19, -0.02); ear.rotation.z = -sx * 0.25; headG.add(ear);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.038, 10, 10), dark);
    eye.position.set(sx * 0.085, 0.03, 0.175); headG.add(eye);
  }
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xff8fa0 }));
  nose.position.set(0, -0.03, 0.2); headG.add(nose);
  // 尾巴
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.065, 0.55, 10), fur);
  tail.position.set(0, 0.5, -0.42); tail.rotation.x = -0.85; g.add(tail);
  const tailTip = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 10), fur);
  tailTip.position.set(0, 0.72, -0.63); g.add(tailTip);
  // 腿
  const legs = [];
  const legGeo = new THREE.CylinderGeometry(0.055, 0.05, 0.3, 8);
  for (const [sx, sz] of [[-0.14, 0.2], [0.14, 0.2], [-0.14, -0.2], [0.14, -0.2]]) {
    const leg = new THREE.Mesh(legGeo, fur);
    leg.position.set(sx, 0.16, sz);
    g.add(leg); legs.push(leg);
  }
  // 脖子上的小光环（玩家标记）
  const tagGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x39ff8e,
    transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
  tagGlow.position.y = 0.15; tagGlow.scale.setScalar(0.8); g.add(tagGlow);

  g.position.set(0, 0, 1.6);
  scene.add(g);
  cat.parts = { body, headG, tail, tailTip, legs };
  return cat;
}

// ============ 输入 ============
const keys = {};
window.addEventListener('keydown', e => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  keys[e.code] = true;
  if (e.code === 'KeyE' && G.mode === 'playing' && G.promptBox && $('probePanel').classList.contains('hidden')) {
    openProbe(G.promptBox);
  }
});
window.addEventListener('keyup', e => { keys[e.code] = false; });

// 虚拟摇杆
const joyVec = { x: 0, y: 0, active: false };
(function joystick() {
  if (!IS_TOUCH) return;
  $('joy').style.display = 'block';
  const joy = $('joy'), knob = $('joyKnob');
  let tid = null, cx = 0, cy = 0;
  function setKnob(dx, dy) { knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`; }
  joy.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.changedTouches[0]; tid = t.identifier;
    const r = joy.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    joyVec.active = true;
  }, { passive: false });
  window.addEventListener('touchmove', e => {
    if (tid == null) return;
    for (const t of e.changedTouches) {
      if (t.identifier !== tid) continue;
      let dx = t.clientX - cx, dy = t.clientY - cy;
      const d = Math.hypot(dx, dy), max = 42;
      if (d > max) { dx = dx / d * max; dy = dy / d * max; }
      setKnob(dx, dy);
      joyVec.x = dx / max; joyVec.y = dy / max;
    }
  }, { passive: true });
  function end(e) {
    for (const t of e.changedTouches) {
      if (t.identifier !== tid) continue;
      tid = null; joyVec.x = 0; joyVec.y = 0; joyVec.active = false; setKnob(0, 0);
    }
  }
  window.addEventListener('touchend', end);
  window.addEventListener('touchcancel', end);
})();

function readInput() {
  let x = 0, z = 0;
  if (keys.KeyW || keys.ArrowUp) z -= 1;
  if (keys.KeyS || keys.ArrowDown) z += 1;
  if (keys.KeyA || keys.ArrowLeft) x -= 1;
  if (keys.KeyD || keys.ArrowRight) x += 1;
  if (joyVec.active) { x += joyVec.x; z += joyVec.y; }
  const l = Math.hypot(x, z);
  if (l > 1) { x /= l; z /= l; }
  return { x, z };
}

// ============ 移动 / 碰撞 / 跟随镜头 ============
function moveCat(dt) {
  const { x, z } = readInput();
  const speed = 3.4;
  cat.moving = (x !== 0 || z !== 0);
  if (cat.moving && G.mode === 'playing') {
    const p = cat.group.position;
    p.x += x * speed * dt;
    p.z += z * speed * dt;
    cat.targetHeading = Math.atan2(x, z);
    cat.phase += dt * 11;
  }
  // 房间边界
  const p = cat.group.position;
  p.x = Math.max(-ROOM.x, Math.min(ROOM.x, p.x));
  p.z = Math.max(-ROOM.z, Math.min(ROOM.z, p.z));
  // 家具碰撞（圆形推出）
  for (const c of colliders) {
    const dx = p.x - c.x, dz = p.z - c.z;
    const d = Math.hypot(dx, dz), min = c.r + 0.32;
    if (d < min && d > 0.0001) {
      p.x = c.x + dx / d * min;
      p.z = c.z + dz / d * min;
    }
  }
  // 朝向平滑
  let dh = cat.targetHeading - cat.heading;
  while (dh > Math.PI) dh -= Math.PI * 2;
  while (dh < -Math.PI) dh += Math.PI * 2;
  cat.heading += dh * Math.min(1, 12 * dt);
  cat.group.rotation.y = cat.heading;
  // 走路动画
  const P = cat.parts;
  if (P) {
    if (cat.moving) {
      P.legs[0].rotation.x = Math.sin(cat.phase) * 0.6;
      P.legs[3].rotation.x = Math.sin(cat.phase) * 0.6;
      P.legs[1].rotation.x = Math.sin(cat.phase + Math.PI) * 0.6;
      P.legs[2].rotation.x = Math.sin(cat.phase + Math.PI) * 0.6;
      P.body.position.y = 0.36 + Math.abs(Math.sin(cat.phase)) * 0.035;
      P.headG.position.y = 0.56 + Math.abs(Math.sin(cat.phase)) * 0.03;
    } else {
      for (const l of P.legs) l.rotation.x *= 0.85;
      P.body.position.y = 0.36 + Math.sin(performance.now() * 0.003) * 0.012; // 呼吸
    }
    P.tail.rotation.z = Math.sin(performance.now() * 0.0022) * 0.3;
    P.tailTip.position.x = Math.sin(performance.now() * 0.0022) * 0.12;
  }
}

const camTarget = new THREE.Vector3();
function followCamera(dt) {
  const p = cat.group.position;
  camTarget.set(p.x * 0.85, 4.7, p.z * 0.85 + 5.6);
  const k = 1 - Math.exp(-4.5 * dt);
  camera.position.lerp(camTarget, k);
  camera.lookAt(p.x, 0.9, p.z - 0.4);
}

// ============ 接近提示 ============
function updatePrompt() {
  if (G.mode !== 'playing' || !$('probePanel').classList.contains('hidden')) {
    if ($('probePanel').classList.contains('hidden')) { /* 面板开着时不刷新提示 */ }
    else { hidePrompt(); return; }
  }
  const p = cat.group.position;
  let best = null, bestD = 2.4;
  for (const b of boxes) {
    const d = Math.hypot(p.x - b.group.position.x, p.z - b.group.position.z);
    if (d < bestD) { bestD = d; best = b; }
  }
  G.promptBox = best;
  if (best) {
    if (best.solved) {
      $('prompt').innerHTML = `⭐ ${best.def.id} 号盒已破解`;
    } else {
      $('prompt').innerHTML = IS_TOUCH ? `📦 发现 <b>${best.def.id} 号盒</b>` : `📦 按 <b>E</b> 开${best.def.id} 号盒`;
    }
    $('prompt').classList.remove('hidden');
    if (IS_TOUCH && !best.solved) $('openBtn').classList.remove('hidden');
    else $('openBtn').classList.add('hidden');
  } else {
    hidePrompt();
  }
}
function hidePrompt() {
  $('prompt').classList.add('hidden');
  $('openBtn').classList.add('hidden');
  G.promptBox = null;
}
$('openBtn').addEventListener('click', () => {
  if (G.promptBox && !G.promptBox.solved) openProbe(G.promptBox);
});

// ============ 试探面板 & 开盒逻辑 ============
const pad = $('pad');
for (let n = 0; n < 16; n++) {
  const b = document.createElement('button');
  b.className = 'num'; b.textContent = n;
  b.addEventListener('click', () => { sfx.click(); probe(n); });
  pad.appendChild(b);
}

const chipsEl = $('chips');
const chipBtns = [];
for (let n = 0; n < 16; n++) {
  const c = document.createElement('button');
  c.className = 'chip'; c.textContent = n; c.dataset.n = n;
  c.addEventListener('click', () => {
    sfx.click();
    c.classList.toggle('sel');
    $('selCount').textContent = chipsEl.querySelectorAll('.sel').length;
  });
  chipsEl.appendChild(c); chipBtns.push(c);
}
function clearChips() {
  chipBtns.forEach(c => c.classList.remove('sel'));
  $('selCount').textContent = '0';
  $('solveFeedback').textContent = '';
}

let probeInFlight = false;
function openProbe(box) {
  if (box.solved) { toast('这个盒子已经破解啦 ⭐'); return; }
  G.activeBox = box;
  $('boxTitle').innerHTML = `🔍 <span style="color:${box.def.css}">${box.def.id} 号盒</span> · 试探中`;
  clearChips();
  $('solveArea').classList.add('hidden');
  $('toggleSolveBtn').classList.remove('on');
  $('probePanel').classList.remove('hidden');
  hidePrompt();
  sfx.open();
}
function closeProbe() {
  $('probePanel').classList.add('hidden');
  G.activeBox = null;
}

function probe(n) {
  const box = G.activeBox;
  if (!box || G.mode !== 'playing' || box.solved || probeInFlight) return;
  probeInFlight = true;
  sfx.probe();
  const from = cat.group.position.clone(); from.y = 0.75;
  const to = box.cubeG.getWorldPosition(new THREE.Vector3());
  fireBeam(from, to, () => impact(box, n));
}

function boxFlash(box, colorHex) {
  const dc = new THREE.Color(box.def.color), fc = new THREE.Color(colorHex);
  box.eMat.color.copy(fc);
  box.light.color.copy(fc);
  box.light.intensity = 24;
  tween(0.8, k => {
    box.eMat.color.copy(fc).lerp(dc, k);
    box.light.color.copy(fc).lerp(dc, k);
    box.light.intensity = 24 - 14 * k;
  });
}

function impact(box, n) {
  const out = box.def.rule.has(n);
  boxFlash(box, out ? box.def.color : 0xff5d6c);
  if (out) sfx.good(); else sfx.bad();
  const wp = box.cubeG.getWorldPosition(new THREE.Vector3());
  if (out) {
    shockwave(box.group.position.x, box.group.position.z, box.def.color, 4, 0.6);
    burst(wp, box.def.color, 42, 2.0, 2.4, 1.1, -0.6);
  } else {
    burst(wp, 0xff5d6c, 16, 1.1, -0.4, 0.8, 2.2);
  }
  const bx0 = box.cubeG.position.x;
  tween(0.28, k => { box.cubeG.position.x = bx0 + (Math.random() - 0.5) * 0.09 * (1 - k); });
  addLog(box, n, out);
  box.probes++; G.probes++;
  $('probeCount').textContent = G.probes;
  probeInFlight = false;
}

function addLog(box, n, out) {
  const list = $('logList');
  const d = document.createElement('div');
  d.className = 'logline ' + (out ? 'one' : 'zero');
  d.innerHTML = `<span><span class="tag" style="border-color:${box.def.css};color:${box.def.css}">${box.def.id}</span>` +
    `输入 <b>${n}</b> → 输出 <b>${out ? 1 : 0}</b></span>`;
  list.prepend(d);
  while (list.children.length > 50) list.lastChild.remove();
}

$('randomBtn').addEventListener('click', () => { sfx.click(); probe((Math.random() * 16) | 0); });
$('toggleSolveBtn').addEventListener('click', () => {
  sfx.click();
  const sa = $('solveArea');
  sa.classList.toggle('hidden');
  $('toggleSolveBtn').classList.toggle('on', !sa.classList.contains('hidden'));
});
$('closeProbe').addEventListener('click', () => { sfx.click(); closeProbe(); });
$('submitAnswerBtn').addEventListener('click', () => {
  const box = G.activeBox;
  if (!box || box.solved) return;
  const sel = new Set(chipBtns.filter(c => c.classList.contains('sel')).map(c => +c.dataset.n));
  box.attempts++; G.attempts++;
  const ans = box.def.rule;
  const ok = sel.size === ans.size && [...sel].every(x => ans.has(x));
  if (ok) { solveBox(box); return; }
  const hits = [...sel].filter(x => ans.has(x)).length;
  $('solveFeedback').textContent = `命中 ${hits} / ${ans.size}，再试试`;
  sfx.bad();
});

function solveBox(box) {
  box.solved = true;
  G.solved++;
  $('solvedCount').textContent = G.solved;
  sfx.win();
  const wp = box.cubeG.getWorldPosition(new THREE.Vector3());
  burst(wp, 0xffd166, 90, 3.0, 1.6, 1.6, 1.0);
  burst(wp, box.def.color, 50, 2.2, 2.6, 1.4, -0.4);
  shockwave(box.group.position.x, box.group.position.z, 0xffd166, 7, 1.0);
  box.ringMat.color.set(0xffffff);
  tween(0.9, k => {
    box.cubeG.scale.setScalar(Math.max(0.001, 1 - k));
    box.cubeMat.opacity = 1 - k;
    box.eMat.opacity = 0.95 * (1 - k);
  }, () => { box.cubeG.visible = false; });
  box.star.material.opacity = 0.9;
  closeProbe();
  toast(`🎉 ${box.def.id} 号盒破解！${box.def.ruleDesc}`, 3400);
  if (G.solved >= 3) setTimeout(showWin, 1700);
}

// ============ 胜利 / 重开 / 主循环 ============
function startTimer() {
  clearInterval(G.timerId);
  G.timerId = setInterval(() => {
    if (G.mode === 'playing') {
      G.elapsed = (Date.now() - G.startT) / 1000;
      $('timer').textContent = fmt(G.elapsed);
    }
  }, 500);
}

function showWin() {
  if (G.mode !== 'playing') return;
  G.mode = 'won';
  clearInterval(G.timerId);
  hidePrompt(); closeProbe();
  $('winRules').innerHTML = boxes.map(b =>
    `<div class="wr"><b style="color:${b.def.css}">${b.def.id} 号盒</b> —— ${b.def.ruleDesc}</div>`).join('');
  $('winStats').textContent = `用时 ${fmt(G.elapsed)} · 试探 ${G.probes} 次 · 提交破解 ${G.attempts} 次`;
  $('winOverlay').classList.remove('hidden');
}

function resetGame() {
  for (const b of boxes) {
    b.solved = false; b.probes = 0; b.attempts = 0;
    b.cubeG.visible = true;
    b.cubeG.scale.setScalar(1);
    b.cubeMat.opacity = 1;
    b.eMat.opacity = 0.95; b.eMat.color.set(b.def.color);
    b.ringMat.color.set(b.def.color);
    b.light.color.set(b.def.color); b.light.intensity = 10;
    b.star.material.opacity = 0;
  }
  $('logList').innerHTML = '';
  closeProbe();
  G.probes = 0; G.solved = 0; G.attempts = 0; G.elapsed = 0;
  $('probeCount').textContent = '0';
  $('solvedCount').textContent = '0';
  $('timer').textContent = '00:00';
  cat.group.position.set(0, 0, 1.6);
  cat.heading = 0; cat.targetHeading = 0; cat.group.rotation.y = 0;
  camera.position.set(0, 4.7, 7.2);
  $('winOverlay').classList.add('hidden');
  G.mode = 'playing';
  G.startT = Date.now();
  startTimer();
  toast('🐾 新的一局，盒子们已重置！');
}

// ---- 接线 ----
$('soundBtn').addEventListener('click', () => {
  G.muted = !G.muted;
  $('soundBtn').textContent = G.muted ? '🔇' : '🔊';
  if (!G.muted) sfx.click();
});
document.querySelectorAll('#catBtns .catchip').forEach(b => {
  b.addEventListener('click', () => {
    sfx.click();
    document.querySelectorAll('#catBtns .catchip').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
    G.catColor = +b.dataset.c;
  });
});
$('startBtn').addEventListener('click', () => {
  sfx.unlock(); sfx.open();
  buildCat(CAT_COLORS[G.catColor]);
  $('startOverlay').classList.add('hidden');
  G.mode = 'playing';
  G.startT = Date.now();
  startTimer();
  toast('🐾 在屋里逛逛，找发光的黑盒子！');
});
$('againBtn').addEventListener('click', () => { sfx.click(); resetGame(); });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- 主循环 ----
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  stepTweens(dt);
  stepParticles(dt);
  if (G.mode === 'playing') {
    moveCat(dt);
    updatePrompt();
    if (G.activeBox) {
      const p = cat.group.position, bp = G.activeBox.group.position;
      if (Math.hypot(p.x - bp.x, p.z - bp.z) > 3.6) closeProbe();
    }
  }
  followCamera(dt);
  for (const b of boxes) {
    if (!b.solved) {
      b.cubeG.position.y = b.baseY + Math.sin(t * 1.4 + b.phase) * 0.1;
      b.cubeG.rotation.y += dt * 0.55;
      b.light.intensity = 10 + Math.sin(t * 2.4 + b.phase) * 3;
    } else {
      b.star.material.opacity = 0.65 + Math.sin(t * 3) * 0.25;
    }
  }
  renderer.render(scene, camera);
}
animate();
