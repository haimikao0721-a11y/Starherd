/**
 * 轨迹预测：用**同一个 KDK 辛积分器**向前积分（不是近似公式），
 * 假设引力井保持当前位置与场强、玩家不再操作。
 * 主天体互为 N 体；货舱作为测试粒子受主天体与井场。全部预分配，零 GC。
 */
import type { PredictedPath, World } from './types';
import { EPS } from './constants';
import { wellAccel } from './physics';

const MAXP = 8;   // 主天体上限
const MAXK = 8;   // 被预测的货舱上限
const MAXPTS = 96;

const pm = new Float64Array(MAXP);
const pr = new Float64Array(MAXP);
const px = new Float64Array(MAXP);
const py = new Float64Array(MAXP);
const pvx = new Float64Array(MAXP);
const pvy = new Float64Array(MAXP);
const pax = new Float64Array(MAXP);
const pay = new Float64Array(MAXP);

const km = new Float64Array(MAXK);
const kx = new Float64Array(MAXK);
const ky = new Float64Array(MAXK);
const kvx = new Float64Array(MAXK);
const kvy = new Float64Array(MAXK);
const kax = new Float64Array(MAXK);
const kay = new Float64Array(MAXK);
const kid = new Int32Array(MAXK);

let NP = 0;
let NK = 0;
let lastPredict = -1;
const scratch = { x: 0, y: 0 };

export function predictedValid(now: number): boolean { return now - lastPredict < 0.15; }

/** 主天体互相 N 体（含 Plummer 软化） */
function accelPrimaries(eps: number): void {
  for (let i = 0; i < NP; i++) { pax[i] = 0; pay[i] = 0; }
  for (let i = 0; i < NP; i++) {
    for (let j = i + 1; j < NP; j++) {
      const dx = px[j] - px[i], dy = py[j] - py[i];
      const r2 = dx * dx + dy * dy + eps * eps;
      const inv = 1 / (r2 * Math.sqrt(r2));
      pax[i] += pm[j] * inv * dx; pay[i] += pm[j] * inv * dy;
      pax[j] -= pm[i] * inv * dx; pay[j] -= pm[i] * inv * dy;
    }
  }
}

/** 货舱：主天体引力 + 引力井场（静态假设） */
function accelLight(eps: number, wMass: number, wx: number, wy: number, range: number): void {
  for (let i = 0; i < NK; i++) {
    kax[i] = 0; kay[i] = 0;
    for (let j = 0; j < NP; j++) {
      const dx = px[j] - kx[i], dy = py[j] - ky[i];
      const r2 = dx * dx + dy * dy + eps * eps;
      const inv = 1 / (r2 * Math.sqrt(r2));
      kax[i] += pm[j] * inv * dx;
      kay[i] += pm[j] * inv * dy;
    }
    if (wMass > 0) {
      scratch.x = 0; scratch.y = 0;
      wellAccel(kx[i], ky[i], wx, wy, wMass, range, false, eps, scratch);
      kax[i] += scratch.x; kay[i] += scratch.y;
    }
  }
}

export function predictPaths(
  world: World, now: number, range: number,
  horizon = 6.0, h = 1 / 45, stride = 4,
): void {
  lastPredict = now;
  const eps = world.epsilon || EPS;
  NP = Math.min(MAXP, world.primaries.length);
  for (let i = 0; i < NP; i++) {
    const b = world.primaries[i];
    pm[i] = b.mu; pr[i] = b.radius;
    px[i] = b.x; py[i] = b.y; pvx[i] = b.vx; pvy[i] = b.vy;
  }
  NK = 0;
  for (let i = 0; i < world.pods.length && NK < MAXK; i++) {
    const b = world.pods[i];
    if (!b.alive || b.delivered) continue;
    km[NK] = b.mass;
    kx[NK] = b.x; ky[NK] = b.y; kvx[NK] = b.vx; kvy[NK] = b.vy;
    kid[NK] = b.id;
    NK++;
  }
  const out: PredictedPath[] = world.predicted;
  if (NK === 0) { out.length = 0; return; }
  if (out.length !== NK) {
    out.length = 0;
    for (let i = 0; i < NK; i++) {
      out.push({ bodyId: kid[i], xs: new Float32Array(MAXPTS), ys: new Float32Array(MAXPTS), n: 0, hazard: false });
    }
  }
  for (let i = 0; i < NK; i++) { out[i].bodyId = kid[i]; out[i].n = 0; out[i].hazard = false; }

  const w = world.well;
  const wMass = world.fieldEnabled ? w.mass : 0;
  const steps = Math.max(1, Math.min(600, Math.round(horizon / h)));
  const bound = world.bounds * 1.15;

  accelPrimaries(eps);
  accelLight(eps, wMass, w.x, w.y, range);

  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < NP; i++) { pvx[i] += pax[i] * h * 0.5; pvy[i] += pay[i] * h * 0.5; }
    for (let i = 0; i < NK; i++) { kvx[i] += kax[i] * h * 0.5; kvy[i] += kay[i] * h * 0.5; }
    for (let i = 0; i < NP; i++) { px[i] += pvx[i] * h; py[i] += pvy[i] * h; }
    for (let i = 0; i < NK; i++) { kx[i] += kvx[i] * h; ky[i] += kvy[i] * h; }
    accelPrimaries(eps);
    accelLight(eps, wMass, w.x, w.y, range);
    for (let i = 0; i < NP; i++) { pvx[i] += pax[i] * h * 0.5; pvy[i] += pay[i] * h * 0.5; }
    for (let i = 0; i < NK; i++) { kvx[i] += kax[i] * h * 0.5; kvy[i] += kay[i] * h * 0.5; }

    if (s % stride === 0) {
      for (let i = 0; i < NK; i++) {
        const o = out[i];
        if (o.n < MAXPTS) { o.xs[o.n] = kx[i]; o.ys[o.n] = ky[i]; o.n++; }
      }
    }
    for (let i = 0; i < NK; i++) {
      if (out[i].hazard) continue;
      for (let j = 0; j < NP; j++) {
        if (Math.hypot(kx[i] - px[j], ky[i] - py[j]) < pr[j] + 0.012) { out[i].hazard = true; break; }
      }
      if (!out[i].hazard && Math.hypot(kx[i], ky[i]) > bound) out[i].hazard = true;
    }
  }
}
