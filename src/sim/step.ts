/**
 * 固定步长物理推进（KDK 速度 Verlet 蛙跳，辛积分器）
 * 单步：半步 kick → 全步 drift → 重算加速度 → 半步 kick → 交互判定
 * 外加：自适应子步、真实碰撞冲量、洛希撕裂、软/硬对接、星风、算力、守恒量审计。
 *
 * 性能约定：所有热路径零分配（复用 scratch 数组与累加器）。
 */
import type { Body, FxKind, World } from './types';
import {
  A_MAX, COMPUTE_DRAIN_FIELD, COMPUTE_DRAIN_SLOWMO, COMPUTE_HYSTERESIS, COMPUTE_REGEN,
  C_DAMP, C_DAMP_PRECISE, DT, ESCAPE_PUSH_MAX, K_SPRING, MAX_ADAPT_DEPTH, RCS_FACTOR,
  RESTITUTION, SHIP_CD, SHIP_MASS, SHIP_RADIUS, STAR_KEEPOUT, STAR_SHIELD, STRESS_TEAR, TEAR_GRACE, TIDAL_REF, TIME_SCALE,
  TRAIL_DT, V_CRIT, WELL_MASS_MAX, WELL_RANGE, WIND_MIN_R,
} from './constants';
import {
  conservedQuantities, dragAccel, primaryAccel, radiationAccel, rocheLimit,
  sphereDensity, tidalGradient, wellAccel,
  primaryAccelRel,
} from './physics';
import { requiredPods } from './world';

const LIGHT: Body[] = [];
const PODSH: Body[] = [];
const AST: Body[] = [];
const WACC = { x: 0, y: 0 };
const NEB = { rho: 0, omega: 0 };
const rocheCache = new Map<number, number>();

function collect(world: World): void {
  LIGHT.length = 0; PODSH.length = 0; AST.length = 0;
  const bs = world.bodies;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (b.primary || !b.alive) continue;
    LIGHT.push(b);
    if (b.kind === 'asteroid') AST.push(b); else PODSH.push(b);
  }
}

function nebulaAt(world: World, x: number, y: number): void {
  let rho = 0, om = 0, wsum = 0;
  for (let i = 0; i < world.nebulae.length; i++) {
    const n = world.nebulae[i];
    const d2 = (n.x - x) * (n.x - x) + (n.y - y) * (n.y - y);
    const r2 = n.r * n.r;
    if (d2 >= r2) continue;
    const f = 1 - d2 / r2;
    const w = f * f * n.density;
    rho += w; om += n.omega * w; wsum += w;
  }
  NEB.rho = rho;
  NEB.omega = wsum > 0 ? om / wsum : 0;
}

/** 星风包络：wind 危险源在周期 75%~95% 区间内以正弦窗爆发 */
function windEnvelope(world: World): number {
  let env = 0;
  for (let i = 0; i < world.hazards.length; i++) {
    const h = world.hazards[i];
    if (h.kind !== 'wind') continue;
    const per = Math.max(1e-3, h.period);
    let ph = ((world.time + h.phase) % per) / per;
    if (ph < 0) ph += 1;
    if (ph < 0.75 || ph > 0.95) continue;
    const v = Math.sin(((ph - 0.75) / 0.2) * Math.PI) * h.strength;
    if (v > env) env = v;
  }
  return env;
}

function mainStar(world: World): Body | null {
  for (let i = 0; i < world.primaries.length; i++) {
    const b = world.primaries[i];
    if (b.kind === 'star') return b;
  }
  return null;
}

/**
 * 加速度累加用的临时向量。
 * ⚠️ 绝对不要把 Body 当作 Vec2 的 out 参数传进 pointAccel/primaryAccel/wellAccel/
 * radiationAccel/dragAccel —— Body 的 x/y 就是**位置**，结构上又满足 Vec2，
 * 编译器不会拦你，结果是加速度被写进位置字段（轻体既不受引力又会瞬移）。
 */
const ACC = { x: 0, y: 0 };

function lightAccel(world: World, b: Body, wind: number): void {
  b.ax = 0; b.ay = 0;
  if (b.docked || !b.alive) return;
  ACC.x = 0; ACC.y = 0;
  primaryAccelRel(b.x, b.y, b.vx, b.vy, world.primaries, world.epsilon, ACC);
  // 碎石雨只受主天体引力。辐射压按面积/质量会把它们加速到离谱，数量一多步长就拖垮。
  if (b.kind === 'asteroid' && b.key.startsWith('rock')) {
    b.ax = ACC.x;
    b.ay = ACC.y;
    return;
  }
  const w = world.well;
  if (world.fieldEnabled && w.engaged && w.mass > 0) {
    wellAccel(b.x, b.y, w.x, w.y, w.mass, WELL_RANGE, w.repel, world.epsilon, ACC);
  }
  const star = mainStar(world);
  if (star) {
    // 光帆系数来自天体自身：货舱按级别带 sail（见 POD_CLASSES / resolvePodSpec），
    // 其余天体与世界构造时的缺省值 1 一致 —— 公式 a = K_RAD·sail·A/(r²m) 本身没有改动。
    radiationAccel(b.x, b.y, star, b.area, b.sail ?? 1, b.mass, ACC);
    if (wind > 0) {
      const dx = b.x - star.x, dy = b.y - star.y;
      const r = Math.max(WIND_MIN_R, Math.hypot(dx, dy));
      const mag = wind / r;
      ACC.x += (mag * dx) / r;
      ACC.y += (mag * dy) / r;
    }
  }
  if (world.nebulae.length) {
    nebulaAt(world, b.x, b.y);
    if (NEB.rho > 0) dragAccel(b.x, b.y, b.vx, b.vy, NEB.rho, b.cd, b.area, b.mass, NEB.omega, ACC);
  }
  b.ax = ACC.x;
  b.ay = ACC.y;
}

function primaryAccels(world: World): void {
  const ps = world.primaries;
  for (let i = 0; i < ps.length; i++) { ps[i].ax = 0; ps[i].ay = 0; }
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i];
    for (let j = i + 1; j < ps.length; j++) {
      const b = ps[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const r2 = dx * dx + dy * dy + world.epsilon * world.epsilon;
      const inv = 1 / (r2 * Math.sqrt(r2));
      const fa = b.mu * inv, fb = a.mu * inv;
      a.ax += fa * dx; a.ay += fa * dy;
      b.ax -= fb * dx; b.ay -= fb * dy;
    }
  }
}

