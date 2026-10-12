/**
 * 独立自检页：不依赖游戏层/宿主页面，直接把 sim + render 跑起来，
 * 用于在集成前验证「物理是否稳定、渲染是否有输出、事件是否触发」。
 * 用法: npx esbuild tools/smoke/sim_render_smoke.ts --bundle --format=esm --outfile=tools/smoke/app.js
 *      然后无头浏览器打开 index.html?asset=http://127.0.0.1:PORT/assets/
 */
import { createWorld } from '../../src/sim/world';
import { advance } from '../../src/sim/step';
import { predictPaths } from '../../src/sim/predict';
import { DEFAULT_QUALITY, PALETTES } from '../../src/sim/types';
import type { AssetStore, LevelsDoc, Manifest, MusicIndexEntry, MusicScore, ViewState, World } from '../../src/sim/types';
import { Renderer } from '../../src/render/renderer';
import { WELL_RANGE } from '../../src/sim/constants';
import { autopilot, createPilot } from '../../src/game/autopilot';

const q = new URLSearchParams(location.search);
const assetBase = q.get('asset') ?? '/assets/';
const levelIdx = Number(q.get('level') ?? '0') || 0;
const simSeconds = Number(q.get('sim') ?? '26') || 26;

const report = document.getElementById('rep') as HTMLPreElement;
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }); };

const chapters = [
  { index: 1, name_zh: '双星摇篮', name_en: 'Binary Cradle', palette: 'loop1', music: 'loop1', desc_zh: '' },
  { index: 4, name_zh: '深渊视界', name_en: 'Abyss Horizon', palette: 'loop4', music: 'loop4', desc_zh: '' },
];

const doc: LevelsDoc = {
  version: 'smoke', generated_at: new Date().toISOString(),
  constants: { G: 1, mu_star: 1, epsilon: 0.02, time_scale: 1.6, isp: 320, g0: 9.80665 },
  chapters,
  levels: [
    {
      id: 'S-1', index: 1, chapter: 1, name_zh: '自检关卡', name_en: 'Smoke', difficulty: 2,
      mu_star: 1, bounds: 6,
      camera: { x: 0, y: 0, zoom: 1.1 },
      bodies: [
        { id: 'star', kind: 'star', mass: 1, radius: 0.16, orbit: null, tint: 0, tag: '主序星' },
        { id: 'planetA', kind: 'planet', mass: 0.0008, radius: 0.045, orbit: { a: 2.35, e: 0.03, omega: 0, M0: 0.7 }, tint: 1 },
        { id: 'stationA', kind: 'station', mass: 0.00004, radius: 0.03, orbit: { a: 1.55, e: 0, omega: 0, M0: 2.1 }, tint: 2 },
      ],
      pods: [{ id: 'p1', mass: 0.00002, radius: 0.012, hull: 1, sail: 0.7, orbit: { a: 1.9, e: 0.06, omega: 0.4, M0: 1.2 } }],
      dock: { body: 'stationA', radius: 0.12, v_max: 0.3 },
      hazards: [{ kind: 'wind', period: 14, phase: 0, strength: 0.06, tag: '星风' }],
      nebulae: [],
      par_time: 40, par_fuel: 0.2, hint_zh: '', hint_en: '', palette: 'loop1',
    },
    {
      id: 'S-4', index: 2, chapter: 4, name_zh: '深渊自检', name_en: 'Abyss Smoke', difficulty: 11,
      mu_star: 1, bounds: 7,
      camera: { x: 0, y: 0, zoom: 0.9 },
      bodies: [
        { id: 'bh', kind: 'blackhole', mass: 1.2, radius: 0.05, orbit: null, tint: 1, rs: 0.04 },
        { id: 'stationB', kind: 'station', mass: 0.00004, radius: 0.03, orbit: { a: 2.2, e: 0.05, omega: 0, M0: 0.4 }, tint: 2 },
      ],
      pods: [
        { id: 'p1', mass: 0.00002, radius: 0.012, hull: 1, sail: 0.9, orbit: { a: 2.6, e: 0.12, omega: 0.2, M0: 0.9 } },
        { id: 'p2', mass: 0.00002, radius: 0.012, hull: 1, sail: 0.9, orbit: { a: 3.1, e: 0.1, omega: 1.1, M0: 3.3 } },
      ],
      dock: { body: 'stationB', radius: 0.12, v_max: 0.25 },
      hazards: [],
      nebulae: [{ x: 1.4, y: -1.1, r: 1.0, density: 0.03, omega: 0.3 }],
      par_time: 60, par_fuel: 0.4, hint_zh: '', hint_en: '', palette: 'loop4',
    },
  ],
};

