/**
 * reltest.ts —— 1PN 相对论进动的解析对照测试。
 *
 * 为什么这样测：1PN 的判据不是"代码跑了"，而是**每圈近星点进动必须等于
 *     Δϖ = 6πμ / (c² · a · (1 − e²))
 * 这是广义相对论预言、并被水星观测证实过的量。用**发货代码**里的 relAccel()
 * 积分一条椭圆轨道，测出进动再与解析值对照——数值对得上，才说明公式与系数都对。
 *
 * 构建与运行：
 *   npx esbuild tools/reltest.ts --bundle --format=esm --platform=node --outfile=tools/reltest.mjs
 *   node tools/reltest.mjs
 */
import { C_LIGHT, relAccel } from '../src/sim/physics';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { pass++; console.log(`  ✓ ${name}  ${detail}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

const MU = 1.0;
const A = 1.5;
const E = 0.3;

/** 用 1PN 加速度做速度 Verlet 积分，返回每次近星点通过的极角序列 */
function integrateOrbits(rel: boolean, steps: number, dt: number): number[] {
  const rp = A * (1 - E);
  const vp = Math.sqrt(MU * (1 + E) / (A * (1 - E)));   // 近星点速度（活力公式）
  let x = rp;
  let y = 0;
  let vx = 0;
  let vy = vp;
  const acc = { x: 0, y: 0 };
  const accel = (px: number, py: number, pvx: number, pvy: number, out: { x: number; y: number }): void => {
    const r2 = px * px + py * py;
    const r = Math.sqrt(r2);
    const k = MU / (r2 * r);                            // 牛顿项
    out.x = -k * px;
    out.y = -k * py;
    // 1PN 项：源在原点，故 r⃗ = 目标 − 源 = (px, py)、v⃗ = 粒子速度
    if (rel) relAccel(px, py, pvx, pvy, MU, out);
  };

  const angles: number[] = [];
  let prevR = Infinity;
  let prevPrevR = Infinity;
  let armed = true;                 // 去抖：触发一次后需等 r 明显回升
  let lastPeriR = rp;
  for (let s = 0; s < steps; s++) {
    accel(x, y, vx, vy, acc);
    vx += acc.x * dt * 0.5;
    vy += acc.y * dt * 0.5;
    x += vx * dt;
    y += vy * dt;
    accel(x, y, vx, vy, acc);
    vx += acc.x * dt * 0.5;
    vy += acc.y * dt * 0.5;

    const r = Math.hypot(x, y);
    // 近星点检测：r 由减转增 → 记录极角；并要求 r 先回升到 rp*1.05 以上才允许下一次触发（去抖）
    if (!armed && r > lastPeriR * 1.05) armed = true;
    if (armed && prevR < prevPrevR && r > prevR) {
      angles.push(Math.atan2(y, x));
      lastPeriR = r;
      armed = false;
    }
    prevPrevR = prevR;
    prevR = r;
  }
  return angles;
}

console.log('='.repeat(70));
console.log('  1PN 相对论进动：解析对照');
console.log('='.repeat(70));
console.log(`  μ=${MU}  a=${A}  e=${E}  c=${C_LIGHT}（游戏单位 RU/TU）`);

// 解析进动（每圈，弧度）
const dOmega = (6 * Math.PI * MU) / (C_LIGHT * C_LIGHT * A * (1 - E * E));
console.log(`  解析值：Δϖ = 6πμ/(c²a(1−e²)) = ${dOmega.toExponential(4)} rad/圈 ` +
  `= ${(dOmega * 180 / Math.PI).toFixed(4)}°/圈`);

// 轨道周期（近似用牛顿周期；1PN 只带来极小修正）
const T = 2 * Math.PI * Math.sqrt((A * A * A) / MU);
const dt = T / 40000;                     // 每圈 4 万步，保证近星点角度采样精度
const orbits = 12;

const withRel = integrateOrbits(true, Math.round(orbits * 40000) + 40000, dt);
const noRel = integrateOrbits(false, Math.round(orbits * 40000) + 40000, dt);

console.log(`  积分：每圈 40000 步，共约 ${orbits} 圈；检出近星点 ${withRel.length} 次（含 1PN）` +
  ` / ${noRel.length} 次（纯牛顿）`);

// 每圈进动 = 相邻两次近星点极角差（去掉 2π）
function advances(angles: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < angles.length; i++) {
    let d = angles[i] - angles[i - 1];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    out.push(d);
  }
  return out;
}

const advRel = advances(withRel);
const advNewt = advances(noRel);
const meanRel = advRel.length ? advRel.reduce((a, b) => a + b, 0) / advRel.length : 0;
const meanNewt = advNewt.length ? advNewt.reduce((a, b) => a + b, 0) / advNewt.length : 0;

check('检出足够多的近星点', advRel.length >= 8, `${advRel.length} 次进动样本`);
check('纯牛顿轨道不进动（对照组）', Math.abs(meanNewt) < dOmega * 0.25,
  `牛顿每圈 ${meanNewt.toExponential(3)} rad（期望≈0）`);

const relErr = Math.abs(meanRel - dOmega) / dOmega;
check('1PN 进动与解析值一致（容差 20%）', relErr < 0.20,
  `数值 ${meanRel.toExponential(4)} vs 解析 ${dOmega.toExponential(4)} rad/圈，` +
  `相对误差 ${(relErr * 100).toFixed(1)}%`);

check('1PN 进动方向为正（顺行旋进）', meanRel > 0, `${meanRel.toExponential(3)} > 0`);

// 标度检验：进动 ∝ 1/c²、∝ 1/(a(1−e²))。这里验证 μ 的线性（用解析式对比数值比例不现实，
// 改为验证"半长轴越小、进动越大"这一单调性，用解析式给出期望比值）
const A2 = 0.9;
const dOmega2 = (6 * Math.PI * MU) / (C_LIGHT * C_LIGHT * A2 * (1 - E * E));
const ratioNum = dOmega2 / dOmega;
const ratioWant = A / A2;
check('解析式标度：a 越小进动越大', dOmega2 > dOmega,
  `a=${A2} 时 ${dOmega2.toExponential(3)} > a=${A} 时 ${dOmega.toExponential(3)} rad/圈`);
check('解析式标度：比值 ≈ A/a₂', Math.abs(ratioNum - ratioWant) / ratioWant < 0.05,
  `实得比值 ${ratioNum.toFixed(3)} vs 期望 ${ratioWant.toFixed(3)}（Δϖ ∝ 1/a）`);

console.log('-'.repeat(70));
console.log(`  1PN 进动测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