/** 牧星者号：主天体引力 + 星风 + 星云阻力 + 饱和弹簧阻尼控制力 */
function wellAccels(world: World, wind: number): void {
  const w = world.well;
  WACC.x = 0; WACC.y = 0;
  primaryAccel(w.x, w.y, world.primaries, world.epsilon, WACC);
  const star = mainStar(world);
  if (star && wind > 0) {
    const dx = w.x - star.x, dy = w.y - star.y;
    const r = Math.max(WIND_MIN_R, Math.hypot(dx, dy));
    const mag = wind / r;
    WACC.x += (mag * dx) / r; WACC.y += (mag * dy) / r;
  }
  if (world.nebulae.length) {
    nebulaAt(world, w.x, w.y);
    if (NEB.rho > 0) {
      dragAccel(w.x, w.y, w.vx, w.vy, NEB.rho, SHIP_CD, Math.PI * SHIP_RADIUS * SHIP_RADIUS, SHIP_MASS, NEB.omega, WACC);
    }
  }
  const damp = w.precise ? C_DAMP_PRECISE : C_DAMP;

  /* 光球层护盾 + 安全阀（见 constants.STAR_KEEPOUT / STAR_SHIELD）：
     推力上限 3.0 与恒星引力的交叉点在 r≈0.57 RU——以内飞船根本拉不动（实测的死局）。
     这里在护盾带内按距离平滑抵消恒星引力，让推力重新拥有控制权，保证任何局面都能脱身；
     位置硬边界由 wellConstraint() 在 drift 之后强制夹住。 */
  const star0 = mainStar(world);
  w.hot = 0;
  if (star0) {
    const dx = w.x - star0.x, dy = w.y - star0.y;
    const r = Math.hypot(dx, dy);
    const rIn = star0.radius + STAR_KEEPOUT;
    const rSh = star0.radius + STAR_SHIELD;
    if (r < rSh) {
      const blend = Math.min(1, (1 - (r - rIn) / Math.max(1e-6, rSh - rIn)) * 1.35);
      if (blend > 0) {
        const den = Math.pow(r * r + world.epsilon * world.epsilon, 1.5);
        const g = den > 0 ? (star0.mu * r) / den : 0;
        const inv = 1 / Math.max(r, 1e-6);
        WACC.x += dx * inv * g * blend;
        WACC.y += dy * inv * g * blend;
      }
      w.hot = r < rIn ? 1 : Math.min(1, 0.9 * (1 - (r - rIn) / Math.max(1e-6, rSh - rIn)));
    }
  }

  let fx = 0, fy = 0;
  if (w.engaged) {
    // PD 跟踪 + 目标速度前馈：相对速度 = v_ship − v_target。
    // 只对相对速度做阻尼，飞船才能跟随以轨道速度运动的目标点；
    // 若按绝对速度制动（−c·v），跟随 0.7 RU/TU 的目标需要 15 RU/TU² 的控制力，
    // 而推力上限只有 3，飞船会彻底跟不上并被甩出系统（实测逃逸到 12 RU）。
    fx = K_SPRING * (w.tx - w.x) - damp * (w.vx - w.tvx);
    fy = K_SPRING * (w.ty - w.y) - damp * (w.vy - w.tvy);
  }
  const amax = world.fuel <= 0 ? A_MAX * RCS_FACTOR : A_MAX;
  const fmag = Math.hypot(fx, fy);
  const fmax = amax * SHIP_MASS;
  if (fmag > fmax && fmag > 0) { const k = fmax / fmag; fx *= k; fy *= k; }
  const invM = SHIP_MASS > 0 ? 1 / SHIP_MASS : 0;
  WACC.x += fx * invM;
  WACC.y += fy * invM;
  w.thrust = Math.min(fmag, fmax) * invM;
}

function kick(world: World, h: number): void {
  const bs = world.bodies;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (!b.alive || b.docked) continue;
    b.vx += b.ax * h; b.vy += b.ay * h;
  }
  const w = world.well;
  w.vx += WACC.x * h; w.vy += WACC.y * h;
}

function drift(world: World, h: number): void {
  const bs = world.bodies;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (!b.alive || b.docked) continue;
    b.x += b.vx * h; b.y += b.vy * h;
    b.ang += b.spin * h;
    b.life += h;
    if (b.contact > 0) b.contact = Math.max(0, b.contact - h);
    if (b.jolt > 0) b.jolt = Math.max(0, b.jolt - h * 2);
  }
  const w = world.well;
  w.x += w.vx * h; w.y += w.vy * h;
}

/** 每帧开始记录上一物理步位置，供渲染插值 */
export function beginFrame(world: World): void {
  recordPrev(world);
}

function recordPrev(world: World): void {
  const bs = world.bodies;
  for (let i = 0; i < bs.length; i++) { bs[i].px = bs[i].x; bs[i].py = bs[i].y; }
  world.well.px = world.well.x; world.well.py = world.well.y;
}

/** 冲量解算（动量守恒），返回冲量大小 */
function impulse(a: Body, b: Body, e: number): number {
  let dx = b.x - a.x, dy = b.y - a.y;
  let r = Math.hypot(dx, dy);
  if (r < 1e-9) { dx = 1; dy = 0; r = 1e-9; }
  const nx = dx / r, ny = dy / r;
  const im1 = a.mass > 0 ? 1 / a.mass : 0;
  const im2 = b.mass > 0 ? 1 / b.mass : 0;
  const isum = im1 + im2 || 1;
  const minD = a.radius + b.radius;
  if (r < minD) {
    const push = minD - r;
    a.x -= nx * push * (im1 / isum); a.y -= ny * push * (im1 / isum);
    b.x += nx * push * (im2 / isum); b.y += ny * push * (im2 / isum);
  }
  const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (vn > 0) return 0;
  const j = (-(1 + e) * vn) / isum;
  a.vx -= j * im1 * nx; a.vy -= j * im1 * ny;
  b.vx += j * im2 * nx; b.vy += j * im2 * ny;
  return Math.abs(j);
}

