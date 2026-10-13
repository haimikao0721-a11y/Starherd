/**
 * eventtest.ts —— 事件力（宇宙风暴）的单元测试。
 *
 * 为什么直接测函数而不是"看预测线有没有弯"：
 * 实时物理与 Tab 预测线**共用** `eventAccelAt()`（predict.ts 里显式调用它），
 * 所以只要证明这个函数的行为正确，就同时证明了"预测线里画的力 == 实际发生的力"。
 * 这比对着截图判断路径有没有偏折可靠得多。
 *
 * 构建与运行：
 *     npx esbuild tools/eventtest.ts --bundle --format=esm --platform=node --outfile=tools/eventtest.mjs
 *     node tools/eventtest.mjs
 */
import { readFileSync } from 'node:fs';
import { createWorld } from '../src/sim/world';
import { eventAccelAt } from '../src/sim/step';
import type { LevelsDoc, LevelSpec } from '../src/sim/types';

const doc = JSON.parse(readFileSync('assets/data/systems.json', 'utf8')) as LevelsDoc;
const spec = doc.levels.find((l) => l.id === 'L2-2') as LevelSpec;
if (!spec || !spec.events || !spec.events.length) {
  console.error('✗ L2-2 没有配置事件，无法测试');
  process.exit(1);
}
const ev = spec.events[0];
const world = createWorld(spec, doc, 1);
const out = { x: 0, y: 0 };

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { pass++; console.log(`  ✓ ${name}  ${detail}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

// 锋面在时刻 t 的推进量（与 eventAccelAt 内部同一套相位公式）
const span = world.bounds * 2.4;
const cxAt = (t: number): number => {
  const period = ev.period > 0 ? ev.period : Number.POSITIVE_INFINITY;
  const u = period === Number.POSITIVE_INFINITY ? t - ev.t0 : (t - ev.t0) % period;
  return -span * 0.5 + u * ev.speed;
};
const nx = Math.cos(ev.dir);
const ny = Math.sin(ev.dir);

console.log('='.repeat(66));
console.log('  宇宙风暴事件力单元测试（L2-2）');
console.log('='.repeat(66));
console.log(`  参数：t0=${ev.t0} 周期=${ev.period} 方向=${ev.dir} rad 速度=${ev.speed} ` +
  `厚度=${ev.width} 加速度=${ev.accel}`);

// 1) 事件开始之前：没有任何力
eventAccelAt(world, ev.t0 - 2, 0, 0, out);
check('事件开始前无力', Math.hypot(out.x, out.y) < 1e-12, `|a|=${Math.hypot(out.x, out.y).toExponential(2)}`);

// 2) 锋面上：力沿 dir，大小约为 accel
const tMid = ev.t0 + 4;
const c = cxAt(tMid);
const onFront = { x: nx * c, y: ny * c };
eventAccelAt(world, tMid, onFront.x, onFront.y, out);
const mag = Math.hypot(out.x, out.y);
const dirErr = Math.abs(Math.atan2(out.y, out.x) - ev.dir);
check('锋面上有力', mag > ev.accel * 0.9, `|a|=${mag.toFixed(4)}（期望≈${ev.accel}）`);
check('方向与 dir 一致', dirErr < 1e-6 || Math.abs(dirErr - Math.PI) < 1e-6,
  `与 dir 夹角 ${(dirErr * 180 / Math.PI).toFixed(3)}°`);

// 3) 锋面外：力为零
const far = { x: nx * (c + ev.width * 3), y: ny * (c + ev.width * 3) };
eventAccelAt(world, tMid, far.x, far.y, out);
check('锋面外无力', Math.hypot(out.x, out.y) < 1e-9, `|a|=${Math.hypot(out.x, out.y).toExponential(2)}`);

// 4) 高斯衰减：离锋面越远力越小，且单调
const r1 = { x: nx * (c + ev.width * 0.2), y: ny * (c + ev.width * 0.2) };
const r2 = { x: nx * (c + ev.width * 0.4), y: ny * (c + ev.width * 0.4) };
eventAccelAt(world, tMid, r1.x, r1.y, out); const a1 = Math.hypot(out.x, out.y);
eventAccelAt(world, tMid, r2.x, r2.y, out); const a2 = Math.hypot(out.x, out.y);
check('锋面内高斯衰减单调', a1 > a2 && a2 > 0, `d=0.2w→${a1.toFixed(4)}  d=0.4w→${a2.toFixed(4)}`);

// 5) 时间推移：锋面确实在移动（同一空间点在不同时刻力不同，且最终归零）
eventAccelAt(world, tMid + 1.0, onFront.x, onFront.y, out);
const later = Math.hypot(out.x, out.y);
check('锋面随时间推进', Math.abs(later - mag) > 1e-6, `t 与 t+1 的 |a|：${mag.toFixed(4)} vs ${later.toFixed(4)}`);

// 6) 周期性：一个周期之后回到同样的力
eventAccelAt(world, tMid + ev.period, onFront.x, onFront.y, out);
check('周期回绕一致', Math.abs(Math.hypot(out.x, out.y) - mag) < 1e-9,
  `t 与 t+period 的 |a|：${mag.toFixed(6)} vs ${Math.hypot(out.x, out.y).toFixed(6)}`);

console.log('-'.repeat(66));
console.log(`  单元测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
