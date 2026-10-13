// tools/eventtest.ts
import { readFileSync } from "node:fs";

// src/sim/types.ts
var POD_CLASSES = {
  /**
   * 标准舱：基准参数，逐位等于改造前的关卡数据。
   * 打法：没有短板也没有借力——拉得动、撞得起、光压可以忽略（2%）。
   */
  standard: {
    id: "standard",
    nameZh: "\u6807\u51C6\u8231",
    nameEn: "STANDARD",
    mass: 2e-5,
    radius: 0.012,
    hull: 1,
    sail: 0.7,
    color: "#9fb3c8",
    note: "\u6807\u51C6\u8231\uFF1A\u57FA\u51C6\u578B\uFF08\u5149\u538B 2% \u6052\u661F\u5F15\u529B\uFF09\u3002\u5404\u9879\u53C2\u6570\u5C45\u4E2D\uFF0C\u62C9\u5F97\u52A8\u4E5F\u649E\u5F97\u8D77\uFF0C\u4E0D\u9700\u8981\u4E3A\u5B83\u6539\u6253\u6CD5\u3002"
  },
  /**
   * 重舱：**只把质量 ×3**（2e-05 → 6e-05）。
   * 为什么这样改会改变打法：所有 1/m 项一起变成 1/3——
   *   · 光压 2.0% → 0.67%、星云阻力 ÷3：失去光压/星云这两个"免费减速"工具，过星云时几乎不掉速；
   *   · 碰撞 Δv = j/m ÷3：撞碎石、硬对接都几乎不掉血，可以直线硬闯碎石带；
   *   · 洛希极限 ∝ ρ^(−1/3) ×0.69（撕裂半径 0.557 → 0.386 RU）：可以贴到行星更近处不被撕开。
   *   · 代价：同样速度下它的动量是 3 倍，撞到别的天体会把对方甩开（难以做"轻碰微调"）。
   */
  heavy: {
    id: "heavy",
    nameZh: "\u91CD\u8231",
    nameEn: "HEAVY",
    mass: 6e-5,
    radius: 0.012,
    hull: 1,
    sail: 0.7,
    color: "#ffb347",
    note: "\u91CD\u8231\uFF1A\u8D28\u91CF \xD73 \u2014\u2014 \u5149\u538B/\u661F\u4E91\u51CF\u901F/\u649E\u51FB\u540E\u679C\u90FD\u53EA\u5269 1/3\uFF08\u53EF\u786C\u95EF\u788E\u77F3\u5E26\u3001\u53EF\u8D34\u884C\u661F\u8FC7\u6D1B\u5E0C\u6781\u9650\uFF09\uFF0C\u4F46\u522B\u6307\u671B\u5149\u538B\u548C\u661F\u4E91\u5E2E\u4F60\u5239\u8F66\u3002"
  },
  /**
   * 易碎舱：壳薄密度低——质量 ×0.4（8e-06）、半径 ×0.85（0.0102）、hull 0.55、帆小 0.55。
   * 为什么这样改会改变打法：**密度才是潮汐判据**（洛希极限 ∝ ρ^(−1/3)）。
   *   · ρ = 1.80（标准舱 2.76）→ 撕裂半径 0.557 → 0.643 RU，危险区外扩 15%：进恒星/行星附近的
   *     安全走廊被压窄，必须把井收小了提前减速、更柔和地接近；
   *   · 碰撞 Δv = j/m ×2.5：硬碰碎石 40% 的撞击量就会解体（重舱要 3 倍才碎）；
   *   · 半径 ×0.85 → 潮汐梯度 ∝ Δr 略降 15%、截面略小，属于"壳小但脆"的补偿，不足以对冲上面两条。
   *   · 注意：把它做成"半径 ×0.8、质量不变"会**反向**变结实（密度 ↑ → 洛希极限更近、潮汐梯度更小），
   *     所以这里用小质量 + 略小半径，让"脆"来自低密度而不是外形。
   */
  fragile: {
    id: "fragile",
    nameZh: "\u6613\u788E\u8231",
    nameEn: "FRAGILE",
    mass: 8e-6,
    radius: 0.0102,
    hull: 0.55,
    sail: 0.55,
    color: "#ff4d5e",
    note: "\u6613\u788E\u8231\uFF1A\u4F4E\u5BC6\u5EA6\u58F3\u8584\uFF08hull 0.55\uFF09\u2014\u2014 \u6495\u88C2\u534A\u5F84\u5916\u6269 15%\uFF080.643 RU\uFF09\uFF0C\u649E\u51FB\u89E3\u4F53\u95E8\u69DB\u964D\u5230 40%\uFF0C\u63A5\u8FD1\u5FC5\u987B\u66F4\u67D4\u548C\u3002"
  },
  /**
   * 大帆舱：帆大而壳轻——sail 1.9（×2.71）、质量 ×0.6（1.2e-05）、hull 0.9。
   * 为什么这样改会改变打法：光压 a_rad = K_RAD·sail·A/(r²·m) 同时吃到 sail ↑ 与 m ↓，
   *   · r=1 处光压 2.0% → 9.05% 恒星引力（4.5 倍）：径向向外的"半悬停"推力，可以借它抬轨道、
   *     省 Δv；但贴恒星时它会把货舱往外推、把精心算好的霍曼转移点顶偏（也能坏事）；
   *   · 洛希极限 ×1.19（撕裂半径 0.660 RU）：帆大壳轻 = 密度低，绕行星时同样更容易被撕开；
   *   · 碰撞 Δv ×1.67：比赛用纸壳，别拿它去撞碎石。
   */
  sailer: {
    id: "sailer",
    nameZh: "\u5927\u5E06\u8231",
    nameEn: "SAILER",
    mass: 12e-6,
    radius: 0.012,
    hull: 0.9,
    sail: 1.9,
    color: "#c9a6ff",
    note: "\u5927\u5E06\u8231\uFF1A\u5149\u5E06\u7CFB\u6570 1.9\u3001\u8D28\u91CF \xD70.6 \u2014\u2014 \u5149\u538B\u662F\u6807\u51C6\u8231\u7684 4.5 \u500D\uFF08r=1 \u5904\u2248\u6052\u661F\u5F15\u529B\u7684 9%\uFF09\uFF0C\u53EF\u9760\u5B83\u7701 \u0394v\uFF0C\u4E5F\u4F1A\u88AB\u5B83\u63A8\u51FA\u8F68\u9053\u3002"
  }
};
var DEFAULT_POD_CLASS = "standard";
function podClass(id) {
  if (id) {
    const hit = POD_CLASSES[id];
    if (hit) return hit;
  }
  return POD_CLASSES[DEFAULT_POD_CLASS];
}
function resolvePodSpec(spec2) {
  const cls = podClass(spec2.class);
  if (cls.id === DEFAULT_POD_CLASS) {
    return { cls, mass: spec2.mass, radius: spec2.radius, hull: spec2.hull ?? 1, sail: spec2.sail ?? 1 };
  }
  return { cls, mass: cls.mass, radius: cls.radius, hull: cls.hull, sail: cls.sail };
}