function spawnShards(world: World, src: Body, count: number, spread: number): void {
  const rr = Math.max(0.004, src.radius * 0.5);
  const area = Math.PI * rr * rr;
  const base = 1e6 + world.bodies.length * 8;
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + world.time * 0.7;
    const m = src.mass / count;
    const sh: Body = {
      id: base + i, key: `shard${base + i}`, kind: 'shard', tag: '碎片',
      mass: m, mu: m, radius: rr,
      x: src.x + Math.cos(ang) * src.radius, y: src.y + Math.sin(ang) * src.radius,
      vx: src.vx + Math.cos(ang) * spread, vy: src.vy + Math.sin(ang) * spread,
      ax: 0, ay: 0, px: src.x, py: src.y,
      alive: true, integrity: 1, area, cd: 0.9, qpr: 1,
      docked: false, delivered: false, lost: false,
      tint: src.tint, ang, spin: (i % 2 ? 1 : -1) * (0.8 + i * 0.13), primary: false,
      contact: 0, jolt: 0, stress: 0, dilation: 1, life: 0, tearT: 0,
      trailX: new Float32Array(48), trailY: new Float32Array(48),
      trailN: 0, trailHead: 0, trailTick: 0,
    };
    world.shards.push(sh);
    world.bodies.push(sh);
  }
}

function fx(world: World, kind: string, x: number, y: number, nx: number, ny: number, mag: number, tint: number, sound?: string, text?: string): void {
  world.fx.push({ kind: kind as FxKind, x, y, nx, ny, mag, tint, sound, text });
}

function destroyBody(world: World, b: Body, sound: string, text: string): void {
  if (!b.alive) return;
  b.alive = false; b.lost = true;
  fx(world, 'lost', b.x, b.y, b.vx, b.vy, Math.hypot(b.vx, b.vy) + 0.3, b.tint, sound, text);
  if (b.kind === 'pod') {
    world.level.podsLost++;
    world.level.combo = 0;
    spawnShards(world, b, 5, 0.55);
  }
}

/** 潮汐撕裂：碎片沿径向分离（真实潮汐拉伸特征） */
function tearBody(world: World, b: Body, cx: number, cy: number): void {
  if (!b.alive) return;
  b.alive = false; b.lost = true;
  fx(world, 'tear', b.x, b.y, cx, cy, 1.6, b.tint, 'tidal_tear', '潮汐撕裂');
  if (b.kind === 'pod') { world.level.podsLost++; world.level.combo = 0; }
  spawnShards(world, b, 7, 0.42);
}

function inPlay(world: World): number {
  let n = 0;
  for (let i = 0; i < world.pods.length; i++) {
    const p = world.pods[i];
    if (p.alive && !p.delivered) n++;
  }
  return n;
}

/**
 * 恒星光球层硬约束（安全闸）。
 *
 * 为什么必须是"硬约束"而不是力：牧星者号的推力上限只有 A_MAX=3.0，而恒星表面附近的引力是
 * μ/(r²+ε²)^{3/2}·r——实测 r=0.02 处高达 884 RU/TU²（软化后）。任何有限推力都counter不了，
 * 所以玩家把井拖进恒星后会陷入"怎么动都没反应、只能重开"的死局（实测反馈）。
 * 这里把光球层当作真实碰撞面：位置硬性夹回边界，并去掉指向恒星的速度分量（完全非弹性），
 * 于是"井进入恒星"在数学上不可能发生，任何局面都能把井拖回来。
 */
function wellConstraint(world: World): void {
  const w = world.well;
  // ---- 作业区外边界（用户反馈："引力井飞出地图了，但没有重开的内容"）----
  // 井（= 玩家的飞船）靠 PD 追随鼠标目标。目标点虽然钳在地图内，但船有惯性，
  // 长时间把鼠标顶在画面边缘会让它一路冲出去（实测到 17.19 RU，而 bounds = 8）。
  // 这里给一个**硬边界**：越界就投影回边界并去掉向外的径向速度——和恒星光球层同一层保护。
  const bnd = world.bounds;
  if (bnd > 0) {
    const rw = Math.hypot(w.x, w.y);
    const lim = bnd * 1.02;
    if (rw > lim) {
      const inv2 = 1 / Math.max(rw, 1e-6);
      const nx2 = w.x * inv2;
      const ny2 = w.y * inv2;
      w.x = nx2 * lim;
      w.y = ny2 * lim;
      const vr2 = w.vx * nx2 + w.vy * ny2;
      if (vr2 > 0) { w.vx -= vr2 * nx2; w.vy -= vr2 * ny2; }
    }
  }
  const star = mainStar(world);
  if (!star) { w.hot = 0; return; }
  const keep = star.radius + STAR_KEEPOUT;
  const dx = w.x - star.x;
  const dy = w.y - star.y;
  const r = Math.hypot(dx, dy);
  if (r >= keep) {
    // 护盾带内提前告警（不做位置干预）
    const rSh = star.radius + STAR_SHIELD;
    w.hot = r < rSh ? Math.min(1, 0.9 * (1 - (r - keep) / Math.max(1e-6, rSh - keep))) : 0;
    return;
  }
  const inv = 1 / Math.max(r, 1e-6);
  const nx = dx * inv;
  const ny = dy * inv;
  w.x = star.x + nx * keep;
  w.y = star.y + ny * keep;
  const vr = w.vx * nx + w.vy * ny;
  if (vr < 0) { w.vx -= vr * nx; w.vy -= vr * ny; } // 去掉撞向恒星的分量
  w.hot = 1;
}


/**
 * 定时事件：**宇宙风暴** —— 一道推进的力场锋面。
 *
 * 设计要点（玩家反馈「事件不能变成运气」）：锋面**完全可预测**——
 * 位置只由 ``t0/period/speed/dir`` 决定，HUD 提前给 ETA，Tab 预测线里也能看到它推偏货舱。
 * 玩家要做的不是祈祷，而是**提前把货舱挪出锋面路径**，或**顺风利用它省燃料**。
 */
/**
 * 事件在某个**时刻 t**、某个位置 (x,y) 处产生的加速度。
 *
 * 抽成公共函数是为了让**实时物理与 Tab 预测线用同一套力**——玩家反馈过
 * "事件不能变成运气"：只有预测线也画得出锋面的推偏，玩家才能提前规划。
 */
