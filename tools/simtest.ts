/**
 * Node 端物理与制导回归测试（无浏览器、无渲染，秒级迭代）
 *
 * 用途：在没有浏览器的情况下验证
 *   1) 辛积分器的守恒量与长期稳定性（长跑 N TU 不发散、不 NaN）
 *   2) 自动驾驶的引力牵引制导能否真的把货舱送进对接环（玩法可行性）
 *   3) 关卡数据是否物理自洽（近星点、洛希极限、时限）
 *
 * 用法:
 *   npx esbuild tools/simtest.ts --bundle --platform=node --format=esm --outfile=tools/simtest.mjs
 *   node tools/simtest.mjs <levels.json> [maxTU] [--verbose]
 */
import { readFileSync } from 'node:fs';
import { createWorld } from '../src/sim/world';
import { advance } from '../src/sim/step';
import { autopilot, createPilot, type PilotTelemetry } from '../src/game/autopilot';
import { rocheLimit, sphereDensity } from '../src/sim/constants';
import type { LevelsDoc, World } from '../src/sim/types';

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith('--'));
const maxTU = Number(args.find((a) => /^\d+(\.\d+)?$/.test(a)) ?? 80);
const verbose = args.includes('--verbose');
const only = args.find((a) => a.startsWith('--level='))?.split('=')[1];

if (!path) {
  console.error('用法: node tools/simtest.mjs <levels.json> [maxTU] [--verbose] [--level=ID]');
  process.exit(2);
}
// 容错：Windows 上用 PowerShell 写出的 JSON 可能带 UTF-8 BOM
const doc = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as LevelsDoc;

interface Row {
  id: string; ok: boolean; time: number; deliv: number; lost: number;
  minDock: number; minVrel: number; fuel: number; dE: number; dL: number;
  steps: number; substeps: number; note: string;
}
const rows: Row[] = [];

function specA(level: { bodies: { id: string; orbit: { a: number; e: number } | null }[] }, key: string): number {
  const b = level.bodies.find((x) => x.id === key);
  if (!b?.orbit) return 0;
  return b.orbit.e > 1e-6 ? 0 : b.orbit.a;
}

const levels = only ? doc.levels.filter((l) => l.id === only) : doc.levels;
console.log(`[simtest] ${levels.length} 关，每关最多 ${maxTU} TU 模拟时间`);
console.log('id      结果  用时TU  送达 损毁  最近距  最小|v_rel|  燃料Δv   ΔE/E      ΔL/L      步数/子步');

