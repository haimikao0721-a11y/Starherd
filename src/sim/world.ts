/**
 * 由关卡数据构建可运行的 World：开普勒要素播种初始状态、程序化补足碎石带、
 * 预计算洛希极限、分配拖尾环形缓冲。全部确定性。
 */
import type {
  Body, BodyKind, LevelRuntime, LevelSpec, Nebula, SimBodyKind, World, LevelsDoc,
} from './types';
import { resolvePodSpec } from './types';
import { Rng } from '../engine/rng';
import { DT, TRAIL_LEN } from './constants';
import { areaOf, elementsToState, rocheLimit, sphereDensity, timeDilation } from './physics';

const TRAIL_KINDS: SimBodyKind[] = ['pod', 'shard'];

function makeBody(
  id: number, key: string, kind: SimBodyKind, mass: number, radius: number,
  x: number, y: number, vx: number, vy: number, tint: number, primary: boolean,
): Body {
  const trailN = TRAIL_KINDS.includes(kind) ? TRAIL_LEN : 0;
  return {
    id, key, kind, tag: '', mass, mu: mass, radius,
    x, y, vx, vy, ax: 0, ay: 0, px: x, py: y,
    alive: true, integrity: 1,
    area: areaOf(radius),
    cd: kind === 'asteroid' ? 1.1 : kind === 'shard' ? 0.9 : 0.7,
    qpr: 1,
    // 光帆系数缺省 1：主天体/小行星/碎片沿用改造前的光压（货舱在下面按级别覆盖）
    sail: 1,
    docked: false, delivered: false, lost: false,
    tint, ang: 0, spin: 0, primary,
    contact: 0, jolt: 0, stress: 0, dilation: 1, life: 0, tearT: 0,
    trailX: trailN ? new Float32Array(trailN) : new Float32Array(0),
    trailY: trailN ? new Float32Array(trailN) : new Float32Array(0),
    trailN: 0, trailHead: 0, trailTick: 0,
  };
}

function kindProps(kind: BodyKind): { spin: number; cd: number } {
  switch (kind) {
    case 'star': return { spin: 0.05, cd: 0 };
    case 'blackhole': return { spin: 0.02, cd: 0 };
    case 'planet': return { spin: 0.12, cd: 0 };
    case 'station': return { spin: 0.35, cd: 0 };
    default: return { spin: 0.5, cd: 1.1 };
  }
}

export interface BuiltWorld { world: World }