export function eventAccelAt(world: World, t: number, x: number, y: number,
  out: { x: number; y: number }): void {
  out.x = 0; out.y = 0;
  const list = world.level.events;
  if (!list || !list.length) return;
  const span = world.bounds * 2.4;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.kind !== 'storm') continue;
    const period = e.period > 0 ? e.period : Number.POSITIVE_INFINITY;
    const u = period === Number.POSITIVE_INFINITY ? t - e.t0 : (t - e.t0) % period;
    if (u < 0) continue;
    const cx = -span * 0.5 + u * e.speed;
    if (Math.abs(cx) > span * 0.75) continue;
    const nx = Math.cos(e.dir);
    const ny = Math.sin(e.dir);
    const d = (x * nx + y * ny) - cx;
    if (Math.abs(d) > e.width) continue;
    const sig = e.width * 0.45;
    const fall = Math.exp(-(d * d) / (2 * sig * sig));
    out.x += nx * e.accel * fall;
    out.y += ny * e.accel * fall;
  }
}

const EV_TMP = { x: 0, y: 0 };

const EV_TMP2 = { x: 0, y: 0 };

/**
 * 极限救援：从 t0 起某个货舱**船体泄漏**，结构强度持续下降，送到对接环即可保住。
 *
 * 为什么不复用潮汐应力（stress）：撕裂机制在第 1~2 章是**关闭**的（教学章不惩罚），
 * 那样救援事件在教学章会形同虚设。这里直接扣 `integrity` 并走统一的 destroyBody 路径，
 * 全章节一致，且 HUD 可以用「剩余秒数」明确预警（玩家要的是"可应对"，不是"看运气"）。
 */
/**
 * 太阳耀斑：预警之后来一发**辐射脉冲**，薄壳货舱（易碎 / 光帆）受重创。
 *
 * 物理依据：辐射压对**迎风面积/质量**敏感，而光帆货舱的 sail 高达 1.9、易碎舱的 hull 只有 0.55。
 * 所以伤害按 `(0.35 + sail) × (hull <= 0.6 ? 1.8 : 0.7)` 计——标准舱几乎无恙，
 * 光帆/易碎舱会被打出可见损伤。这给了关卡一个**编队选择**的维度：带光帆省燃料，但要躲耀斑。
 */
function applyFlare(world: World, dt: number): void {
  const list = world.level.events;
  if (!list || !list.length) return;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.kind !== 'flare') continue;
    const dur = e.duration ?? 1.2;
    const u = world.time - e.t0;
    if (u < 0 || u > dur) continue;
    // 脉冲包络：半正弦，峰值在窗口中央
    const env = Math.sin((u / dur) * Math.PI);
    for (let k = 0; k < world.pods.length; k++) {
      const b = world.pods[k];
      if (!b.alive || b.delivered) continue;
      const sail = b.sail ?? 1;
      const thin = (b.hull ?? 1) <= 0.6 ? 1.8 : 0.7;
      b.integrity -= e.accel * (0.35 + sail) * thin * env * dt;
      if (b.integrity <= 0) destroyBody(world, b, 'impact_hull', '太阳耀斑烧穿船体');
    }
  }
}

/**
 * 引力波掠过：一段短暂的**潮汐四极**踢——沿传播方向拉伸、垂直方向压缩。
 *
 * 这是真实的引力波应变图样（h+ 极化）：位移场 δx = ½h·x、δy = −½h·y（在波坐标系里）。
 * 效果上表现为"货舱被拉长压扁"，对已经贴站的低速货舱影响小、对高速掠过的轨迹影响大——
 * 于是它惩罚"莽"，而不是随机惩罚玩家。
 */
/**
 * 小行星雨：每隔一个周期，从指定方向撒入一批碎石穿场而过。
 *
 * 复用 `spawnShards` 的造体方式（推入 world.bodies），因此**已有的小行星碰撞判定自动生效**：
 * 货舱撞上就按 `dv > V_CRIT*2.2 → 撞击小行星` 损毁，抢在雨前把货舱挪开就行——是可控风险，不是随机灾难。
 * 判定"跨过周期边界"而不是"每帧撒"，避免同一批被重复生成。
 */
/**
 * 多段目标：一次成功对接后推进到下一段，站台随即切换到下一个目标天体。
 *
 * 这就是「多星串联」的机制底座——先送到 A 站，HUD 显示"航段 2/2"，再把后续货舱送去 B 站。
 * 单站关（objectives 缺省）不受影响：objectivesTotal = 1，本函数直接返回。
 */
function advanceObjective(world: World): void {
  const lv = world.level;
  const list = lv.objectives;
  if (!list || list.length <= 1) return;
  if (lv.objectiveIndex >= list.length - 1) return;
  lv.objectiveIndex++;
  const o = list[lv.objectiveIndex];
  const body = world.primaries.find((p) => p.key === o.body) ?? world.primaries[world.primaries.length - 1];
  const off = o.offset ?? { x: 0, y: 0 };
  world.dock.bodyId = body.id;
  world.dock.ox = off.x;
  world.dock.oy = off.y;
  world.dock.x = body.x + off.x;
  world.dock.y = body.y + off.y;
  if (o.radius != null) world.dock.radius = o.radius;
  if (o.v_max != null) world.dock.vMax = o.v_max;
  world.dock.pulse = 1;
  fx(world, 'dock', world.dock.x, world.dock.y, 0, 0, 1.0, 0x8fd0ff, 'dock_success',
    `航段 ${lv.objectiveIndex + 1}/${list.length} · ${o.label_zh ?? '下一个目标'}`);
}

/** 甩摆稳定阻尼系数（1/TU）。刻意很小：只压径向摆动，不改切向速度。 */
const K_SLING_DAMP = 0.05;

/**
 * 甩摆稳定阻尼：**只对已被引力井捕获的货舱**生效，且只阻尼相对井的**径向**速度分量。
 *
 * 为什么只动径向：切向速度决定轨道能量，动它等于白送或白扣玩家的燃料；径向摆动才是
 * "看起来乱飘"的来源。压住它，玩家能预期货舱下一圈怎么走——这正是"只做特定"的辅助。
 * 判据与 HUD 捕获面板同源：μ_eff = M_w·cut(r)，|v_rel| < sqrt(2μ_eff/r) 视为被捕获。
 */