// src/engine/rng.ts
var Rng = class {
  s;
  constructor(seed) {
    this.s = seed >>> 0 || 2654435769;
  }
  next() {
    this.s = this.s + 1831565813 >>> 0;
    let t = this.s;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  range(a, b) {
    return a + (b - a) * this.next();
  }
  int(a, b) {
    return Math.floor(this.range(a, b + 1));
  }
  pick(arr) {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))];
  }
  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }
};

// src/sim/constants.ts
var TIME_SCALE = 1.6;
var SKILLED_TIME_FACTOR = 2.5;
var PHYS_HZ = 120;
var DT = 1 / (PHYS_HZ * TIME_SCALE);
var SHIP_MASS = 6e-5;
var OMEGA = 2 * Math.PI / 0.5;
var ZETA = 0.85;
var ZETA_PRECISE = 1;
var K_SPRING = SHIP_MASS * OMEGA * OMEGA;
var C_DAMP = 2 * ZETA * Math.sqrt(K_SPRING * SHIP_MASS);
var C_DAMP_PRECISE = 2 * ZETA_PRECISE * Math.sqrt(K_SPRING * SHIP_MASS);
var AREA_K = Math.PI;
var TRAIL_LEN = 180;
function sphereDensity(mass, radius) {
  return mass / (4 / 3 * Math.PI * Math.pow(Math.max(radius, 1e-6), 3));
}
function timeDilation(r, rs) {
  const x = rs / Math.max(r, rs * 1.0001);
  return 1 / Math.sqrt(Math.max(1e-6, 1 - x));
}

