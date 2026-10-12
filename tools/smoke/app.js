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
var G = 1;
var EPS = 0.02;
var TIME_SCALE = 1.6;
var PHYS_HZ = 120;
var DT = 1 / (PHYS_HZ * TIME_SCALE);
var MAX_ADAPT_DEPTH = 3;
var SHIP_MASS = 6e-5;
var A_MAX = 3;
var RCS_FACTOR = 0.14;
var OMEGA = 2 * Math.PI / 0.5;
var ZETA = 0.85;
var ZETA_PRECISE = 1;
var K_SPRING = SHIP_MASS * OMEGA * OMEGA;
var C_DAMP = 2 * ZETA * Math.sqrt(K_SPRING * SHIP_MASS);
var C_DAMP_PRECISE = 2 * ZETA_PRECISE * Math.sqrt(K_SPRING * SHIP_MASS);
var SHIP_RADIUS = 0.028;
var SHIP_CD = 0.4;
var WELL_MASS_MIN = 4e-3;
var WELL_MASS_MAX = 0.16;
var WELL_RANGE = 1.4;
var K_RAD = 1264e-6;
var AREA_K = Math.PI;
var WIND_MIN_R = 0.25;
var V_CRIT = 0.22;
var RESTITUTION = 0.55;
var COMPUTE_REGEN = 0.22;
var COMPUTE_DRAIN_FIELD = 0.3;
var COMPUTE_DRAIN_SLOWMO = 0.55;
var COMPUTE_HYSTERESIS = 0.3;
var TRAIL_LEN = 180;
var TRAIL_DT = 0.06;
var STRESS_TEAR = 2.6;
var TIDAL_REF = 0.053;
function rocheLimit(rPrimary, rhoPrimary, rhoSecondary) {
  return rPrimary * Math.cbrt(2 * rhoPrimary / Math.max(rhoSecondary, 1e-9));
}
function sphereDensity(mass, radius) {
  return mass / (4 / 3 * Math.PI * Math.pow(Math.max(radius, 1e-6), 3));
}
function tidalGradient(mu, r, dr) {
  return 2 * mu * dr / Math.pow(Math.max(r, 1e-6), 3);
}
function timeDilation(r, rs) {
  const x = rs / Math.max(r, rs * 1.0001);
  return 1 / Math.sqrt(Math.max(1e-6, 1 - x));
}