function wellCaptureAssist(world: World, dt: number): void {
  if (!world.fieldEnabled) return;
  const wl = world.well;
  if (!(wl.mass > 0)) return;
  for (let i = 0; i < world.pods.length; i++) {
    const p = world.pods[i];
    if (!p.alive || p.delivered) continue;
    const dx = p.x - wl.x;
    const dy = p.y - wl.y;
    const r = Math.hypot(dx, dy);
    if (!(r > 1e-4) || r > WELL_RANGE * 2.2) continue;
    const cut = 1 / (1 + Math.pow(r / WELL_RANGE, 6));
    const mu = wl.mass * cut;
    const rvx = p.vx - wl.vx;
    const rvy = p.vy - wl.vy;
    const v2 = rvx * rvx + rvy * rvy;
    if (v2 >= (2 * mu) / r) continue;                 // 没被捕获：不干预
    const rad = (rvx * dx + rvy * dy) / r;            // 径向速度分量
    const damp = Math.min(0.5, K_SLING_DAMP * dt);
    p.vx -= rad * damp * (dx / r);
    p.vy -= rad * damp * (dy / r);
  }
}

function applyShower(world: World, dt: number): void {
  const list = world.level.events;
  if (!list || !list.length) return;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.kind !== 'shower') continue;
    if (world.time < e.t0) continue;
    const period = e.period > 0 ? e.period : Number.POSITIVE_INFINITY;
    if (period === Number.POSITIVE_INFINITY) {
      if (world.time - dt < e.t0 && world.time >= e.t0) spawnShower(world, e);
      continue;
    }
    const k = Math.floor((world.time - e.t0) / period);
    const key = e.t0 + k * period;
    if (world.time - dt < key && world.time >= key) spawnShower(world, e);
  }
}

function cullRocks(world: World): void {
  const edge = world.bounds * 1.35;
  const bs = world.bodies;
  let live = 0;
  for (let i = bs.length - 1; i >= 0; i--) {
    const b = bs[i];
    if (!b.key.startsWith('rock')) continue;
    const gone = !b.alive || b.life > 36 || Math.hypot(b.x, b.y) > edge;
    if (gone) { bs.splice(i, 1); continue; }
    live++;
  }
  if (live <= 10) return;
  for (let i = 0; i < bs.length && live > 10; i++) {
    const b = bs[i];
    if (!b.key.startsWith('rock') || !b.alive) continue;
    bs.splice(i, 1);
    i--;
    live--;
  }
}

/** 撒一批碎石：从 dir 反方向的场外飞入，带一定的横向散布 */
function spawnShower(world: World, e: { dir: number; speed: number; width: number; count?: number; rockMass?: number; rockRadius?: number }): void {
  cullRocks(world);
  let live = 0;
  for (let i = 0; i < world.bodies.length; i++) {
    const b = world.bodies[i];
    if (b.alive && b.key.startsWith('rock')) live++;
  }
  const room = 10 - live;
  if (room <= 0) return;
  const n = Math.max(1, Math.min(room, e.count ?? 6));
  const rm = e.rockMass ?? 6e-6;
  const rr = e.rockRadius ?? 0.045;
  const area = Math.PI * rr * rr;
  const nx = Math.cos(e.dir);
  const ny = Math.sin(e.dir);
  const base = 9_000_000 + world.bodies.length * 32;
  const edge = world.bounds * 1.15;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : (i / (n - 1) - 0.5) * 2;      // -1..1
    const ox = -ny * t * e.width;
    const oy = nx * t * e.width;
    const b: Body = {
      id: base + i, key: `rock${base + i}`, kind: 'asteroid', tag: '碎石',
      mass: rm, mu: rm, radius: rr,
      x: -nx * edge + ox, y: -ny * edge + oy,
      vx: nx * e.speed + ox * 0.05, vy: ny * e.speed + oy * 0.05,
      ax: 0, ay: 0, px: -nx * edge + ox, py: -ny * edge + oy,
      alive: true, integrity: 1, area, cd: 0.9, qpr: 1,
      docked: false, delivered: false, lost: false,
      tint: 0x9a8f86, ang: e.dir, spin: (i % 2 ? 1 : -1) * (0.5 + i * 0.07), primary: false,
      contact: 0, jolt: 0, stress: 0, dilation: 1, life: 0, tearT: 0,
      trailX: new Float32Array(12), trailY: new Float32Array(12),
      trailN: 0, trailHead: 0, trailTick: 0,
    };
    world.bodies.push(b);
  }
}

function applyWave(world: World, dt: number): void {
  const list = world.level.events;
  if (!list || !list.length) return;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.kind !== 'wave') continue;
    const dur = e.duration ?? 2.5;
    const u = world.time - e.t0;
    if (u < 0 || u > dur) continue;
    const env = Math.sin((u / dur) * Math.PI);     // 起落各半，避免瞬时跳变
    const nx = Math.cos(e.dir);
    const ny = Math.sin(e.dir);
    for (let k = 0; k < world.pods.length; k++) {
      const b = world.pods[k];
      if (!b.alive || b.delivered) continue;
      const along = b.x * nx + b.y * ny;           // 沿传播方向的投影
      const perpX = b.x - along * nx;
      const perpY = b.y - along * ny;
      if (Math.hypot(b.x, b.y) > world.bounds * 1.2) continue;
      const aAlong = 0.5 * e.accel * env * along;  // 拉伸
      const aPerp = -0.5 * e.accel * env;          // 压缩（垂直于方向）
      b.vx += (aAlong * nx + aPerp * perpX) * dt;
      b.vy += (aAlong * ny + aPerp * perpY) * dt;
    }
  }
}

function applyRescue(world: World, dt: number): void {
  const list = world.level.events;
  if (!list || !list.length) return;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.kind !== 'rescue') continue;
    if (world.time < e.t0) continue;
    const b = world.pods.find((p) => p.alive && !p.delivered);
    if (!b) continue;
    b.integrity -= (e.leakRate ?? 0.02) * dt;
    if (b.integrity <= 0) {
      destroyBody(world, b, 'impact_hull', '船体泄漏解体');
    }
  }
}

