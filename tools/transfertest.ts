/**
 * transfertest.ts —— 霍曼 vs 双椭圆的数值验证（用文献结论检验实现）。
 *
 * 外部基准（不是自己算完自己信）：
 *   1) 已知霍曼 Δv 的正确性：地球→火星量级的半径比（1 → 1.524）时，
 *      Δv/√(μ/r₁) 有公认值；本测试用"能量守恒 + vis-viva"独立算一遍对照。
 *   2) 双椭圆优于霍曼的**阈值 r₂/r₁ ≈ 11.94**（r_b 取最优）。
 *   3) r_b → ∞ 的渐近阈值 ≈ 15.58。
 *   4) 双椭圆必然更慢（耗时更长）——这是它的代价，必须一起验证，
 *      否则"更省"的故事是不完整的。
 *
 * 构建与运行：
 *   npx esbuild tools/transfertest.ts --bundle --format=esm --platform=node --outfile=tools/transfertest.mjs
 *   node tools/transfertest.mjs
 */
import { bestBiElliptic, biElliptic, circularSpeed, hohmann, recommendTransfer } from '../src/sim/transfer';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { pass++; console.log(`  ✓ ${name}  ${detail}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

const MU = 1.0;

console.log('='.repeat(72));
console.log('  霍曼 vs 双椭圆：数值验证');
console.log('='.repeat(72));

// ---- 1) 霍曼 Δv 与 vis-viva 独立复算对照 ----
{
  const r1 = 1.0;
  const r2 = 1.524;                              // 地球→火星量级
  const h = hohmann(MU, r1, r2);
  // 独立算法：转移椭圆 a=(r1+r2)/2，用 vis-viva 求两端速度，再与圆速度作差
  const a = 0.5 * (r1 + r2);
  const vPeri = Math.sqrt(MU * (2 / r1 - 1 / a));
  const vApo = Math.sqrt(MU * (2 / r2 - 1 / a));
  const dvIndep = (vPeri - circularSpeed(MU, r1)) + (circularSpeed(MU, r2) - vApo);
  check('霍曼 Δv 与 vis-viva 独立复算一致', Math.abs(h.dv - dvIndep) < 1e-12,
    `实现 ${h.dv.toFixed(10)} vs 独立 ${dvIndep.toFixed(10)}`);
  check('霍曼耗时 = 半个转移椭圆周期',
    Math.abs(h.time - Math.PI * Math.sqrt((a * a * a) / MU)) < 1e-12,
    `T/2 = ${h.time.toFixed(6)} TU`);
}

// ---- 2) 双椭圆更省的阈值 ≈ 11.94 ----
{
  let below = 0;
  let above = 0;
  const ratios: number[] = [];
  for (let r2 = 2; r2 <= 40; r2 += 0.02) {
    const h = hohmann(MU, 1, r2);
    const b = bestBiElliptic(MU, 1, r2);
    if (b.dv < h.dv) { if (above === 0) ratios.push(r2); above++; } else below++;
  }
  const thr = ratios.length ? ratios[0] : NaN;
  console.log(`  扫描结果：半径比 < ${thr.toFixed(2)} 时霍曼更省；≥ ${thr.toFixed(2)} 时双椭圆更省`);
  check('阈值 ≈ 11.94（文献值）', Math.abs(thr - 11.94) < 0.35,
    `数值阈值 ${thr.toFixed(2)} vs 文献 11.94`);
  check('两种情形都出现过（扫描有效）', below > 100 && above > 100, `below=${below} above=${above}`);
}

// ---- 3) rb → ∞ 的双抛物线极限（用可独立推导的解析极限对照）----
{
  // 解析极限：rb→∞ 时
  //   Δv_bi → √(μ/r₁)·(√2 − 1) + [√(2μ/r₂) − √(μ/r₂)]
  // 物理含义：r₁ 处做接近抛物线逃逸的加速，r₂ 处从接近逃逸速度减速到圆速度。
  const rBig = 1e9;
  let worst = 0;
  const rows: string[] = [];
  for (const r2 of [5, 12, 20, 40]) {
    const b = biElliptic(MU, 1, r2, rBig);
    const limit = (Math.sqrt(2) - 1) + (Math.sqrt(2 / r2) - Math.sqrt(1 / r2));
    const err = Math.abs(b.dv - limit) / limit;
    if (err > worst) worst = err;
    rows.push(`r₂=${r2}: ${b.dv.toFixed(6)} vs 极限 ${limit.toFixed(6)}`);
  }
  check('rb→∞ 收敛到解析抛物线极限（容差 1e-3）', worst < 1e-3, rows.join('；'));
  console.log('  注：文献常引的 15.58（双抛物线阈值）在本实现的意义下**无法复现**——');
  console.log('      手算复核 R=12 时双抛物线 0.533787 < 霍曼 0.534148，已在 R≈11.9 就更省。');
  console.log('      这里不为了凑那个数字去改代码，改为断言可独立推导的极限公式。');
}

// ---- 4) 双椭圆的代价：更慢 ----
{
  const cases: Array<[number, number]> = [[1, 20], [1, 30], [1, 40]];
  let allSlower = true;
  const detail: string[] = [];
  for (const [r1, r2] of cases) {
    const h = hohmann(MU, r1, r2);
    const b = bestBiElliptic(MU, r1, r2);
    const slower = b.time > h.time;
    if (!slower) allSlower = false;
    detail.push(`r₂/r₁=${r2}：霍曼 ${h.time.toFixed(1)} TU vs 双椭圆 ${b.time.toFixed(1)} TU`);
  }
  check('双椭圆必然更慢（代价必须一起成立）', allSlower, detail.join('；'));
}

// ---- 5) recommendTransfer 的取舍正确 ----
{
  const near = recommendTransfer(MU, 1, 3);
  const far = recommendTransfer(MU, 1, 30);
  check('近距离推荐霍曼', near.best.kind === 'hohmann', `r₂/r₁=3 → ${near.best.kind}`);
  check('远距离推荐双椭圆', far.best.kind === 'bi-elliptic', `r₂/r₁=30 → ${far.best.kind}`);
  check('远距离时双椭圆确实更省',
    far.biPlan.dv < far.hohmannPlan.dv,
    `霍曼 ${far.hohmannPlan.dv.toFixed(5)} vs 双椭圆 ${far.biPlan.dv.toFixed(5)} RU/TU`);
  // 报告节省比例，便于玩家理解"省多少、慢多少"
  const save = (1 - far.biPlan.dv / far.hohmannPlan.dv) * 100;
  const slow = far.biPlan.time / far.hohmannPlan.time;
  console.log(`  r₂/r₁=30 时：双椭圆省 ${save.toFixed(1)}% 燃料，但耗时是霍曼的 ${slow.toFixed(1)} 倍`);
}

console.log('-'.repeat(72));
console.log(`  转移方案测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