// src/sim/physics.ts
function softenInvCube(dx, dy, eps) {
  const r2 = dx * dx + dy * dy + eps * eps;
  return 1 / (r2 * Math.sqrt(r2));
}
function pointAccel(dx, dy, mu, eps, out) {
  const k = mu * softenInvCube(dx, dy, eps);
  out.x += k * dx;
  out.y += k * dy;
}
function primaryAccel(x, y, primaries, eps, out) {
  for (let i = 0; i < primaries.length; i++) {
    const b = primaries[i];
    if (!b.alive) continue;
    pointAccel(b.x - x, b.y - y, b.mu, eps, out);
  }
}
function wellAccel(x, y, wx, wy, fieldMass, range, repel, eps, out) {
  const dx = wx - x, dy = wy - y;
  const r2 = dx * dx + dy * dy;
  const r = Math.sqrt(r2);
  if (r > range * 2.2) return;
  const t = r / range;
  const cut = 1 / (1 + Math.pow(t, 6));
  if (cut < 1e-4) return;
  const mag = fieldMass * softenInvCube(dx, dy, eps) * cut * (repel ? -1 : 1);
  out.x += mag * dx;
  out.y += mag * dy;
}
function radiationAccel(x, y, star, area, sail, mass, out) {
  if (sail <= 0 || mass <= 0) return;
  const dx = x - star.x, dy = y - star.y;
  const r2 = dx * dx + dy * dy;
  const r = Math.sqrt(r2);
  if (r < 1e-4) return;
  const mag = K_RAD * sail * area / (r2 * mass);
  out.x += mag * dx / r;
  out.y += mag * dy / r;
}
function dragAccel(x, y, vx, vy, rho, cd, area, mass, omega, out) {
  if (rho <= 0 || mass <= 0) return;
  const vmx = -omega * y, vmy = omega * x;
  const rx = vx - vmx, ry = vy - vmy;
  const sp = Math.hypot(rx, ry);
  if (sp < 1e-9) return;
  const k = 0.5 * rho * cd * area * sp / mass;
  out.x -= k * rx;
  out.y -= k * ry;
}
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
  const E = solveKepler(M0, e);
  const cosE = Math.cos(E), sinE = Math.sin(E);
  const denom = 1 - e * cosE;
  const r = a * denom;
  const nu = 2 * Math.atan2(Math.sqrt(1 + e) * sinE, Math.sqrt(1 - e) * cosE);
  const xp = r * Math.cos(nu), yp = r * Math.sin(nu);
  const sq = Math.sqrt(mu / a);
  const vxp = -sq * sinE / denom;
  const vyp = sq * Math.sqrt(Math.max(0, 1 - e * e)) * cosE / denom;
  const cw = Math.cos(omega), sw = Math.sin(omega);
  return {
    x: xp * cw - yp * sw,
    y: xp * sw + yp * cw,
    vx: vxp * cw - vyp * sw,
    vy: vxp * sw + vyp * cw
  };
}
function areaOf(radius) {
  return AREA_K * radius * radius;
}
function conservedQuantities(primaries, light, eps) {
  let ke = 0, pe = 0, angular = 0, px2 = 0, py2 = 0;
  for (let i = 0; i < primaries.length; i++) {
    const b = primaries[i];
    if (!b.alive) continue;
    ke += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy);
    angular += b.mass * (b.x * b.vy - b.y * b.vx);
    px2 += b.mass * b.vx;
    py2 += b.mass * b.vy;
    for (let j = i + 1; j < primaries.length; j++) {
      const c = primaries[j];
      if (!c.alive) continue;
      pe -= G * b.mass * c.mass / Math.sqrt((b.x - c.x) ** 2 + (b.y - c.y) ** 2 + eps * eps);
    }
  }
  for (let i = 0; i < light.length; i++) {
    const b = light[i];
    if (!b.alive) continue;
    ke += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy);
    angular += b.mass * (b.x * b.vy - b.y * b.vx);
    px2 += b.mass * b.vx;
    py2 += b.mass * b.vy;
    for (let j = 0; j < primaries.length; j++) {
      const c = primaries[j];
      if (!c.alive) continue;
      pe -= G * b.mass * c.mass / Math.sqrt((b.x - c.x) ** 2 + (b.y - c.y) ** 2 + eps * eps);
    }
  }
  return { ke, pe, energy: ke + pe, angular, px: px2, py: py2 };
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
  const addPrimary = (key, kind, mass, radius, tint, orbit, rs2) => {
    let x = 0, y = 0, vx = 0, vy = 0;
    if (orbit) {
      const st = elementsToState(orbit.a, orbit.e, orbit.omega, orbit.M0, muStar);
      x = st.x;
      y = st.y;
      vx = st.vx;
      vy = st.vy;
    }
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
  for (const spec of level.bodies) {
    addPrimary(spec.id, spec.kind, spec.mass, spec.radius, spec.tint, spec.orbit, spec.rs);
  }
  if (!primaries.some((b) => b.kind === "star" || b.kind === "blackhole")) {
    addPrimary("core", "star", 1, 0.16, 0, null);
  }
  for (const spec of level.pods) {
    let x = 0, y = 0, vx = 0, vy = 0;
    if (spec.orbit) {
      const st = elementsToState(spec.orbit.a, spec.orbit.e, spec.orbit.omega, spec.orbit.M0, muStar);
      x = st.x;
      y = st.y;
      vx = st.vx;
      vy = st.vy;
    } else {
      const a = rng.range(1.2, 2.2), ang = rng.range(0, Math.PI * 2);
      x = Math.cos(ang) * a;
      y = Math.sin(ang) * a;
      const v = Math.sqrt(muStar / a);
      vx = -Math.sin(ang) * v;
      vy = Math.cos(ang) * v;
    }
    const b = makeBody(id++, spec.id, "pod", spec.mass, spec.radius, x, y, vx, vy, 4, false);
    b.tag = spec.id;
    b.integrity = spec.hull ?? 1;
    b.cd = 0.7;
    bodies.push(b);
    pods.push(b);
    byKey.set(spec.id, b);
  }
  const designed = level.bodies.filter((b) => b.kind === "asteroid");
  for (const spec of designed) {
    for (let i = 0; i < Math.max(1, Math.round(spec.mass > 0 ? 1 : 1)); i++) {
      const a = spec.orbit ? spec.orbit.a * (1 + (i - 0.5) * 2e-3) : 2;
      const st = elementsToState(a, spec.orbit?.e ?? 0.05, spec.orbit?.omega ?? 0, (spec.orbit?.M0 ?? 0) + i * 0.01, muStar);
      const b = makeBody(id++, `${spec.id}_${i}`, "asteroid", spec.mass, spec.radius, st.x, st.y, st.vx, st.vy, 4, false);
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
  const dockBody = byKey.get(level.dock.body) ?? primaries[primaries.length - 1];
  const off = level.dock.offset ?? { x: 0, y: 0 };
  const dock = {
    bodyId: dockBody.id,
    x: dockBody.x + off.x,
    y: dockBody.y + off.y,
    ox: off.x,
    oy: off.y,
    radius: level.dock.radius,
    vMax: level.dock.v_max,
    pulse: 0
  };
  const nebulae = (level.nebulae ?? []).map((n) => ({ ...n }));
  const fuelCapacity = 24 + 2.2 * level.difficulty;
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
    timeLimit: Math.max(90, level.par_time * 3.4),
    combo: 0,
    comboTimer: 0
  };
  const bh = primaries.find((b) => b.kind === "blackhole");
  const rs = bh ? level.bodies.find((s) => s.kind === "blackhole")?.rs ?? 0.03 : 0;
  if (bh) {
    for (const b of pods) b.dilation = timeDilation(Math.hypot(b.x - bh.x, b.y - bh.y), rs);
  }
  const world = {
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
      thrust: 0,
      intensity: 0,
      polarity: 1
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
  world.well.px = world.well.x;
  world.well.py = world.well.y;
  world.well.tx = world.well.x;
  world.well.ty = world.well.y;
  world.requiredPods = required;
  return world;
}
function requiredPods(world) {
  const r = world.requiredPods;
  if (r) return r;
  return Math.max(1, Math.round(world.level.podsTotal * (world.level.difficulty <= 2 ? 1 : 0.6)));
}

// src/sim/step.ts
var LIGHT = [];
var PODSH = [];
var AST = [];
var WACC = { x: 0, y: 0 };
var NEB = { rho: 0, omega: 0 };
var rocheCache = /* @__PURE__ */ new Map();
function collect(world) {
  LIGHT.length = 0;
  PODSH.length = 0;
  AST.length = 0;
  const bs = world.bodies;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (b.primary || !b.alive) continue;
    LIGHT.push(b);
    if (b.kind === "asteroid") AST.push(b);
    else PODSH.push(b);
  }
}
function nebulaAt(world, x, y) {
  let rho = 0, om = 0, wsum = 0;
  for (let i = 0; i < world.nebulae.length; i++) {
    const n = world.nebulae[i];
    const d2 = (n.x - x) * (n.x - x) + (n.y - y) * (n.y - y);
    const r2 = n.r * n.r;
    if (d2 >= r2) continue;
    const f = 1 - d2 / r2;
    const w = f * f * n.density;
    rho += w;
    om += n.omega * w;
    wsum += w;
  }
  NEB.rho = rho;
  NEB.omega = wsum > 0 ? om / wsum : 0;
}
function windEnvelope(world) {
  let env = 0;
  for (let i = 0; i < world.hazards.length; i++) {
    const h = world.hazards[i];
    if (h.kind !== "wind") continue;
    const per = Math.max(1e-3, h.period);
    let ph = (world.time + h.phase) % per / per;
    if (ph < 0) ph += 1;
    if (ph < 0.75 || ph > 0.95) continue;
    const v = Math.sin((ph - 0.75) / 0.2 * Math.PI) * h.strength;
    if (v > env) env = v;
  }
  return env;
}
function mainStar(world) {
  for (let i = 0; i < world.primaries.length; i++) {
    const b = world.primaries[i];
    if (b.kind === "star") return b;
  }
  return null;
}
function lightAccel(world, b, wind) {
  b.ax = 0;
  b.ay = 0;
  if (b.docked || !b.alive) return;
  primaryAccel(b.x, b.y, world.primaries, world.epsilon, b);
  const w = world.well;
  if (world.fieldEnabled && w.engaged && w.mass > 0) {
    wellAccel(b.x, b.y, w.x, w.y, w.mass, WELL_RANGE, w.repel, world.epsilon, b);
  }
  const star = mainStar(world);
  if (star) {
    radiationAccel(b.x, b.y, star, b.area, 1, b.mass, b);
    if (wind > 0) {
      const dx = b.x - star.x, dy = b.y - star.y;
      const r = Math.max(WIND_MIN_R, Math.hypot(dx, dy));
      const mag = wind / r;
      b.ax += mag * dx / r;
      b.ay += mag * dy / r;
    }
  }
  if (world.nebulae.length) {
    nebulaAt(world, b.x, b.y);
    if (NEB.rho > 0) dragAccel(b.x, b.y, b.vx, b.vy, NEB.rho, b.cd, b.area, b.mass, NEB.omega, b);
  }
}
function primaryAccels(world) {
  const ps = world.primaries;
  for (let i = 0; i < ps.length; i++) {
    ps[i].ax = 0;
    ps[i].ay = 0;
  }
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i];
    for (let j = i + 1; j < ps.length; j++) {
      const b = ps[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const r2 = dx * dx + dy * dy + world.epsilon * world.epsilon;
      const inv = 1 / (r2 * Math.sqrt(r2));
      const fa = b.mu * inv, fb = a.mu * inv;
      a.ax += fa * dx;
      a.ay += fa * dy;
      b.ax -= fb * dx;
      b.ay -= fb * dy;
    }
  }
}
function wellAccels(world, wind) {
  const w = world.well;
  WACC.x = 0;
  WACC.y = 0;
  primaryAccel(w.x, w.y, world.primaries, world.epsilon, WACC);
  const star = mainStar(world);
  if (star && wind > 0) {
    const dx = w.x - star.x, dy = w.y - star.y;
    const r = Math.max(WIND_MIN_R, Math.hypot(dx, dy));
    const mag = wind / r;
    WACC.x += mag * dx / r;
    WACC.y += mag * dy / r;
  }
  if (world.nebulae.length) {
    nebulaAt(world, w.x, w.y);
    if (NEB.rho > 0) {
      dragAccel(w.x, w.y, w.vx, w.vy, NEB.rho, SHIP_CD, Math.PI * SHIP_RADIUS * SHIP_RADIUS, SHIP_MASS, NEB.omega, WACC);
    }
  }
  const damp = w.precise ? C_DAMP_PRECISE : C_DAMP;
  let fx2 = 0, fy = 0;
  if (w.engaged) {
    fx2 = K_SPRING * (w.tx - w.x) - damp * w.vx;
    fy = K_SPRING * (w.ty - w.y) - damp * w.vy;
  }
  const amax = world.fuel <= 0 ? A_MAX * RCS_FACTOR : A_MAX;
  const fmag = Math.hypot(fx2, fy);
  const fmax = amax * SHIP_MASS;
  if (fmag > fmax && fmag > 0) {
    const k = fmax / fmag;
    fx2 *= k;
    fy *= k;
  }
  const invM = SHIP_MASS > 0 ? 1 / SHIP_MASS : 0;
  WACC.x += fx2 * invM;
  WACC.y += fy * invM;
  w.thrust = Math.min(fmag, fmax) * invM;
}
function kick(world, h) {
  const bs = world.bodies;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (!b.alive || b.docked) continue;
    b.vx += b.ax * h;
    b.vy += b.ay * h;
  }
  const w = world.well;
  w.vx += WACC.x * h;
  w.vy += WACC.y * h;
}
function drift(world, h) {
  const bs = world.bodies;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (!b.alive || b.docked) continue;
    b.x += b.vx * h;
    b.y += b.vy * h;
    b.ang += b.spin * h;
    b.life += h;
    if (b.contact > 0) b.contact = Math.max(0, b.contact - h);
    if (b.jolt > 0) b.jolt = Math.max(0, b.jolt - h * 2);
  }
  const w = world.well;
  w.x += w.vx * h;
  w.y += w.vy * h;
}
function recordPrev(world) {
  const bs = world.bodies;
  for (let i = 0; i < bs.length; i++) {
    bs[i].px = bs[i].x;
    bs[i].py = bs[i].y;
  }
  world.well.px = world.well.x;
  world.well.py = world.well.y;
}
function impulse(a, b, e) {
  let dx = b.x - a.x, dy = b.y - a.y;
  let r = Math.hypot(dx, dy);
  if (r < 1e-9) {
    dx = 1;
    dy = 0;
    r = 1e-9;
  }
  const nx = dx / r, ny = dy / r;
  const im1 = a.mass > 0 ? 1 / a.mass : 0;
  const im2 = b.mass > 0 ? 1 / b.mass : 0;
  const isum = im1 + im2 || 1;
  const minD = a.radius + b.radius;
  if (r < minD) {
    const push = minD - r;
    a.x -= nx * push * (im1 / isum);
    a.y -= ny * push * (im1 / isum);
    b.x += nx * push * (im2 / isum);
    b.y += ny * push * (im2 / isum);
  }
  const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (vn > 0) return 0;
  const j = -(1 + e) * vn / isum;
  a.vx -= j * im1 * nx;
  a.vy -= j * im1 * ny;
  b.vx += j * im2 * nx;
  b.vy += j * im2 * ny;
  return Math.abs(j);
}
function spawnShards(world, src, count, spread) {
  const rr = Math.max(4e-3, src.radius * 0.5);
  const area = Math.PI * rr * rr;
  const base = 1e6 + world.bodies.length * 8;
  for (let i = 0; i < count; i++) {
    const ang = i / count * Math.PI * 2 + world.time * 0.7;
    const m = src.mass / count;
    const sh = {
      id: base + i,
      key: `shard${base + i}`,
      kind: "shard",
      tag: "\u788E\u7247",
      mass: m,
      mu: m,
      radius: rr,
      x: src.x + Math.cos(ang) * src.radius,
      y: src.y + Math.sin(ang) * src.radius,
      vx: src.vx + Math.cos(ang) * spread,
      vy: src.vy + Math.sin(ang) * spread,
      ax: 0,
      ay: 0,
      px: src.x,
      py: src.y,
      alive: true,
      integrity: 1,
      area,
      cd: 0.9,
      qpr: 1,
      docked: false,
      delivered: false,
      lost: false,
      tint: src.tint,
      ang,
      spin: (i % 2 ? 1 : -1) * (0.8 + i * 0.13),
      primary: false,
      contact: 0,
      jolt: 0,
      stress: 0,
      dilation: 1,
      life: 0,
      trailX: new Float32Array(48),
      trailY: new Float32Array(48),
      trailN: 0,
      trailHead: 0,
      trailTick: 0
    };
    world.shards.push(sh);
    world.bodies.push(sh);
  }
}
function fx(world, kind, x, y, nx, ny, mag, tint, sound, text) {
  world.fx.push({ kind, x, y, nx, ny, mag, tint, sound, text });
}
function destroyBody(world, b, sound, text) {
  if (!b.alive) return;
  b.alive = false;
  b.lost = true;
  fx(world, "lost", b.x, b.y, b.vx, b.vy, Math.hypot(b.vx, b.vy) + 0.3, b.tint, sound, text);
  if (b.kind === "pod") {
    world.level.podsLost++;
    world.level.combo = 0;
    spawnShards(world, b, 5, 0.55);
  }
}
function tearBody(world, b, cx, cy) {
  if (!b.alive) return;
  b.alive = false;
  b.lost = true;
  fx(world, "tear", b.x, b.y, cx, cy, 1.6, b.tint, "tidal_tear", "\u6F6E\u6C50\u6495\u88C2");
  if (b.kind === "pod") {
    world.level.podsLost++;
    world.level.combo = 0;
  }
  spawnShards(world, b, 7, 0.42);
}
function inPlay(world) {
  let n = 0;
  for (let i = 0; i < world.pods.length; i++) {
    const p = world.pods[i];
    if (p.alive && !p.delivered) n++;
  }
  return n;
}
function interactions(world, dt) {
  for (let i = 0; i < PODSH.length; i++) {
    const b = PODSH[i];
    if (!b.alive || b.docked) continue;
    for (let k = 0; k < world.primaries.length; k++) {
      const p = world.primaries[k];
      if (!p.alive) continue;
      if (Math.hypot(b.x - p.x, b.y - p.y) > p.radius + b.radius) continue;
      if (b.kind === "pod") {
        destroyBody(world, b, "impact_hull", p.kind === "star" ? "\u5760\u5165\u6052\u661F" : p.kind === "blackhole" ? "\u8D8A\u8FC7\u89C6\u754C" : "\u649E\u51FB\u884C\u661F");
      } else {
        b.alive = false;
        fx(world, "impact", b.x, b.y, b.vx, b.vy, 0.4, b.tint, "impact_rock");
      }
      break;
    }
  }
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
      a.jolt = 0.6;
      a.contact = 0.25;
      if (b.kind === "pod") {
        if (dv > V_CRIT * 2.2) destroyBody(world, b, "impact_hull", "\u649E\u51FB\u5C0F\u884C\u661F");
        else fx(world, "impact", b.x, b.y, a.x - b.x, a.y - b.y, Math.min(1, dv * 4), b.tint, "impact_rock");
      } else {
        fx(world, "impact", b.x, b.y, a.x - b.x, a.y - b.y, 0.4, b.tint, "impact_rock");
      }
    }
  }
  for (let i = 0; i < PODSH.length; i++) {
    const b = PODSH[i];
    if (!b.alive || b.docked) continue;
    for (let j = i + 1; j < PODSH.length; j++) {
      const a = PODSH[j];
      if (!a.alive || a.docked) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) > a.radius + b.radius) continue;
      const imp = impulse(a, b, 0.5);
      if (imp > 0) fx(world, "impact", (a.x + b.x) * 0.5, (a.y + b.y) * 0.5, 0, 0, 0.3, b.tint, "impact_rock");
    }
  }
  for (let i = 0; i < PODSH.length; i++) {
    const b = PODSH[i];
    if (!b.alive || b.docked || b.kind !== "pod") continue;
    let stress = 0;
    for (let k = 0; k < world.primaries.length; k++) {
      const p = world.primaries[k];
      if (!p.alive || p.radius <= 0) continue;
      const d = Math.hypot(b.x - p.x, b.y - p.y);
      if (d > 1.35) continue;
      const key = p.id * 1e3 + Math.round((sphereDensity(b.mass, b.radius) || 2.6) * 100);
      let limit = rocheCache.get(key);
      if (limit === void 0 || !Number.isFinite(limit)) {
        limit = rocheLimit(p.radius, sphereDensity(p.mass, p.radius), sphereDensity(b.mass, b.radius) || 2.6);
        rocheCache.set(key, limit);
      }
      const s = tidalGradient(p.mu, d, b.radius) / TIDAL_REF;
      if (s > stress) stress = s;
      if (d < limit) {
        tearBody(world, b, p.x, p.y);
        break;
      }
    }
    if (b.alive) {
      b.stress = Math.min(3, stress);
      if (b.stress > STRESS_TEAR) {
        const p = world.primaries[0];
        tearBody(world, b, p ? p.x : 0, p ? p.y : 0);
      }
    }
  }
  for (let i = 0; i < world.pods.length; i++) {
    const b = world.pods[i];
    if (!b.alive || b.delivered) continue;
    if (Math.hypot(b.x, b.y) > world.bounds * 1.15) destroyBody(world, b, "dock_fail", "\u8131\u79BB\u4F5C\u7528\u8303\u56F4");
  }
  const station = world.primaries.find((p) => p.id === world.dock.bodyId);
  if (station) {
    world.dock.x = station.x + world.dock.ox;
    world.dock.y = station.y + world.dock.oy;
    if (world.dock.pulse > 0) world.dock.pulse = Math.max(0, world.dock.pulse - dt * 1.6);
    const hard = world.dock.vMax * 2.6;
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
        p.docked = true;
        p.delivered = true;
        p.vx = station.vx;
        p.vy = station.vy;
        p.integrity = soft ? 1 : 0.55;
        world.level.podsDelivered++;
        if (soft) {
          world.level.combo++;
          world.level.comboTimer = 8;
        } else {
          world.level.combo = 0;
        }
        world.dock.pulse = 1;
        fx(
          world,
          "dock",
          p.x,
          p.y,
          0,
          0,
          soft ? 1 : 0.6,
          p.tint,
          "dock_success",
          soft ? `\u8F6F\u5BF9\u63A5 \xD7${world.level.combo}` : "\u786C\u5BF9\u63A5\uFF08\u901F\u5EA6\u8D85\u9650\uFF0C\u8D27\u8231\u53D7\u635F\uFF09"
        );
      } else {
        const dx = p.x - world.dock.x, dy = p.y - world.dock.y;
        const r = Math.max(1e-6, Math.hypot(dx, dy));
        const nx = dx / r, ny = dy / r;
        const vn = (p.vx - station.vx) * nx + (p.vy - station.vy) * ny;
        if (vn < 0) {
          p.vx -= 1.7 * vn * nx;
          p.vy -= 1.7 * vn * ny;
          p.jolt = 1;
          fx(world, "impact", p.x, p.y, -nx, -ny, 0.8, p.tint, "impact_hull", "\u5BF9\u63A5\u901F\u5EA6\u8D85\u9650");
        }
      }
    }
    for (let i = 0; i < world.pods.length; i++) {
      const p = world.pods[i];
      if (!p.delivered) continue;
      const a = world.time * 0.35 + i / Math.max(1, world.pods.length) * Math.PI * 2;
      p.x = world.dock.x + Math.cos(a) * 0.05;
      p.y = world.dock.y + Math.sin(a) * 0.05;
      p.vx = station.vx;
      p.vy = station.vy;
      p.px = p.x;
      p.py = p.y;
    }
  }
  for (let i = 0; i < world.shards.length; i++) {
    const s = world.shards[i];
    if (s.alive && s.life > 34) s.alive = false;
  }
}
function updateTrails(world, dt) {
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
function updateStats(world) {
  const s = world.stats;
  const pure = conservedQuantities(world.primaries, [], world.epsilon);
  const full = conservedQuantities(world.primaries, LIGHT, world.epsilon);
  s.ke = full.ke;
  s.pe = full.pe;
  s.energy = full.energy;
  s.angularMomentum = full.angular;
  s.momentumX = full.px;
  s.momentumY = full.py;
  if (s.energy0 === 0) {
    s.energy0 = pure.energy;
    s.angular0 = pure.angular;
  }
  const t = Math.max(world.time, 0.5);
  s.energyDrift = s.energy0 !== 0 ? Math.abs(pure.energy - s.energy0) / (Math.abs(s.energy0) * t) : 0;
  s.angularDrift = s.angular0 !== 0 ? Math.abs(pure.angular - s.angular0) / (Math.abs(s.angular0) * t) : 0;
  s.time = world.time;
  s.lastStats = world.time;
}
function needsSplit(world, dt) {
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
function stepOnce(world, dt, depth = 0) {
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
  primaryAccels(world);
  for (let i = 0; i < LIGHT.length; i++) lightAccel(world, LIGHT[i], wind);
  wellAccels(world, wind);
  kick(world, dt * 0.5);
  world.time += dt;
  world.stats.steps++;
  interactions(world, dt);
  updateTrails(world, dt);
}
function frameEnd(world, simDt) {
  const dtReal = simDt * TIME_SCALE;
  const w = world.well;
  const load = w.engaged ? w.mass / WELL_MASS_MAX : 0;
  const slow = world.slowmo < 0.99 ? 1 : 0;
  const drain = load * COMPUTE_DRAIN_FIELD + slow * COMPUTE_DRAIN_SLOWMO;
  world.compute = Math.max(0, Math.min(world.computeMax, world.compute + (COMPUTE_REGEN - drain) * dtReal));
  if (world.compute <= 1e-6) world.fieldEnabled = false;
  else if (!world.fieldEnabled && world.compute >= COMPUTE_HYSTERESIS * world.computeMax) world.fieldEnabled = true;
  if (w.engaged && w.thrust > 0) {
    world.fuel = Math.max(0, world.fuel - w.thrust * dtReal / TIME_SCALE);
    world.level.fuelUsed = world.fuelCapacity - world.fuel;
  }
  w.intensity = w.engaged && world.fieldEnabled ? Math.min(1, 0.35 + w.mass / WELL_MASS_MAX * 0.85) : 0;
  w.polarity = w.repel ? -1 : 1;
  world.level.elapsed = world.time;
  if (world.level.comboTimer > 0) {
    world.level.comboTimer -= dtReal;
    if (world.level.comboTimer <= 0) world.level.combo = 0;
  }
  const env = windEnvelope(world);
  if (env > 0.02 && world.windActive <= 0.02) {
    const star = mainStar(world);
    if (star) fx(world, "wind", star.x, star.y, 0, 0, env * 4, 5, "wind_warning", "\u661F\u98CE\u7206\u53D1");
  }
  world.windActive = env;
  if (world.stats.lastStats < 0 || world.time - world.stats.lastStats > 0.1) updateStats(world);
  if (world.bodies.length > 160) {
    let dead = 0;
    for (let i = 0; i < world.bodies.length; i++) if (!world.bodies[i].alive) dead++;
    if (dead > 24) {
      world.bodies = world.bodies.filter((b) => b.alive || b.primary);
      world.shards = world.shards.filter((b) => b.alive);
    }
  }
  if (world.status !== "running") {
    world.statusTimer += dtReal;
    return;
  }
  const req = requiredPods(world);
  if (world.level.podsDelivered >= req) {
    world.status = "won";
    world.statusTimer = 0;
    fx(world, "win", world.dock.x, world.dock.y, 0, 0, 1, 2, "chapter_fanfare", "\u4EFB\u52A1\u5B8C\u6210");
  } else if (world.level.podsDelivered + inPlay(world) < req) {
    world.status = "lost";
    world.statusTimer = 0;
    fx(world, "fail", 0, 0, 0, 0, 1, 4, "dock_fail", "\u4EFB\u52A1\u5931\u8D25\uFF1A\u53EF\u9001\u8FBE\u8D27\u8231\u4E0D\u8DB3");
  } else if (world.time > world.level.timeLimit) {
    world.status = "lost";
    world.statusTimer = 0;
    fx(world, "fail", 0, 0, 0, 0, 1, 4, "dock_fail", "\u4EFB\u52A1\u5931\u8D25\uFF1A\u8D85\u51FA\u4EFB\u52A1\u65F6\u9650");
  }
}
function advance(world, dtTU, maxSteps = 8) {
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

// src/sim/predict.ts
var MAXP = 8;
var MAXK = 8;
var MAXPTS = 96;
var pm = new Float64Array(MAXP);
var pr = new Float64Array(MAXP);
var px = new Float64Array(MAXP);
var py = new Float64Array(MAXP);
var pvx = new Float64Array(MAXP);
var pvy = new Float64Array(MAXP);
var pax = new Float64Array(MAXP);
var pay = new Float64Array(MAXP);
var km = new Float64Array(MAXK);
var kx = new Float64Array(MAXK);
var ky = new Float64Array(MAXK);
var kvx = new Float64Array(MAXK);
var kvy = new Float64Array(MAXK);
var kax = new Float64Array(MAXK);
var kay = new Float64Array(MAXK);
var kid = new Int32Array(MAXK);
var NP = 0;
var NK = 0;
var lastPredict = -1;
var scratch = { x: 0, y: 0 };
function accelPrimaries(eps) {
  for (let i = 0; i < NP; i++) {
    pax[i] = 0;
    pay[i] = 0;
  }
  for (let i = 0; i < NP; i++) {
    for (let j = i + 1; j < NP; j++) {
      const dx = px[j] - px[i], dy = py[j] - py[i];
      const r2 = dx * dx + dy * dy + eps * eps;
      const inv = 1 / (r2 * Math.sqrt(r2));
      pax[i] += pm[j] * inv * dx;
      pay[i] += pm[j] * inv * dy;
      pax[j] -= pm[i] * inv * dx;
      pay[j] -= pm[i] * inv * dy;
    }
  }
}
function accelLight(eps, wMass, wx, wy, range) {
  for (let i = 0; i < NK; i++) {
    kax[i] = 0;
    kay[i] = 0;
    for (let j = 0; j < NP; j++) {
      const dx = px[j] - kx[i], dy = py[j] - ky[i];
      const r2 = dx * dx + dy * dy + eps * eps;
      const inv = 1 / (r2 * Math.sqrt(r2));
      kax[i] += pm[j] * inv * dx;
      kay[i] += pm[j] * inv * dy;
    }
    if (wMass > 0) {
      scratch.x = 0;
      scratch.y = 0;
      wellAccel(kx[i], ky[i], wx, wy, wMass, range, false, eps, scratch);
      kax[i] += scratch.x;
      kay[i] += scratch.y;
    }
  }
}
function predictPaths(world, now2, range, horizon = 6, h = 1 / 45, stride = 4) {
  lastPredict = now2;
  const eps = world.epsilon || EPS;
  NP = Math.min(MAXP, world.primaries.length);
  for (let i = 0; i < NP; i++) {
    const b = world.primaries[i];
    pm[i] = b.mu;
    pr[i] = b.radius;
    px[i] = b.x;
    py[i] = b.y;
    pvx[i] = b.vx;
    pvy[i] = b.vy;
  }
  NK = 0;
  for (let i = 0; i < world.pods.length && NK < MAXK; i++) {
    const b = world.pods[i];
    if (!b.alive || b.delivered) continue;
    km[NK] = b.mass;
    kx[NK] = b.x;
    ky[NK] = b.y;
    kvx[NK] = b.vx;
    kvy[NK] = b.vy;
    kid[NK] = b.id;
    NK++;
  }
  const out = world.predicted;
  if (NK === 0) {
    out.length = 0;
    return;
  }
  if (out.length !== NK) {
    out.length = 0;
    for (let i = 0; i < NK; i++) {
      out.push({ bodyId: kid[i], xs: new Float32Array(MAXPTS), ys: new Float32Array(MAXPTS), n: 0, hazard: false });
    }
  }
  for (let i = 0; i < NK; i++) {
    out[i].bodyId = kid[i];
    out[i].n = 0;
    out[i].hazard = false;
  }
  const w = world.well;
  const wMass = world.fieldEnabled ? w.mass : 0;
  const steps = Math.max(1, Math.min(600, Math.round(horizon / h)));
  const bound = world.bounds * 1.15;
  accelPrimaries(eps);
  accelLight(eps, wMass, w.x, w.y, range);
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < NP; i++) {
      pvx[i] += pax[i] * h * 0.5;
      pvy[i] += pay[i] * h * 0.5;
    }
    for (let i = 0; i < NK; i++) {
      kvx[i] += kax[i] * h * 0.5;
      kvy[i] += kay[i] * h * 0.5;
    }
    for (let i = 0; i < NP; i++) {
      px[i] += pvx[i] * h;
      py[i] += pvy[i] * h;
    }
    for (let i = 0; i < NK; i++) {
      kx[i] += kvx[i] * h;
      ky[i] += kvy[i] * h;
    }
    accelPrimaries(eps);
    accelLight(eps, wMass, w.x, w.y, range);
    for (let i = 0; i < NP; i++) {
      pvx[i] += pax[i] * h * 0.5;
      pvy[i] += pay[i] * h * 0.5;
    }
    for (let i = 0; i < NK; i++) {
      kvx[i] += kax[i] * h * 0.5;
      kvy[i] += kay[i] * h * 0.5;
    }
    if (s % stride === 0) {
      for (let i = 0; i < NK; i++) {
        const o = out[i];
        if (o.n < MAXPTS) {
          o.xs[o.n] = kx[i];
          o.ys[o.n] = ky[i];
          o.n++;
        }
      }
    }
    for (let i = 0; i < NK; i++) {
      if (out[i].hazard) continue;
      for (let j = 0; j < NP; j++) {
        if (Math.hypot(kx[i] - px[j], ky[i] - py[j]) < pr[j] + 0.012) {
          out[i].hazard = true;
          break;
        }
      }
      if (!out[i].hazard && Math.hypot(kx[i], ky[i]) > bound) out[i].hazard = true;
    }
  }
}

// src/sim/types.ts
var PALETTES = {
  loop1: {
    id: "loop1",
    bg: "#05070f",
    bg2: "#0a1024",
    star: "#ffe9a8",
    star2: "#ff9d3c",
    pod: "#ffb347",
    pod2: "#ff7a1a",
    station: "#8ef7d0",
    station2: "#2ad6a0",
    well: "#ff4fd8",
    well2: "#a626ff",
    danger: "#ff4d5e",
    danger2: "#8c1020",
    orbit: "#59d9ff",
    orbit2: "#2a6cff",
    ui: "#9fb3c8",
    uiDim: "#44536b",
    uiAccent: "#59d9ff",
    nebula: "nebula_loop1",
    tints: ["#ffe9a8", "#7fd4ff", "#8ef7d0", "#c9a6ff", "#ffb347", "#ff7d94"]
  },
  loop2: {
    id: "loop2",
    bg: "#060508",
    bg2: "#1a1206",
    star: "#fff0c0",
    star2: "#ffb03c",
    pod: "#ffd166",
    pod2: "#ff8f1f",
    station: "#9ef0ff",
    station2: "#26b6d6",
    well: "#ff7a3c",
    well2: "#ff2d6f",
    danger: "#ff5a3c",
    danger2: "#7a1a08",
    orbit: "#ffd98e",
    orbit2: "#c07a1a",
    ui: "#c8b39f",
    uiDim: "#5b4a3b",
    uiAccent: "#ffb347",
    nebula: "nebula_loop2",
    tints: ["#fff0c0", "#ffb03c", "#9ef0ff", "#ffd166", "#c9a6ff", "#ff7d94"]
  },
  loop3: {
    id: "loop3",
    bg: "#04070c",
    bg2: "#0b1a2a",
    star: "#d6f0ff",
    star2: "#4fa8ff",
    pod: "#ffd9f0",
    pod2: "#ff6fd8",
    station: "#c7ff9e",
    station2: "#5fd62a",
    well: "#59d9ff",
    well2: "#2a6cff",
    danger: "#ff4d5e",
    danger2: "#5e0a2a",
    orbit: "#9ecbff",
    orbit2: "#3a5cff",
    ui: "#a7c0d8",
    uiDim: "#3b4c63",
    uiAccent: "#8ef7d0",
    nebula: "nebula_loop3",
    tints: ["#d6f0ff", "#4fa8ff", "#c7ff9e", "#ffd9f0", "#ffb347", "#ff7d94"]
  },
  loop4: {
    id: "loop4",
    bg: "#06040a",
    bg2: "#160416",
    star: "#ffd0ff",
    star2: "#8a2bff",
    pod: "#ffcf7a",
    pod2: "#ff5a1a",
    station: "#7affe0",
    station2: "#12a08a",
    well: "#c04fff",
    well2: "#5a1fff",
    danger: "#ff2d55",
    danger2: "#3a0016",
    orbit: "#d08cff",
    orbit2: "#5a1fff",
    ui: "#b9a7d8",
    uiDim: "#4a3b63",
    uiAccent: "#ff6fd8",
    nebula: "nebula_loop4",
    tints: ["#ffd0ff", "#8a2bff", "#7affe0", "#ffcf7a", "#ff5a1a", "#ff2d55"]
  }
};
var DEFAULT_QUALITY = {
  maxParticles: 2200,
  trails: true,
  bloom: true,
  chroma: true,
  fieldContours: true,
  starLayers: 3,
  glowScale: 1,
  targetFps: 60
};

// src/engine/view.ts
var PX_PER_RU = 128;

// src/render/draw.ts
var TAU = Math.PI * 2;
var perf = { draws: 0 };
function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v === v ? v : a;
}
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}
function wo(t, f, ph) {
  return Math.sin(t * f + ph);
}
var rngState = 2654435769 >>> 0;
function seedRng(s) {
  rngState = s >>> 0 || 2654435769;
}
function rnd() {
  let x = rngState;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  rngState = x || 2654435769;
  return x * 23283064365386963e-26;
}
function rndR(a, b) {
  return a + (b - a) * rnd();
}
function hash2i(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ h >>> 13, 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function wrapi(v, p) {
  const m = v % p;
  return m < 0 ? m + p : m;
}
function vnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const x0 = period > 0 ? wrapi(xi, period) : xi;
  const y0 = period > 0 ? wrapi(yi, period) : yi;
  const x1 = period > 0 ? wrapi(xi + 1, period) : xi + 1;
  const y1 = period > 0 ? wrapi(yi + 1, period) : yi + 1;
  const a = hash2i(x0, y0, seed), b = hash2i(x1, y0, seed);
  const c = hash2i(x0, y1, seed), d = hash2i(x1, y1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x, y, oct, base, seed, tile) {
  let sum = 0, amp = 0.5, tot = 0, f = base, p = base;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * f, y * f, tile ? p : 0, seed + i * 977);
    tot += amp;
    amp *= 0.5;
    f *= 2;
    p *= 2;
  }
  return sum / (tot || 1);
}
function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
function ctx2d(c) {
  const g = c.getContext("2d");
  if (!g) throw new Error("LagrangeCourier/render: 2D context unavailable");
  return g;
}
function srcW(s) {
  const im = s;
  if (im.naturalWidth) return im.naturalWidth;
  const cv = s;
  return cv.width || 64;
}
function srcH(s) {
  const im = s;
  if (im.naturalHeight) return im.naturalHeight;
  const cv = s;
  return cv.height || 64;
}
var rgbCache = /* @__PURE__ */ new Map();
function hexToRgb(hex) {
  const c = rgbCache.get(hex);
  if (c !== void 0) return c;
  let v = 16777215;
  if (typeof hex === "string" && hex.charCodeAt(0) === 35 && hex.length >= 7) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    if (r === r && g === g && b === b) v = (r << 16 | g << 8 | b) >>> 0;
  }
  if (rgbCache.size < 1024) rgbCache.set(hex, v);
  return v;
}
function rgbToHex(v) {
  const n = v >>> 0;
  return "#" + (n & 16777215 | 16777216).toString(16).slice(1);
}
function mixRgb(a, b, t) {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const r = (a >> 16 & 255) + ((b >> 16 & 255) - (a >> 16 & 255)) * k | 0;
  const g = (a >> 8 & 255) + ((b >> 8 & 255) - (a >> 8 & 255)) * k | 0;
  const bl = (a & 255) + ((b & 255) - (a & 255)) * k | 0;
  return (r << 16 | g << 8 | bl) >>> 0;
}
function mixColor(a, b, t) {
  return rgbToHex(mixRgb(hexToRgb(a), hexToRgb(b), t));
}
function rgba(color, a) {
  const v = hexToRgb(color);
  const alpha = a < 0 ? 0 : a > 1 ? 1 : a;
  return "rgba(" + (v >> 16 & 255) + "," + (v >> 8 & 255) + "," + (v & 255) + "," + alpha + ")";
}
function tintSprite(src, color, shade) {
  const w = srcW(src), h = srcH(src);
  const c = makeCanvas(w, h);
  const g = ctx2d(c);
  g.drawImage(src, 0, 0, w, h);
  if (shade) {
    g.globalCompositeOperation = "multiply";
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = "destination-in";
    g.drawImage(src, 0, 0, w, h);
  } else {
    g.globalCompositeOperation = "source-in";
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
  }
  g.globalCompositeOperation = "source-over";
  return c;
}
var SpriteBank = class {
  assets;
  rawCache = /* @__PURE__ */ new Map();
  rawFromAsset = /* @__PURE__ */ new Set();
  procCache = /* @__PURE__ */ new Map();
  slots = /* @__PURE__ */ new Map();
  slotColors = [];
  cache = /* @__PURE__ */ new Map();
  frame = 0;
  constructor(assets) {
    this.assets = assets;
    this.slot("#ffffff");
  }
  /** 颜色槽（粒子/热路径用整数索引，避免每帧拼 key 字符串） */
  slot(color) {
    let s = this.slots.get(color);
    if (s === void 0) {
      if (this.slotColors.length >= 256) {
        this.slots.clear();
        this.slotColors.length = 0;
        this.cache.clear();
        this.slotColors.push("#ffffff");
        this.slots.set("#ffffff", 0);
      }
      s = this.slotColors.length;
      this.slotColors.push(color);
      this.slots.set(color, s);
    }
    return s;
  }
  colorOf(slot) {
    const c = this.slotColors[slot];
    return c === void 0 ? "#ffffff" : c;
  }
  bySlot(name, slot, mode) {
    let per = this.cache.get(name);
    if (per === void 0) {
      per = [];
      this.cache.set(name, per);
    }
    let arr = per[mode];
    if (arr === void 0) {
      arr = [];
      per[mode] = arr;
    }
    let c = arr[slot];
    if (c === void 0) {
      c = tintSprite(this.raw(name), this.colorOf(slot), mode === 1);
      arr[slot] = c;
    }
    return c;
  }
  byColor(name, color, mode) {
    return this.bySlot(name, this.slot(color), mode);
  }
  /** 白色 alpha 形状染色（辉光族） */
  tinted(name, color) {
    return this.byColor(name, color, 0);
  }
  /** 灰度亮度图着色（球体/云带/涡旋） */
  shaded(name, color) {
    return this.byColor(name, color, 1);
  }
  fromAsset(name) {
    return this.rawFromAsset.has(name);
  }
  tryImage(name) {
    try {
      const im = this.assets.image(name);
      if (im && im.complete && im.naturalWidth > 0) return im;
    } catch (e) {
    }
    return void 0;
  }
  raw(name) {
    let s = this.rawCache.get(name);
    if (s === void 0) {
      const im = this.tryImage(name);
      if (im) {
        s = im;
        this.rawFromAsset.add(name);
      } else {
        s = this.proc(name);
      }
      this.rawCache.set(name, s);
    }
    return s;
  }
  proc(name) {
    let c = this.procCache.get(name);
    if (c === void 0) {
      c = buildProcedural(name);
      this.procCache.set(name, c);
    }
    return c;
  }
  /** 每帧调用一次：素材若迟到加载完成，替换程序化回退并失效染色缓存 */
  tick() {
    this.frame++;
    if ((this.frame & 63) !== 0) return;
    let changed = false;
    const names = [];
    this.rawCache.forEach((_v, k) => {
      if (!this.rawFromAsset.has(k)) names.push(k);
    });
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      const im = this.tryImage(n);
      if (im) {
        this.rawCache.set(n, im);
        this.rawFromAsset.add(n);
        changed = true;
      }
    }
    if (changed) this.cache.clear();
  }
};
function mkGlowSoft(size) {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  const R = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R;
      const r = Math.sqrt(dx * dx + dy * dy);
      const f = r >= 1 ? 0 : Math.pow(1 - r, 2.1);
      const core = r >= 0.34 ? 0 : Math.pow(1 - r / 0.34, 2.6) * 0.75;
      const a = clamp(f + core, 0, 1);
      const i = (y * size + x) * 4;
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
      d[i + 3] = a * 255 | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
function mkGlowRing(size) {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  const R = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R;
      const r = Math.sqrt(dx * dx + dy * dy);
      const band = Math.exp(-Math.pow((r - 0.82) / 0.11, 2));
      const halo = r > 0.82 ? Math.exp(-Math.pow((r - 0.82) / 0.3, 2)) * 0.22 : 0;
      const a = clamp(band + halo, 0, 1);
      const i = (y * size + x) * 4;
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
      d[i + 3] = a * 255 | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
function mkSpark(size) {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  const R = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R;
      const r = Math.sqrt(dx * dx + dy * dy);
      const core = r >= 1 ? 0 : Math.pow(1 - r, 5);
      const sx = Math.exp(-Math.abs(dy) / 0.045) * Math.pow(Math.max(0, 1 - Math.abs(dx)), 2.6) * 0.55;
      const sy = Math.exp(-Math.abs(dx) / 0.045) * Math.pow(Math.max(0, 1 - Math.abs(dy)), 2.6) * 0.55;
      const a = clamp(core + sx + sy, 0, 1);
      const i = (y * size + x) * 4;
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
      d[i + 3] = a * 255 | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
function mkShard(size) {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const R = size * 0.5;
  g.translate(R, R);
  g.beginPath();
  g.moveTo(-R * 0.85, -R * 0.25);
  g.lineTo(R * 0.9, -R * 0.6);
  g.lineTo(R * 0.35, R * 0.75);
  g.lineTo(-R * 0.55, R * 0.5);
  g.closePath();
  g.fillStyle = "#ffffff";
  g.fill();
  g.globalCompositeOperation = "destination-out";
  g.beginPath();
  g.moveTo(-R * 0.1, -R * 0.9);
  g.lineTo(R * 0.18, R * 0.9);
  g.lineWidth = size * 0.06;
  g.strokeStyle = "rgba(0,0,0,0.75)";
  g.stroke();
  return c;
}
function mkStarField(size) {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  g.clearRect(0, 0, size, size);
  const seedSave = rngState;
  seedRng(5350067);
  const n = 260;
  for (let i = 0; i < n; i++) {
    const x = rnd() * size, y = rnd() * size;
    const p = Math.pow(rnd(), 3.1);
    const a = 0.16 + p * 0.84;
    const s = p > 0.86 ? 2.2 : p > 0.5 ? 1.4 : 1;
    g.globalAlpha = a;
    g.fillStyle = "#ffffff";
    g.fillRect(x, y, s, s);
    if (p > 0.93) {
      g.globalAlpha = a * 0.22;
      g.fillRect(x - s * 2, y - s * 2, s * 5, s * 5);
    }
  }
  g.globalAlpha = 1;
  rngState = seedSave;
  return c;
}
function mkVignette(size) {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  const R = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.02);
      const a = Math.pow(r, 2.3) * 0.92;
      const i = (y * size + x) * 4;
      d[i] = 0;
      d[i + 1] = 0;
      d[i + 2] = 0;
      d[i + 3] = a * 255 | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
function mkLens(w, h) {
  const c = makeCanvas(w, h);
  const g = ctx2d(c);
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const vy = Math.exp(-Math.pow((v - 0.5) / 0.26, 2));
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const ux = 0.25 + 0.75 * Math.pow(Math.sin(Math.PI * u), 1.3);
      const a = clamp(vy * ux, 0, 1);
      const i = (y * w + x) * 4;
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
      d[i + 3] = a * 255 | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
function mkRingDock(size) {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const R = size * 0.5;
  g.translate(R, R);
  g.strokeStyle = "#ffffff";
  g.lineWidth = size * 0.022;
  g.beginPath();
  g.arc(0, 0, R * 0.8, 0, TAU);
  g.stroke();
  g.globalAlpha = 0.75;
  g.lineWidth = size * 0.012;
  g.beginPath();
  g.arc(0, 0, R * 0.62, 0, TAU);
  g.stroke();
  g.globalAlpha = 0.95;
  g.lineWidth = size * 0.03;
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * TAU;
    const r0 = R * (i % 3 === 0 ? 0.66 : 0.72);
    const r1 = R * 0.94;
    g.beginPath();
    g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    g.stroke();
  }
  g.globalAlpha = 1;
  return c;
}
function mkGridHex(size) {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const R = size * 0.5;
  g.translate(R, R);
  g.strokeStyle = "rgba(255,255,255,0.5)";
  g.lineWidth = 1;
  const r = R * 0.92;
  g.beginPath();
  for (let i = 0; i <= 6; i++) {
    const a = i / 6 * TAU + Math.PI / 6;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  return c;
}
function mkSphere(size) {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  const R = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R;
      const r = Math.sqrt(dx * dx + dy * dy);
      const edge = 1 - smoothstep(0.88, 1, r);
      const nz = Math.sqrt(Math.max(0, 1 - Math.min(1, r) * Math.min(1, r)));
      const lit = clamp(-dx * 0.72 - dy * 0.28 + nz * 0.62, 0, 1);
      const v = Math.pow(0.06 + lit * 0.94, 1.35) * edge;
      const a = r >= 1 ? 0 : edge;
      const i = (y * size + x) * 4;
      const b = v * 255 | 0;
      d[i] = b;
      d[i + 1] = b;
      d[i + 2] = b;
      d[i + 3] = a * 255 | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
function mkBands(size) {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  const R = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R;
      const r = Math.sqrt(dx * dx + dy * dy);
      const edge = 1 - smoothstep(0.9, 1, r);
      const band = fbm((x + 0.5) / size * 3, (y + 0.5) / size * 9, 4, 1, 7717, false);
      const v = clamp((band - 0.28) * 1.9, 0, 1) * edge;
      const i = (y * size + x) * 4;
      const b = v * 255 | 0;
      d[i] = b;
      d[i + 1] = b;
      d[i + 2] = b;
      d[i + 3] = edge * 255 | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
function mkVortex(size) {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  const R = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R;
      const r = Math.sqrt(dx * dx + dy * dy);
      const a0 = Math.atan2(dy, dx);
      const mask = (1 - smoothstep(0.55, 1, r)) * smoothstep(0.05, 0.35, r);
      const sp = 0.5 + 0.5 * Math.sin(a0 * 2 + Math.log(Math.max(r, 0.04)) * 4.2);
      const v = Math.pow(sp, 2.4);
      const i = (y * size + x) * 4;
      const b = v * 255 | 0;
      d[i] = b;
      d[i + 1] = b;
      d[i + 2] = b;
      d[i + 3] = clamp(mask, 0, 1) * 255 | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
function mkNebula(size, name) {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  let seed = 1337;
  for (let i = 0; i < name.length; i++) seed = seed * 31 + name.charCodeAt(i) | 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      let n = fbm(u, v, 4, 3, seed, true);
      n = Math.pow(clamp((n - 0.34) * 1.85, 0, 1), 1.5);
      const dx = u - 0.5, dy = v - 0.5;
      const rad = Math.sqrt(dx * dx + dy * dy) * 2;
      const mask = 1 - smoothstep(0.62, 1, rad);
      const a = clamp(n * mask, 0, 1);
      const i = (y * size + x) * 4;
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
      d[i + 3] = a * 255 | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
function buildProcedural(name) {
  switch (name) {
    case "glow_soft":
      return mkGlowSoft(128);
    case "glow_ring":
      return mkGlowRing(128);
    case "spark":
      return mkSpark(64);
    case "shard":
      return mkShard(32);
    case "star_field":
      return mkStarField(256);
    case "vignette":
      return mkVignette(192);
    case "lens_gradient":
      return mkLens(160, 64);
    case "ring_dock":
      return mkRingDock(128);
    case "grid_hex":
      return mkGridHex(128);
    case "nebula_loop1":
    case "nebula_loop2":
    case "nebula_loop3":
    case "nebula_loop4":
    case "nebula":
      return mkNebula(160, name);
    case "sphere":
      return mkSphere(128);
    case "bands":
      return mkBands(128);
    case "vortex":
      return mkVortex(192);
    default:
      return mkGlowSoft(64);
  }
}
function blit(g, src, x, y, w, h, alpha) {
  if (alpha <= 2e-3 || w <= 0 || h <= 0) return;
  g.globalAlpha = alpha > 1 ? 1 : alpha;
  g.drawImage(src, x, y, w, h);
  perf.draws++;
}
function blitC(g, src, cx, cy, w, h, alpha) {
  blit(g, src, cx - w * 0.5, cy - h * 0.5, w, h, alpha);
}
function glowAt(env, name, color, x, y, size, alpha) {
  blitC(env.g, env.bank.tinted(name, color), x, y, size, size, alpha);
}
function tintColor(pal, tint) {
  const n = pal.tints.length;
  if (n === 0) return pal.ui;
  const i = ((tint | 0) % n + n) % n;
  return pal.tints[i];
}
function drawStar(env, b) {
  const g = env.g, pal = env.pal;
  const R = b.radius;
  const pulse = 0.9 + 0.1 * wo(env.t, 0.55 + b.id % 7 * 0.03, b.id);
  const gs = env.gs;
  g.globalCompositeOperation = "lighter";
  glowAt(env, "glow_soft", pal.star2, b.x, b.y, R * 22 * pulse, 0.075 * gs);
  glowAt(env, "glow_soft", pal.star2, b.x, b.y, R * 11 * pulse, 0.13 * gs);
  glowAt(env, "glow_soft", pal.star, b.x, b.y, R * 5.2 * pulse, 0.3 * gs);
  glowAt(env, "glow_soft", pal.star, b.x, b.y, R * 2.5, 0.62 * gs);
  g.save();
  g.translate(b.x, b.y);
  g.rotate(env.t * 0.05 + b.id);
  blitC(g, env.bank.tinted("glow_ring", pal.star), 0, 0, R * 4.4, R * 2, 0.14 * gs);
  g.rotate(-env.t * 0.09 - b.id * 2);
  blitC(g, env.bank.tinted("glow_ring", pal.star2), 0, 0, R * 3.1, R * 3.1, 0.1 * gs);
  g.restore();
  g.globalCompositeOperation = "lighter";
  blitC(g, env.bank.shaded("sphere", mixColor(pal.star, "#ffffff", 0.55)), b.x, b.y, R * 2.05, R * 2.05, 1);
  if (b.contact > 0) glowAt(env, "glow_soft", "#ffffff", b.x, b.y, R * 14, clamp(b.contact, 0, 1) * 0.5);
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
}
function drawPlanet(env, b) {
  const g = env.g, pal = env.pal;
  const R = b.radius;
  const base = tintColor(pal, b.tint);
  const toStar = Math.atan2(env.starY - b.y, env.starX - b.x);
  g.globalCompositeOperation = "lighter";
  glowAt(env, "glow_soft", mixColor(base, pal.star, 0.4), b.x, b.y, R * 7.5, 0.1 * env.gs);
  g.save();
  g.translate(b.x, b.y);
  g.rotate(toStar + Math.PI);
  blitC(g, env.bank.shaded("sphere", base), 0, 0, R * 2.06, R * 2.06, 1);
  g.restore();
  g.save();
  g.translate(b.x, b.y);
  g.rotate(b.ang);
  blitC(g, env.bank.shaded("bands", mixColor(base, "#ffffff", 0.45)), 0, 0, R * 1.9, R * 1.9, 0.22);
  g.restore();
  blitC(g, env.bank.tinted("glow_ring", mixColor(base, "#ffffff", 0.6)), b.x, b.y, R * 2.6, R * 2.6, 0.32 * env.gs);
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
}
function drawBlackHole(env, b) {
  const g = env.g, pal = env.pal;
  const R = b.radius;
  const tilt = 0.34 + 0.06 * wo(env.t, 0.13, b.id);
  const dil = b.dilation > 0 ? clamp(b.dilation, 0.5, 4) : 1;
  const disk = mixColor(pal.star2, pal.well, 0.35);
  g.globalCompositeOperation = "lighter";
  g.save();
  g.translate(b.x, b.y);
  g.rotate(tilt);
  const lens = env.bank.tinted("lens_gradient", mixColor(pal.orbit, "#ffffff", 0.5));
  blitC(g, lens, 0, -R * 2.35, R * 5.6, R * 2.1, 0.3 * env.gs);
  blitC(g, lens, 0, R * 2.35, R * 5.6, R * 2.1, 0.3 * env.gs);
  blitC(g, lens, -R * 2.95, 0, R * 2.1, R * 5.6, 0.16 * env.gs);
  blitC(g, lens, R * 2.95, 0, R * 2.1, R * 5.6, 0.16 * env.gs);
  g.restore();
  g.save();
  g.translate(b.x, b.y);
  g.rotate(tilt);
  g.scale(1, 0.3);
  blitC(g, env.bank.tinted("glow_soft", disk), 0, 0, R * 7.2, R * 7.2, 0.34 * env.gs);
  blitC(g, env.bank.tinted("glow_soft", mixColor(disk, "#ffffff", 0.5)), -R * 1.5, 0, R * 5, R * 5, 0.34 * env.gs);
  blitC(g, env.bank.tinted("glow_soft", disk), R * 1.7, 0, R * 3.6, R * 3.6, 0.1 * env.gs);
  g.restore();
  glowAt(env, "glow_ring", mixColor(pal.star, "#ffffff", 0.35), b.x, b.y, R * 3.1, 0.85 * env.gs * dil);
  glowAt(env, "glow_soft", mixColor(pal.orbit, "#ffffff", 0.4), b.x, b.y, R * 6.4, 0.16 * env.gs);
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
  g.fillStyle = "#000000";
  g.beginPath();
  g.arc(b.x, b.y, R * 1.02, 0, TAU);
  g.fill();
  perf.draws++;
  g.globalCompositeOperation = "lighter";
  g.save();
  g.translate(b.x, b.y);
  g.rotate(tilt);
  g.scale(1, 0.3);
  g.strokeStyle = rgba(disk, 0.5);
  g.lineWidth = R * 0.34;
  g.beginPath();
  g.arc(0, 0, R * 2.5, Math.PI * 0.12, Math.PI * 0.88);
  g.stroke();
  perf.draws++;
  g.restore();
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
}
function drawStation(env, b) {
  const g = env.g, pal = env.pal;
  const R = b.radius;
  const col = pal.station;
  g.globalCompositeOperation = "lighter";
  glowAt(env, "glow_soft", col, b.x, b.y, R * 9, 0.13 * env.gs);
  g.save();
  g.translate(b.x, b.y);
  g.rotate(b.ang + env.t * 0.35);
  blitC(g, env.bank.tinted("ring_dock", col), 0, 0, R * 3.4, R * 3.4, 0.6);
  g.rotate(-env.t * 0.6);
  blitC(g, env.bank.tinted("ring_dock", mixColor(col, pal.station2, 0.6)), 0, 0, R * 2.2, R * 2.2, 0.35);
  g.restore();
  g.strokeStyle = rgba(col, 0.85);
  g.lineWidth = 1.6 * env.inv;
  g.beginPath();
  const rr = R * 1.05;
  for (let i = 0; i <= 6; i++) {
    const a = i / 6 * TAU + Math.PI / 6 + b.ang * 0.2;
    const x = b.x + Math.cos(a) * rr, y = b.y + Math.sin(a) * rr;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  perf.draws++;
  g.lineWidth = 1 * env.inv;
  g.strokeStyle = rgba(col, 0.45);
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * TAU + Math.PI / 6 + b.ang * 0.2;
    g.moveTo(b.x, b.y);
    g.lineTo(b.x + Math.cos(a) * rr, b.y + Math.sin(a) * rr);
  }
  g.stroke();
  perf.draws++;
  blitC(g, env.bank.shaded("sphere", mixColor(col, "#ffffff", 0.4)), b.x, b.y, R * 0.9, R * 0.9, 0.9);
  const blink = 0.5 + 0.5 * wo(env.t, 2.6, b.id * 1.7);
  if (blink > 0.45) glowAt(env, "spark", "#ffffff", b.x, b.y - R * 1.5, R * 1.6 * (0.6 + blink), (blink - 0.45) * 1.5);
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
}
function drawPod(env, b) {
  const g = env.g, pal = env.pal;
  const R = b.radius;
  const integ = clamp(b.integrity, 0, 1);
  const col = mixColor(pal.pod, pal.danger, 1 - integ);
  g.globalCompositeOperation = "lighter";
  glowAt(env, "glow_soft", col, b.x, b.y, R * 7.5, (0.24 + (1 - integ) * 0.3) * env.gs);
  glowAt(env, "glow_soft", mixColor(col, "#ffffff", 0.5), b.x, b.y, R * 3.2, 0.5 * env.gs);
  if (b.area > 0) {
    g.save();
    g.translate(b.x, b.y);
    g.rotate(b.ang);
    g.strokeStyle = rgba(pal.pod2, 0.35);
    g.lineWidth = 1.1 * env.inv;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(-R * 3.4, -R * 1.2);
    g.moveTo(0, 0);
    g.lineTo(-R * 3.4, R * 1.2);
    g.moveTo(-R * 3.4, -R * 1.2);
    g.lineTo(-R * 3.4, R * 1.2);
    g.stroke();
    perf.draws++;
    g.restore();
  }
  blitC(g, env.bank.shaded("sphere", col), b.x, b.y, R * 2.05, R * 2.05, 1);
  blitC(g, env.bank.tinted("glow_ring", mixColor(col, "#ffffff", 0.55)), b.x, b.y, R * 2.9, R * 2.9, 0.34 * env.gs);
  if (b.jolt > 0.02) glowAt(env, "glow_soft", "#ffffff", b.x, b.y, R * 9, clamp(b.jolt, 0, 1) * 0.5);
  if (b.stress > 0.5) {
    const s = clamp((b.stress - 0.5) / 1.5, 0, 1);
    glowAt(env, "glow_ring", pal.danger, b.x, b.y, R * (3.4 + s * 2.4), s * 0.45 * (0.55 + 0.45 * wo(env.t, 9, b.id)));
  }
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
}
function drawRock(env, b) {
  const g = env.g, pal = env.pal;
  const R = b.radius;
  const col = tintColor(pal, b.tint);
  g.globalCompositeOperation = "lighter";
  g.save();
  g.translate(b.x, b.y);
  g.rotate(b.ang);
  blitC(g, env.bank.tinted("shard", col), 0, 0, R * 2.7, R * 2.7, b.kind === "debris" ? 0.85 : 0.95);
  g.restore();
  glowAt(env, "glow_soft", col, b.x, b.y, R * 5, 0.12 * env.gs);
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
}
function drawBody(env, b) {
  switch (b.kind) {
    case "star":
      drawStar(env, b);
      break;
    case "planet":
      drawPlanet(env, b);
      break;
    case "blackhole":
      drawBlackHole(env, b);
      break;
    case "station":
      drawStation(env, b);
      break;
    case "pod":
      drawPod(env, b);
      break;
    default:
      drawRock(env, b);
      break;
  }
}
function drawTrail(g, b, color, inv, alpha, ix, iy) {
  const cap = b.trailX.length;
  if (cap < 4 || b.trailY.length !== cap) return;
  let n = b.trailN;
  if (n > cap) n = cap;
  if (n < 2) return;
  let start = b.trailHead - n;
  start = (start % cap + cap) % cap;
  const CH = 6;
  g.globalCompositeOperation = "lighter";
  g.lineCap = "round";
  g.lineJoin = "round";
  g.strokeStyle = color;
  for (let c = 0; c < CH; c++) {
    const i0 = Math.floor((n - 1) * c / CH);
    const i1 = Math.floor((n - 1) * (c + 1) / CH);
    if (i1 <= i0) continue;
    const f = (c + 0.5) / CH;
    const a = alpha * (0.05 + 0.95 * f * f);
    if (a < 6e-3) continue;
    const w = (0.5 + 2.4 * f * f) * inv;
    g.globalAlpha = a;
    g.lineWidth = w;
    g.beginPath();
    let idx = start + i0;
    if (idx >= cap) idx -= cap;
    g.moveTo(b.trailX[idx], b.trailY[idx]);
    for (let k = i0 + 1; k <= i1; k++) {
      let j = start + k;
      if (j >= cap) j -= cap;
      g.lineTo(b.trailX[j], b.trailY[j]);
    }
    if (i1 >= n - 1) g.lineTo(ix, iy);
    g.stroke();
    perf.draws++;
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = "source-over";
}
function makeDockInfo() {
  return { x: 0, y: 0, r: 0.09, vMax: 0.09, pulse: 0, hasPod: false, px: 0, py: 0, rvx: 0, rvy: 0, ok: true, vrel: 0 };
}
function drawDock(env, d) {
  const g = env.g, pal = env.pal;
  const col = d.hasPod && !d.ok ? pal.danger : pal.station;
  const a = env.bank.tinted("ring_dock", col);
  g.globalCompositeOperation = "lighter";
  blitC(g, a, d.x, d.y, d.r * 2.2, d.r * 2.2, 0.85);
  glowAt(env, "glow_soft", col, d.x, d.y, d.r * 6, 0.16 * env.gs);
  const gate = d.hasPod ? clamp(d.vrel / (d.vMax || 1e-6), 0, 3) : 0;
  g.strokeStyle = rgba(col, d.hasPod && !d.ok ? 0.5 + 0.5 * wo(env.t, 16, 0) : 0.5);
  g.lineWidth = 1.6 * env.inv;
  g.setLineDash(DASH_S);
  g.beginPath();
  g.arc(d.x, d.y, d.r * (1 + Math.min(gate, 2) * 0.16), 0, TAU);
  g.stroke();
  g.setLineDash(DASH_N);
  perf.draws++;
  if (d.hasPod && !d.ok) {
    const mag = Math.hypot(d.rvx, d.rvy) || 1e-6;
    const L = d.r * (1.6 + Math.min(gate, 3) * 0.8);
    const ux = d.rvx / mag, uy = d.rvy / mag;
    const x1 = d.px, y1 = d.py;
    const x2 = x1 + ux * L, y2 = y1 + uy * L;
    g.strokeStyle = rgba(pal.danger, 0.8);
    g.lineWidth = 1.8 * env.inv;
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
    g.beginPath();
    g.moveTo(x2, y2);
    g.lineTo(x2 - ux * L * 0.28 - uy * L * 0.16, y2 - uy * L * 0.28 + ux * L * 0.16);
    g.lineTo(x2 - ux * L * 0.28 + uy * L * 0.16, y2 - uy * L * 0.28 - ux * L * 0.16);
    g.closePath();
    g.fillStyle = rgba(pal.danger, 0.8);
    g.fill();
    perf.draws += 2;
  }
  if (d.pulse > 0.01) {
    const p = clamp(d.pulse, 0, 1);
    glowAt(env, "glow_ring", pal.station, d.x, d.y, d.r * (2.4 + (1 - p) * 9), p * 0.75);
    glowAt(env, "glow_soft", "#ffffff", d.x, d.y, d.r * 8 * (1.2 - p), p * 0.35);
  }
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
}
function makeWellView() {
  return { x: 0, y: 0, tx: 0, ty: 0, mass: 0, k: 0, engaged: false, repel: false, intensity: 0, thrust: 0 };
}
function drawWell(env, w) {
  const g = env.g, pal = env.pal;
  const massN = clamp(w.mass / 0.05, 0, 1);
  const col = w.repel ? mixColor(pal.orbit, "#ffffff", 0.15) : pal.well;
  const col2 = w.repel ? pal.orbit2 : pal.well2;
  const on = w.engaged || w.mass > 1e-5;
  const scale = (0.55 + massN * 1.5) * (on ? 1 : 0.45);
  const R = 0.16 * scale;
  const bright = (0.3 + massN * 0.7) * (on ? 1 : 0.35);
  g.globalCompositeOperation = "lighter";
  g.strokeStyle = rgba(col, 0.35);
  g.lineWidth = 1 * env.inv;
  g.setLineDash(DASH_M);
  g.beginPath();
  g.moveTo(w.x, w.y);
  g.lineTo(w.tx, w.ty);
  g.stroke();
  g.setLineDash(DASH_N);
  perf.draws++;
  g.beginPath();
  g.arc(w.tx, w.ty, 0.012, 0, TAU);
  g.strokeStyle = rgba(col, 0.5);
  g.stroke();
  perf.draws++;
  const vtx = env.bank.shaded("vortex", col);
  g.save();
  g.translate(w.x, w.y);
  const rot = w.repel ? -1 : 1;
  g.rotate(env.t * 0.45 * rot);
  blitC(g, vtx, 0, 0, R * 6.2, R * 6.2, 0.16 * bright * env.gs);
  g.rotate(env.t * 0.75 * rot + 1.1);
  blitC(g, vtx, 0, 0, R * 4, R * 4, 0.3 * bright * env.gs);
  g.rotate(-env.t * 1.25 * rot);
  blitC(g, env.bank.shaded("vortex", col2), 0, 0, R * 2.4, R * 2.4, 0.5 * bright * env.gs);
  g.restore();
  glowAt(env, "glow_soft", col, w.x, w.y, R * 7 * (0.9 + 0.1 * wo(env.t, 3, 0)), 0.3 * bright * env.gs);
  glowAt(env, "glow_ring", mixColor(col, "#ffffff", 0.4), w.x, w.y, R * 3.2 * (1 + 0.05 * wo(env.t, 4.4, 0)), 0.55 * bright * env.gs);
  g.globalCompositeOperation = "source-over";
  g.fillStyle = "#04060c";
  g.beginPath();
  g.arc(w.x, w.y, R * 0.5, 0, TAU);
  g.fill();
  perf.draws++;
  if (on) {
    const dx = w.x - w.tx, dy = w.y - w.ty;
    const fx2 = -w.k * dx * (w.repel ? -1 : 1);
    const fy = -w.k * dy * (w.repel ? -1 : 1);
    const fm = Math.hypot(fx2, fy);
    if (fm > 1e-9) {
      const L = clamp(Math.log(1 + fm * 400) * 0.06, 0.02, 0.5);
      const ux = fx2 / fm, uy = fy / fm;
      const x1 = w.x, y1 = w.y;
      const x2 = x1 + ux * L, y2 = y1 + uy * L;
      g.globalCompositeOperation = "lighter";
      g.strokeStyle = rgba(col, 0.85);
      g.lineWidth = 2 * env.inv;
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
      g.beginPath();
      g.moveTo(x2, y2);
      g.lineTo(x2 - ux * L * 0.3 - uy * L * 0.17, y2 - uy * L * 0.3 + ux * L * 0.17);
      g.lineTo(x2 - ux * L * 0.3 + uy * L * 0.17, y2 - uy * L * 0.3 - ux * L * 0.17);
      g.closePath();
      g.fillStyle = rgba(col, 0.85);
      g.fill();
      perf.draws += 2;
      g.globalCompositeOperation = "source-over";
    }
  }
  g.globalAlpha = 1;
}
var PredictionCache = class {
  paths = [];
  ns = [];
  timer = 99;
  count = 0;
  update(world, dt) {
    this.timer += dt;
    const expired = this.timer >= 0.066;
    if (expired) this.timer = 0;
    const list = world.predicted;
    const n0 = list.length;
    for (let i = 0; i < n0; i++) {
      const p = list[i];
      const n = p.n | 0;
      if (expired || this.paths[i] === void 0 || this.ns[i] !== n) {
        const path = new Path2D();
        if (n > 0) {
          path.moveTo(p.xs[0], p.ys[0]);
          for (let k = 1; k < n; k++) path.lineTo(p.xs[k], p.ys[k]);
        }
        this.paths[i] = path;
        this.ns[i] = n;
      }
    }
    if (this.count > n0) {
      this.paths.length = n0;
      this.ns.length = n0;
    }
    this.count = n0;
  }
  get(i) {
    return this.paths[i];
  }
  clear() {
    this.paths.length = 0;
    this.ns.length = 0;
    this.count = 0;
    this.timer = 99;
  }
};
function drawPredicted(env, world, cache, ghostRadius) {
  const g = env.g, pal = env.pal;
  const list = world.predicted;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const path = cache.get(i);
    if (!path || p.n < 2) continue;
    const hazard = p.hazard;
    const flash = hazard ? 0.45 + 0.55 * Math.abs(wo(env.t, 7.5, i * 1.3)) : 1;
    const col = hazard ? pal.danger : pal.orbit;
    g.globalCompositeOperation = "lighter";
    g.setLineDash(DASH_P);
    g.strokeStyle = rgba(col, (hazard ? 0.75 : 0.5) * flash);
    g.lineWidth = 1.4 * env.inv;
    g.stroke(path);
    perf.draws++;
    g.setLineDash(DASH_N);
    const ex = p.xs[p.n - 1], ey = p.ys[p.n - 1];
    const a = hazard ? 0.3 * flash + 0.1 : 0.34;
    blitC(g, env.bank.shaded("sphere", mixColor(pal.pod, hazard ? pal.danger : pal.pod2, hazard ? 0.6 : 0.15)), ex, ey, ghostRadius * 2.1, ghostRadius * 2.1, a);
    glowAt(env, "glow_soft", col, ex, ey, ghostRadius * 7, a * 0.5);
  }
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
}
var DASH_N = [0, 0];
var DASH_S = [3, 4];
var DASH_M = [2, 3];
var DASH_P = [4, 5];
var DASH_B = [7, 9];
function drawGrid(env, camX, camY, viewR, bounds) {
  const g = env.g, pal = env.pal;
  const STEP = 0.5;
  const dist = Math.hypot(camX, camY);
  const r0 = Math.max(0, dist - viewR);
  const r1 = dist + viewR + STEP;
  let k0 = Math.max(1, Math.ceil(r0 / STEP));
  let k1 = Math.min(k0 + 44, Math.floor(r1 / STEP));
  if (k1 < k0) return;
  const maxR = Math.max(1.5, bounds * 1.35, r1 * 0.6);
  const span = k1 - k0 + 1;
  const BUCK = 5;
  g.globalCompositeOperation = "lighter";
  g.strokeStyle = pal.uiDim;
  g.lineWidth = 0.9 * env.inv;
  for (let bucket = 0; bucket < BUCK; bucket++) {
    const midK = k0 + (bucket + 0.5) / BUCK * span;
    const midR = midK * STEP;
    const alpha = 0.12 * Math.pow(clamp(1 - midR / maxR, 0, 1), 1.35) + 8e-3;
    if (alpha < 5e-3) continue;
    g.globalAlpha = alpha;
    g.beginPath();
    for (let k = k0 + bucket; k <= k1; k += BUCK) {
      const r = k * STEP;
      g.moveTo(r, 0);
      g.arc(0, 0, r, 0, TAU);
    }
    g.stroke();
    perf.draws++;
  }
  g.globalAlpha = 0.045;
  g.beginPath();
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * TAU;
    const ca = Math.cos(a), sa = Math.sin(a);
    g.moveTo(ca * r0, sa * r0);
    g.lineTo(ca * r1, sa * r1);
  }
  g.stroke();
  perf.draws++;
  g.globalAlpha = 1;
  g.globalCompositeOperation = "source-over";
}
function drawBounds(env, bounds, proximity) {
  const g = env.g, pal = env.pal;
  const p = clamp(proximity, 0, 1);
  const pulse = 0.5 + 0.5 * wo(env.t, 2.2 + p * 5, 0);
  g.globalCompositeOperation = "lighter";
  g.setLineDash(DASH_B);
  g.strokeStyle = rgba(pal.danger, 0.22 + p * 0.55 * pulse);
  g.lineWidth = (1.4 + p * 2.2) * env.inv;
  g.beginPath();
  g.arc(0, 0, bounds, 0, TAU);
  g.stroke();
  perf.draws++;
  g.setLineDash(DASH_N);
  if (p > 0.02) glowAt(env, "glow_ring", pal.danger, 0, 0, bounds * 2.06, p * 0.22 * env.gs);
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
}
function drawOrbits(env, world, starX, starY) {
  const g = env.g, pal = env.pal;
  const body = world.bodies;
  g.globalCompositeOperation = "lighter";
  g.setLineDash(DASH_S);
  g.strokeStyle = rgba(pal.orbit2, 0.28);
  g.lineWidth = 1 * env.inv;
  for (let i = 0; i < body.length; i++) {
    const b = body[i];
    if (b.kind === "star") continue;
    const r = Math.hypot(b.x - starX, b.y - starY);
    if (r < 1e-4 || r > 60) continue;
    g.beginPath();
    g.arc(starX, starY, r, 0, TAU);
    g.stroke();
    perf.draws++;
  }
  g.setLineDash(DASH_N);
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
}
function drawVelocityVectors(env, world) {
  const g = env.g, pal = env.pal;
  g.globalCompositeOperation = "lighter";
  g.strokeStyle = rgba(pal.orbit, 0.55);
  g.lineWidth = 1.1 * env.inv;
  g.beginPath();
  for (let i = 0; i < world.bodies.length; i++) {
    const b = world.bodies[i];
    const L = 0.35;
    const m = Math.hypot(b.vx, b.vy) || 1e-6;
    const k = Math.min(1, m) * L / m;
    g.moveTo(b.x, b.y);
    g.lineTo(b.x + b.vx * k, b.y + b.vy * k);
  }
  g.stroke();
  perf.draws++;
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
}

// src/render/starfield.ts
var LAYERS = [
  { pf: 0.05, alpha: 0.55, scale: 1, drift: 1.5 },
  { pf: 0.13, alpha: 0.34, scale: 1.35, drift: 3.2 },
  { pf: 0.26, alpha: 0.22, scale: 1.9, drift: 6 }
];
var Starfield = class {
  bank;
  pal;
  grad = null;
  gradKey = "";
  pats = [null, null, null];
  patKey = -1;
  nebulaSrc = null;
  nebulaKey = -1;
  t = 0;
  recheck = 0;
  inst = [
    { px: 0.32, py: 0.34, size: 1.55, alpha: 0.11, spin: 6e-3, seed: 0 },
    { px: -0.38, py: 0.42, size: 1.15, alpha: 0.085, spin: -9e-3, seed: 1 },
    { px: 0.05, py: -0.35, size: 0.95, alpha: 0.06, spin: 0.013, seed: 2 }
  ];
  constructor(bank, pal) {
    this.bank = bank;
    this.pal = pal;
  }
  setPalette(p) {
    this.pal = p;
    this.gradKey = "";
    this.nebulaSrc = null;
    this.nebulaKey = -1;
  }
  update(dt) {
    this.t += dt;
    this.recheck += dt;
    if (this.recheck > 1.5) {
      this.recheck = 0;
      this.nebulaSrc = null;
    }
  }
  gradient(g, h) {
    const key = this.pal.id + "|" + h;
    if (this.grad && this.gradKey === key) return this.grad;
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, this.pal.bg);
    gr.addColorStop(0.42, this.pal.bg2);
    gr.addColorStop(0.72, this.pal.bg);
    gr.addColorStop(1, "#010206");
    this.grad = gr;
    this.gradKey = key;
    return gr;
  }
  resolveNebula() {
    if (this.nebulaSrc) return this.nebulaSrc;
    const name = this.pal.nebula || "nebula_loop1";
    const asset = this.bank.fromAsset(name) ? 1 : 0;
    const src = this.bank.raw(name);
    this.nebulaSrc = asset === 1 ? src : this.bank.tinted(name, mixColor(this.pal.well, this.pal.orbit, 0.45));
    this.nebulaKey = asset;
    return this.nebulaSrc;
  }
  patterns(g) {
    const key = this.bank.fromAsset("star_field") ? 1 : 0;
    if (this.patKey === key && this.pats[0]) return;
    const src = this.bank.raw("star_field");
    for (let i = 0; i < this.pats.length; i++) this.pats[i] = g.createPattern(src, "repeat");
    this.patKey = key;
  }
  /**
   * 背景层（屏幕坐标）。cam 为相机中心（世界单位），zoom 为当前缩放。
   * 返回后 ctx 的 composite/alpha 已复位为 source-over / 1。
   */
  draw(g, camX, camY, zoom, w, h, shakeX, shakeY, q2) {
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    g.fillStyle = this.gradient(g, h);
    g.fillRect(0, 0, w, h);
    perf.draws++;
    const neb = this.resolveNebula();
    g.globalCompositeOperation = "lighter";
    const s = PX_PER_RU * zoom;
    const nLayers = this.inst.length;
    for (let i = 0; i < nLayers; i++) {
      const inst = this.inst[i];
      const size = Math.max(w, h) * inst.size;
      const half = size * 0.5;
      const pf = 0.02 + i * 0.012;
      const maxOff = Math.max(w, h) * 0.2;
      let pox = -camX * s * pf + shakeX * pf;
      let poy = -camY * s * pf + shakeY * pf;
      pox = pox < -maxOff ? -maxOff : pox > maxOff ? maxOff : pox;
      poy = poy < -maxOff ? -maxOff : poy > maxOff ? maxOff : poy;
      const ox = w * 0.5 + inst.px * w + pox + wo(this.t, 0.03 + i * 0.011, inst.seed * 2.1) * 26;
      const oy = h * 0.5 + inst.py * h + poy + wo(this.t, 0.024 + i * 9e-3, inst.seed * 3.3) * 20;
      const a = inst.alpha * (0.75 + 0.25 * wo(this.t, 0.07, inst.seed));
      g.save();
      g.translate(ox, oy);
      g.rotate(wo(this.t, 0.02 + i * 6e-3, inst.seed) * 0.12);
      g.globalAlpha = a;
      g.drawImage(neb, -half, -half, size, size);
      g.restore();
      perf.draws++;
    }
    this.patterns(g);
    const nl = clamp(q2.starLayers | 0, 0, 3);
    g.globalCompositeOperation = "lighter";
    for (let i = 0; i < nl; i++) {
      const pat = this.pats[i];
      if (!pat) continue;
      const L = LAYERS[i];
      const src = this.bank.raw("star_field");
      const ts = src.width || src.naturalWidth || 256;
      const tile = ts * L.scale;
      let ox = -camX * s * L.pf + shakeX * 0.4 * L.pf * 8 + wo(this.t, 0.05, i * 1.9) * L.drift;
      let oy = -camY * s * L.pf + shakeY * 0.4 * L.pf * 8 + wo(this.t, 0.041, i * 2.7) * L.drift * 0.6;
      ox = (ox % tile + tile) % tile;
      oy = (oy % tile + tile) % tile;
      g.save();
      g.translate(ox - tile, oy - tile);
      g.scale(L.scale, L.scale);
      g.fillStyle = pat;
      g.globalAlpha = L.alpha * (0.82 + 0.18 * wo(this.t, 0.11 + i * 0.03, i));
      g.fillRect(0, 0, (w + tile * 2) / L.scale, (h + tile * 2) / L.scale);
      g.restore();
      perf.draws++;
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
  }
  /** 恒星附近的微弱光晕（世界坐标层调用，屏幕空间保底） */
  get nebulaIsAsset() {
    return this.nebulaKey === 1;
  }
};

// src/render/particles.ts
var K_SPARK = 0;
var K_SHARD = 1;
var K_STREAK = 2;
var K_GLOW = 3;
var RING_CAP = 72;
var ACTIVE_SLOTS = 24;
var Particles = class {
  cap = 0;
  limit = 0;
  count = 0;
  cursor = 0;
  px;
  py;
  vx;
  vy;
  life;
  maxLife;
  size;
  rot;
  spin;
  drag;
  slot;
  kind;
  activeSlots = new Int16Array(ACTIVE_SLOTS);
  /* 冲击波环池 */
  rn = 0;
  rCursor = 0;
  rx = new Float32Array(RING_CAP);
  ry = new Float32Array(RING_CAP);
  rr = new Float32Array(RING_CAP);
  rv = new Float32Array(RING_CAP);
  rl = new Float32Array(RING_CAP);
  rm = new Float32Array(RING_CAP);
  rs = new Int16Array(RING_CAP);
  rw = new Float32Array(RING_CAP);
  /** 最近一次 warn 事件（渲染器读给 postfx 做危险脉动） */
  warn = 0;
  /** 本帧由特效产生的屏震冲量（渲染器读取后清零） */
  impulse = 0;
  constructor(capacity) {
    this.alloc(Math.max(64, capacity | 0));
  }
  alloc(n) {
    this.cap = n;
    this.limit = n;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.size = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.spin = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.slot = new Int16Array(n);
    this.kind = new Uint8Array(n);
  }
  get live() {
    return this.count;
  }
  get capacity() {
    return this.cap;
  }
  /** 质量变更：只在需要扩容时重建 typed array（不每帧分配） */
  setCapacity(n) {
    const want = Math.max(64, n | 0);
    this.limit = want;
    if (want > this.cap) {
      const old = { px: this.px, py: this.py, vx: this.vx, vy: this.vy, life: this.life, maxLife: this.maxLife, size: this.size, rot: this.rot, spin: this.spin, drag: this.drag, slot: this.slot, kind: this.kind, cap: this.cap };
      this.alloc(want);
      const keep = Math.min(old.cap, want);
      this.px.set(old.px.subarray(0, keep));
      this.py.set(old.py.subarray(0, keep));
      this.vx.set(old.vx.subarray(0, keep));
      this.vy.set(old.vy.subarray(0, keep));
      this.life.set(old.life.subarray(0, keep));
      this.maxLife.set(old.maxLife.subarray(0, keep));
      this.size.set(old.size.subarray(0, keep));
      this.rot.set(old.rot.subarray(0, keep));
      this.spin.set(old.spin.subarray(0, keep));
      this.drag.set(old.drag.subarray(0, keep));
      this.slot.set(old.slot.subarray(0, keep));
      this.kind.set(old.kind.subarray(0, keep));
      this.count = Math.min(this.count, keep);
    }
  }
  reset() {
    this.life.fill(0);
    this.count = 0;
    this.cursor = 0;
    this.rn = 0;
    this.rCursor = 0;
    this.warn = 0;
    this.impulse = 0;
  }
  /* ------------------------------------------------------------ 生成 */
  slotOf(bank, p, tint) {
    return bank.slot(tintColor(p, tint));
  }
  spawn(kind, x, y, vx, vy, life, size, slot, drag, spin) {
    if (this.count >= this.limit) return;
    let i = this.cursor;
    let guard = 0;
    while (this.life[i] > 0 && guard < this.cap) {
      i++;
      if (i >= this.cap) i = 0;
      guard++;
    }
    if (guard >= this.cap) return;
    this.cursor = i + 1 >= this.cap ? 0 : i + 1;
    this.px[i] = x;
    this.py[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.slot[i] = slot;
    this.kind[i] = kind;
    this.drag[i] = drag;
    this.rot[i] = rnd() * TAU;
    this.spin[i] = spin;
    this.count++;
  }
  ring(x, y, r0, vr, life, slot, width) {
    const i = this.rCursor;
    this.rCursor = i + 1 >= RING_CAP ? 0 : i + 1;
    this.rx[i] = x;
    this.ry[i] = y;
    this.rr[i] = r0;
    this.rv[i] = vr;
    this.rl[i] = life;
    this.rm[i] = life;
    this.rs[i] = slot;
    this.rw[i] = width;
    if (this.rn < RING_CAP) this.rn++;
  }
  jet(x, y, dx, dy, n, spread, sp0, sp1, life, size, slot, kind) {
    const base = Math.atan2(dy, dx);
    for (let i = 0; i < n; i++) {
      const a = base + (rnd() * 2 - 1) * spread;
      const sp = rndR(sp0, sp1);
      this.spawn(kind, x, y, Math.cos(a) * sp, Math.sin(a) * sp, life * rndR(0.7, 1.25), size * rndR(0.6, 1.4), slot, kind === K_SHARD ? 0.2 : 1.4, kind === K_SHARD ? (rnd() * 2 - 1) * 3 : 0);
    }
  }
  radial(x, y, n, a0, a1, sp0, sp1, life, size, slot, kind, drag) {
    for (let i = 0; i < n; i++) {
      const a = a0 + (a1 - a0) * rnd();
      const sp = rndR(sp0, sp1);
      this.spawn(kind, x, y, Math.cos(a) * sp, Math.sin(a) * sp, life * rndR(0.7, 1.3), size * rndR(0.6, 1.4), slot, drag, kind === K_SHARD ? (rnd() * 2 - 1) * 3.2 : 0);
    }
  }
  /**
   * 把一条特效并入粒子系统。返回屏震冲量（0..2）。
   * world 用于取主恒星位置（星风）与场景尺度。
   */
  emit(ev, world, pal, view, bank) {
    const x = ev.x || 0, y = ev.y || 0;
    let dx = ev.nx || 0, dy = ev.ny || 0;
    let mag = ev.mag;
    if (!(mag > 0)) mag = 1;
    const dl = Math.hypot(dx, dy);
    if (dl < 1e-6) {
      dx = 1;
      dy = 0;
    } else {
      dx /= dl;
      dy /= dl;
    }
    const q2 = view.quality;
    const rich = clamp((q2 && q2.maxParticles > 0 ? q2.maxParticles : 2200) / 2200, 0.25, 1);
    const slotTint = this.slotOf(bank, pal, ev.tint);
    const sDanger = bank.slot(pal.danger);
    const sPod = bank.slot(pal.pod);
    const sStation = bank.slot(pal.station);
    const sWell = bank.slot(pal.well);
    const sOrbit = bank.slot(pal.orbit);
    let imp = 0;
    switch (ev.kind) {
      case "impact": {
        const n = Math.round(16 * rich);
        this.jet(x, y, dx, dy, n, 0.55, 0.05, 0.42 * (0.6 + mag), 0.55, 0.016, slotTint, K_SPARK);
        this.jet(x, y, dx, dy, Math.round(4 * rich), 1.1, 0.03, 0.14, 0.9, 0.014, slotTint, K_SHARD);
        this.ring(x, y, 0.01, 0.28 + mag * 0.1, 0.34, slotTint, 2.4);
        imp = clamp(mag * 0.5, 0.08, 0.7);
        break;
      }
      case "dock": {
        this.ring(x, y, 0.02, 0.55, 0.75, sStation, 5);
        this.ring(x, y, 0.01, 0.28, 0.5, bank.slot("#ffffff"), 2.5);
        const n = Math.round(26 * rich);
        for (let i = 0; i < n; i++) {
          const a = rnd() * TAU, r = rndR(0.01, 0.06);
          this.spawn(K_GLOW, x + Math.cos(a) * r, y + Math.sin(a) * r, Math.cos(a) * rndR(0.02, 0.1), Math.sin(a) * rndR(0.02, 0.1) - 0.06, rndR(0.5, 1.3), 0.02, sStation, 0.5, 0);
        }
        break;
      }
      case "lost": {
        this.radial(x, y, Math.round(34 * rich), 0, TAU, 0.06, 0.5, 1, 0.02, sDanger, K_SHARD, 0.22);
        this.radial(x, y, Math.round(24 * rich), 0, TAU, 0.1, 0.8, 0.5, 0.02, sDanger, K_SPARK, 1.6);
        this.radial(x, y, Math.round(10 * rich), 0, TAU, 0.05, 0.4, 0.35, 0.03, bank.slot("#ffffff"), K_SPARK, 2);
        this.ring(x, y, 0.02, 0.9, 0.85, sDanger, 7);
        this.ring(x, y, 0.01, 0.45, 0.55, bank.slot("#ffffff"), 3);
        imp = 1.5;
        break;
      }
      case "fragment":
      case "tear": {
        const big = ev.kind === "tear";
        this.radial(x, y, Math.round((big ? 26 : 14) * rich), 0, TAU, 0.05, big ? 0.6 : 0.35, big ? 1.3 : 0.9, 0.017, sPod, K_SHARD, 0.2);
        this.jet(x, y, dx, dy, Math.round((big ? 22 : 12) * rich), 0.9, 0.08, 0.45, 0.7, 0.022, sOrbit, K_STREAK);
        this.ring(x, y, 0.015, big ? 0.6 : 0.35, 0.6, sOrbit, 3.4);
        imp = big ? 0.8 : 0.35;
        break;
      }
      case "wind": {
        const n = Math.round(52 * rich);
        for (let i = 0; i < n; i++) {
          const a = rnd() * TAU;
          const sp = rndR(0.5, 1.5);
          const r0 = rndR(0, 0.05);
          this.spawn(K_STREAK, x + Math.cos(a) * r0, y + Math.sin(a) * r0, Math.cos(a) * sp, Math.sin(a) * sp, rndR(0.7, 1.5), 0.02, slotTint, 0.06, 0);
        }
        break;
      }
      case "pulse": {
        this.ring(x, y, 0.03, 1.25, 0.7, sWell, 6);
        this.ring(x, y, 0.02, 0.7, 0.45, bank.slot("#ffffff"), 3);
        this.radial(x, y, Math.round(14 * rich), 0, TAU, 0.06, 0.4, 0.6, 0.016, sWell, K_SPARK, 1.5);
        imp = 0.2;
        break;
      }
      case "ignite": {
        this.jet(x, y, -dx, -dy, Math.round(20 * rich), 0.4, 0.1, 0.5, 0.45, 0.018, sPod, K_SPARK);
        this.jet(x, y, -dx, -dy, Math.round(6 * rich), 0.3, 0.05, 0.2, 0.8, 0.02, bank.slot("#ffffff"), K_GLOW);
        this.ring(x, y, 8e-3, 0.3, 0.3, sPod, 2);
        imp = 0.25;
        break;
      }
      case "thruster": {
        this.jet(x, y, -dx, -dy, 3, 0.28, 0.06, 0.24, 0.28, 0.013, sPod, K_SPARK);
        break;
      }
      case "warn": {
        this.warn = 1;
        this.ring(x, y, 0.02, 0.5, 0.9, sDanger, 4);
        break;
      }
      case "win": {
        this.ring(x, y, 0.03, 0.8, 1.1, sStation, 6);
        this.ring(x, y, 0.02, 0.45, 0.8, bank.slot("#ffffff"), 3);
        const n = Math.round(46 * rich);
        for (let i = 0; i < n; i++) {
          const a = rnd() * TAU, r = rndR(0.01, 0.18);
          this.spawn(K_GLOW, x + Math.cos(a) * r, y + Math.sin(a) * r, Math.cos(a) * rndR(0.01, 0.06), -rndR(0.05, 0.22), rndR(0.8, 2), 0.02, sStation, 0.35, 0);
        }
        break;
      }
      case "fail": {
        this.radial(x, y, Math.round(30 * rich), 0, TAU, 0.05, 0.45, 1.2, 0.02, sDanger, K_SHARD, 0.25);
        this.ring(x, y, 0.02, 0.6, 1, sDanger, 5);
        imp = 0.9;
        break;
      }
      case "soi":
      case "enter": {
        this.ring(x, y, 0.02, 0.5, 0.8, sOrbit, 4);
        this.radial(x, y, Math.round(18 * rich), 0, TAU, 0.03, 0.22, 0.9, 0.018, sOrbit, K_GLOW, 0.4);
        break;
      }
      case "countdown": {
        this.ring(x, y, 0.01, 0.25, 0.4, sOrbit, 2.5);
        break;
      }
      default: {
        this.radial(x, y, Math.round(10 * rich), 0, TAU, 0.04, 0.3, 0.6, 0.016, slotTint, K_SPARK, 1.2);
        break;
      }
    }
    this.impulse += imp;
    return imp;
  }
  /* ------------------------------------------------------------ 更新 */
  update(dt, world) {
    if (dt <= 0) return;
    const n = this.cap;
    let live = 0;
    for (let i = 0; i < n; i++) {
      const l = this.life[i];
      if (l <= 0) continue;
      const nl = l - dt;
      if (nl <= 0) {
        this.life[i] = 0;
        continue;
      }
      this.life[i] = nl;
      live++;
      const d = this.drag[i];
      if (d > 0) {
        const f = 1 - d * dt;
        const k = f < 0 ? 0 : f;
        this.vx[i] *= k;
        this.vy[i] *= k;
      }
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      if (this.spin[i] !== 0) this.rot[i] += this.spin[i] * dt;
    }
    this.count = live;
    let rn = 0;
    for (let i = 0; i < RING_CAP; i++) {
      const l = this.rl[i];
      if (l <= 0) continue;
      const nl = l - dt;
      if (nl <= 0) {
        this.rl[i] = 0;
        continue;
      }
      this.rl[i] = nl;
      this.rr[i] += this.rv[i] * dt;
      rn++;
    }
    this.rn = rn;
  }
  /* ------------------------------------------------------------ 绘制 */
  draw(env) {
    const g = env.g;
    const bank = env.bank;
    const n = this.cap;
    if (this.count > 0) {
      g.globalCompositeOperation = "lighter";
      let slots = 0;
      for (let i = 0; i < n; i++) {
        if (this.life[i] <= 0 || this.kind[i] !== K_SPARK) continue;
        const s = this.slot[i];
        let seen = false;
        for (let k = 0; k < slots; k++) {
          if (this.activeSlots[k] === s) {
            seen = true;
            break;
          }
        }
        if (!seen) {
          if (slots >= ACTIVE_SLOTS) break;
          this.activeSlots[slots++] = s;
        }
      }
      for (let k = 0; k < slots; k++) {
        const s = this.activeSlots[k];
        g.fillStyle = bank.colorOf(s);
        g.globalAlpha = 0.85;
        g.beginPath();
        for (let i = 0; i < n; i++) {
          if (this.life[i] <= 0 || this.kind[i] !== K_SPARK || this.slot[i] !== s) continue;
          const f = this.life[i] / this.maxLife[i];
          const r = this.size[i] * (0.35 + f * 0.85) * 1.9;
          if (r <= 0.02) continue;
          g.moveTo(this.px[i] + r, this.py[i]);
          g.arc(this.px[i], this.py[i], r, 0, TAU);
        }
        g.fill();
        perf.draws++;
      }
      for (let i = 0; i < n; i++) {
        if (this.life[i] <= 0 || this.kind[i] !== K_SHARD) continue;
        const f = this.life[i] / this.maxLife[i];
        const sz = this.size[i] * (0.7 + f * 0.6) * 2.6;
        g.save();
        g.translate(this.px[i], this.py[i]);
        g.rotate(this.rot[i]);
        blitC(g, bank.bySlot("shard", this.slot[i], 0), 0, 0, sz, sz, Math.pow(f, 0.55) * 0.95);
        g.restore();
      }
      g.lineCap = "round";
      g.lineWidth = 1.5 * env.inv;
      for (let i = 0; i < n; i++) {
        if (this.life[i] <= 0 || this.kind[i] !== K_STREAK) continue;
        const f = this.life[i] / this.maxLife[i];
        const L = Math.min(0.09, Math.hypot(this.vx[i], this.vy[i]) * 0.12);
        g.strokeStyle = bank.colorOf(this.slot[i]);
        g.globalAlpha = Math.pow(f, 0.6) * 0.75;
        g.beginPath();
        g.moveTo(this.px[i], this.py[i]);
        g.lineTo(this.px[i] - this.vx[i] * L, this.py[i] - this.vy[i] * L);
        g.stroke();
        perf.draws++;
      }
      for (let i = 0; i < n; i++) {
        if (this.life[i] <= 0 || this.kind[i] !== K_GLOW) continue;
        const f = this.life[i] / this.maxLife[i];
        const sz = this.size[i] * (2.2 + (1 - f) * 2.2);
        blitC(g, bank.bySlot("glow_soft", this.slot[i], 0), this.px[i], this.py[i], sz, sz, Math.pow(f, 0.8) * 0.75 * env.gs);
      }
    }
    if (this.rn > 0) {
      g.globalCompositeOperation = "lighter";
      for (let i = 0; i < RING_CAP; i++) {
        const l = this.rl[i];
        if (l <= 0) continue;
        const f = l / this.rm[i];
        const fw = (1 - f) * (1 - f);
        const d = this.rr[i] * 2;
        blitC(g, bank.bySlot("glow_ring", this.rs[i], 0), this.rx[i], this.ry[i], d, d, (0.25 + 0.75 * f) * 0.85);
        blitC(g, bank.bySlot("glow_soft", this.rs[i], 0), this.rx[i], this.ry[i], d * 1.5, d * 1.5, fw * 0.28 * env.gs);
      }
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
  }
  /** 危险脉动：把调色板 danger 颜色交给 postfx（无分配） */
  dangerColor(pal) {
    return this.warn > 0 ? pal.danger : mixColor(pal.bg, pal.bg2, 0.5);
  }
};

// src/render/field.ts
var FIELD_COLS = 96;
var FIELD_ROWS = 54;
var REBUILD_MS = 120;
var ARROW_STEP = 8;
var MAX_LEVELS = 26;
function marchingSquares(values, cols, rows, x0, y0, hx, hy, level, emit) {
  let segs = 0;
  const stride = cols + 1;
  for (let gy = 0; gy < rows; gy++) {
    const row = gy * stride;
    const row2 = row + stride;
    const wy0 = y0 + gy * hy;
    const wy1 = wy0 + hy;
    for (let gx = 0; gx < cols; gx++) {
      const v00 = values[row + gx];
      const v10 = values[row + gx + 1];
      const v11 = values[row2 + gx + 1];
      const v01 = values[row2 + gx];
      let mn = v00, mx = v00;
      if (v10 < mn) mn = v10;
      else if (v10 > mx) mx = v10;
      if (v11 < mn) mn = v11;
      else if (v11 > mx) mx = v11;
      if (v01 < mn) mn = v01;
      else if (v01 > mx) mx = v01;
      if (level < mn || level > mx) continue;
      let code = 0;
      if (v00 >= level) code |= 1;
      if (v10 >= level) code |= 2;
      if (v11 >= level) code |= 4;
      if (v01 >= level) code |= 8;
      if (code === 0 || code === 15) continue;
      const wx0 = x0 + gx * hx;
      const wx1 = wx0 + hx;
      let e0x = 0, e0y = wy0, e1x = wx1, e1y = 0, e2x = 0, e2y = wy1, e3x = wx0, e3y = 0;
      const d0 = v10 - v00, d1 = v11 - v10, d2 = v11 - v01, d3 = v01 - v00;
      e0x = wx0 + (d0 === 0 ? 0.5 : (level - v00) / d0) * hx;
      e1y = wy0 + (d1 === 0 ? 0.5 : (level - v10) / d1) * hy;
      e2x = wx0 + (d2 === 0 ? 0.5 : (level - v01) / d2) * hx;
      e3y = wy0 + (d3 === 0 ? 0.5 : (level - v00) / d3) * hy;
      switch (code) {
        case 1:
        case 14:
          emit(e3x, e3y, e0x, e0y);
          segs++;
          break;
        case 2:
        case 13:
          emit(e0x, e0y, e1x, e1y);
          segs++;
          break;
        case 3:
        case 12:
          emit(e3x, e3y, e1x, e1y);
          segs++;
          break;
        case 4:
        case 11:
          emit(e1x, e1y, e2x, e2y);
          segs++;
          break;
        case 6:
        case 9:
          emit(e0x, e0y, e2x, e2y);
          segs++;
          break;
        case 7:
        case 8:
          emit(e2x, e2y, e3x, e3y);
          segs++;
          break;
        case 5: {
          const center = (v00 + v10 + v11 + v01) * 0.25;
          if (center >= level) {
            emit(e0x, e0y, e1x, e1y);
            segs++;
            emit(e2x, e2y, e3x, e3y);
            segs++;
          } else {
            emit(e3x, e3y, e0x, e0y);
            segs++;
            emit(e1x, e1y, e2x, e2y);
            segs++;
          }
          break;
        }
        case 10: {
          const center = (v00 + v10 + v11 + v01) * 0.25;
          if (center >= level) {
            emit(e3x, e3y, e0x, e0y);
            segs++;
            emit(e1x, e1y, e2x, e2y);
            segs++;
          } else {
            emit(e0x, e0y, e1x, e1y);
            segs++;
            emit(e2x, e2y, e3x, e3y);
            segs++;
          }
          break;
        }
        default:
          break;
      }
    }
  }
  return segs;
}
function samplePotential(out, cols, rows, x0, y0, hx, hy, bodies, G2, eps) {
  const stride = cols + 1;
  const e2 = eps * eps;
  for (let gy = 0; gy <= rows; gy++) {
    const wy = y0 + gy * hy;
    for (let gx = 0; gx <= cols; gx++) {
      const wx = x0 + gx * hx;
      let phi = 0;
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        const dx = wx - b.x, dy = wy - b.y;
        phi -= G2 * b.mass / Math.sqrt(dx * dx + dy * dy + e2);
      }
      out[gy * stride + gx] = phi;
    }
  }
}
var FieldLayer = class {
  vals = new Float32Array((FIELD_COLS + 1) * (FIELD_ROWS + 1));
  levels = [];
  contours = [];
  timer = 1e3;
  bounds = 6;
  dirty = true;
  lastPalette = "";
  segs = 0;
  /** 标记需要重算（关卡/调色板/质量变化时调用） */
  invalidate() {
    this.dirty = true;
    this.timer = 1e3;
  }
  buildLevels(world) {
    const bodies = world.bodies;
    const cand = this.levels;
    cand.length = 0;
    const G2 = world.G || 1;
    const eps = world.epsilon || 0.02;
    const bounds = world.bounds || 6;
    let mmax = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.mass > mmax) mmax = b.mass;
    }
    const nearMul = [1.6, 2.4, 3.6, 5.6];
    const globMul = [0.06, 0.12, 0.22, 0.38, 0.6, 0.85];
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b.primary && b.kind !== "pod") continue;
      const m = b.mass;
      if (m <= 0 || m < mmax * 4e-3) continue;
      const R = Math.max(b.radius, 0.012);
      for (let k = 0; k < nearMul.length; k++) {
        const r = R * nearMul[k];
        cand.push(-(G2 * m) / Math.sqrt(r * r + eps * eps));
      }
      for (let k = 0; k < globMul.length; k++) {
        const r = Math.max(R * 1.2, bounds * globMul[k]);
        cand.push(-(G2 * m) / Math.sqrt(r * r + eps * eps));
      }
    }
    if (cand.length === 0) return;
    cand.sort((a, b) => b - a);
    let w = 0;
    for (let i = 0; i < cand.length; i++) {
      const v = cand[i];
      if (w > 0 && Math.abs(v - cand[w - 1]) < Math.abs(v) * 0.03) continue;
      cand[w++] = v;
    }
    cand.length = w;
    if (cand.length > MAX_LEVELS) {
      const keep = [];
      for (let i = 0; i < MAX_LEVELS; i++) keep.push(cand[Math.round(i * (cand.length - 1) / (MAX_LEVELS - 1))]);
      cand.length = 0;
      for (let i = 0; i < keep.length; i++) cand.push(keep[i]);
    }
  }
  rebuild(world, pal, quality) {
    if (!quality.fieldContours) {
      this.contours.length = 0;
      return;
    }
    const bounds = world.bounds || 6;
    const x0 = -bounds, y0 = -bounds;
    const hx = 2 * bounds / FIELD_COLS;
    const hy = 2 * bounds / FIELD_ROWS;
    const G2 = world.G || 1;
    const eps = world.epsilon || 0.02;
    const b = world.primaries && world.primaries.length ? world.primaries : world.bodies;
    const src = [];
    for (let i = 0; i < b.length; i++) {
      const o = b[i];
      if (o.mass > 0 && o.kind !== "pod") src.push(o);
    }
    if (src.length === 0) {
      this.contours.length = 0;
      return;
    }
    samplePotential(this.vals, FIELD_COLS, FIELD_ROWS, x0, y0, hx, hy, src, G2, eps);
    this.buildLevels(world);
    const lv = this.levels;
    this.contours.length = 0;
    this.segs = 0;
    const deep = hexToRgb(pal.well);
    const mid = hexToRgb(pal.orbit);
    const shallow = hexToRgb(pal.orbit2);
    let phiMin = 0;
    for (let i = 0; i < lv.length; i++) if (lv[i] < phiMin) phiMin = lv[i];
    for (let i = 0; i < lv.length; i++) {
      const level = lv[i];
      const path = new Path2D();
      const s = marchingSquares(this.vals, FIELD_COLS, FIELD_ROWS, x0, y0, hx, hy, level, (x1, y1, x2, y2) => {
        path.moveTo(x1, y1);
        path.lineTo(x2, y2);
      });
      if (s === 0) continue;
      this.segs += s;
      const t = phiMin === 0 ? 0 : clamp(level / phiMin, 0, 1);
      const col = t < 0.55 ? mixRgb(shallow, mid, t / 0.55) : mixRgb(mid, deep, (t - 0.55) / 0.45);
      this.contours.push({
        level,
        path,
        color: rgbToHex(col),
        width: 1,
        alpha: 0.14 + 0.34 * t
      });
    }
    this.bounds = bounds;
    this.lastPalette = pal.id;
    this.dirty = false;
  }
  /**
   * 每帧入口：showContours 时按 120 ms 节流重算并绘制等势线；showVectors 时叠场向量箭头。
   */
  draw(env, world, dt, showContours, showVectors) {
    if (showContours) {
      this.timer += dt * 1e3;
      if (this.dirty || this.timer >= REBUILD_MS || this.lastPalette !== env.pal.id || this.bounds !== (world.bounds || 6)) {
        this.timer = 0;
        this.rebuild(world, env.pal, env.quality);
      }
      const g = env.g;
      if (this.contours.length) {
        g.globalCompositeOperation = "lighter";
        g.lineJoin = "round";
        for (let i = 0; i < this.contours.length; i++) {
          const c = this.contours[i];
          g.strokeStyle = rgba(c.color, c.alpha);
          g.lineWidth = c.width * env.inv * (1 + i / this.contours.length * 0.7);
          g.stroke(c.path);
          perf.draws++;
        }
        g.globalCompositeOperation = "source-over";
        g.globalAlpha = 1;
      }
    }
    if (showVectors) this.drawVectors(env, world);
  }
  /** 稀疏场向量箭头：每 8 格一个，长度按 |g| 归一化 */
  drawVectors(env, world) {
    const g = env.g;
    const bounds = world.bounds || 6;
    const G2 = world.G || 1;
    const eps = world.epsilon || 0.02;
    const hx = 2 * bounds / FIELD_COLS;
    const hy = 2 * bounds / FIELD_ROWS;
    const e2 = eps * eps;
    const b = world.primaries && world.primaries.length ? world.primaries : world.bodies;
    g.globalCompositeOperation = "lighter";
    g.strokeStyle = rgba(env.pal.orbit, 0.3);
    g.fillStyle = rgba(env.pal.orbit, 0.34);
    g.lineWidth = 0.9 * env.inv;
    g.beginPath();
    const cell = ARROW_STEP * hx;
    const cellY = ARROW_STEP * hy;
    const maxLen = Math.min(cell, cellY) * 0.85;
    for (let gy = ARROW_STEP * 0.5; gy < FIELD_ROWS; gy += ARROW_STEP) {
      const wy = -bounds + gy * hy;
      for (let gx = ARROW_STEP * 0.5; gx < FIELD_COLS; gx += ARROW_STEP) {
        const wx = -bounds + gx * hx;
        let ax = 0, ay = 0;
        for (let i = 0; i < b.length; i++) {
          const o = b[i];
          if (o.mass <= 0) continue;
          const dx = o.x - wx, dy = o.y - wy;
          const r2 = dx * dx + dy * dy + e2;
          const inv = G2 * o.mass / (r2 * Math.sqrt(r2));
          ax += dx * inv;
          ay += dy * inv;
        }
        const m = Math.hypot(ax, ay);
        if (m < 1e-9) continue;
        const L = maxLen * clamp(Math.log(1 + m * 60) * 0.5, 0.12, 1);
        const ux = ax / m, uy = ay / m;
        const x2 = wx + ux * L, y2 = wy + uy * L;
        g.moveTo(wx, wy);
        g.lineTo(x2, y2);
        g.moveTo(x2, y2);
        g.lineTo(x2 - ux * L * 0.34 - uy * L * 0.18, y2 - uy * L * 0.34 + ux * L * 0.18);
        g.lineTo(x2 - ux * L * 0.34 + uy * L * 0.18, y2 - uy * L * 0.34 - ux * L * 0.18);
        g.closePath();
      }
    }
    g.stroke();
    perf.draws++;
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
  }
  /** 诊断/自动化测试用 */
  get contourCount() {
    return this.contours.length;
  }
  get levelCount() {
    return this.levels.length;
  }
  get segmentCount() {
    return this.segs;
  }
};

// src/render/postfx.ts
var PostFX = class {
  out;
  bank;
  w = 1600;
  h = 900;
  dpr = 1;
  q = null;
  bA = null;
  bB = null;
  bgA = null;
  bgB = null;
  bw = 0;
  bh = 0;
  cR = null;
  cB = null;
  cgR = null;
  cgB = null;
  cw = 0;
  ch = 0;
  scan = null;
  vigGrad = null;
  vigKey = "";
  dangerVig;
  constructor(out, bank) {
    this.out = out;
    this.bank = bank;
    const s = makeCanvas(1, 4);
    const sg = ctx2d(s);
    sg.fillStyle = "#ffffff";
    sg.fillRect(0, 0, 1, 1);
    this.scan = out.createPattern(s, "repeat");
    this.dangerVig = buildDangerVignette(160);
  }
  setQuality(q2) {
    this.q = q2;
    if (!q2.bloom) {
      this.bA = null;
      this.bB = null;
      this.bgA = null;
      this.bgB = null;
    }
    if (!q2.chroma) {
      this.cR = null;
      this.cB = null;
      this.cgR = null;
      this.cgB = null;
    }
  }
  resize(w, h, dpr) {
    this.w = Math.max(1, w | 0);
    this.h = Math.max(1, h | 0);
    this.dpr = dpr > 0 ? dpr : 1;
    this.vigKey = "";
    const devW = Math.max(1, Math.round(this.w * this.dpr));
    const devH = Math.max(1, Math.round(this.h * this.dpr));
    this.bw = Math.max(32, Math.round(devW / 4));
    this.bh = Math.max(32, Math.round(devH / 4));
    this.cw = devW;
    this.ch = devH;
    this.bA = null;
    this.bB = null;
    this.cR = null;
    this.cB = null;
  }
  /** 惰性分配（质量降级时完全不分配） */
  ensureBloom() {
    if (this.bA && this.bB) return true;
    this.bA = makeCanvas(this.bw, this.bh);
    this.bB = makeCanvas(this.bw, this.bh);
    this.bgA = ctx2d(this.bA);
    this.bgB = ctx2d(this.bB);
    return true;
  }
  ensureChroma() {
    if (this.cR && this.cB) return true;
    this.cR = makeCanvas(this.cw, this.ch);
    this.cB = makeCanvas(this.cw, this.ch);
    this.cgR = ctx2d(this.cR);
    this.cgB = ctx2d(this.cB);
    return true;
  }
  reset() {
    if (this.bgA) this.bgA.clearRect(0, 0, this.bw, this.bh);
    if (this.bgB) this.bgB.clearRect(0, 0, this.bw, this.bh);
    if (this.cgR) this.cgR.clearRect(0, 0, this.cw, this.ch);
    if (this.cgB) this.cgB.clearRect(0, 0, this.cw, this.ch);
  }
  vignette(g) {
    const key = this.w + "x" + this.h;
    if (this.bank.fromAsset("vignette")) return this.bank.raw("vignette");
    if (this.vigGrad && this.vigKey === key) return this.vigGrad;
    const r = Math.hypot(this.w, this.h) * 0.5;
    const gr = g.createRadialGradient(this.w * 0.5, this.h * 0.5, r * 0.42, this.w * 0.5, this.h * 0.5, r);
    gr.addColorStop(0, "rgba(0,0,0,0)");
    gr.addColorStop(1, "rgba(0,0,0,0.85)");
    this.vigGrad = gr;
    this.vigKey = key;
    return gr;
  }
  /**
   * 场景 → 可见 canvas 的最终合成。
   * slow: 慢动作强度 0..1；warn: 危险脉动 0..1。
   */
  composite(scene, view, pal, t, warn, slow, hitstop) {
    const g = this.out;
    const q2 = this.q ?? view.quality;
    const w = this.w, h = this.h, dpr = this.dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    const chroma = q2.chroma ? clamp(view.chroma, 0, 1) : 0;
    if (chroma > 0.015 && this.ensureChroma() && this.cgR && this.cgB && this.cR && this.cB) {
      const gr = this.cgR, gb = this.cgB;
      gr.setTransform(1, 0, 0, 1, 0, 0);
      gr.globalCompositeOperation = "source-over";
      gr.globalAlpha = 1;
      gr.clearRect(0, 0, this.cw, this.ch);
      gr.drawImage(scene, 0, 0, this.cw, this.ch);
      gr.globalCompositeOperation = "multiply";
      gr.fillStyle = "#ff0000";
      gr.fillRect(0, 0, this.cw, this.ch);
      gb.setTransform(1, 0, 0, 1, 0, 0);
      gb.globalCompositeOperation = "source-over";
      gb.globalAlpha = 1;
      gb.clearRect(0, 0, this.cw, this.ch);
      gb.drawImage(scene, 0, 0, this.cw, this.ch);
      gb.globalCompositeOperation = "multiply";
      gb.fillStyle = "#00ffff";
      gb.fillRect(0, 0, this.cw, this.ch);
      const d = 0.6 + chroma * 3.2;
      g.globalCompositeOperation = "lighter";
      g.globalAlpha = 1;
      g.drawImage(this.cR, -d, 0, w, h);
      g.drawImage(this.cB, d, 0, w, h);
      perf.draws += 6;
    } else {
      g.globalCompositeOperation = "source-over";
      g.drawImage(scene, 0, 0, w, h);
      perf.draws++;
    }
    if (q2.bloom && this.ensureBloom() && this.bgA && this.bgB && this.bA && this.bB) {
      const bgA = this.bgA, bgB = this.bgB;
      bgA.setTransform(1, 0, 0, 1, 0, 0);
      bgA.globalCompositeOperation = "source-over";
      bgA.globalAlpha = 1;
      bgA.clearRect(0, 0, this.bw, this.bh);
      bgA.drawImage(scene, 0, 0, this.bw, this.bh);
      bgB.setTransform(1, 0, 0, 1, 0, 0);
      bgB.globalCompositeOperation = "source-over";
      bgB.globalAlpha = 1;
      bgB.clearRect(0, 0, this.bw, this.bh);
      bgB.globalCompositeOperation = "lighter";
      bgB.globalAlpha = 1 / 7;
      for (let k = -3; k <= 3; k++) bgB.drawImage(this.bA, k * 1.6, 0, this.bw, this.bh);
      bgA.globalCompositeOperation = "source-over";
      bgA.globalAlpha = 1;
      bgA.clearRect(0, 0, this.bw, this.bh);
      bgA.globalCompositeOperation = "lighter";
      bgA.globalAlpha = 1 / 7;
      for (let k = -3; k <= 3; k++) bgA.drawImage(this.bB, 0, k * 1.6, this.bw, this.bh);
      g.globalCompositeOperation = "lighter";
      g.globalAlpha = clamp((0.42 + hitstop * 0.5) * view.intensity, 0.1, 0.95) * (q2.glowScale || 1);
      g.drawImage(this.bA, 0, 0, w, h);
      g.globalAlpha = 0.22;
      g.drawImage(this.bA, -w * 4e-3, -h * 6e-3, w * 1.02, h * 1.03);
      perf.draws += 17;
    }
    const v = this.vignette(g);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = clamp(0.72 * (0.6 + view.intensity * 0.5), 0, 0.95);
    if (v instanceof CanvasGradient) {
      g.fillStyle = v;
      g.fillRect(0, 0, w, h);
    } else {
      g.drawImage(v, 0, 0, w, h);
    }
    perf.draws++;
    if (warn > 0.01) {
      g.globalCompositeOperation = "lighter";
      g.globalAlpha = clamp(warn * (0.35 + 0.3 * Math.abs(Math.sin(t * 5))), 0, 0.6);
      g.drawImage(this.dangerVig, 0, 0, w, h);
      perf.draws++;
    }
    if (slow > 0.02) {
      g.globalCompositeOperation = "lighter";
      g.globalAlpha = clamp(slow * 0.1, 0, 0.12);
      g.fillStyle = mixColor(pal.orbit2, "#0a2a4a", 0.55);
      g.fillRect(0, 0, w, h);
      perf.draws++;
      const cx = w * 0.5, cy = h * 0.5;
      const R = Math.hypot(w, h) * 0.5;
      g.globalAlpha = clamp(slow * 0.09, 0, 0.1);
      g.strokeStyle = rgba(mixColor(pal.orbit, "#ffffff", 0.5), 1);
      g.lineWidth = 1.3;
      g.beginPath();
      const N = 48;
      for (let i = 0; i < N; i++) {
        const a = i / N * TAU + Math.sin(t * 0.3 + i) * 0.05;
        const r0 = R * (0.5 + 0.22 * Math.abs(Math.sin(t * 0.7 + i * 1.7)));
        const dx = Math.cos(a), dy = Math.sin(a);
        g.moveTo(cx + dx * r0, cy + dy * r0);
        g.lineTo(cx + dx * R * 1.05, cy + dy * R * 1.05);
      }
      g.stroke();
      perf.draws++;
    }
    if (this.scan) {
      g.globalCompositeOperation = "lighter";
      g.globalAlpha = 0.028;
      g.fillStyle = this.scan;
      g.fillRect(0, 0, w, h);
      perf.draws++;
    }
    const flash = clamp(view.flash, 0, 1);
    if (flash > 4e-3) {
      g.globalCompositeOperation = "lighter";
      g.globalAlpha = flash * 0.75;
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, w, h);
      perf.draws++;
    }
    const fade = clamp(view.fade, 0, 1);
    if (fade > 2e-3) {
      g.globalCompositeOperation = "source-over";
      g.globalAlpha = fade;
      g.fillStyle = "#000000";
      g.fillRect(0, 0, w, h);
      perf.draws++;
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
  }
};
function buildDangerVignette(size) {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  const R = size * 0.5;
  const col = hexToRgb("#ff4d5e");
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.02);
      const a = Math.pow(r, 3.4);
      const i = (y * size + x) * 4;
      d[i] = col >> 16 & 255;
      d[i + 1] = col >> 8 & 255;
      d[i + 2] = col & 255;
      d[i + 3] = a * 255 | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// src/render/renderer.ts
var FX_RING = 64;
var MAX_DPR = 2;
function now() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}
var Renderer = class {
  /**
   * 暴露给 game 层：world.fx 由谁消费。
   * 默认 false —— game.ts 的 drainFx() 已经把每一条 world.fx 转发给 pushFx() 并清空数组，
   * 若再自行摄取会每条特效双重生成。集成方若改为「renderer 自己吃 world.fx」，
   * 把它设成 true，并让 game 层停止转发。
   */
  ingestWorldFx = false;
  stats = { fps: 60, drawCalls: 0, particles: 0 };
  canvas;
  g;
  scene;
  sg;
  bank;
  post;
  parts;
  field = new FieldLayer();
  stars;
  pal;
  q;
  lastVQ;
  env;
  w = 1600;
  h = 900;
  dpr = 1;
  t = 0;
  fps = 60;
  frameMs = 0;
  dbg = { fps: 60, particles: 0, drawCalls: 0, frameMs: 0 };
  camX = 0;
  camY = 0;
  camZoom = 1;
  camInit = false;
  shakeEnv = 0;
  shakeImpulse = 0;
  shX = 0;
  shY = 0;
  shRot = 0;
  warnHold = 0;
  dockInfo = makeDockInfo();
  wellView = makeWellView();
  pred = new PredictionCache();
  dockBody = null;
  fxRing = new Array(FX_RING).fill(null);
  fxHead = 0;
  fxCount = 0;
  fxSeen = /* @__PURE__ */ new WeakSet();
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.g = ctx2d(canvas);
    this.pal = opts.palette;
    this.q = { ...opts.quality || DEFAULT_QUALITY };
    this.lastVQ = { ...this.q };
    this.bank = new SpriteBank(opts.assets);
    this.parts = new Particles(this.q.maxParticles);
    this.stars = new Starfield(this.bank, this.pal);
    this.scene = makeCanvas(1, 1);
    this.sg = ctx2d(this.scene);
    this.post = new PostFX(this.g, this.bank);
    this.post.setQuality(this.q);
    this.env = {
      g: this.sg,
      bank: this.bank,
      pal: this.pal,
      t: 0,
      s: PX_PER_RU,
      inv: 1 / PX_PER_RU,
      gs: this.q.glowScale || 1,
      quality: this.q,
      starX: 0,
      starY: 0,
      budget: 1
    };
    seedRng(1279481170);
    const cw = canvas.clientWidth || canvas.width || 1600;
    const ch = canvas.clientHeight || canvas.height || 900;
    const d = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
    this.resize(cw, ch, Math.min(MAX_DPR, Math.max(1, d)));
    this.installDebug();
  }
  /**
   * window.__LC_DEBUG：自动化测试读取 {fps, particles, drawCalls, frameMs}。
   * game 层每帧会整体赋值 window.__LC_DEBUG（publishDebug），所以这里装一个
   * 「getter 返回稳定对象 + setter 合并对方字段」的访问器：
   * 两边写入都不丢，四个渲染指标始终是本渲染器的权威值。
   */
  installDebug() {
    if (typeof window === "undefined") return;
    const g = window;
    const existing = g.__LC_DEBUG;
    if (existing && typeof existing === "object") this.mergeDebug(existing);
    try {
      Object.defineProperty(window, "__LC_DEBUG", {
        configurable: true,
        enumerable: true,
        get: () => this.dbg,
        set: (v) => {
          if (v && typeof v === "object") this.mergeDebug(v);
          this.writeDebug();
        }
      });
    } catch (e) {
      this.mergeDebug({ __LC_DEBUG: void 0 });
      g.__LC_DEBUG = this.dbg;
    }
    this.writeDebug();
  }
  mergeDebug(src) {
    const dst = this.dbg;
    for (const k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) dst[k] = src[k];
    }
  }
  writeDebug() {
    this.dbg.fps = this.fps;
    this.dbg.particles = this.parts.live;
    this.dbg.drawCalls = perf.draws;
    this.dbg.frameMs = this.frameMs;
  }
  /* ------------------------------------------------------------ 尺寸 */
  resize(w, h, dpr) {
    const nw = Math.max(1, Math.round(w));
    const nh = Math.max(1, Math.round(h));
    const nd = clamp(dpr > 0 ? dpr : 1, 0.5, MAX_DPR * 2);
    const dw = Math.max(1, Math.round(nw * nd));
    const dh = Math.max(1, Math.round(nh * nd));
    const changed = nw !== this.w || nh !== this.h || nd !== this.dpr;
    this.w = nw;
    this.h = nh;
    this.dpr = nd;
    if (this.canvas.width !== dw) this.canvas.width = dw;
    if (this.canvas.height !== dh) this.canvas.height = dh;
    if (this.canvas.style) {
      this.canvas.style.width = nw + "px";
      this.canvas.style.height = nh + "px";
    }
    if (this.scene.width !== dw) this.scene.width = dw;
    if (this.scene.height !== dh) this.scene.height = dh;
    this.sg.setTransform(nd, 0, 0, nd, 0, 0);
    this.post.resize(nw, nh, nd);
    if (changed) this.field.invalidate();
  }
  syncSize(view) {
    if (!view) return;
    const vw = view.w, vh = view.h, vd = view.dpr;
    if (vw > 0 && vh > 0 && (vw !== this.w || vh !== this.h || vd > 0 && vd !== this.dpr)) {
      this.resize(vw, vh, vd > 0 ? vd : this.dpr);
    }
  }
  /* ------------------------------------------------------------ 调色板 / 质量 */
  setPalette(p) {
    this.pal = p;
    this.env.pal = p;
    this.stars.setPalette(p);
    this.field.invalidate();
  }
  setQuality(q2) {
    const t = this.q;
    if (q2.maxParticles !== void 0) t.maxParticles = q2.maxParticles;
    if (q2.trails !== void 0) t.trails = q2.trails;
    if (q2.bloom !== void 0) t.bloom = q2.bloom;
    if (q2.chroma !== void 0) t.chroma = q2.chroma;
    if (q2.fieldContours !== void 0) t.fieldContours = q2.fieldContours;
    if (q2.starLayers !== void 0) t.starLayers = q2.starLayers;
    if (q2.glowScale !== void 0) t.glowScale = q2.glowScale;
    if (q2.targetFps !== void 0) t.targetFps = q2.targetFps;
    this.applyQuality();
  }
  /** view.quality 变了才覆盖内部质量（setQuality 的效果不会被未变化的 view.quality 冲掉） */
  syncQuality(vq) {
    if (!vq) return;
    const l = this.lastVQ;
    if (vq.maxParticles === l.maxParticles && vq.trails === l.trails && vq.bloom === l.bloom && vq.chroma === l.chroma && vq.fieldContours === l.fieldContours && vq.starLayers === l.starLayers && vq.glowScale === l.glowScale && vq.targetFps === l.targetFps) return;
    l.maxParticles = vq.maxParticles;
    l.trails = vq.trails;
    l.bloom = vq.bloom;
    l.chroma = vq.chroma;
    l.fieldContours = vq.fieldContours;
    l.starLayers = vq.starLayers;
    l.glowScale = vq.glowScale;
    l.targetFps = vq.targetFps;
    this.setQuality(vq);
  }
  applyQuality() {
    const q2 = this.q;
    this.parts.setCapacity(Math.max(64, q2.maxParticles | 0));
    this.post.setQuality(q2);
    this.field.invalidate();
    this.env.gs = q2.glowScale > 0 ? q2.glowScale : 1;
    this.env.quality = q2;
  }
  /* ------------------------------------------------------------ 特效队列 */
  pushFx(ev) {
    if (!ev) return;
    const i = this.fxHead;
    this.fxRing[i] = ev;
    this.fxHead = i + 1 >= FX_RING ? 0 : i + 1;
    if (this.fxCount < FX_RING) this.fxCount++;
  }
  drainFx(world, view) {
    if (this.fxCount === 0) return;
    const n = this.fxCount;
    this.fxCount = 0;
    let start = this.fxHead - n;
    if (start < 0) start += FX_RING;
    for (let k = 0; k < n; k++) {
      let i = start + k;
      if (i >= FX_RING) i -= FX_RING;
      const ev = this.fxRing[i];
      this.fxRing[i] = null;
      if (ev) this.parts.emit(ev, world, this.pal, view, this.bank);
    }
  }
  /** world.fx 由 sim/game 填充：按对象身份去重（同一事件只吃一次），保证「清空后重建」与「追加」两种约定都成立 */
  ingestWorldFxEvents(world, view) {
    if (!this.ingestWorldFx) return;
    const arr = world.fx;
    if (!arr || arr.length === 0) return;
    const n = arr.length;
    const start = n > 48 ? n - 48 : 0;
    for (let i = start; i < n; i++) {
      const ev = arr[i];
      if (!ev || this.fxSeen.has(ev)) continue;
      this.fxSeen.add(ev);
      this.parts.emit(ev, world, this.pal, view, this.bank);
    }
  }
  /* ------------------------------------------------------------ 相机 / 屏震 */
  updateCamera(world, view, dt) {
    const cam = view.camera;
    if (!cam) return;
    const wantX = cam.x;
    const wantY = cam.y;
    let wantZ = view.targetZoom > 0.01 ? view.targetZoom : cam.zoom;
    if (!(wantZ > 0.01)) wantZ = 1;
    wantZ = clamp(wantZ, 0.12, 8);
    if (!this.camInit) {
      this.camInit = true;
      this.camX = wantX;
      this.camY = wantY;
      this.camZoom = wantZ;
    } else {
      this.camX = wantX;
      this.camY = wantY;
      const k = 1 - Math.exp(-dt * 7.5);
      this.camZoom += (wantZ - this.camZoom) * k;
    }
    cam.x = this.camX;
    cam.y = this.camY;
    cam.zoom = this.camZoom;
  }
  updateShake(view, dt) {
    this.shakeImpulse *= Math.exp(-dt * 2.6);
    if (this.shakeImpulse < 2e-3) this.shakeImpulse = 0;
    const amp = clamp(view.shake, 0, 3) * 10 + clamp(this.shakeImpulse, 0, 3) * 8;
    this.shakeEnv += (amp - this.shakeEnv) * (1 - Math.exp(-dt * 16));
    if (this.shakeEnv < 0.01) {
      this.shakeEnv = 0;
      this.shX = 0;
      this.shY = 0;
      this.shRot = 0;
      return;
    }
    const t = this.t;
    const nx = wo(t, 41.3, 0.7) * 0.55 + wo(t, 27.1, 2.3) * 0.3 + wo(t, 63.7, 4.1) * 0.15;
    const ny = wo(t, 37.9, 1.9) * 0.55 + wo(t, 31.7, 3.7) * 0.3 + wo(t, 71.3, 5.3) * 0.15;
    const nr = wo(t, 23.3, 2.7);
    this.shX = nx * this.shakeEnv * 0.5;
    this.shY = ny * this.shakeEnv * 0.5;
    this.shRot = clamp(nr * this.shakeEnv * 35e-5, -698e-5, 698e-5);
  }
  slowAmount(world, view) {
    let s = 0;
    const cand = [view.slowmo, world.slowmo, world.timeScale];
    for (let i = 0; i < cand.length; i++) {
      const v = cand[i];
      if (v > 0 && v < 1) {
        const k = 1 - v;
        if (k > s) s = k;
      }
    }
    return clamp(s, 0, 1);
  }
  /* ------------------------------------------------------------ 主帧 */
  frame(world, alpha, dtReal, view) {
    const t0 = now();
    const dt = clamp(dtReal > 0 ? dtReal : 1 / 60, 5e-4, 0.1);
    const a = clamp(alpha, 0, 1);
    perf.draws = 0;
    this.syncSize(view);
    if (view) this.syncQuality(view.quality);
    this.bank.tick();
    this.t += dt;
    const inst = 1 / clamp(dtReal > 0 ? dtReal : 1 / 60, 5e-4, 0.5);
    this.fps += (inst - this.fps) * 0.08;
    this.drainFx(world, view);
    this.ingestWorldFxEvents(world, view);
    this.shakeImpulse += this.parts.impulse;
    this.parts.impulse = 0;
    if (this.parts.warn > 0) this.warnHold = 1;
    else this.warnHold *= Math.exp(-dt * 1.6);
    this.parts.warn = 0;
    const slow = this.slowAmount(world, view);
    const hitstop = clamp(view.hitstop, 0, 1);
    const dtP = dt * (1 - 0.72 * slow) * (1 - hitstop * 0.85);
    this.parts.update(dtP, world);
    this.updateCamera(world, view, dt);
    this.updateShake(view, dt);
    this.stars.update(dt);
    this.drawScene(world, a, view, dt, slow);
    this.post.composite(this.scene, view, this.pal, this.t, clamp(this.warnHold, 0, 1), slow, hitstop);
    const ms = now() - t0;
    this.frameMs += (ms - this.frameMs) * 0.1;
    this.stats.fps = this.fps;
    this.stats.drawCalls = perf.draws;
    this.stats.particles = this.parts.live;
    this.writeDebug();
  }
  /** 关卡开始/结束：清空残留特效与拖尾、缓存 */
  reset() {
    this.parts.reset();
    this.field.invalidate();
    this.pred.clear();
    this.fxRing.fill(null);
    this.fxHead = 0;
    this.fxCount = 0;
    this.fxSeen = /* @__PURE__ */ new WeakSet();
    this.shakeEnv = 0;
    this.shakeImpulse = 0;
    this.shX = 0;
    this.shY = 0;
    this.shRot = 0;
    this.warnHold = 0;
    this.post.reset();
    this.camInit = false;
  }
  /* ------------------------------------------------------------ 场景绘制 */
  drawScene(world, a, view, dt, slow) {
    const sg = this.sg;
    const w = this.w, h = this.h;
    sg.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    sg.globalCompositeOperation = "source-over";
    sg.globalAlpha = 1;
    sg.lineCap = "butt";
    sg.lineJoin = "miter";
    sg.setLineDash(DASH_EMPTY);
    this.stars.draw(sg, this.camX, this.camY, this.camZoom, w, h, this.shX, this.shY, this.q);
    const s = PX_PER_RU * this.camZoom;
    const env = this.env;
    env.g = sg;
    env.pal = this.pal;
    env.t = this.t;
    env.s = s;
    env.inv = 1 / s;
    env.gs = this.q.glowScale > 0 ? this.q.glowScale : 1;
    env.quality = this.q;
    env.budget = clamp(view.intensity, 0.2, 1);
    let starX = 0, starY = 0, found = false;
    const bodies = world.bodies;
    for (let i = 0; i < bodies.length; i++) {
      if (bodies[i].kind === "star") {
        starX = bodies[i].px + (bodies[i].x - bodies[i].px) * a;
        starY = bodies[i].py + (bodies[i].y - bodies[i].py) * a;
        found = true;
        break;
      }
    }
    env.starX = starX;
    env.starY = starY;
    sg.save();
    sg.translate(w * 0.5 + this.shX, h * 0.5 + this.shY);
    if (this.shRot !== 0) sg.rotate(this.shRot);
    sg.scale(s, s);
    sg.translate(-this.camX, -this.camY);
    const viewR = 0.5 * Math.hypot(w, h) / s + 0.5;
    const hw = w * 0.5 / s;
    const hh = h * 0.5 / s;
    drawGrid(env, this.camX, this.camY, viewR, world.bounds);
    let prox = 0;
    const wl = world.well;
    if (wl) {
      const dmax = Math.hypot(wl.px + (wl.x - wl.px) * a, wl.py + (wl.y - wl.py) * a);
      prox = clamp((dmax - world.bounds * 0.72) / (world.bounds * 0.28 || 1), 0, 1);
    }
    const podsArr = world.pods;
    for (let i = 0; i < podsArr.length; i++) {
      const p = podsArr[i];
      const d = Math.hypot(p.x, p.y) / (world.bounds || 1);
      if (d > prox) prox = clamp((d - 0.72) / 0.28, 0, 1);
    }
    drawBounds(env, world.bounds, prox);
    if (view.showOrbits) drawOrbits(env, world, starX, starY);
    this.field.draw(env, world, dt, !!view.showField && !!this.q.fieldContours, !!view.showVectors);
    if (view.showPredict) {
      this.pred.update(world, dt);
      const gr = podsArr.length > 0 ? podsArr[0].radius : 0.012;
      drawPredicted(env, world, this.pred, Math.max(gr, 8e-3));
    }
    if (view.showVectors) drawVelocityVectors(env, world);
    if (this.q.trails) {
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        if (b.trailN < 2) continue;
        const bx = b.px + (b.x - b.px) * a;
        const by = b.py + (b.y - b.py) * a;
        if (Math.abs(bx - this.camX) > hw + 1 || Math.abs(by - this.camY) > hh + 1) continue;
        const col = b.kind === "pod" ? this.pal.pod : b.kind === "station" ? this.pal.station : b.kind === "star" ? this.pal.star2 : tintColor(this.pal, b.tint);
        drawTrail(sg, b, col, env.inv, b.kind === "pod" ? 0.62 : 0.4, bx, by);
      }
    }
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const bx = b.px + (b.x - b.px) * a;
      const by = b.py + (b.y - b.py) * a;
      const pad = Math.max(0.4, b.radius * 24);
      if (Math.abs(bx - this.camX) > hw + pad || Math.abs(by - this.camY) > hh + pad) continue;
      drawBodyAt(env, b, bx, by);
    }
    const dock = world.dock;
    if (dock) {
      const di = this.dockInfo;
      di.x = dock.x;
      di.y = dock.y;
      di.r = dock.radius || 0.05;
      di.vMax = dock.vMax || 0.09;
      di.pulse = clamp(dock.pulse, 0, 1);
      di.hasPod = false;
      let best = Infinity;
      for (let i = 0; i < podsArr.length; i++) {
        const p = podsArr[i];
        if (p.delivered || p.lost) continue;
        const dd = (p.x - dock.x) * (p.x - dock.x) + (p.y - dock.y) * (p.y - dock.y);
        if (dd < best) {
          best = dd;
          di.hasPod = true;
          di.px = p.px + (p.x - p.px) * a;
          di.py = p.py + (p.y - p.py) * a;
          const db = this.resolveDockBody(world);
          const dvx = p.vx - (db ? db.vx : 0);
          const dvy = p.vy - (db ? db.vy : 0);
          di.rvx = dvx;
          di.rvy = dvy;
          di.vrel = Math.hypot(dvx, dvy);
          di.ok = di.vrel < di.vMax;
        }
      }
      drawDock(env, di);
    }
    if (wl) {
      const wv = this.wellView;
      wv.x = wl.px + (wl.x - wl.px) * a;
      wv.y = wl.py + (wl.y - wl.py) * a;
      wv.tx = wl.tx;
      wv.ty = wl.ty;
      wv.mass = wl.mass;
      wv.k = wl.k;
      wv.engaged = wl.engaged;
      wv.repel = wl.repel;
      wv.intensity = wl.intensity;
      wv.thrust = wl.thrust;
      drawWell(env, wv);
    }
    this.parts.draw(env);
    sg.restore();
    sg.globalAlpha = 1;
    sg.globalCompositeOperation = "source-over";
    sg.setLineDash(DASH_EMPTY);
  }
  resolveDockBody(world) {
    const id = world.dock ? world.dock.bodyId : -1;
    if (this.dockBody && this.dockBody.id === id) return this.dockBody;
    this.dockBody = null;
    for (let i = 0; i < world.bodies.length; i++) {
      if (world.bodies[i].id === id) {
        this.dockBody = world.bodies[i];
        break;
      }
    }
    return this.dockBody;
  }
};
var DASH_EMPTY = [];
function drawBodyAt(env, b, x, y) {
  const ox = b.x, oy = b.y;
  b.x = x;
  b.y = y;
  try {
    drawBody(env, b);
  } finally {
    b.x = ox;
    b.y = oy;
  }
}