function applyEvents(world: World, dt: number): void {
  const list = world.level.events;
  if (!list || !list.length) return;
  if (!world.events || world.events.length !== list.length) {
    world.events = list.map((e) => ({ kind: e.kind, x: 0, y: 0, dir: e.dir, eta: e.t0, active: false }));
  }
  const span = world.bounds * 2.4;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const st = world.events[i];
    const period = e.period > 0 ? e.period : Number.POSITIVE_INFINITY;
    const u = period === Number.POSITIVE_INFINITY ? world.time - e.t0 : (world.time - e.t0) % period;
    const cx = -span * 0.5 + u * e.speed;
    const nx = Math.cos(e.dir);
    const ny = Math.sin(e.dir);
    st.x = nx * cx;
    st.y = ny * cx;
    st.dir = e.dir;
    st.eta = world.time < e.t0 ? e.t0 - world.time : -cx / Math.max(1e-6, e.speed);
    st.active = Math.abs(cx) < e.width * 0.5 + world.bounds * 0.6;
    if (u < 0 || Math.abs(cx) > span * 0.75) continue;
    for (let k = 0; k < world.pods.length; k++) {
      const b = world.pods[k];
      if (!b.alive || b.delivered) continue;
      eventAccelAt(world, world.time, b.x, b.y, EV_TMP);
      b.vx += EV_TMP.x * dt;
      b.vy += EV_TMP.y * dt;
    }
  }
}

function interactions(world: World, dt: number): void {  // 1) 轻体 × 主天体（撞星/越视界/撞行星 = 损毁）
  for (let i = 0; i < PODSH.length; i++) {
    const b = PODSH[i];
    if (!b.alive || b.docked) continue;
    for (let k = 0; k < world.primaries.length; k++) {
      const p = world.primaries[k];
      if (!p.alive) continue;
      if (Math.hypot(b.x - p.x, b.y - p.y) > p.radius + b.radius) continue;
      if (b.kind === 'pod') {
        destroyBody(world, b, 'impact_hull', p.kind === 'star' ? '坠入恒星' : p.kind === 'blackhole' ? '越过视界' : '撞击行星');
      } else {
        b.alive = false;
        fx(world, 'impact', b.x, b.y, b.vx, b.vy, 0.4, b.tint, 'impact_rock');
      }
      break;
    }
  }

  // 2) 货舱/碎片 × 小行星
  for (let i = 0; i < PODSH.length; i++) {
    const b = PODSH[i];
    if (!b.alive || b.docked) continue;
    for (let k = 0; k < AST.length; k++) {
      const a = AST[k];
      if (!a.alive) continue;
      const rr = a.radius + b.radius;
      if (Math.abs(a.x - b.x) > rr || Math.abs(a.y - b.y) > rr) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) > rr) continue;
      const j = impulse(a, b, RESTITUTION);
      if (j <= 0) continue;
      const dv = j / Math.max(b.mass, 1e-9);
      b.jolt = Math.min(1, dv * 3);
      a.jolt = 0.6; a.contact = 0.25;
      if (b.kind === 'pod') {
        if (dv > V_CRIT * 2.2) destroyBody(world, b, 'impact_hull', '撞击小行星');
        else fx(world, 'impact', b.x, b.y, a.x - b.x, a.y - b.y, Math.min(1, dv * 4), b.tint, 'impact_rock');
      } else {
        fx(world, 'impact', b.x, b.y, a.x - b.x, a.y - b.y, 0.4, b.tint, 'impact_rock');
      }
    }
  }

  // 3) 货舱 / 碎片之间（弹性，动量守恒）
  for (let i = 0; i < PODSH.length; i++) {
    const b = PODSH[i];
    if (!b.alive || b.docked) continue;
    for (let j = i + 1; j < PODSH.length; j++) {
      const a = PODSH[j];
      if (!a.alive || a.docked) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) > a.radius + b.radius) continue;
      const imp = impulse(a, b, 0.5);
      if (imp > 0) fx(world, 'impact', (a.x + b.x) * 0.5, (a.y + b.y) * 0.5, 0, 0, 0.3, b.tint, 'impact_rock');
    }
  }

  // 4) 洛希极限撕裂 + 潮汐应力
  //
  //  **按关卡开关**：撕裂是"高级机制"（README 里写的是第 4 章必修），但此前它对所有关卡生效。
  //  后果：第 1~2 章 hazards 为空、玩家根本没被警告过，货舱被拉到 0.56 RU 内就**即死**——
  //  实测自动驾驶在教学关 L1-1 的 t=9.33 就是这样把货舱弄碎的（r=0.22）。
  //  现在只在关卡显式声明隐患（{kind:'tidal'}）或第 3 章及以后才启用；
  //  第 1~2 章仍保留"潮汐应力"读数与警告（stress 照常计算），只是不会撕裂。
  const tearOn = world.level.chapter >= 3
    || world.hazards.some((h) => h.kind === 'tidal');
  for (let i = 0; i < PODSH.length; i++) {
    const b = PODSH[i];
    if (!b.alive || b.docked || b.kind !== 'pod') continue;
    let stress = 0;
    let breaking = 0;
    let breaker: Body | null = null;
    for (let k = 0; k < world.primaries.length; k++) {
      const p = world.primaries[k];
      if (!p.alive || p.radius <= 0) continue;
      const d = Math.hypot(b.x - p.x, b.y - p.y);
      if (d > 1.35) continue;
      const key = p.id * 1000 + Math.round((sphereDensity(b.mass, b.radius) || 2.6) * 100);
      let limit = rocheCache.get(key);
      if (limit === undefined || !Number.isFinite(limit)) {
        limit = rocheLimit(p.radius, sphereDensity(p.mass, p.radius), sphereDensity(b.mass, b.radius) || 2.6);
        rocheCache.set(key, limit);
      }
      const s = tidalGradient(p.mu, d, b.radius) / TIDAL_REF;
      if (s > stress) stress = s;
      if (d < limit) {
        if (s > breaking) { breaking = s; breaker = p; }
      }
    }
    if (!tearOn) { breaking = 0; breaker = null; }
    // 结构解体需要高应力**持续作用**一段时间（真实的应力-强度判据），
    // 而不是瞬时归零：这让 HUD 的"⚠ 已进入撕裂区"警告成为可反应的信息，
    // 玩家有机会把货舱拉出来，而不是一进危险区就必死。
    if (breaking > 0 && breaker) {
      b.tearT += dt;
      if (b.tearT >= TEAR_GRACE) { tearBody(world, b, breaker.x, breaker.y); }
    } else {
      b.tearT = Math.max(0, b.tearT - dt * 2);
    }
    if (b.alive) {
      b.stress = Math.min(3, stress);
      if (b.stress > STRESS_TEAR && b.tearT >= TEAR_GRACE) {
        const p = world.primaries[0];
        tearBody(world, b, p ? p.x : 0, p ? p.y : 0);
      }
    }
  }

  // 5) 逃逸出作用范围
  for (let i = 0; i < world.pods.length; i++) {
    const b = world.pods[i];
    if (!b.alive || b.delivered) continue;
    if (Math.hypot(b.x, b.y) > world.bounds * 1.15) destroyBody(world, b, 'dock_fail', '脱离作用范围');
  }

  // 6) 对接：软对接（满分）与硬对接（宽容但扣分），真实速度门限
  const station = world.primaries.find((p) => p.id === world.dock.bodyId);
  if (station) {
    world.dock.x = station.x + world.dock.ox;
    world.dock.y = station.y + world.dock.oy;
    if (world.dock.pulse > 0) world.dock.pulse = Math.max(0, world.dock.pulse - dt * 1.6);
    const hard = world.dock.vMax * 2.6;
    // 泊位包络：软对接（满分）要求在环内且速度达标；硬对接允许 1.8 倍半径内以损伤为代价捕获，
    // 对应真实工程的"软捕获 / 硬捕获"两种对接模式。
    const softR = world.dock.radius;
    const hardR = world.dock.radius * 1.8;
    for (let i = 0; i < world.pods.length; i++) {
      const p = world.pods[i];
      if (!p.alive || p.delivered) continue;
      const d = Math.hypot(p.x - world.dock.x, p.y - world.dock.y);
      if (d > hardR) continue;
      const rv = Math.hypot(p.vx - station.vx, p.vy - station.vy);
      if (rv <= hard) {
        const soft = rv <= world.dock.vMax && d <= softR;
        p.docked = true; p.delivered = true;
        p.vx = station.vx; p.vy = station.vy;
        p.integrity = soft ? 1 : 0.55;
        world.level.podsDelivered++;
        advanceObjective(world);   // 多段目标：推进航段
        if (soft) {
          world.level.combo++;
          world.level.comboTimer = 8;
        } else {
          world.level.combo = 0;
        }
        world.dock.pulse = 1;
        fx(world, 'dock', p.x, p.y, 0, 0, soft ? 1 : 0.6, p.tint, 'dock_success',
          soft ? `软对接 ×${world.level.combo}` : '硬对接（速度超限，货舱受损）');
      } else {
        // 速度过高 → 撞环弹开并受损
        const dx = p.x - world.dock.x, dy = p.y - world.dock.y;
        const r = Math.max(1e-6, Math.hypot(dx, dy));
        const nx = dx / r, ny = dy / r;
        const vn = (p.vx - station.vx) * nx + (p.vy - station.vy) * ny;
        if (vn < 0) {
          p.vx -= 1.7 * vn * nx; p.vy -= 1.7 * vn * ny;
          p.jolt = 1;
          fx(world, 'impact', p.x, p.y, -nx, -ny, 0.8, p.tint, 'impact_hull', '对接速度超限');
        }
      }
    }
    for (let i = 0; i < world.pods.length; i++) {
      const p = world.pods[i];
      if (!p.delivered) continue;
      const a = world.time * 0.35 + (i / Math.max(1, world.pods.length)) * Math.PI * 2;
      p.x = world.dock.x + Math.cos(a) * 0.05;
      p.y = world.dock.y + Math.sin(a) * 0.05;
      p.vx = station.vx; p.vy = station.vy;
      p.px = p.x; p.py = p.y;
    }
  }

  // 7) 碎片寿命与清理（标记死亡，数组在 frameEnd 里压缩）
  for (let i = 0; i < world.shards.length; i++) {
    const s = world.shards[i];
    if (s.alive && s.life > 34) s.alive = false;
  }
}

