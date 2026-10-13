/**
 * zvctest.ts —— CR3BP / Jacobi 常数的单元测试。
 *
 * 为什么这样测：
 *  1) 三角点 L4/L5 有**解析 Jacobi 常数** C = 3 − μ + μ²，可直接对照（检验有效势实现）
 *  2) 五个拉格朗日点的 C 值有**严格层级** C_L1 > C_L2 > C_L3 > C_L4 = C_L5（检验共线点求根）
 *  3) 与**地月系经典数表**对照（μ = 0.01215）：C_L1≈3.1883、C_L2≈3.1722、C_L3≈3.0121、C_L4≈2.9880
 *     —— 这是外部文献值，不是自己算完自己信
 *  4) reachable 关于 C 单调（C 越大禁区越大）
 *
 * 构建与运行：
 *   npx esbuild tools/zvctest.ts --bundle --format=esm --platform=node --outfile=tools/zvctest.mjs
 *   node tools/zvctest.mjs
 */
import {
  collinearC, cr3bp, jacobi, omegaEff, reachable, triangularC, zvcMask,
} from '../src/sim/zvc';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { pass++; console.log(`  ✓ ${name}  ${detail}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

const SQ3_2 = Math.sqrt(3) / 2;

console.log('='.repeat(70));
console.log('  CR3BP / Jacobi 常数单元测试');
console.log('='.repeat(70));

// ---- 1) 三角点：数值算出的 C 必须等于解析值 3 − μ + μ² ----
for (const mu of [0.001, 0.01, 0.01215, 0.1, 0.3]) {
  // L4 = (0.5 − μ, +√3/2)，在旋转系中静止（速度 0）
  const x4 = 0.5 - mu;
  const cNum = jacobi(mu, x4, SQ3_2, 0, 0);
  const cAna = triangularC(mu);
  check(`L4 解析值 μ=${mu}`, Math.abs(cNum - cAna) < 1e-9,
    `数值 ${cNum.toFixed(9)} vs 3−μ+μ² = ${cAna.toFixed(9)}`);
}

// ---- 2) 五点 C 值的严格层级 ----
for (const mu of [0.001, 0.01215, 0.1, 0.3]) {
  const c1 = collinearC(mu, -1);
  const c2 = collinearC(mu, 0);
  const c3 = collinearC(mu, 1);
  const c45 = triangularC(mu);
  check(`C 层级 μ=${mu}`, c1 > c2 && c2 > c3 && c3 > c45,
    `L1 ${c1.toFixed(4)} > L2 ${c2.toFixed(4)} > L3 ${c3.toFixed(4)} > L4/5 ${c45.toFixed(4)}`);
}

// ---- 3) 与地月系经典数表对照（外部文献值）----
{
  const mu = 0.01215;
  const table: Array<[string, number, number]> = [
    ['L1', collinearC(mu, -1), 3.1883],
    ['L2', collinearC(mu, 0), 3.1722],
    ['L3', collinearC(mu, 1), 3.0121],
    ['L4/L5', triangularC(mu), 2.9880],
  ];
  for (const [nm, got, want] of table) {
    check(`对照地月系数表 ${nm}`, Math.abs(got - want) < 2e-3,
      `算得 ${got.toFixed(4)}，文献 ${want.toFixed(4)}，差 ${(got - want).toExponential(2)}`);
  }
}

// ---- 4) reachable 关于 C 单调 ----
{
  const mu = 0.01215;
  const pts: Array<[number, number]> = [[0.2, 0.1], [1.2, 0.0], [0.5, 0.8], [-1.5, 0.3]];
  let mono = true;
  let detail = '';
  for (const [x, y] of pts) {
    const weak = reachable(mu, 2.9, x, y);
    const strong = reachable(mu, 3.3, x, y);
    if (weak && !strong) { /* 允许：C 大使可达变不可达 */ } else if (strong && !weak) { mono = false; detail = `(${x},${y}) 反例`; }
  }
  check('reachable 单调（C 越大禁区越大）', mono, detail || '4 个采样点均满足');
}

// ---- 5) zvcMask 的形状与禁区比例合理性 ----
{
  const mu = 0.01215;
  const mask = zvcMask(mu, 3.05, -1.5, 1.5, -1.5, 1.5, 60, 60);
  let blocked = 0;
  for (let i = 0; i < mask.blocked.length; i++) blocked += mask.blocked[i];
  const frac = blocked / mask.blocked.length;
  check('zvcMask 尺寸与禁区比例', mask.w === 60 && mask.h === 60 && frac > 0.05 && frac < 0.95,
    `${mask.w}×${mask.h}，禁区占比 ${(frac * 100).toFixed(1)}%`);
}

// ---- 6) cr3bp：质量比与平均运动符合定义 ----
{
  const c = cr3bp(0.03, 0.97, 2.0);          // 故意把重的放在第二个参数
  const wantMu = 0.03;
  const wantOmega = Math.sqrt(1.0 / 8.0);    // sqrt((m1+m2)/d³) = sqrt(1/8)
  check('cr3bp 质量比', Math.abs(c.mu - wantMu) < 1e-12, `μ=${c.mu}`);
  check('cr3bp 平均运动', Math.abs(c.omega - wantOmega) < 1e-12,
    `ω=${c.omega.toFixed(6)} vs ${wantOmega.toFixed(6)}`);
  check('cr3bp 保证 m1 ≥ m2', c.m1 >= c.m2, `m1=${c.m1} m2=${c.m2}`);
}

// ---- 7) omegaEff 在两主天体处发散（1/r 项）----
{
  const mu = 0.01215;
  const near = omegaEff(mu, -mu + 1e-4, 0);      // 紧贴重天体（−μ, 0）
  const far = omegaEff(mu, -mu, 1.0);            // 距重天体 1（沿 y，远离轻天体）
  check('omegaEff 在重天体附近显著增大', near > far * 5, `${near.toFixed(2)} vs ${far.toFixed(2)}`);
}

console.log('-'.repeat(70));
console.log(`  CR3BP 单元测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