// src/sim/physics.ts
function solveKepler(M, e) {
  let m = M % (2 * Math.PI);
  if (m < 0) m += 2 * Math.PI;
  let E = e < 0.8 ? m : Math.PI;
  for (let i = 0; i < 12; i++) {
    const f = E - e * Math.sin(E) - m;
    const fp = 1 - e * Math.cos(E);
    const d = f / fp;
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}
function elementsToState(a, e, omega, M0, mu) {
  const retro = a < 0;
  const A = Math.abs(a);
  const E = solveKepler(M0, e);
  const cosE = Math.cos(E), sinE = Math.sin(E);
  const denom = 1 - e * cosE;
  const r = A * denom;
  const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  const xp = r * Math.cos(nu), yp = r * Math.sin(nu);
  const sq = Math.sqrt(mu / A);
  const vxp = -sq * sinE / denom;
  const vyp = sq * Math.sqrt(Math.max(0, 1 - e * e)) * cosE / denom;
  const cw = Math.cos(omega), sw = Math.sin(omega);
  const s = retro ? -1 : 1;
  return {
    x: xp * cw - yp * sw,
    y: xp * sw + yp * cw,
    vx: s * (vxp * cw - vyp * sw),
    vy: s * (vxp * sw + vyp * cw)
  };
}
function areaOf(radius) {
  return AREA_K * radius * radius;
}

// src/sim/world.ts
var TRAIL_KINDS = ["pod", "shard"];
function makeBody(id, key, kind, mass, radius, x, y, vx, vy, tint, primary) {
  const trailN = TRAIL_KINDS.includes(kind) ? TRAIL_LEN : 0;
  return {
    id,
    key,
    kind,
    tag: "",
    mass,
    mu: mass,
    radius,
    x,
    y,
    vx,
    vy,
    ax: 0,
    ay: 0,
    px: x,
    py: y,
    alive: true,
    integrity: 1,
    area: areaOf(radius),
    cd: kind === "asteroid" ? 1.1 : kind === "shard" ? 0.9 : 0.7,
    qpr: 1,
    // 光帆系数缺省 1：主天体/小行星/碎片沿用改造前的光压（货舱在下面按级别覆盖）
    sail: 1,
    hull: 1,
    docked: false,
    delivered: false,
    lost: false,
    tint,
    ang: 0,
    spin: 0,
    primary,
    contact: 0,
    jolt: 0,
    stress: 0,
    dilation: 1,
    life: 0,
    tearT: 0,
    trailX: trailN ? new Float32Array(trailN) : new Float32Array(0),
    trailY: trailN ? new Float32Array(trailN) : new Float32Array(0),
    trailN: 0,
    trailHead: 0,
    trailTick: 0
  };
}
function kindProps(kind) {
  switch (kind) {
    case "star":
      return { spin: 0.05, cd: 0 };
    case "blackhole":
      return { spin: 0.02, cd: 0 };
    case "planet":
      return { spin: 0.12, cd: 0 };
    case "station":
      return { spin: 0.35, cd: 0 };
    default:
      return { spin: 0.5, cd: 1.1 };
  }
}
function createWorld(level, doc2, attempt = 1) {
  const consts = doc2.constants;
  const muStar = level.mu_star || consts.mu_star || 1;
  const rng = new Rng(24301 ^ level.index * 2654435761);
  const bodies = [];
  const primaries = [];
  const pods = [];
  const shards = [];
  let id = 1;
  const byKey = /* @__PURE__ */ new Map();
  const placeOrbit = (orbit) => {
    if (!orbit) return { x: 0, y: 0, vx: 0, vy: 0 };
    const parent = orbit.parent ? byKey.get(orbit.parent) : void 0;
    const mu = parent ? parent.mu : muStar;
    const st = elementsToState(orbit.a, orbit.e, orbit.omega, orbit.M0, mu);
    if (!parent) return { x: st.x, y: st.y, vx: st.vx, vy: st.vy };
    return { x: parent.x + st.x, y: parent.y + st.y, vx: parent.vx + st.vx, vy: parent.vy + st.vy };
  };
  const addPrimary = (key, kind, mass, radius, tint, orbit, rs2) => {
    const { x, y, vx, vy } = placeOrbit(orbit);
    const b = makeBody(id++, key, kind, mass, radius, x, y, vx, vy, tint, true);
    const kp = kindProps(kind);
    b.spin = kp.spin;
    b.cd = kp.cd;
    b.tag = key;
    bodies.push(b);
    primaries.push(b);
    byKey.set(key, b);
    return b;
  };
  {
    const pending = level.bodies.slice();
    for (let pass2 = 0; pass2 < 4 && pending.length > 0; pass2++) {
      let placedAny = false;
      for (let i = pending.length - 1; i >= 0; i--) {
        const spec2 = pending[i];
        const par = spec2.orbit?.parent;
        if (par && !byKey.has(par)) continue;
        addPrimary(spec2.id, spec2.kind, spec2.mass, spec2.radius, spec2.tint, spec2.orbit, spec2.rs);
        pending.splice(i, 1);
        placedAny = true;
      }
      if (!placedAny) break;
    }
    for (const spec2 of pending) {
      addPrimary(spec2.id, spec2.kind, spec2.mass, spec2.radius, spec2.tint, spec2.orbit && { ...spec2.orbit, parent: void 0 }, spec2.rs);
    }
  }
  if (!primaries.some((b) => b.kind === "star" || b.kind === "blackhole")) {
    addPrimary("core", "star", 1, 0.16, 0, null);
  }
  for (const spec2 of level.pods) {
    let x = 0, y = 0, vx = 0, vy = 0;
    if (spec2.orbit) {
      const p = placeOrbit(spec2.orbit);
      x = p.x;
      y = p.y;
      vx = p.vx;
      vy = p.vy;
    } else {
      const a = rng.range(1.2, 2.2), ang = rng.range(0, Math.PI * 2);
      x = Math.cos(ang) * a;
      y = Math.sin(ang) * a;
      const v = Math.sqrt(muStar / a);
      vx = -Math.sin(ang) * v;
      vy = Math.cos(ang) * v;
    }
    const pc = resolvePodSpec(spec2);
    const b = makeBody(id++, spec2.id, "pod", pc.mass, pc.radius, x, y, vx, vy, 4, false);
    b.tag = spec2.id;
    b.class = pc.cls.id;
    b.sail = pc.sail;
    b.hull = pc.hull;
    b.integrity = pc.hull;
    b.cd = 0.7;
    bodies.push(b);
    pods.push(b);
    byKey.set(spec2.id, b);
  }
  const designed = level.bodies.filter((b) => b.kind === "asteroid");
  for (const spec2 of designed) {
    for (let i = 0; i < Math.max(1, Math.round(spec2.mass > 0 ? 1 : 1)); i++) {
      const a = spec2.orbit ? spec2.orbit.a * (1 + (i - 0.5) * 2e-3) : 2;
      const st = elementsToState(a, spec2.orbit?.e ?? 0.05, spec2.orbit?.omega ?? 0, (spec2.orbit?.M0 ?? 0) + i * 0.01, muStar);
      const b = makeBody(id++, `${spec2.id}_${i}`, "asteroid", spec2.mass, spec2.radius, st.x, st.y, st.vx, st.vy, 4, false);
      const kp = kindProps("asteroid");
      b.cd = kp.cd;
      b.spin = rng.range(0.2, 1.4) * rng.sign();
      bodies.push(b);
      byKey.set(b.key, b);
    }
  }
  if (level.chapter >= 2 && bodies.filter((b) => b.kind === "asteroid").length < 24) {
    const stationR = Math.hypot(byKey.get(level.dock.body)?.x ?? 1.6, byKey.get(level.dock.body)?.y ?? 0);
    const count = level.chapter >= 3 ? 96 : 72;
    for (let i = 0; i < count; i++) {
      let a = rng.range(1.35, 2.9);
      if (Math.abs(a - stationR) < 0.22) a += 0.3 * Math.sign(a - stationR || 1);
      const e = Math.abs(rng.range(0, 0.14));
      const omega = rng.range(0, Math.PI * 2);
      const M0 = rng.range(0, Math.PI * 2);
      const st = elementsToState(a, e, omega, M0, muStar);
      const radius = 35e-4 + Math.pow(rng.next(), 2.2) * 95e-4;
      const mass = sphereDensity(2.6, radius) * (4 / 3) * Math.PI * radius ** 3;
      const b = makeBody(id++, `rock${i}`, "asteroid", mass, radius, st.x, st.y, st.vx, st.vy, 4, false);
      b.spin = rng.range(0.2, 1.6) * rng.sign();
      bodies.push(b);
      byKey.set(b.key, b);
    }
  }
  const dockTarget = level.objectives && level.objectives.length ? level.objectives[0] : null;
  const dockBody = (dockTarget ? byKey.get(dockTarget.body) : null) ?? byKey.get(level.dock.body) ?? primaries[primaries.length - 1];
  const off = dockTarget?.offset ?? level.dock.offset ?? { x: 0, y: 0 };
  const dock = {
    bodyId: dockBody.id,
    x: dockBody.x + off.x,
    y: dockBody.y + off.y,
    ox: off.x,
    oy: off.y,
    radius: dockTarget?.radius ?? level.dock.radius,
    vMax: dockTarget?.v_max ?? level.dock.v_max,
    pulse: 0
  };
  const nebulae = (level.nebulae ?? []).map((n) => ({ ...n }));
  const budget = missionBudget(level);
  const fuelCapacity = budget.fuel;
  const eventState = (level.events ?? []).map((e) => ({
    kind: e.kind,
    x: 0,
    y: 0,
    dir: e.dir,
    eta: e.t0,
    active: false
  }));
  const required = Math.max(1, Math.round(level.pods.length * (level.difficulty <= 2 ? 1 : 0.6)));
  const levelRt = {
    id: level.id,
    index: level.index,
    chapter: level.chapter,
    nameZh: level.name_zh,
    nameEn: level.name_en,
    difficulty: level.difficulty,
    parTime: level.par_time,
    parFuel: level.par_fuel,
    hintZh: level.hint_zh,
    hintEn: level.hint_en,
    palette: level.palette ?? `loop${level.chapter}`,
    music: `loop${Math.min(4, Math.max(1, level.chapter))}`,
    podsTotal: level.pods.length,
    podsDelivered: 0,
    podsLost: 0,
    elapsed: 0,
    fuelUsed: 0,
    fuelCapacity,
    attempts: attempt,
    fidelityGrade: "\u2014",
    fidelityFactor: 0.7,
    fidelityNote: "\u7B49\u5F85\u98DE\u884C\u7ED3\u675F\u540E\u7684\u5B88\u6052\u91CF\u5BA1\u8BA1",
    solution: {
      method: level.solution?.method ?? "hohmann",
      dvMin: level.solution?.dv_min ?? 0,
      notes: level.solution?.notes ?? ""
    },
    bounds: level.bounds,
    // 定时事件（宇宙风暴等）：必须抄进运行时 level，否则 applyEvents 读到 undefined（曾经漏抄导致"数据到了前端但事件静默失效"）
    events: level.events,
    // 多段目标：同样必须显式拷入（运行时 level 是逐字段手抄的）
    objectives: level.objectives,
    objectiveIndex: 0,
    objectivesTotal: Math.max(1, level.objectives?.length ?? 1),
    // 时限与 world.time 同一单位。第 1 章教学关在 missionBudget 里给到至少 180。
    // 时限不参与计分——时间分用的是 parTime（见 score.ts）。
    timeLimit: budget.timeLimit,
    combo: 0,
    comboTimer: 0
  };
  const bh = primaries.find((b) => b.kind === "blackhole");
  const rs = bh ? level.bodies.find((s) => s.kind === "blackhole")?.rs ?? 0.03 : 0;
  if (bh) {
    for (const b of pods) b.dilation = timeDilation(Math.hypot(b.x - bh.x, b.y - bh.y), rs);
  }
  const world2 = {
    time: 0,
    frame: 0,
    G: consts.G ?? 1,
    epsilon: consts.epsilon ?? 0.02,
    bounds: level.bounds,
    bodies,
    primaries,
    pods,
    shards,
    well: {
      engaged: false,
      repel: false,
      precise: false,
      mass: 8e-3,
      targetMass: 8e-3,
      k: 0,
      c: 0,
      x: dockBody.x + 0.6,
      y: dockBody.y + 0.6,
      vx: 0,
      vy: 0,
      px: 0,
      py: 0,
      tx: 0,
      ty: 0,
      ltx: 0,
      lty: 0,
      tvx: 0,
      tvy: 0,
      thrust: 0,
      intensity: 0,
      polarity: 1,
      hot: 0
    },
    level: levelRt,
    dock,
    nebulae,
    hazards: level.hazards ?? [],
    windTimer: 0,
    windActive: 0,
    status: "running",
    statusTimer: 0,
    fieldEnabled: true,
    fuel: fuelCapacity,
    fuelCapacity,
    compute: 1,
    computeMax: 1,
    timeScale: 1,
    slowmo: 1,
    events: eventState,
    fx: [],
    predicted: [],
    stats: {
      steps: 0,
      substeps: 0,
      ke: 0,
      pe: 0,
      energy: 0,
      angularMomentum: 0,
      momentumX: 0,
      momentumY: 0,
      energy0: 0,
      angular0: 0,
      time: 0,
      energyDrift: 0,
      angularDrift: 0,
      lastStepMs: 0,
      lastStats: -1
    },
    counters: {}
  };
  world2.well.px = world2.well.x;
  world2.well.py = world2.well.y;
  {
    const r0 = Math.hypot(world2.well.x, world2.well.y);
    if (r0 > 1e-6) {
      const ang = Math.atan2(world2.well.y, world2.well.x) + 0.12;
      world2.well.x = Math.cos(ang) * r0;
      world2.well.y = Math.sin(ang) * r0;
      const vc = Math.sqrt(muStar / r0);
      const sense = dockBody.x * dockBody.vy - dockBody.y * dockBody.vx >= 0 ? 1 : -1;
      world2.well.vx = -Math.sin(ang) * vc * sense;
      world2.well.vy = Math.cos(ang) * vc * sense;
      world2.well.px = world2.well.x;
      world2.well.py = world2.well.y;
    }
  }
  world2.well.tx = world2.well.x;
  world2.well.ty = world2.well.y;
  world2.well.ltx = world2.well.x;
  world2.well.lty = world2.well.y;
  world2.requiredPods = required;
  return world2;
}
function missionBudget(level) {
  const nominalFuel = 40 + 6 * level.difficulty;
  const margin = Number(level.margin);
  const limit = Number.isFinite(margin) && margin > 0 && margin < 1;
  if (limit) {
    const skilled = Math.max(level.par_time * SKILLED_TIME_FACTOR, 12);
    return {
      fuel: nominalFuel * (1 + margin),
      timeLimit: skilled * (1 + margin),
      margin,
      nominalFuel
    };
  }
  const fuelScale = Number(level.fuel_scale ?? 1) || 1;
  return {
    fuel: nominalFuel * fuelScale,
    timeLimit: Math.max(90, level.par_time * 3.4, level.chapter === 1 ? 180 : 0),
    margin: 0,
    nominalFuel
  };
}

// src/sim/step.ts
function eventAccelAt(world2, t, x, y, out2) {
  out2.x = 0;
  out2.y = 0;
  const list = world2.level.events;
  if (!list || !list.length) return;
  const span2 = world2.bounds * 2.4;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.kind !== "storm") continue;
    const period = e.period > 0 ? e.period : Number.POSITIVE_INFINITY;
    const u = period === Number.POSITIVE_INFINITY ? t - e.t0 : (t - e.t0) % period;
    if (u < 0) continue;
    const cx = -span2 * 0.5 + u * e.speed;
    if (Math.abs(cx) > span2 * 0.75) continue;
    const nx2 = Math.cos(e.dir);
    const ny2 = Math.sin(e.dir);
    const d = x * nx2 + y * ny2 - cx;
    if (Math.abs(d) > e.width) continue;
    const sig = e.width * 0.45;
    const fall = Math.exp(-(d * d) / (2 * sig * sig));
    out2.x += nx2 * e.accel * fall;
    out2.y += ny2 * e.accel * fall;
  }
}