// src/game/autopilot.ts
function createPilot() {
  return { podIndex: -1, mode: "idle", switched: -99, thrustAcc: 0 };
}
var KP = 1.1;
var KD = 1.9;
var A_MAX_CMD = 0.75;
var R_MIN = 0.2;
var R_MAX = 1;
function autopilot(world, st, tel) {
  const w = world.well;
  const dock = world.dock;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < world.pods.length; i++) {
    const p = world.pods[i];
    if (!p.alive || p.delivered) continue;
    const d = Math.hypot(p.x - dock.x, p.y - dock.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best < 0) {
    st.mode = "idle";
    w.engaged = false;
    if (tel) {
      tel.active = false;
      tel.targetIndex = -1;
    }
    return;
  }
  st.podIndex = best;
  const pod = world.pods[best];
  const station = world.primaries.find((p) => p.id === dock.bodyId);
  const svx = station ? station.vx : 0;
  const svy = station ? station.vy : 0;
  let adx = KP * (dock.x - pod.x) + KD * (svx - pod.vx);
  let ady = KP * (dock.y - pod.y) + KD * (svy - pod.vy);
  let amag = Math.hypot(adx, ady);
  if (amag < 1e-6) {
    adx = 1;
    ady = 0;
    amag = 1;
  }
  const scale = Math.min(1, A_MAX_CMD / amag);
  adx *= scale;
  ady *= scale;
  amag = Math.min(amag, A_MAX_CMD);
  const rWant = R_MIN + (R_MAX - R_MIN) * (1 - Math.min(1, amag / 0.9));
  const r = Math.max(R_MIN, Math.min(R_MAX, rWant));
  const mass = Math.max(WELL_MASS_MIN, Math.min(WELL_MASS_MAX, amag * r * r));
  const ux = adx / (amag || 1), uy = ady / (amag || 1);
  w.tx = pod.x + ux * r;
  w.ty = pod.y + uy * r;
  w.mass = mass;
  w.targetMass = mass;
  w.engaged = true;
  w.repel = false;
  w.precise = false;
  st.mode = "track";
  st.thrustAcc += w.thrust;
  if (tel) {
    tel.active = true;
    tel.targetIndex = best;
    tel.distance = Math.hypot(dock.x - pod.x, dock.y - pod.y);
    tel.closing = ((dock.x - pod.x) * pod.vx + (dock.y - pod.y) * pod.vy) / Math.max(tel.distance, 1e-6);
    tel.aDes = amag;
  }
}