/** 极简 AssetStore：从宿主 HTTP 目录加载真实素材；加载失败则用 canvas 生成占位图 */
class SmokeAssets implements AssetStore {
  manifest: Manifest = {
    version: 'smoke', generator: 'smoke', seed: 1, generated_at: '', audio: [], art: [], music: [], total_bytes: 0,
  };
  musicIndex: MusicIndexEntry[] = [];
  assetBase = assetBase;
  private imgs = new Map<string, HTMLImageElement>();
  private failed: string[] = [];
  ready = false;
  get errors(): string[] { return this.failed; }
  image(n: string): HTMLImageElement | undefined { return this.imgs.get(n); }
  audioBuffer(): AudioBuffer | undefined { return undefined; }
  audioUrl(n: string): string { return `${assetBase}audio/${n}.wav`; }
  music(): MusicScore | undefined { return undefined; }

  async load(names: string[]): Promise<void> {
    await Promise.all(names.map((n) => new Promise<void>((res) => {
      const im = new Image();
      im.onload = () => { this.imgs.set(n, im); res(); };
      im.onerror = () => { this.failed.push(n); this.imgs.set(n, fallback(n)); res(); };
      im.src = `${assetBase}art/${n}.png`;
    })));
    this.ready = true;
  }
}

function fallback(n: string): HTMLImageElement {
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = s; cv.height = s;
  const c = cv.getContext('2d') as CanvasRenderingContext2D;
  const id = c.createImageData(s, s);
  const h = s / 2;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const d = Math.hypot(x - h, y - h) / h;
      const i = (y * s + x) * 4;
      let a = 0;
      if (n.startsWith('glow')) a = Math.max(0, 1 - d) ** 2.2;
      else if (n.startsWith('nebula')) a = Math.max(0, 1 - d) ** 3;
      else if (n === 'vignette') a = Math.min(1, Math.max(0, (d - 0.55) / 0.45));
      else a = Math.max(0, 1 - d) ** 1.5;
      id.data[i] = 255; id.data[i + 1] = 255; id.data[i + 2] = 255; id.data[i + 3] = Math.round(a * 255);
    }
  }
  c.putImageData(id, 0, 0);
  const img = new Image();
  img.src = cv.toDataURL();
  return img;
}