// tools/eventtest.ts
var doc = JSON.parse(readFileSync("assets/data/systems.json", "utf8"));
var spec = doc.levels.find((l) => l.id === "L2-2");
if (!spec || !spec.events || !spec.events.length) {
  console.error("\u2717 L2-2 \u6CA1\u6709\u914D\u7F6E\u4E8B\u4EF6\uFF0C\u65E0\u6CD5\u6D4B\u8BD5");
  process.exit(1);
}
var ev = spec.events[0];
var world = createWorld(spec, doc, 1);
var out = { x: 0, y: 0 };
var pass = 0;
var fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  \u2713 ${name}  ${detail}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}  ${detail}`);
  }
}
var span = world.bounds * 2.4;
var cxAt = (t) => {
  const period = ev.period > 0 ? ev.period : Number.POSITIVE_INFINITY;
  const u = period === Number.POSITIVE_INFINITY ? t - ev.t0 : (t - ev.t0) % period;
  return -span * 0.5 + u * ev.speed;
};
var nx = Math.cos(ev.dir);
var ny = Math.sin(ev.dir);
console.log("=".repeat(66));
console.log("  \u5B87\u5B99\u98CE\u66B4\u4E8B\u4EF6\u529B\u5355\u5143\u6D4B\u8BD5\uFF08L2-2\uFF09");
console.log("=".repeat(66));
console.log(`  \u53C2\u6570\uFF1At0=${ev.t0} \u5468\u671F=${ev.period} \u65B9\u5411=${ev.dir} rad \u901F\u5EA6=${ev.speed} \u539A\u5EA6=${ev.width} \u52A0\u901F\u5EA6=${ev.accel}`);
eventAccelAt(world, ev.t0 - 2, 0, 0, out);
check("\u4E8B\u4EF6\u5F00\u59CB\u524D\u65E0\u529B", Math.hypot(out.x, out.y) < 1e-12, `|a|=${Math.hypot(out.x, out.y).toExponential(2)}`);
var tMid = ev.t0 + 4;
var c = cxAt(tMid);
var onFront = { x: nx * c, y: ny * c };
eventAccelAt(world, tMid, onFront.x, onFront.y, out);
var mag = Math.hypot(out.x, out.y);
var dirErr = Math.abs(Math.atan2(out.y, out.x) - ev.dir);
check("\u950B\u9762\u4E0A\u6709\u529B", mag > ev.accel * 0.9, `|a|=${mag.toFixed(4)}\uFF08\u671F\u671B\u2248${ev.accel}\uFF09`);
check(
  "\u65B9\u5411\u4E0E dir \u4E00\u81F4",
  dirErr < 1e-6 || Math.abs(dirErr - Math.PI) < 1e-6,
  `\u4E0E dir \u5939\u89D2 ${(dirErr * 180 / Math.PI).toFixed(3)}\xB0`
);
var far = { x: nx * (c + ev.width * 3), y: ny * (c + ev.width * 3) };
eventAccelAt(world, tMid, far.x, far.y, out);
check("\u950B\u9762\u5916\u65E0\u529B", Math.hypot(out.x, out.y) < 1e-9, `|a|=${Math.hypot(out.x, out.y).toExponential(2)}`);
var r1 = { x: nx * (c + ev.width * 0.2), y: ny * (c + ev.width * 0.2) };
var r2 = { x: nx * (c + ev.width * 0.4), y: ny * (c + ev.width * 0.4) };
eventAccelAt(world, tMid, r1.x, r1.y, out);
var a1 = Math.hypot(out.x, out.y);
eventAccelAt(world, tMid, r2.x, r2.y, out);
var a2 = Math.hypot(out.x, out.y);
check("\u950B\u9762\u5185\u9AD8\u65AF\u8870\u51CF\u5355\u8C03", a1 > a2 && a2 > 0, `d=0.2w\u2192${a1.toFixed(4)}  d=0.4w\u2192${a2.toFixed(4)}`);
eventAccelAt(world, tMid + 1, onFront.x, onFront.y, out);
var later = Math.hypot(out.x, out.y);
check("\u950B\u9762\u968F\u65F6\u95F4\u63A8\u8FDB", Math.abs(later - mag) > 1e-6, `t \u4E0E t+1 \u7684 |a|\uFF1A${mag.toFixed(4)} vs ${later.toFixed(4)}`);
eventAccelAt(world, tMid + ev.period, onFront.x, onFront.y, out);
check(
  "\u5468\u671F\u56DE\u7ED5\u4E00\u81F4",
  Math.abs(Math.hypot(out.x, out.y) - mag) < 1e-9,
  `t \u4E0E t+period \u7684 |a|\uFF1A${mag.toFixed(6)} vs ${Math.hypot(out.x, out.y).toFixed(6)}`
);
console.log("-".repeat(66));
console.log(`  \u5355\u5143\u6D4B\u8BD5\uFF1A${pass} \u901A\u8FC7 / ${fail} \u5931\u8D25`);
process.exit(fail ? 1 : 0);