// tools/smoke/sim_render_smoke.ts
var q = new URLSearchParams(location.search);
var assetBase = q.get("asset") ?? "/assets/";
var levelIdx = Number(q.get("level") ?? "0") || 0;
var simSeconds = Number(q.get("sim") ?? "26") || 26;
var report = document.getElementById("rep");
var checks = [];
var check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
};
var chapters = [
  { index: 1, name_zh: "\u53CC\u661F\u6447\u7BEE", name_en: "Binary Cradle", palette: "loop1", music: "loop1", desc_zh: "" },
  { index: 4, name_zh: "\u6DF1\u6E0A\u89C6\u754C", name_en: "Abyss Horizon", palette: "loop4", music: "loop4", desc_zh: "" }
];
var doc = {
  version: "smoke",
  generated_at: (/* @__PURE__ */ new Date()).toISOString(),
  constants: { G: 1, mu_star: 1, epsilon: 0.02, time_scale: 1.6, isp: 320, g0: 9.80665 },
  chapters,
  levels: [
    {
      id: "S-1",
      index: 1,
      chapter: 1,
      name_zh: "\u81EA\u68C0\u5173\u5361",
      name_en: "Smoke",
      difficulty: 2,
      mu_star: 1,
      bounds: 6,
      camera: { x: 0, y: 0, zoom: 1.1 },
      bodies: [
        { id: "star", kind: "star", mass: 1, radius: 0.16, orbit: null, tint: 0, tag: "\u4E3B\u5E8F\u661F" },
        { id: "planetA", kind: "planet", mass: 8e-4, radius: 0.045, orbit: { a: 2.35, e: 0.03, omega: 0, M0: 0.7 }, tint: 1 },
        { id: "stationA", kind: "station", mass: 4e-5, radius: 0.03, orbit: { a: 1.55, e: 0, omega: 0, M0: 2.1 }, tint: 2 }
      ],
      pods: [{ id: "p1", mass: 2e-5, radius: 0.012, hull: 1, sail: 0.7, orbit: { a: 1.9, e: 0.06, omega: 0.4, M0: 1.2 } }],
      dock: { body: "stationA", radius: 0.12, v_max: 0.3 },
      hazards: [{ kind: "wind", period: 14, phase: 0, strength: 0.06, tag: "\u661F\u98CE" }],
      nebulae: [],
      par_time: 40,
      par_fuel: 0.2,
      hint_zh: "",
      hint_en: "",
      palette: "loop1"
    },
    {
      id: "S-4",
      index: 2,
      chapter: 4,
      name_zh: "\u6DF1\u6E0A\u81EA\u68C0",
      name_en: "Abyss Smoke",
      difficulty: 11,
      mu_star: 1,
      bounds: 7,
      camera: { x: 0, y: 0, zoom: 0.9 },
      bodies: [
        { id: "bh", kind: "blackhole", mass: 1.2, radius: 0.05, orbit: null, tint: 1, rs: 0.04 },
        { id: "stationB", kind: "station", mass: 4e-5, radius: 0.03, orbit: { a: 2.2, e: 0.05, omega: 0, M0: 0.4 }, tint: 2 }
      ],
      pods: [
        { id: "p1", mass: 2e-5, radius: 0.012, hull: 1, sail: 0.9, orbit: { a: 2.6, e: 0.12, omega: 0.2, M0: 0.9 } },
        { id: "p2", mass: 2e-5, radius: 0.012, hull: 1, sail: 0.9, orbit: { a: 3.1, e: 0.1, omega: 1.1, M0: 3.3 } }
      ],
      dock: { body: "stationB", radius: 0.12, v_max: 0.25 },
      hazards: [],
      nebulae: [{ x: 1.4, y: -1.1, r: 1, density: 0.03, omega: 0.3 }],
      par_time: 60,
      par_fuel: 0.4,
      hint_zh: "",
      hint_en: "",
      palette: "loop4"
    }
  ]
};
var SmokeAssets = class {
  manifest = {
    version: "smoke",
    generator: "smoke",
    seed: 1,
    generated_at: "",
    audio: [],
    art: [],
    music: [],
    total_bytes: 0
  };
  musicIndex = [];
  assetBase = assetBase;
  imgs = /* @__PURE__ */ new Map();
  failed = [];
  ready = false;
  get errors() {
    return this.failed;
  }
  image(n) {
    return this.imgs.get(n);
  }
  audioBuffer() {
    return void 0;
  }
  audioUrl(n) {
    return `${assetBase}audio/${n}.wav`;
  }
  music() {
    return void 0;
  }
  async load(names) {
    await Promise.all(names.map((n) => new Promise((res) => {
      const im = new Image();
      im.onload = () => {
        this.imgs.set(n, im);
        res();
      };
      im.onerror = () => {
        this.failed.push(n);
        this.imgs.set(n, fallback(n));
        res();
      };
      im.src = `${assetBase}art/${n}.png`;
    })));
    this.ready = true;
  }
};
function fallback(n) {
  const s = 256;
  const cv = document.createElement("canvas");
  cv.width = s;
  cv.height = s;
  const c = cv.getContext("2d");
  const id = c.createImageData(s, s);
  const h = s / 2;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const d = Math.hypot(x - h, y - h) / h;
      const i = (y * s + x) * 4;
      let a = 0;
      if (n.startsWith("glow")) a = Math.max(0, 1 - d) ** 2.2;
      else if (n.startsWith("nebula")) a = Math.max(0, 1 - d) ** 3;
      else if (n === "vignette") a = Math.min(1, Math.max(0, (d - 0.55) / 0.45));
      else a = Math.max(0, 1 - d) ** 1.5;
      id.data[i] = 255;
      id.data[i + 1] = 255;
      id.data[i + 2] = 255;
      id.data[i + 3] = Math.round(a * 255);
    }
  }
  c.putImageData(id, 0, 0);
  const img = new Image();
  img.src = cv.toDataURL();
  return img;
}
async function main() {
  const cv = document.getElementById("cv");
  const W = window.innerWidth, H = window.innerHeight, dpr = 1;
  cv.width = W * dpr;
  cv.height = H * dpr;
  cv.style.width = `${W}px`;
  cv.style.height = `${H}px`;
  const assets = new SmokeAssets();
  await assets.load(["glow_soft", "glow_ring", "spark", "shard", "vignette", "lens_gradient", "ring_dock", "grid_hex", "star_field", "nebula_loop1", "nebula_loop4"]);
  check("\u7D20\u6750\u52A0\u8F7D", assets.errors.length <= 4, `\u5931\u8D25 ${assets.errors.length} \u4E2A: ${assets.errors.join(",")}`);
  const spec = doc.levels[Math.min(levelIdx, doc.levels.length - 1)];
  const world = createWorld(spec, doc, 1);
  check("\u4E16\u754C\u6784\u5EFA", world.bodies.length >= 3 && world.pods.length >= 1, `\u7269\u4F53 ${world.bodies.length} \u4E2A\uFF0C\u4E3B\u5929\u4F53 ${world.primaries.length}\uFF0C\u8D27\u8231 ${world.pods.length}`);
  const renderer = new Renderer(cv, { assets, palette: PALETTES[spec.palette ?? "loop1"], quality: { ...DEFAULT_QUALITY } });
  renderer.resize(W, H, dpr);
  const view = {
    w: W,
    h: H,
    dpr,
    zoom: 1.1,
    targetZoom: 1.1,
    shake: 0,
    hitstop: 0,
    flash: 0,
    chroma: 0,
    showField: !q.has("nofield"),
    showVectors: !q.has("nofield"),
    showPredict: true,
    showOrbits: true,
    slowmo: 1,
    intensity: 0.6,
    fade: 0,
    uiAlpha: 1,
    wellMode: "attract",
    quality: { ...DEFAULT_QUALITY },
    camera: { x: 0, y: 0, zoom: 1.1 }
  };
  const e0 = { e: 0, l: 0 };
  let steps = 0;
  let exceptions = 0;
  let maxAbs = 0;
  let collapsed = 0;
  const t0 = performance.now();
  const frames = [];
  const secPerFrame = 1 / 60;
  const simPerFrame = secPerFrame;
  let simT = 0;
  let podInitR = Math.hypot(world.pods[0].x, world.pods[0].y);
  let minDock = Infinity;
  let renderCalls = 0;
  let fxCount = 0;
  const pilot = createPilot();
  while (simT < simSeconds) {
    await new Promise((r) => requestAnimationFrame(() => r()));
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
        if (renderCalls % 30 === 0 && pod.alive) {
          renderer.pushFx({ kind: "impact", x: pod.x, y: pod.y, nx: Math.cos(simT), ny: Math.sin(simT), mag: 0.7, tint: 4 });
        }
        predictPaths(world, simT, WELL_RANGE, 5, 1 / 40, 6);
        renderer.frame(world, 1, secPerFrame, view);
        renderCalls++;
      } catch (err) {
        exceptions++;
        if (exceptions < 3) console.error("[SMOKE] \u5F02\u5E38", err);
      }
      if (e0.e === 0) {
        e0.e = world.stats.energy0;
        e0.l = world.stats.angular0;
      }
      maxAbs = Math.max(maxAbs, Math.abs(world.well.x), Math.abs(world.well.y));
      const pr2 = Math.hypot(pod ? pod.x : 0, pod ? pod.y : 0);
      if (pod && pod.alive && !pod.delivered && pr2 < 0.2) collapsed++;
      simT += simPerFrame;
      frames.push(performance.now() - ft0);
    }
  }
  const wall = (performance.now() - t0) / 1e3;
  frames.sort((a, b) => a - b);
  const p50 = frames[Math.floor(frames.length * 0.5)] ?? 0;
  const p95 = frames[Math.floor(frames.length * 0.95)] ?? 0;
  const s = world.stats;
  check("\u65E0\u5F02\u5E38", exceptions === 0, `\u5F02\u5E38 ${exceptions} \u6B21`);
  check("\u7269\u7406\u63A8\u8FDB", steps > 1e3 && world.time > simSeconds * 0.9, `${steps} \u6B65 / \u6A21\u62DF\u65F6\u95F4 ${world.time.toFixed(2)} TU`);
  check("\u80FD\u91CF\u5B88\u6052", Math.abs(s.energyDrift) < 0.1, `\u0394E/E=${s.energyDrift.toExponential(3)}\uFF08\u542B\u5F15\u529B\u4E95\u5BF9\u8F7B\u4F53\u505A\u529F\uFF0C\u4E3B\u5929\u4F53\u5B50\u7CFB\u7EDF\u7CBE\u5EA6\u89C1\u4E0B\u4E00\u9879\uFF09`);
  check("\u89D2\u52A8\u91CF\u5B88\u6052", Math.abs(s.angularDrift) < 0.1, `\u0394L/L=${s.angularDrift.toExponential(3)}`);
  check("\u8F68\u9053\u672A\u9000\u5316", world.primaries.every((b) => isFinite(b.x) && isFinite(b.y) && Math.hypot(b.x, b.y) < world.bounds * 2), `\u4E3B\u5929\u4F53\u4F4D\u7F6E\u6709\u9650\u4E14\u5728\u754C\u5185`);
  check("\u8D27\u8231\u88AB\u7275\u5F15", Math.abs(Math.hypot(world.pods[0].x, world.pods[0].y) - podInitR) > 0.02 || world.level.podsDelivered > 0, `\u521D\u59CB\u534A\u5F84 ${podInitR.toFixed(3)} \u2192 \u73B0\u5728 ${Math.hypot(world.pods[0].x, world.pods[0].y).toFixed(3)}`);
  check("\u6E32\u67D3\u6709\u8F93\u51FA", renderCalls > 100 && renderer.stats.particles >= 0, `\u6E32\u67D3 ${renderCalls} \u5E27\uFF0C\u7C92\u5B50 ${renderer.stats.particles}\uFF0Cfps\u2248${renderer.stats.fps.toFixed(1)}`);
  check("\u5E27\u8017\u65F6\u8FBE\u6807", p95 < 33, `p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms\uFF08\u542B\u7269\u7406+\u9884\u6D4B+\u6E32\u67D3\uFF09`);
  check("\u4E8B\u4EF6\u7CFB\u7EDF", fxCount > 0, `\u7D2F\u8BA1 ${fxCount} \u4E2A\u7279\u6548\u4E8B\u4EF6`);
  check("\u5BF9\u63A5\u94FE\u8DEF", world.level.podsDelivered > 0 || minDock < 0.35, `\u5DF2\u5BF9\u63A5 ${world.level.podsDelivered}\uFF0C\u5386\u53F2\u6700\u8FD1\u8DDD\u5BF9\u63A5\u73AF ${minDock === Infinity ? "N/A" : minDock.toFixed(3)} RU\uFF08\u73AF\u534A\u5F84 ${world.dock.radius}\uFF09`);
  const ok = checks.every((c) => c.ok);
  document.title = ok ? "SMOKE:OK" : "SMOKE:FAIL";
  report.innerHTML = `<b class="${ok ? "ok" : "bad"}">SIM+RENDER SMOKE ${ok ? "PASS" : "FAIL"}</b>
\u5173\u5361=${spec.id} \u6A21\u62DF=${world.time.toFixed(2)}TU \u72B6\u6001=${world.status} \u9001\u8FBE=${world.level.podsDelivered}/${world.level.podsTotal} \u635F\u6BC1=${world.level.podsLost}
\u5E27\u8017\u65F6 p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms \u6E32\u67D3\u5E27=${renderCalls} \u7C92\u5B50=${renderer.stats.particles}
\u4E3B\u5929\u4F53\u80FD\u91CF\u6F02\u79FB \u0394E/E=${s.energyDrift.toExponential(3)} \u89D2\u52A8\u91CF \u0394L/L=${s.angularDrift.toExponential(3)}
\u8F68\u8FF9\u9884\u6D4B\u70B9\u6570=${world.predicted.map((p) => p.n).join(",")}

` + checks.map((c) => `${c.ok ? "\u2714" : "\u2718"} ${c.name.padEnd(12)} ${c.detail}`).join("\n");
  console.info("[SMOKE]", JSON.stringify({ ok, checks }));
}
void main().catch((e) => {
  const msg = String(e?.stack ?? e);
  checks.push({ name: "main \u672A\u629B\u5F02\u5E38", ok: false, detail: msg.slice(0, 400) });
  document.title = "SMOKE:FAIL";
  report.innerHTML = `<b class="bad">SMOKE \u5D29\u4E86</b>
${msg}

` + checks.map((c) => `${c.ok ? "\u2714" : "\u2718"} ${c.name} ${c.detail}`).join("\n");
  console.error("[SMOKE] \u5D29\u4E86", e);
});