for (const level of levels) {
  const world: World = createWorld(level, doc, 1);
  if (args.includes('--init')) {
    console.log(`   [init] ${level.id} 物体 ${world.bodies.length}：`);
    for (const b of world.bodies.slice(0, 40)) {
      const bad = !isFinite(b.x) || !isFinite(b.y) || !isFinite(b.vx) || !isFinite(b.vy);
      if (bad || world.bodies.length <= 10) {
        console.log(`     ${bad ? '✘' : '✔'} ${b.key.padEnd(10)} ${b.kind.padEnd(9)} x=${b.x} y=${b.y} vx=${b.vx} vy=${b.vy}`);
      }
    }
    const nb = world.bodies.filter((b) => !isFinite(b.x) || !isFinite(b.vx));
    console.log(`   [init] 非有限初始状态的物体数 = ${nb.length}${nb.length ? ' → ' + nb.map((b) => b.key).join(',') : ''}`);
  }
  const pilot = createPilot();
  let minDock = Infinity;
  let minVrel = Infinity;
  let t = 0;
  const dt = 1 / 60;
  let lastLog = 0;
  const trace = args.includes('--trace');
  const keplerOnly = args.includes('--kepler');
  const tel: PilotTelemetry = {
    active: false, targetIndex: -1, distance: 0, closing: 0, aDes: 0,
    rPod: 0, rStation: 0, phase: 'idle', fuel: 0, dWellPod: 0, dirErr: 0, deadband: false,
  };
  const events: string[] = [];
  const eventsSeen = new Set<string>();
  const rRange = new Map<string, { min: number; max: number; a: number }>();

  // 物理预检：货舱近星点必须大于洛希极限
  const star = world.primaries.find((b) => b.kind === 'star' || b.kind === 'blackhole');
  let precheck = '';
  if (star) {
    const pod = world.pods[0];
    const lim = rocheLimit(star.radius, sphereDensity(star.mass, star.radius), sphereDensity(pod.mass, pod.radius) || 2.6);
    const r0 = Math.hypot(pod.x - star.x, pod.y - star.y);
    precheck = r0 < lim ? `⚠初始半径 ${r0.toFixed(2)} < 洛希极限 ${lim.toFixed(2)}` : '';
  }

  while (t < maxTU && world.status === 'running') {
    if (keplerOnly) {
      // 纯开普勒回归：关掉引力井，验证"初始状态自洽 → 轨道闭合且形状正确"
      world.well.engaged = false;
      world.well.mass = 0;
      world.well.targetMass = 0;
    } else {
      autopilot(world, pilot, tel);
    }
    advance(world, dt, 12);
    if (args.includes('--init') && t < 0.06) {
      const nb = world.bodies.filter((b) => !isFinite(b.x) || !isFinite(b.y) || !isFinite(b.vx) || !isFinite(b.vy));
      console.log(`   [step t=${t.toFixed(3)}] 非有限物体 ${nb.length}${nb.length ? ' → ' + nb.slice(0, 6).map((b) => `${b.key}(${b.kind}) x=${b.x} vx=${b.vx} ax=${b.ax}`).join(' | ') : ''}`);
    }
    t += dt;
    for (const ev of world.fx) {
      if (!eventsSeen.has(ev.kind + (ev.text ?? ''))) {
        eventsSeen.add(ev.kind + (ev.text ?? ''));
        events.push(`t=${t.toFixed(2)} ${ev.kind}${ev.text ? '「' + ev.text + '」' : ''} @(${ev.x.toFixed(2)},${ev.y.toFixed(2)}) mag=${ev.mag.toFixed(2)}`);
      }
    }
    world.fx.length = 0;
    if (trace && t <= 1.2 && Math.abs(t * 20 - Math.round(t * 20)) < 1e-9) {
      const p = world.pods[0];
      const dw = Math.hypot(p.x - world.well.x, p.y - world.well.y);
      console.log(`   t=${t.toFixed(2)} pod=(${p.x.toFixed(3)},${p.y.toFixed(3)}) |v|=${Math.hypot(p.vx, p.vy).toFixed(3)} r=${Math.hypot(p.x, p.y).toFixed(3)} | well=(${world.well.x.toFixed(3)},${world.well.y.toFixed(3)}) mass=${world.well.mass.toFixed(3)} dw=${dw.toFixed(3)} alive=${p.alive}`);
    }
    const station = world.primaries.find((b) => b.id === world.dock.bodyId);
    for (const b of world.primaries) {
      const r = Math.hypot(b.x - (world.primaries[0].x), b.y - (world.primaries[0].y));
      if (!rRange.has(b.key)) rRange.set(b.key, { min: r, max: r, a: specA(level, b.key) });
      const e = rRange.get(b.key)!;
      e.min = Math.min(e.min, r); e.max = Math.max(e.max, r);
    }
    for (const p of world.pods) {
      if (!p.alive || p.delivered) continue;
      const d = Math.hypot(p.x - world.dock.x, p.y - world.dock.y);
      const rv = station ? Math.hypot(p.vx - station.vx, p.vy - station.vy) : 0;
      if (d < minDock) minDock = d;
      if (d < 0.6 && rv < minVrel) minVrel = rv;
    }
    if (verbose && t - lastLog >= 2.5) {
      lastLog = t;
      const p = world.pods[0];
      const d = Math.hypot(p.x - world.dock.x, p.y - world.dock.y);
      const rv = station ? Math.hypot(p.vx - station.vx, p.vy - station.vy) : 0;
      console.log(`   t=${t.toFixed(1)} podR=${Math.hypot(p.x, p.y).toFixed(2)} rSt=${tel.rStation.toFixed(2)} |v|=${Math.hypot(p.vx, p.vy).toFixed(3)} dDock=${d.toFixed(3)} |vrel|=${rv.toFixed(3)} wellR=${Math.hypot(world.well.x, world.well.y).toFixed(2)} dwp=${tel.dWellPod.toFixed(2)} dirErr=${tel.dirErr.toFixed(0)}° mass=${world.well.mass.toFixed(3)} fuel=${world.fuel.toFixed(1)} ${tel.phase}`);
    }
  }

  const ok = world.status === 'won';
  if (events.length && (verbose || trace)) {
    console.log('   事件: ' + events.join('\n         '));
  }
  if (keplerOnly) {
    console.log('   开普勒回归（无引力井）：');
    for (const [k, v] of rRange) {
      const circ = v.a > 0;
      const dev = circ ? Math.abs(v.max - v.min) / v.a : 0;
      const okK = !circ || dev < 0.02;
      console.log(`     ${k.padEnd(10)} a=${v.a.toFixed(3)} r∈[${v.min.toFixed(3)}, ${v.max.toFixed(3)}] 相对起伏=${(dev * 100).toFixed(2)}% ${okK ? '✔' : '✘ 轨道形状不对（初始状态不自洽）'}`);
    }
  }
  rows.push({
    id: level.id, ok, time: world.time, deliv: world.level.podsDelivered, lost: world.level.podsLost,
    minDock: minDock === Infinity ? NaN : minDock,
    minVrel: minVrel === Infinity ? NaN : minVrel,
    fuel: world.level.fuelUsed, dE: world.stats.energyDrift, dL: world.stats.angularDrift,
    steps: world.stats.steps, substeps: world.stats.substeps,
    note: precheck || (ok ? '' : `status=${world.status}`),
  });
  const r = rows[rows.length - 1];
  console.log(
    `${r.id.padEnd(8)} ${(ok ? '成功' : '未达成').padEnd(5)} ${r.time.toFixed(1).padStart(6)} ${String(r.deliv).padStart(5)} ${String(r.lost).padStart(4)}  ` +
    `${(isNaN(r.minDock) ? '-' : r.minDock.toFixed(3)).padStart(7)} ${(isNaN(r.minVrel) ? '-' : r.minVrel.toFixed(3)).padStart(9)}  ` +
    `${r.fuel.toFixed(2).padStart(6)}  ${r.dE.toExponential(2)}  ${r.dL.toExponential(2)}  ${r.steps}/${r.substeps}${r.note ? '  ' + r.note : ''}`,
  );
}

const won = rows.filter((r) => r.ok).length;
const worstDE = Math.max(...rows.map((r) => r.dE));
const anyNaN = rows.some((r) => !isFinite(r.dE) || !isFinite(r.time));
console.log(`\n[simtest] 通关 ${won}/${rows.length}；最大 ΔE/E=${worstDE.toExponential(2)}；NaN=${anyNaN}`);
const hardFail = anyNaN || worstDE > 1e-2;
process.exit(hardFail ? 1 : 0);
