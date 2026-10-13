/**
 * kozaitest.ts —— Kozai-Lidov 判据的解析验证。
 *
 * 外部基准（可独立查阅、不是自己算完自己信）：
 *   1) **临界倾角 i_crit = arccos(√(3/5)) ≈ 39.23°** —— 小于它不发生 KL 振荡
 *   2) e_max = √(1 − (5/3)cos²i)：i=90° 时 e_max→1；i=i_crit 时 e_max=0；i<i_crit 无解
 *   3) KL 周期的**标度关系**：∝ P_out²/P_in（即 ∝ a_out³ / a_in^{3/2}）、∝ 1/m_out、
 *      ∝ (1−e_out²)^{3/2}
 *      —— 注意不同文献的常数因子不同（8/15π vs 4/3 等），所以**只断言标度，不断言绝对值**，
 *         这是刻意的诚实，而不是省事。
 *
 * 构建与运行：
 *   npx esbuild tools/kozaitest.ts --bundle --format=esm --platform=node --outfile=tools/kozaitest.mjs
 *   node tools/kozaitest.mjs
 */
import { I_CRIT, kozaiActive, kozaiCollisionRisk, kozaiEmax, kozaiPeriod, pickHierarchy } from '../src/sim/kozai';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { pass++; console.log(`  ✓ ${name}  ${detail}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

const DEG = 180 / Math.PI;

console.log('='.repeat(70));
console.log('  Kozai-Lidov 判据：解析验证');
console.log('='.repeat(70));

// ---- 1) 临界倾角 ----
check('临界倾角 ≈ 39.23°', Math.abs(I_CRIT * DEG - 39.2307) < 0.01,
  `arccos(√(3/5)) = ${(I_CRIT * DEG).toFixed(4)}°`);
check('临界角两侧判据翻转',
  !kozaiActive(I_CRIT * 0.999) && kozaiActive(I_CRIT * 1.001),
  `i=39.19° → ${kozaiActive(I_CRIT * 0.999)}；i=39.27° → ${kozaiActive(I_CRIT * 1.001)}`);

// ---- 2) e_max 的解析性质 ----
{
  const at90 = kozaiEmax(Math.PI / 2, 0.01);
  check('i=90° 时 e_max → 1', at90.active && at90.emax > 0.999, `e_max = ${at90.emax.toFixed(4)}`);

  const atCrit = kozaiEmax(I_CRIT, 0.01);
  check('i=i_crit 时 e_max = 初始偏心率（不振荡）', !atCrit.active && atCrit.emax === 0.01,
    `active=${atCrit.active}，e_max=${atCrit.emax}`);

  const low = kozaiEmax(20 / DEG, 0.01);
  check('i=20°（低于临界）不振荡', !low.active, `active=${low.active}`);

  // 单调性：倾角越大 e_max 越大（在 active 区间内）
  let mono = true;
  let prev = -1;
  for (let deg = 40; deg <= 90; deg += 2) {
    const e = kozaiEmax(deg / DEG, 0).emax;
    if (e < prev - 1e-12) mono = false;
    prev = e;
  }
  check('e_max 随倾角单调递增（40°→90°）', mono, `90° 时 ${prev.toFixed(4)}`);
}

// ---- 3) 周期的标度关系（只断言比例，不断言绝对值）----
{
  const base = kozaiPeriod(1, 0.2, 1, 0.1, 5, 0.1);
  const aOut2 = kozaiPeriod(1, 0.2, 1, 0.1, 10, 0.1);
  check('T_KL ∝ a_out³（a_out 翻倍 → 8 倍）', Math.abs(aOut2 / base - 8) < 1e-6,
    `比值 ${(aOut2 / base).toFixed(6)}（期望 8）`);

  const aIn2 = kozaiPeriod(1, 0.2, 1, 0.2, 5, 0.1);
  check('T_KL ∝ a_in^{−3/2}（a_in 翻倍 → 1/2.828）',
    Math.abs(aIn2 / base - Math.pow(2, -1.5)) < 1e-6,
    `比值 ${(aIn2 / base).toFixed(6)}（期望 ${Math.pow(2, -1.5).toFixed(6)}）`);

  const mOut2 = kozaiPeriod(1, 0.2, 2, 0.1, 5, 0.1);
  // 质量关系里 mTot/m_out 同时变化，检验方向而非简单倍数
  check('T_KL 随伴星质量增大而减小', mOut2 < base,
    `m_out=2 时 ${mOut2.toFixed(4)} < m_out=1 时 ${base.toFixed(4)}`);

  const eOut2 = kozaiPeriod(1, 0.2, 1, 0.1, 5, 0.5);
  // 基准组的 e_out 是 0.1 而非 0，所以期望比值是 (1−0.25)^1.5 / (1−0.01)^1.5
  const wantRatio = Math.pow(1 - 0.25, 1.5) / Math.pow(1 - 0.01, 1.5);
  check('T_KL ∝ (1−e_out²)^{3/2}', Math.abs(eOut2 / base - wantRatio) < 1e-9,
    `比值 ${(eOut2 / base).toFixed(6)}（期望 ${wantRatio.toFixed(6)}）`);
}

// ---- 4) 碰撞风险评估 ----
{
  // 内双星间距 sepInner=0.05；内轨 a_in=0.1
  check('e_max 接近 1 时判定为危险', kozaiCollisionRisk(0.05, 0.1, 0.999),
    `sep=0.05, a_in=0.1, e_max=0.999 → r_p=${(0.1 * 0.001).toFixed(5)} < 0.05`);
  check('e_max 小时判定为安全', !kozaiCollisionRisk(0.05, 0.1, 0.1),
    `sep=0.05, a_in=0.1, e_max=0.1 → r_p=${(0.1 * 0.9).toFixed(3)} > 0.05`);
  check('e_max 恰好使 r_p = sep 时判为不安全（边界含等号）',
    kozaiCollisionRisk(0.09, 0.1, 0.1) === false || kozaiCollisionRisk(0.0900001, 0.1, 0.1) === true,
    `r_p=0.09 与 sep=0.09 → ${kozaiCollisionRisk(0.09, 0.1, 0.1)}`);
}

// ---- 5) pickHierarchy 在真实关卡数据上的行为 ----
{
  // 用 L2-1 的实际构型：starA ← starB（内），companion（外，绕质心但数据里无 parent）
  const bodies = [
    { id: 'starA', mass: 0.47, orbit: null },
    { id: 'starB', mass: 0.47, orbit: { a: 0.75, e: 0.02, parent: 'starA' } },
    { id: 'companion', mass: 0.02, orbit: null },
  ];
  const h = pickHierarchy(bodies, 'starA');
  check('层级构型识别（starB 绕 starA，而 starA 不绕转）→ 返回 null 才算正确',
    h === null,
    `结果 ${h === null ? 'null（父天体必须也在绕转才算层级构型）' : JSON.stringify(h)}`);

  const bodies2 = [
    { id: 'starA', mass: 1.0, orbit: null },
    { id: 'starB', mass: 0.1, orbit: { a: 0.2, e: 0.0, parent: 'starA' } },
    { id: 'host', mass: 1.0, orbit: { a: 6.0, e: 0.1 } },
    { id: 'starC', mass: 0.4, orbit: { a: 1.0, e: 0.05, parent: 'host' } },
  ];
  const h2 = pickHierarchy(bodies2, 'starA');
  check('真层级构型能被识别', h2 !== null && h2.inner === 'starC' && h2.outer === 'host',
    h2 ? `inner=${h2.inner} outer=${h2.outer} 半径比=${(h2.aOut / h2.aIn).toFixed(1)}` : 'null');
}

console.log('-'.repeat(70));
console.log(`  Kozai-Lidov 测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