export function createWorld(level: LevelSpec, doc: LevelsDoc, attempt = 1): World {
  const consts = doc.constants;
  const muStar = level.mu_star || consts.mu_star || 1;
  const rng = new Rng(0x5eed ^ (level.index * 2654435761));

  const bodies: Body[] = [];
  const primaries: Body[] = [];
  const pods: Body[] = [];
  const shards: Body[] = [];
  let id = 1;
  const byKey = new Map<string, Body>();

  /**
   * 解算轨道初始状态。
   * - `orbit.parent` 为空 → 绕系统主天体（μ = muStar）；
   * - 填了父天体 id → **层级轨道**（卫星/绕行星的站）：相对轨道用**父天体的 μ** 解算，
   *   再叠加父天体自身的位置与速度。这就是真实任务设计里的拼锥近似（patched conic），
   *   因此卫星的周期、速度、Hill 球都是真实值，不需要任何"手工摆位"。
   * 父天体必须已经放置（见下方两趟放置循环）。
   */
  const placeOrbit = (orbit: LevelSpec['bodies'][number]['orbit']): { x: number; y: number; vx: number; vy: number } => {
    if (!orbit) return { x: 0, y: 0, vx: 0, vy: 0 };
    const parent = orbit.parent ? byKey.get(orbit.parent) : undefined;
    const mu = parent ? parent.mu : muStar;
    const st = elementsToState(orbit.a, orbit.e, orbit.omega, orbit.M0, mu);
    if (!parent) return { x: st.x, y: st.y, vx: st.vx, vy: st.vy };
    return { x: parent.x + st.x, y: parent.y + st.y, vx: parent.vx + st.vx, vy: parent.vy + st.vy };
  };

  const addPrimary = (key: string, kind: BodyKind, mass: number, radius: number, tint: number, orbit: LevelSpec['bodies'][number]['orbit'], rs?: number): Body => {
    const { x, y, vx, vy } = placeOrbit(orbit);
    const b = makeBody(id++, key, kind, mass, radius, x, y, vx, vy, tint, true);
    const kp = kindProps(kind);
    b.spin = kp.spin; b.cd = kp.cd;
    b.tag = key;
    bodies.push(b); primaries.push(b); byKey.set(key, b);
    void rs;
    return b;
  };

  // 主天体：**按依赖顺序放置**。带 orbit.parent 的天体（卫星/绕行星的空间站）必须等父天体就位，
  // 所以这里最多跑 4 趟，每趟只放"没有父天体、或父天体已就位"的那些。
  {
    const pending = level.bodies.slice();
    for (let pass = 0; pass < 4 && pending.length > 0; pass++) {
      let placedAny = false;
      for (let i = pending.length - 1; i >= 0; i--) {
        const spec = pending[i];
        const par = spec.orbit?.parent;
        if (par && !byKey.has(par)) continue; // 父天体还没放，等下一趟
        addPrimary(spec.id, spec.kind, spec.mass, spec.radius, spec.tint, spec.orbit, spec.rs);
        pending.splice(i, 1);
        placedAny = true;
      }
      if (!placedAny) break;
    }
    // 循环依赖等异常：把剩下的当无父轨道放掉，保证关卡仍可运行
    for (const spec of pending) {
      addPrimary(spec.id, spec.kind, spec.mass, spec.radius, spec.tint, spec.orbit && { ...spec.orbit, parent: undefined }, spec.rs);
    }
  }
  // 若关卡没有恒星，补一颗（保证有引力中心，也保证有光压与星风来源）
  if (!primaries.some((b) => b.kind === 'star' || b.kind === 'blackhole')) {
    addPrimary('core', 'star', 1, 0.16, 0, null);
  }

  // 货舱（同样支持绕行星/卫星的层级轨道）
  for (const spec of level.pods) {
    let x = 0, y = 0, vx = 0, vy = 0;
    if (spec.orbit) {
      const p = placeOrbit(spec.orbit);
      x = p.x; y = p.y; vx = p.vx; vy = p.vy;
    } else {
      const a = rng.range(1.2, 2.2), ang = rng.range(0, Math.PI * 2);
      x = Math.cos(ang) * a; y = Math.sin(ang) * a;
      const v = Math.sqrt(muStar / a);
      vx = -Math.sin(ang) * v; vy = Math.cos(ang) * v;
    }
    // 货舱级别（cargo pod variant）：class 缺失/未知 → 标准舱，此时原样使用 spec 的数值，
    // 因此旧关卡数据的行为逐位不变；其余级别用 POD_CLASSES 的权威参数覆盖 mass/radius/hull/sail。
    const pc = resolvePodSpec(spec);
    const b = makeBody(id++, spec.id, 'pod', pc.mass, pc.radius, x, y, vx, vy, 4, false);
    b.tag = spec.id;
    b.class = pc.cls.id;
    b.sail = pc.sail;
    b.integrity = pc.hull;
    b.cd = 0.7;
    bodies.push(b); pods.push(b); byKey.set(spec.id, b);
  }

  // 碎石带：第 2 章起，若关卡自带小行星不足则程序化补足（每颗都在真实开普勒轨道上）
  const designed = level.bodies.filter((b) => b.kind === 'asteroid');
  for (const spec of designed) {
    for (let i = 0; i < Math.max(1, Math.round(spec.mass > 0 ? 1 : 1)); i++) {
      const a = spec.orbit ? spec.orbit.a * (1 + (i - 0.5) * 0.002) : 2.0;
      const st = elementsToState(a, spec.orbit?.e ?? 0.05, spec.orbit?.omega ?? 0, (spec.orbit?.M0 ?? 0) + i * 0.01, muStar);
      const b = makeBody(id++, `${spec.id}_${i}`, 'asteroid', spec.mass, spec.radius, st.x, st.y, st.vx, st.vy, 4, false);
      const kp = kindProps('asteroid');
      b.cd = kp.cd; b.spin = rng.range(0.2, 1.4) * rng.sign();
      bodies.push(b); byKey.set(b.key, b);
    }
  }
  if (level.chapter >= 2 && bodies.filter((b) => b.kind === 'asteroid').length < 24) {
    const stationR = Math.hypot(byKey.get(level.dock.body)?.x ?? 1.6, byKey.get(level.dock.body)?.y ?? 0);
    const count = level.chapter >= 3 ? 96 : 72;
    for (let i = 0; i < count; i++) {
      let a = rng.range(1.35, 2.9);
      // 在空间站轨道附近留出柯克伍德式空隙，保证有可通行走廊
      if (Math.abs(a - stationR) < 0.22) a += 0.3 * Math.sign(a - stationR || 1);
      const e = Math.abs(rng.range(0, 0.14));
      const omega = rng.range(0, Math.PI * 2);
      const M0 = rng.range(0, Math.PI * 2);
      const st = elementsToState(a, e, omega, M0, muStar);
      const radius = 0.0035 + Math.pow(rng.next(), 2.2) * 0.0095; // 幂律尺寸分布（真实小行星带特征）
      const mass = sphereDensity(2.6, radius) * (4 / 3) * Math.PI * radius ** 3;
      const b = makeBody(id++, `rock${i}`, 'asteroid', mass, radius, st.x, st.y, st.vx, st.vy, 4, false);
      b.spin = rng.range(0.2, 1.6) * rng.sign();
      bodies.push(b); byKey.set(b.key, b);
    }
  }

  // 对接环
  const dockBody = byKey.get(level.dock.body) ?? primaries[primaries.length - 1];
  const off = level.dock.offset ?? { x: 0, y: 0 };
  const dock = {
    bodyId: dockBody.id,
    x: dockBody.x + off.x, y: dockBody.y + off.y,
    ox: off.x, oy: off.y,
    radius: level.dock.radius, vMax: level.dock.v_max, pulse: 0,
  };

  const nebulae: Nebula[] = (level.nebulae ?? []).map((n) => ({ ...n }));

  // 燃料：飞船自身的 Δv 预算由难度给出（与货舱的霍曼 Δv 是两种货币，HUD 分开显示）
  // 标定依据：悬停在 r≈1.5 处对抗恒星引力约需 0.44 Δv/TU，一次 1 RU 的转场约 3 Δv，
  // 因此 40~110 Δv 对应 20~60 TU 的真实任务时长。
  // 燃料预算：40 + 6×难度，再乘可选的关卡系数（fuel_scale）。
  // 玩家反馈「有些关太极限、不像能过」——放宽预算即可，物理与几何一律不动。
  const fuelScale = Number((level as { fuel_scale?: number }).fuel_scale ?? 1) || 1;
  const fuelCapacity = (40 + 6 * level.difficulty) * fuelScale;

  // 定时事件（宇宙风暴等）：运行时状态挂到 world.events，由 step 每步更新
  const eventState = (level.events ?? []).map((e) => ({
    kind: e.kind, x: 0, y: 0, dir: e.dir, eta: e.t0, active: false,
  }));
  const required = Math.max(1, Math.round(level.pods.length * (level.difficulty <= 2 ? 1 : 0.6)));

  const levelRt: LevelRuntime = {
    id: level.id, index: level.index, chapter: level.chapter,
    nameZh: level.name_zh, nameEn: level.name_en, difficulty: level.difficulty,
    parTime: level.par_time, parFuel: level.par_fuel,
    hintZh: level.hint_zh, hintEn: level.hint_en,
    palette: level.palette ?? `loop${level.chapter}`,
    music: `loop${Math.min(4, Math.max(1, level.chapter))}`,
    podsTotal: level.pods.length, podsDelivered: 0, podsLost: 0,
    elapsed: 0, fuelUsed: 0, fuelCapacity, attempts: attempt,
    fidelityGrade: '—', fidelityFactor: 0.7, fidelityNote: '等待飞行结束后的守恒量审计',
    solution: {
      method: level.solution?.method ?? 'hohmann',
      dvMin: level.solution?.dv_min ?? 0,
      notes: level.solution?.notes ?? '',
    },
    bounds: level.bounds,
    // 定时事件（宇宙风暴等）：必须抄进运行时 level，否则 applyEvents 读到 undefined（曾经漏抄导致"数据到了前端但事件静默失效"）
    events: level.events,
    // 时限（秒）。第 1 章是教学章：给足 180 秒，让玩家能反复试错而不被计时器逼死。
    // 注意时限不参与计分——时间分用的是 parTime（见 score.ts），所以放宽时限不会让分数虚高。
    timeLimit: Math.max(90, level.par_time * 3.4, level.chapter === 1 ? 180 : 0),
    combo: 0, comboTimer: 0,
  };

  // 黑洞时间膨胀因子（视觉）
  const bh = primaries.find((b) => b.kind === 'blackhole');
  const rs = bh ? (level.bodies.find((s) => s.kind === 'blackhole')?.rs ?? 0.03) : 0;
  if (bh) {
    for (const b of pods) b.dilation = timeDilation(Math.hypot(b.x - bh.x, b.y - bh.y), rs);
  }

  const world: World = {
    time: 0, frame: 0,
    G: consts.G ?? 1, epsilon: consts.epsilon ?? 0.02, bounds: level.bounds,
    bodies, primaries, pods, shards,
    well: {
      engaged: false, repel: false, precise: false,
      mass: 0.008, targetMass: 0.008,
      k: 0, c: 0,
      x: dockBody.x + 0.6, y: dockBody.y + 0.6, vx: 0, vy: 0,
      px: 0, py: 0, tx: 0, ty: 0,
      ltx: 0, lty: 0, tvx: 0, tvy: 0,
      thrust: 0, intensity: 0, polarity: 1, hot: 0,
    },
    level: levelRt,
    dock,
    nebulae, hazards: level.hazards ?? [],
    windTimer: 0, windActive: 0,
    status: 'running', statusTimer: 0,
    fieldEnabled: true,
    fuel: fuelCapacity, fuelCapacity,
    compute: 1, computeMax: 1,
    timeScale: 1, slowmo: 1,
    events: eventState,
    fx: [], predicted: [],
    stats: {
      steps: 0, substeps: 0, ke: 0, pe: 0, energy: 0,
      angularMomentum: 0, momentumX: 0, momentumY: 0,
      energy0: 0, angular0: 0, time: 0,
      energyDrift: 0, angularDrift: 0, lastStepMs: 0, lastStats: -1,
    },
    counters: {},
  };
  world.well.px = world.well.x; world.well.py = world.well.y;

  // 牧星者号起始状态：与空间站同轨伴飞（在站前方 0.12 rad，速度取该半径处的圆轨道速度）。
  // 否则飞船以零速出生，开局就朝恒星自由落体——玩家还没反应过来就被俘获了。
  {
    const r0 = Math.hypot(world.well.x, world.well.y);
    if (r0 > 1e-6) {
      const ang = Math.atan2(world.well.y, world.well.x) + 0.12;
      world.well.x = Math.cos(ang) * r0;
      world.well.y = Math.sin(ang) * r0;
      const vc = Math.sqrt(muStar / r0);
      // 与空间站同向绕行
      const sense = dockBody.x * dockBody.vy - dockBody.y * dockBody.vx >= 0 ? 1 : -1;
      world.well.vx = -Math.sin(ang) * vc * sense;
      world.well.vy = Math.cos(ang) * vc * sense;
      world.well.px = world.well.x; world.well.py = world.well.y;
    }
  }
  world.well.tx = world.well.x; world.well.ty = world.well.y;
  world.well.ltx = world.well.x; world.well.lty = world.well.y;

  // 洛希极限（真实公式）预计算：用于关卡危险区可视化与撕裂判定
  (world as World & { requiredPods?: number }).requiredPods = required;
  return world;
}

/** 关卡要求的送达数量（存活率计分与胜负判定用） */
export function requiredPods(world: World): number {
  const r = (world as World & { requiredPods?: number }).requiredPods;
  if (r) return r;
  return Math.max(1, Math.round(world.level.podsTotal * (world.level.difficulty <= 2 ? 1 : 0.6)));
}

/** 每颗主天体的洛希极限（相对标准货舱密度），供渲染危险环使用 */
export function rocheLimitsFor(world: World, podDensity: number): { body: Body; limit: number }[] {
  const out: { body: Body; limit: number }[] = [];
  for (const b of world.primaries) {
    if (b.radius <= 0) continue;
    out.push({ body: b, limit: rocheLimit(b.radius, sphereDensity(b.mass, b.radius), podDensity) });
  }
  return out;
}

export { DT };