function updateTrails(world: World, dt: number): void {
  const bs = world.bodies;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (b.trailX.length === 0 || !b.alive) continue;
    b.trailTick += dt;
    if (b.trailTick < TRAIL_DT) continue;
    b.trailTick = 0;
    b.trailX[b.trailHead] = b.x;
    b.trailY[b.trailHead] = b.y;
    b.trailHead = (b.trailHead + 1) % b.trailX.length;
    if (b.trailN < b.trailX.length) b.trailN++;
  }
}

function updateStats(world: World): void {
  const s = world.stats;
  const pure = conservedQuantities(world.primaries, [], world.epsilon);
  const full = conservedQuantities(world.primaries, LIGHT, world.epsilon);
  s.ke = full.ke; s.pe = full.pe; s.energy = full.energy;
  s.angularMomentum = full.angular;
  s.momentumX = full.px; s.momentumY = full.py;
  if (s.energy0 === 0) { s.energy0 = pure.energy; s.angular0 = pure.angular; }
  const t = Math.max(world.time, 0.5);
  s.energyDrift = s.energy0 !== 0 ? Math.abs(pure.energy - s.energy0) / (Math.abs(s.energy0) * t) : 0;
  s.angularDrift = s.angular0 !== 0 ? Math.abs(pure.angular - s.angular0) / (Math.abs(s.angular0) * t) : 0;
  s.time = world.time;
  s.lastStats = world.time;
}

/** 近距交会时二分步长（近星点与近站交会不炸） */
function needsSplit(world: World, dt: number): boolean {
  const w = world.well;
  for (let i = 0; i < world.primaries.length; i++) {
    const p = world.primaries[i];
    const d = Math.hypot(w.x - p.x, w.y - p.y);
    if (d < Math.max(0.08, p.radius * 4)) return true;
    if (Math.hypot(w.vx, w.vy) * dt > 0.35 * Math.max(d, 1e-3)) return true;
  }
  for (let i = 0; i < world.pods.length; i++) {
    const b = world.pods[i];
    if (!b.alive || b.docked) continue;
    for (let k = 0; k < world.primaries.length; k++) {
      const p = world.primaries[k];
      const d = Math.hypot(b.x - p.x, b.y - p.y);
      if (d < Math.max(0.05, p.radius * 3)) return true;
      if (Math.hypot(b.vx, b.vy) * dt > 0.3 * Math.max(d, 1e-3)) return true;
    }
  }
  return false;
}