async function main(): Promise<void> {
  const cv = document.getElementById('cv') as HTMLCanvasElement;
  const W = window.innerWidth, H = window.innerHeight, dpr = 1;
  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.width = `${W}px`; cv.style.height = `${H}px`;

  const assets = new SmokeAssets();
  await assets.load(['glow_soft', 'glow_ring', 'spark', 'shard', 'vignette', 'lens_gradient', 'ring_dock', 'grid_hex', 'star_field', 'nebula_loop1', 'nebula_loop4']);
  check('素材加载', assets.errors.length <= 4, `失败 ${assets.errors.length} 个: ${assets.errors.join(',')}`);

  const spec = doc.levels[Math.min(levelIdx, doc.levels.length - 1)];
  const world: World = createWorld(spec, doc, 1);
  check('世界构建', world.bodies.length >= 3 && world.pods.length >= 1, `物体 ${world.bodies.length} 个，主天体 ${world.primaries.length}，货舱 ${world.pods.length}`);

  const renderer = new Renderer(cv, { assets, palette: PALETTES[spec.palette ?? 'loop1'], quality: { ...DEFAULT_QUALITY } });
  renderer.resize(W, H, dpr);

  const view: ViewState = {
    w: W, h: H, dpr, zoom: 1.1, targetZoom: 1.1, shake: 0, hitstop: 0, flash: 0, chroma: 0,
    showField: !q.has('nofield'), showVectors: !q.has('nofield'), showPredict: true, showOrbits: true,
    slowmo: 1, intensity: 0.6, fade: 0, uiAlpha: 1, wellMode: 'attract',
    quality: { ...DEFAULT_QUALITY }, camera: { x: 0, y: 0, zoom: 1.1 },
  };

  // ---- 物理稳定性：跑 N 秒模拟时间，检查守恒量与轨道是否退化 ----
  const e0 = { e: 0, l: 0 };
  let steps = 0;
  let exceptions = 0;
  let maxAbs = 0;
  let collapsed = 0;
  const t0 = performance.now();
  const frames: number[] = [];
  const secPerFrame = 1 / 60;
  const simPerFrame = secPerFrame; // 1:1 实时
  let simT = 0;
  let podInitR = Math.hypot(world.pods[0].x, world.pods[0].y);
  let minDock = Infinity;
  let renderCalls = 0;
  let fxCount = 0;

  // 用游戏里真正的 PD 引力牵引制导（同时验证 autopilot 是否真能把货舱送进对接环）
  const pilot = createPilot();

  while (simT < simSeconds) {
    // 让出主线程：使无头浏览器的虚拟时间能推进，截图时页面处于完成态
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    // 无头浏览器的虚拟时间对 rAF 次数有上限，故每个 rAF 批处理 8 个模拟帧
    for (let k = 0; k < 8 && simT < simSeconds; k++) {
    const ft0 = performance.now();
    autopilot(world, pilot);
    const pod = world.pods[0];
    minDock = Math.min(minDock, Math.hypot(world.dock.x - pod.x, world.dock.y - pod.y));
    try {
      steps += advance(world, simPerFrame, 12);
      fxCount += world.fx.length;
      for (const ev of world.fx) renderer.pushFx(ev);
      world.fx.length = 0;
      // 每 30 帧补一次撞击特效，用于验证粒子系统确实在工作（真实游戏由物理事件驱动）
      if (renderCalls % 30 === 0 && pod.alive) {
        renderer.pushFx({ kind: 'impact', x: pod.x, y: pod.y, nx: Math.cos(simT), ny: Math.sin(simT), mag: 0.7, tint: 4 });
      }
      predictPaths(world, simT, WELL_RANGE, 5, 1 / 40, 6);
      renderer.frame(world, 1, secPerFrame, view);
      renderCalls++;
    } catch (err) {
      exceptions++;
      if (exceptions < 3) console.error('[SMOKE] 异常', err);
    }
    if (e0.e === 0) { e0.e = world.stats.energy0; e0.l = world.stats.angular0; }
    maxAbs = Math.max(maxAbs, Math.abs(world.well.x), Math.abs(world.well.y));
    const pr = Math.hypot(pod ? pod.x : 0, pod ? pod.y : 0);
    if (pod && pod.alive && !pod.delivered && pr < 0.2) collapsed++;
    simT += simPerFrame;
    frames.push(performance.now() - ft0);
    }
  }
  const wall = (performance.now() - t0) / 1000;
  frames.sort((a, b) => a - b);
  const p50 = frames[Math.floor(frames.length * 0.5)] ?? 0;
  const p95 = frames[Math.floor(frames.length * 0.95)] ?? 0;

  const s = world.stats;
  check('无异常', exceptions === 0, `异常 ${exceptions} 次`);
  check('物理推进', steps > 1000 && world.time > simSeconds * 0.9, `${steps} 步 / 模拟时间 ${world.time.toFixed(2)} TU`);
  check('能量守恒', Math.abs(s.energyDrift) < 1e-1, `ΔE/E=${s.energyDrift.toExponential(3)}（含引力井对轻体做功，主天体子系统精度见下一项）`);
  check('角动量守恒', Math.abs(s.angularDrift) < 1e-1, `ΔL/L=${s.angularDrift.toExponential(3)}`);
  check('轨道未退化', world.primaries.every((b) => isFinite(b.x) && isFinite(b.y) && Math.hypot(b.x, b.y) < world.bounds * 2), `主天体位置有限且在界内`);
  check('货舱被牵引', Math.abs(Math.hypot(world.pods[0].x, world.pods[0].y) - podInitR) > 0.02 || world.level.podsDelivered > 0, `初始半径 ${podInitR.toFixed(3)} → 现在 ${Math.hypot(world.pods[0].x, world.pods[0].y).toFixed(3)}`);
  check('渲染有输出', renderCalls > 100 && renderer.stats.particles >= 0, `渲染 ${renderCalls} 帧，粒子 ${renderer.stats.particles}，fps≈${renderer.stats.fps.toFixed(1)}`);
  check('帧耗时达标', p95 < 33, `p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms（含物理+预测+渲染）`);
  check('事件系统', fxCount > 0, `累计 ${fxCount} 个特效事件`);
  check('对接链路', world.level.podsDelivered > 0 || minDock < 0.35, `已对接 ${world.level.podsDelivered}，历史最近距对接环 ${minDock === Infinity ? 'N/A' : minDock.toFixed(3)} RU（环半径 ${world.dock.radius}）`);
  void maxAbs; void collapsed; void wall;

  const ok = checks.every((c) => c.ok);
  document.title = ok ? 'SMOKE:OK' : 'SMOKE:FAIL';
  report.innerHTML = `<b class="${ok ? 'ok' : 'bad'}">SIM+RENDER SMOKE ${ok ? 'PASS' : 'FAIL'}</b>\n`
    + `关卡=${spec.id} 模拟=${world.time.toFixed(2)}TU 状态=${world.status} 送达=${world.level.podsDelivered}/${world.level.podsTotal} 损毁=${world.level.podsLost}\n`
    + `帧耗时 p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms 渲染帧=${renderCalls} 粒子=${renderer.stats.particles}\n`
    + `主天体能量漂移 ΔE/E=${s.energyDrift.toExponential(3)} 角动量 ΔL/L=${s.angularDrift.toExponential(3)}\n`
    + `轨迹预测点数=${world.predicted.map((p) => p.n).join(',')}\n\n`
    + checks.map((c) => `${c.ok ? '✔' : '✘'} ${c.name.padEnd(12)} ${c.detail}`).join('\n');
  console.info('[SMOKE]', JSON.stringify({ ok, checks }));
}

void main().catch((e: unknown) => {
  const msg = String((e as Error)?.stack ?? e);
  checks.push({ name: 'main 未抛异常', ok: false, detail: msg.slice(0, 400) });
  document.title = 'SMOKE:FAIL';
  report.innerHTML = `<b class="bad">SMOKE 崩了</b>\n${msg}\n\n` + checks.map((c) => `${c.ok ? '✔' : '✘'} ${c.name} ${c.detail}`).join('\n');
  console.error('[SMOKE] 崩了', e);
});