/** 单个物理步（含自适应子步与交互判定） */
export function stepOnce(world: World, dt: number, depth = 0): void {
  collect(world);
  const wind = windEnvelope(world);

  primaryAccels(world);
  for (let i = 0; i < LIGHT.length; i++) lightAccel(world, LIGHT[i], wind);
  wellAccels(world, wind);

  if (depth < MAX_ADAPT_DEPTH && needsSplit(world, dt)) {
    stepOnce(world, dt * 0.5, depth + 1);
    stepOnce(world, dt * 0.5, depth + 1);
    world.stats.substeps++;
    return;
  }

  recordPrev(world);
  kick(world, dt * 0.5);
  drift(world, dt);
  wellConstraint(world);
  primaryAccels(world);
  for (let i = 0; i < LIGHT.length; i++) lightAccel(world, LIGHT[i], wind);
  wellAccels(world, wind);
  kick(world, dt * 0.5);

  world.time += dt;
  world.stats.steps++;
  interactions(world, dt);
  applyEvents(world, dt);
  applyRescue(world, dt);
  applyFlare(world, dt);
  applyWave(world, dt);
  applyShower(world, dt);
  wellCaptureAssist(world, dt);
  updateTrails(world, dt);
}

/** 帧级收尾：算力 / 燃料 Δv 记账 / 星风预警 / 守恒量 / 胜负判定 */
export function frameEnd(world: World, simDt: number): void {
  const dtReal = simDt * TIME_SCALE;
  const w = world.well;

  // 目标点速度前馈：由目标点位移估计速度（EMA 平滑，避免鼠标抖动放大）。
  // ⚠️ 单位必须是 RU/TU（模拟时间单位），与 well.vx 一致；用实时秒会差 TIME_SCALE 倍，
  //    前馈只有应有的 62%，飞船会持续落后于目标（实测跟踪误差达 0.5 RU）。
  if (simDt > 1e-9) {
    const ivx = (w.tx - w.ltx) / simDt;
    const ivy = (w.ty - w.lty) / simDt;
    const k = Math.min(1, dtReal * 14);
    w.tvx += (ivx - w.tvx) * k;
    w.tvy += (ivy - w.tvy) * k;
    w.ltx = w.tx; w.lty = w.ty;
  }

  const load = w.engaged ? w.mass / WELL_MASS_MAX : 0;
  const slow = world.slowmo < 0.99 ? 1 : 0;
  const drain = load * COMPUTE_DRAIN_FIELD + slow * COMPUTE_DRAIN_SLOWMO;
  world.compute = Math.max(0, Math.min(world.computeMax, world.compute + (COMPUTE_REGEN - drain) * dtReal));
  if (world.compute <= 1e-6) world.fieldEnabled = false;
  else if (!world.fieldEnabled && world.compute >= COMPUTE_HYSTERESIS * world.computeMax) world.fieldEnabled = true;

  // 火箭方程记账：消耗 Δv = ∫|a_thrust| dt（飞船质量不变时 Δv 与推进剂质量分数一一对应）
  if (w.engaged && w.thrust > 0) {
    world.fuel = Math.max(0, world.fuel - (w.thrust * dtReal) / TIME_SCALE);
    world.level.fuelUsed = world.fuelCapacity - world.fuel;
  }
  w.intensity = w.engaged && world.fieldEnabled ? Math.min(1, 0.35 + (w.mass / WELL_MASS_MAX) * 0.85) : 0;
  w.polarity = w.repel ? -1 : 1;
  world.level.elapsed = world.time;
  if (world.level.comboTimer > 0) {
    world.level.comboTimer -= dtReal;
    if (world.level.comboTimer <= 0) world.level.combo = 0;
  }

  const env = windEnvelope(world);
  if (env > 0.02 && world.windActive <= 0.02) {
    const star = mainStar(world);
    if (star) fx(world, 'wind', star.x, star.y, 0, 0, env * 4, 5, 'wind_warning', '星风爆发');
  }
  world.windActive = env;

  if (world.stats.lastStats < 0 || world.time - world.stats.lastStats > 0.1) updateStats(world);

  // 压缩已销毁的碎片（避免数组无限增长）
  if (world.bodies.length > 160) {
    let dead = 0;
    for (let i = 0; i < world.bodies.length; i++) if (!world.bodies[i].alive) dead++;
    if (dead > 24) {
      world.bodies = world.bodies.filter((b) => b.alive || b.primary);
      world.shards = world.shards.filter((b) => b.alive);
    }
  }

  if (world.status !== 'running') { world.statusTimer += dtReal; return; }

  const req = requiredPods(world);
  if (world.level.podsDelivered >= req) {
    world.status = 'won'; world.statusTimer = 0;
    fx(world, 'win', world.dock.x, world.dock.y, 0, 0, 1, 2, 'chapter_fanfare', '任务完成');
  } else if (world.level.podsDelivered + inPlay(world) < req) {
    world.status = 'lost'; world.statusTimer = 0;
    fx(world, 'fail', 0, 0, 0, 0, 1, 4, 'dock_fail', '任务失败：可送达货舱不足');
  } else if (world.time > world.level.timeLimit) {
    world.status = 'lost'; world.statusTimer = 0;
    fx(world, 'fail', 0, 0, 0, 0, 1, 4, 'dock_fail', '任务失败：超出任务时限');
  }
}

/** 便捷推进（自带头部累加器；引擎主循环用 stepOnce+frameEnd 自行管理相位） */
export function advance(world: World, dtTU: number, maxSteps = 8): number {
  let steps = 0;
  let acc = dtTU;
  while (acc >= DT - 1e-12 && steps < maxSteps) {
    stepOnce(world, DT);
    acc -= DT;
    steps++;
  }
  if (steps > 0) frameEnd(world, steps * DT);
  else if (dtTU > 0) frameEnd(world, 0);
  return steps;
}
