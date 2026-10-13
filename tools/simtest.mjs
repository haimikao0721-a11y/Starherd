// tools/simtest.ts
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
function resolvePodSpec(spec) {
  const cls = podClass(spec.class);
  if (cls.id === DEFAULT_POD_CLASS) {
    return { cls, mass: spec.mass, radius: spec.radius, hull: spec.hull ?? 1, sail: spec.sail ?? 1 };
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
var G = 1;
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
var FIELD_ACCEL_MAX = 1.1;
var FIELD_SOFTEN = 0.12;
var STAR_KEEPOUT = 0.22;
var STAR_SHIELD = 0.62;
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
var TEAR_GRACE = 0.45;
function keplerPeriod(mu, a) {
  return 2 * Math.PI * Math.sqrt(a * a * a / Math.max(mu, 1e-9));
}
function rocheLimit(rPrimary, rhoPrimary, rhoSecondary) {
  return rPrimary * Math.cbrt(2 * rhoPrimary / Math.max(rhoSecondary, 1e-9));
}
function tidalTearRadius(mu, bodyMass, bodyRadius) {
  const gSelf = G * bodyMass / (bodyRadius * bodyRadius);
  return Math.cbrt(2 * mu * bodyRadius / Math.max(gSelf, 1e-12));
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
var C_LIGHT = 30;
function relSignificant(mu, r) {
  return mu / (C_LIGHT * C_LIGHT * Math.max(1e-9, r)) > 1e-5;
}
function relAccel(dx, dy, dvx, dvy, muTotal, out) {
  const r2 = dx * dx + dy * dy;
  const r = Math.sqrt(r2);
  if (!relSignificant(muTotal, r)) return;
  const v2 = dvx * dvx + dvy * dvy;
  const rv = dx * dvx + dy * dvy;
  const k = muTotal / (C_LIGHT * C_LIGHT * r2 * r);
  const c1 = 4 * muTotal / r - v2;
  out.x += k * (c1 * dx + 4 * rv * dvx);
  out.y += k * (c1 * dy + 4 * rv * dvy);
}
function pointAccel(dx, dy, mu, eps, out) {
  const k = mu * softenInvCube(dx, dy, eps);
  out.x += k * dx;
  out.y += k * dy;
}
function primaryAccelRel(x, y, vx, vy, primaries, eps, out) {
  for (let i = 0; i < primaries.length; i++) {
    const b = primaries[i];
    if (!b.alive) continue;
    const dx = b.x - x;
    const dy = b.y - y;
    pointAccel(dx, dy, b.mu, eps, out);
    const r2 = dx * dx + dy * dy;
    if (b.kind === "blackhole" && r2 > 1e-12 && relSignificant(b.mu, Math.sqrt(r2))) {
      relAccel(dx, dy, b.vx - vx, b.vy - vy, b.mu, out);
    }
  }
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
  const r = Math.hypot(dx, dy);
  if (r > range * 2.2) return;
  const t = r / range;
  const cut = 1 / (1 + Math.pow(t, 6));
  if (cut < 1e-4) return;
  const soft = Math.max(FIELD_SOFTEN, eps);
  let mag = fieldMass * softenInvCube(dx, dy, soft) * cut;
  if (mag * r > FIELD_ACCEL_MAX) mag = FIELD_ACCEL_MAX / Math.max(r, 1e-6);
  if (repel) mag = -mag;
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
function stateToElements(x, y, vx, vy, mu) {
  const r = Math.hypot(x, y);
  const v2 = vx * vx + vy * vy;
  const a = 1 / (2 / Math.max(r, 1e-6) - v2 / mu);
  const h = x * vy - y * vx;
  const e = Math.sqrt(Math.max(0, 1 - h * h / (mu * Math.max(Math.abs(a), 1e-6))));
  const nu = Math.atan2(y, x);
  const period = a > 0 ? 2 * Math.PI * Math.sqrt(a * a * a / mu) : Infinity;
  return { a, e, omega: 0, nu, period, r };
}
function areaOf(radius) {
  return AREA_K * radius * radius;
}
function conservedQuantities(primaries, light, eps) {
  let ke = 0, pe = 0, angular = 0, px = 0, py = 0;
  for (let i = 0; i < primaries.length; i++) {
    const b = primaries[i];
    if (!b.alive) continue;
    ke += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy);
    angular += b.mass * (b.x * b.vy - b.y * b.vx);
    px += b.mass * b.vx;
    py += b.mass * b.vy;
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
    px += b.mass * b.vx;
    py += b.mass * b.vy;
    for (let j = 0; j < primaries.length; j++) {
      const c = primaries[j];
      if (!c.alive) continue;
      pe -= G * b.mass * c.mass / Math.sqrt((b.x - c.x) ** 2 + (b.y - c.y) ** 2 + eps * eps);
    }
  }
  return { ke, pe, energy: ke + pe, angular, px, py };
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
    for (let pass = 0; pass < 4 && pending.length > 0; pass++) {
      let placedAny = false;
      for (let i = pending.length - 1; i >= 0; i--) {
        const spec = pending[i];
        const par = spec.orbit?.parent;
        if (par && !byKey.has(par)) continue;
        addPrimary(spec.id, spec.kind, spec.mass, spec.radius, spec.tint, spec.orbit, spec.rs);
        pending.splice(i, 1);
        placedAny = true;
      }
      if (!placedAny) break;
    }
    for (const spec of pending) {
      addPrimary(spec.id, spec.kind, spec.mass, spec.radius, spec.tint, spec.orbit && { ...spec.orbit, parent: void 0 }, spec.rs);
    }
  }
  if (!primaries.some((b) => b.kind === "star" || b.kind === "blackhole")) {
    addPrimary("core", "star", 1, 0.16, 0, null);
  }
  for (const spec of level.pods) {
    let x = 0, y = 0, vx = 0, vy = 0;
    if (spec.orbit) {
      const p = placeOrbit(spec.orbit);
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
    const pc = resolvePodSpec(spec);
    const b = makeBody(id++, spec.id, "pod", pc.mass, pc.radius, x, y, vx, vy, 4, false);
    b.tag = spec.id;
    b.class = pc.cls.id;
    b.sail = pc.sail;
    b.hull = pc.hull;
    b.integrity = pc.hull;
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
  const fuelScale = Number(level.fuel_scale ?? 1) || 1;
  const fuelCapacity = (40 + 6 * level.difficulty) * fuelScale;
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
    // 时限（秒）。第 1 章是教学章：给足 180 秒，让玩家能反复试错而不被计时器逼死。
    // 注意时限不参与计分——时间分用的是 parTime（见 score.ts），所以放宽时限不会让分数虚高。
    timeLimit: Math.max(90, level.par_time * 3.4, level.chapter === 1 ? 180 : 0),
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
  world.well.px = world.well.x;
  world.well.py = world.well.y;
  {
    const r0 = Math.hypot(world.well.x, world.well.y);
    if (r0 > 1e-6) {
      const ang = Math.atan2(world.well.y, world.well.x) + 0.12;
      world.well.x = Math.cos(ang) * r0;
      world.well.y = Math.sin(ang) * r0;
      const vc = Math.sqrt(muStar / r0);
      const sense = dockBody.x * dockBody.vy - dockBody.y * dockBody.vx >= 0 ? 1 : -1;
      world.well.vx = -Math.sin(ang) * vc * sense;
      world.well.vy = Math.cos(ang) * vc * sense;
      world.well.px = world.well.x;
      world.well.py = world.well.y;
    }
  }
  world.well.tx = world.well.x;
  world.well.ty = world.well.y;
  world.well.ltx = world.well.x;
  world.well.lty = world.well.y;
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
var ACC = { x: 0, y: 0 };
function lightAccel(world, b, wind) {
  b.ax = 0;
  b.ay = 0;
  if (b.docked || !b.alive) return;
  ACC.x = 0;
  ACC.y = 0;
  primaryAccelRel(b.x, b.y, b.vx, b.vy, world.primaries, world.epsilon, ACC);
  const w = world.well;
  if (world.fieldEnabled && w.engaged && w.mass > 0) {
    wellAccel(b.x, b.y, w.x, w.y, w.mass, WELL_RANGE, w.repel, world.epsilon, ACC);
  }
  const star = mainStar(world);
  if (star) {
    radiationAccel(b.x, b.y, star, b.area, b.sail ?? 1, b.mass, ACC);
    if (wind > 0) {
      const dx = b.x - star.x, dy = b.y - star.y;
      const r = Math.max(WIND_MIN_R, Math.hypot(dx, dy));
      const mag = wind / r;
      ACC.x += mag * dx / r;
      ACC.y += mag * dy / r;
    }
  }
  if (world.nebulae.length) {
    nebulaAt(world, b.x, b.y);
    if (NEB.rho > 0) dragAccel(b.x, b.y, b.vx, b.vy, NEB.rho, b.cd, b.area, b.mass, NEB.omega, ACC);
  }
  b.ax = ACC.x;
  b.ay = ACC.y;
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
        const g = den > 0 ? star0.mu * r / den : 0;
        const inv = 1 / Math.max(r, 1e-6);
        WACC.x += dx * inv * g * blend;
        WACC.y += dy * inv * g * blend;
      }
      w.hot = r < rIn ? 1 : Math.min(1, 0.9 * (1 - (r - rIn) / Math.max(1e-6, rSh - rIn)));
    }
  }
  let fx2 = 0, fy = 0;
  if (w.engaged) {
    fx2 = K_SPRING * (w.tx - w.x) - damp * (w.vx - w.tvx);
    fy = K_SPRING * (w.ty - w.y) - damp * (w.vy - w.tvy);
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
      tearT: 0,
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
function wellConstraint(world) {
  const w = world.well;
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
      if (vr2 > 0) {
        w.vx -= vr2 * nx2;
        w.vy -= vr2 * ny2;
      }
    }
  }
  const star = mainStar(world);
  if (!star) {
    w.hot = 0;
    return;
  }
  const keep = star.radius + STAR_KEEPOUT;
  const dx = w.x - star.x;
  const dy = w.y - star.y;
  const r = Math.hypot(dx, dy);
  if (r >= keep) {
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
  if (vr < 0) {
    w.vx -= vr * nx;
    w.vy -= vr * ny;
  }
  w.hot = 1;
}
function eventAccelAt(world, t, x, y, out) {
  out.x = 0;
  out.y = 0;
  const list = world.level.events;
  if (!list || !list.length) return;
  const span = world.bounds * 2.4;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.kind !== "storm") continue;
    const period = e.period > 0 ? e.period : Number.POSITIVE_INFINITY;
    const u = period === Number.POSITIVE_INFINITY ? t - e.t0 : (t - e.t0) % period;
    if (u < 0) continue;
    const cx = -span * 0.5 + u * e.speed;
    if (Math.abs(cx) > span * 0.75) continue;
    const nx = Math.cos(e.dir);
    const ny = Math.sin(e.dir);
    const d = x * nx + y * ny - cx;
    if (Math.abs(d) > e.width) continue;
    const sig = e.width * 0.45;
    const fall = Math.exp(-(d * d) / (2 * sig * sig));
    out.x += nx * e.accel * fall;
    out.y += ny * e.accel * fall;
  }
}
var EV_TMP = { x: 0, y: 0 };
function applyFlare(world, dt) {
  const list = world.level.events;
  if (!list || !list.length) return;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.kind !== "flare") continue;
    const dur = e.duration ?? 1.2;
    const u = world.time - e.t0;
    if (u < 0 || u > dur) continue;
    const env = Math.sin(u / dur * Math.PI);
    for (let k = 0; k < world.pods.length; k++) {
      const b = world.pods[k];
      if (!b.alive || b.delivered) continue;
      const sail = b.sail ?? 1;
      const thin = (b.hull ?? 1) <= 0.6 ? 1.8 : 0.7;
      b.integrity -= e.accel * (0.35 + sail) * thin * env * dt;
      if (b.integrity <= 0) destroyBody(world, b, "impact_hull", "\u592A\u9633\u8000\u6591\u70E7\u7A7F\u8239\u4F53");
    }
  }
}
function advanceObjective(world) {
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
  fx(
    world,
    "dock",
    world.dock.x,
    world.dock.y,
    0,
    0,
    1,
    9425151,
    "dock_success",
    `\u822A\u6BB5 ${lv.objectiveIndex + 1}/${list.length} \xB7 ${o.label_zh ?? "\u4E0B\u4E00\u4E2A\u76EE\u6807"}`
  );
}
function applyShower(world, dt) {
  const list = world.level.events;
  if (!list || !list.length) return;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.kind !== "shower") continue;
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
function spawnShower(world, e) {
  const n = Math.max(1, Math.min(24, e.count ?? 6));
  const rm = e.rockMass ?? 6e-6;
  const rr = e.rockRadius ?? 0.045;
  const area = Math.PI * rr * rr;
  const nx = Math.cos(e.dir);
  const ny = Math.sin(e.dir);
  const base = 9e6 + world.bodies.length * 32;
  const edge = world.bounds * 1.15;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : (i / (n - 1) - 0.5) * 2;
    const ox = -ny * t * e.width;
    const oy = nx * t * e.width;
    const b = {
      id: base + i,
      key: `rock${base + i}`,
      kind: "asteroid",
      tag: "\u788E\u77F3",
      mass: rm,
      mu: rm,
      radius: rr,
      x: -nx * edge + ox,
      y: -ny * edge + oy,
      vx: nx * e.speed + ox * 0.05,
      vy: ny * e.speed + oy * 0.05,
      ax: 0,
      ay: 0,
      px: -nx * edge + ox,
      py: -ny * edge + oy,
      alive: true,
      integrity: 1,
      area,
      cd: 0.9,
      qpr: 1,
      docked: false,
      delivered: false,
      lost: false,
      tint: 10129286,
      ang: e.dir,
      spin: (i % 2 ? 1 : -1) * (0.5 + i * 0.07),
      primary: false,
      contact: 0,
      jolt: 0,
      stress: 0,
      dilation: 1,
      life: 0,
      tearT: 0,
      trailX: new Float32Array(48),
      trailY: new Float32Array(48),
      trailN: 0,
      trailHead: 0,
      trailTick: 0
    };
    world.bodies.push(b);
  }
}
function applyWave(world, dt) {
  const list = world.level.events;
  if (!list || !list.length) return;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.kind !== "wave") continue;
    const dur = e.duration ?? 2.5;
    const u = world.time - e.t0;
    if (u < 0 || u > dur) continue;
    const env = Math.sin(u / dur * Math.PI);
    const nx = Math.cos(e.dir);
    const ny = Math.sin(e.dir);
    for (let k = 0; k < world.pods.length; k++) {
      const b = world.pods[k];
      if (!b.alive || b.delivered) continue;
      const along = b.x * nx + b.y * ny;
      const perpX = b.x - along * nx;
      const perpY = b.y - along * ny;
      if (Math.hypot(b.x, b.y) > world.bounds * 1.2) continue;
      const aAlong = 0.5 * e.accel * env * along;
      const aPerp = -0.5 * e.accel * env;
      b.vx += (aAlong * nx + aPerp * perpX) * dt;
      b.vy += (aAlong * ny + aPerp * perpY) * dt;
    }
  }
}
function applyRescue(world, dt) {
  const list = world.level.events;
  if (!list || !list.length) return;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.kind !== "rescue") continue;
    if (world.time < e.t0) continue;
    const b = world.pods.find((p) => p.alive && !p.delivered);
    if (!b) continue;
    b.integrity -= (e.leakRate ?? 0.02) * dt;
    if (b.integrity <= 0) {
      destroyBody(world, b, "impact_hull", "\u8239\u4F53\u6CC4\u6F0F\u89E3\u4F53");
    }
  }
}
function applyEvents(world, dt) {
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
  const tearOn = world.level.chapter >= 3 || world.hazards.some((h) => h.kind === "tidal");
  for (let i = 0; i < PODSH.length; i++) {
    const b = PODSH[i];
    if (!b.alive || b.docked || b.kind !== "pod") continue;
    let stress = 0;
    let breaking = 0;
    let breaker = null;
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
        if (s > breaking) {
          breaking = s;
          breaker = p;
        }
      }
    }
    if (!tearOn) {
      breaking = 0;
      breaker = null;
    }
    if (breaking > 0 && breaker) {
      b.tearT += dt;
      if (b.tearT >= TEAR_GRACE) {
        tearBody(world, b, breaker.x, breaker.y);
      }
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
        advanceObjective(world);
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
  updateTrails(world, dt);
}
function frameEnd(world, simDt) {
  const dtReal = simDt * TIME_SCALE;
  const w = world.well;
  if (simDt > 1e-9) {
    const ivx = (w.tx - w.ltx) / simDt;
    const ivy = (w.ty - w.lty) / simDt;
    const k = Math.min(1, dtReal * 14);
    w.tvx += (ivx - w.tvx) * k;
    w.tvy += (ivy - w.tvy) * k;
    w.ltx = w.tx;
    w.lty = w.ty;
  }
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

// src/game/autopilot.ts
function createPilot() {
  return {
    podIndex: -1,
    mode: "idle",
    switched: -99,
    thrustAcc: 0,
    cmdX: 0,
    cmdY: 0,
    hasCmd: false,
    dt: 1 / 60,
    lastBest: Infinity,
    lastBestT: 0,
    retryUntil: 0,
    retryCount: 0
  };
}
var KV = 1.5;
var A_MAX_CMD = 0.6;
var K_A = 0.4;
var A_TANGENT = 0.08;
var KR_E = 1.35;
var PHASE_OFFSET = 0.04;
var PHASE_MAX_OFFSET = 0.25;
var RNDZ_GATE = 1.2;
var R_MIN = 0.25;
var R_MAX = 1;
var TAU = Math.PI * 2;
var DIR_DEADBAND = 0.5;
var SLEW_FAST = 1.1;
var A_DEAD = 0.03;
var KEEP_OUT = 0.5;
var AVOID_MARGIN = 0.06;
var AVOID_RANGE = 3.5;
var AVOID_GAIN = 1.35;
function autopilot(world, st, tel) {
  const w = world.well;
  const dock = world.dock;
  let best = -1;
  let bestD = Infinity;
  let bestScore = Infinity;
  let curD = Infinity;
  let curScore = Infinity;
  const stAng = Math.atan2(dock.y, dock.x);
  const rDock = Math.hypot(dock.x, dock.y);
  for (let i = 0; i < world.pods.length; i++) {
    const p = world.pods[i];
    if (!p.alive || p.delivered) continue;
    const d = Math.hypot(p.x - dock.x, p.y - dock.y);
    const rp = Math.hypot(p.x, p.y);
    let dA = stAng - Math.atan2(p.y, p.x);
    while (dA > Math.PI) dA -= 2 * Math.PI;
    while (dA < -Math.PI) dA += 2 * Math.PI;
    const score = Math.abs(dA) * Math.max(rDock, 1e-6) + 0.8 * Math.abs(rp - rDock);
    if (i === st.podIndex) {
      curD = d;
      curScore = score;
    }
    if (score < bestScore) {
      bestScore = score;
      bestD = d;
      best = i;
    }
  }
  {
    const cur = st.podIndex >= 0 && st.podIndex < world.pods.length ? world.pods[st.podIndex] : null;
    if (cur && cur.alive && !cur.delivered && best !== st.podIndex && Number.isFinite(curScore) && bestScore > 0.7 * curScore) {
      best = st.podIndex;
      bestD = curD;
      bestScore = curScore;
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
  const nowT = Number.isFinite(world.stats.time) ? world.stats.time : 0;
  if (bestD < st.lastBest - 0.02) {
    st.lastBest = bestD;
    st.lastBestT = nowT;
  }
  if (nowT > st.retryUntil && nowT - st.lastBestT > 14 && st.retryCount < 4) {
    st.retryUntil = nowT + 7;
    st.retryCount++;
    st.lastBestT = nowT;
    st.lastBest = bestD;
  }
  const retrying = nowT < st.retryUntil;
  const rPod = Math.max(1e-6, Math.hypot(pod.x, pod.y));
  const rSt = Math.max(1e-6, Math.hypot(dock.x, dock.y));
  const rhatx = pod.x / rPod, rhaty = pod.y / rPod;
  const vmag = Math.max(1e-6, Math.hypot(pod.vx, pod.vy));
  const vhx = pod.vx / vmag, vhy = pod.vy / vmag;
  const vRad = pod.vx * rhatx + pod.vy * rhaty;
  let adx = 0, ady = 0;
  let phase = "spiral";
  const star = world.primaries.find((b) => b.kind === "star" || b.kind === "blackhole") ?? world.primaries[0];
  const mu = star ? star.mu : 1;
  const vc = Math.sqrt(mu / rPod);
  const thx = -rhaty, thy = rhatx;
  const sgn = pod.vx * thx + pod.vy * thy >= 0 ? 1 : -1;
  const tvx0 = sgn * thx, tvy0 = sgn * thy;
  const dx = dock.x - pod.x, dy = dock.y - pod.y;
  const sep = Math.hypot(dx, dy) || 1e-6;
  if (sep > RNDZ_GATE) {
    const els = stateToElements(pod.x, pod.y, pod.vx, pod.vy, mu);
    const Tst = keplerPeriod(mu, Math.max(rSt, 1e-6));
    const aOsc = isFinite(els.a) && els.a > 0 ? els.a : rPod;
    let aTarget = rSt;
    const angPod = Math.atan2(pod.y, pod.x);
    const angSt = Math.atan2(dock.y, dock.x);
    let dAng = angSt - angPod;
    while (dAng > Math.PI) dAng -= 2 * Math.PI;
    while (dAng < -Math.PI) dAng += 2 * Math.PI;
    if (Math.abs(dAng) > 0.12) {
      const phOff = Math.min(PHASE_MAX_OFFSET, Math.max(PHASE_OFFSET, Math.abs(dAng) * 0.18));
      aTarget = rSt - Math.sign(dAng) * phOff;
    }
    if (retrying) aTarget = rSt + 0.15;
    let da = aOsc - aTarget;
    const tearR = tidalTearRadius(mu, pod.mass, pod.radius) * 1.35;
    const core = world.primaries.find((b) => (b.kind === "star" || b.kind === "blackhole") && b.alive);
    const surfR = (core ? core.radius : 0.12) + 0.14;
    const safePeri = Math.max(tearR, surfR);
    const peri = aOsc * (1 - Math.max(0, Math.min(0.95, els.e)));
    if (peri < safePeri) {
      const depth = Math.min(1, (safePeri - peri) / safePeri);
      da = Math.max(da, (safePeri - peri) * (3 + 14 * depth));
    }
    const rRatio = rPod / Math.max(aOsc, 1e-6);
    const periGuard = rRatio > 1 ? 1 : 0.25 + 0.75 * Math.max(0, (rRatio - 0.75) / 0.25);
    const at = Math.max(-A_TANGENT, Math.min(A_TANGENT, -K_A * da * periGuard));
    const at0 = Math.max(-A_TANGENT, Math.min(A_TANGENT, -K_A * da));
    adx = at * tvx0;
    ady = at * tvy0;
    const eBoost = 1 + 6 * Math.min(0.8, Math.max(0, els.e));
    adx += -KR_E * eBoost * vRad * rhatx;
    ady += -KR_E * eBoost * vRad * rhaty;
    phase = "spiral";
  } else {
    const ux0 = dx / sep, uy0 = dy / sep;
    const vClose = -((pod.vx - svx) * ux0 + (pod.vy - svy) * uy0);
    const aNeeded = vClose > 0 ? vClose * vClose / Math.max(2 * sep, 1e-6) : 0;
    const vLim = Math.max(0.05, (dock.vMax || 0.3) * 0.55);
    const vApp = aNeeded > FIELD_ACCEL_MAX * 0.8 ? 0 : Math.min(vLim, sep * 0.45);
    adx = KV * (svx + ux0 * vApp - pod.vx);
    ady = KV * (svy + uy0 * vApp - pod.vy);
    phase = "terminal";
  }
  for (const b of world.bodies) {
    if (!b.alive) continue;
    if (b.kind !== "star" && b.kind !== "blackhole" && b.kind !== "planet" && b.kind !== "asteroid") continue;
    const dbx = pod.x - b.x;
    const dby = pod.y - b.y;
    const rb = Math.hypot(dbx, dby);
    const danger = b.radius + AVOID_MARGIN;
    const isAsteroid = b.kind === "asteroid";
    const isBig = b.kind === "star" || b.kind === "blackhole";
    const range = isAsteroid ? AVOID_RANGE * 1.7 : AVOID_RANGE;
    const horizon = isBig ? 3 : 4;
    const dangerEff = danger + (isBig ? 0.06 : 0);
    const outer = dangerEff * range;
    if (rb > outer) continue;
    const nbx = dbx / (rb || 1e-9);
    const nby = dby / (rb || 1e-9);
    const rvx = pod.vx - b.vx;
    const rvy = pod.vy - b.vy;
    const vCloseB = rvx * nbx + rvy * nby;
    if (vCloseB > 0) continue;
    const vv2 = rvx * rvx + rvy * rvy;
    const tca = vv2 > 1e-12 ? -(dbx * rvx + dby * rvy) / vv2 : 0;
    if (tca < 0) continue;
    const tH = Math.min(tca, horizon);
    const miss = Math.hypot(dbx + rvx * tH, dby + rvy * tH);
    if (miss > dangerEff) continue;
    const need = vCloseB * vCloseB / Math.max(2 * Math.max(rb - dangerEff, 1e-3), 1e-6);
    const urgency = Math.max(0, 1 - rb / outer);
    const cap = urgency > 0.5 ? FIELD_ACCEL_MAX : A_MAX_CMD;
    const k = Math.min(cap, need) * urgency * AVOID_GAIN;
    if (k <= 0) continue;
    adx += nbx * k;
    ady += nby * k;
    if (tel) tel.avoid = (tel.avoid ?? 0) + 1;
  }
  {
    const elsA = stateToElements(pod.x, pod.y, pod.vx, pod.vy, mu);
    const aA = Number.isFinite(elsA.a) && elsA.a > 0 ? elsA.a : rPod;
    const periA = aA * (1 - Math.max(0, Math.min(0.95, elsA.e)));
    const coreA = world.primaries.find((b) => (b.kind === "star" || b.kind === "blackhole") && b.alive);
    const safeA = Math.max(
      tidalTearRadius(mu, pod.mass, pod.radius) * 1.35,
      (coreA ? coreA.radius : 0.12) + 0.14
    );
    if (periA < safeA) {
      const deficit = safeA - periA;
      const kA = Math.min(A_MAX_CMD, deficit * 6) * (phase === "terminal" ? 1 : 0.5);
      adx += vhx * kA;
      ady += vhy * kA;
      if (tel) tel.abort = true;
    }
  }
  let amag = Math.hypot(adx, ady);
  if (amag < 1e-6) {
    adx = vhx;
    ady = vhy;
    amag = 1e-3;
  }
  const scale = Math.min(1, A_MAX_CMD / amag);
  adx *= scale;
  ady *= scale;
  amag = Math.min(amag, A_MAX_CMD);
  if (amag < A_DEAD && sep < 0.15) {
    w.mass = WELL_MASS_MIN;
    w.targetMass = WELL_MASS_MIN;
    w.engaged = true;
    w.repel = false;
    w.precise = true;
    st.cmdX = w.x;
    st.cmdY = w.y;
    st.hasCmd = true;
    if (tel) {
      tel.active = true;
      tel.targetIndex = best;
      tel.distance = sep;
      tel.closing = 0;
      tel.aDes = amag;
      tel.rPod = rPod;
      tel.rStation = rSt;
      tel.phase = phase;
      tel.fuel = world.fuel;
      tel.dWellPod = Math.hypot(w.x - pod.x, w.y - pod.y);
      tel.dirErr = 0;
      tel.deadband = true;
    }
    return;
  }
  if (tel) tel.deadband = false;
  const rWant = R_MIN + (R_MAX - R_MIN) * (1 - Math.min(1, amag / 0.9));
  const r = Math.max(R_MIN, Math.min(R_MAX, rWant));
  const rActual = Math.hypot(w.x - pod.x, w.y - pod.y);
  const rEff = Math.max(R_MIN, Math.min(r, rActual));
  const cut = 1 / (1 + Math.pow(rEff / WELL_RANGE, 6));
  const mass = Math.max(WELL_MASS_MIN, Math.min(WELL_MASS_MAX, amag * rEff * rEff / Math.max(cut, 1e-3)));
  const ux = adx / (amag || 1), uy = ady / (amag || 1);
  let wantX = pod.x + ux * r;
  let wantY = pod.y + uy * r;
  if (st.hasCmd) {
    const cdx = st.cmdX - pod.x;
    const cdy = st.cmdY - pod.y;
    const cd = Math.hypot(cdx, cdy);
    if (cd > 1e-6 && cd < R_MAX * 1.6) {
      const cosT = (cdx * ux + cdy * uy) / cd;
      if (cosT > Math.cos(DIR_DEADBAND)) {
        wantX = st.cmdX;
        wantY = st.cmdY;
      }
    }
  }
  const wr = Math.hypot(w.x, w.y);
  if (wr < KEEP_OUT) {
    const k = (KEEP_OUT + 0.25) / Math.max(wr, 1e-3);
    wantX = w.x * k;
    wantY = w.y * k;
  }
  if (st.hasCmd) {
    const mdx = wantX - st.cmdX, mdy = wantY - st.cmdY;
    const md = Math.hypot(mdx, mdy);
    const slewEff = SLEW_FAST;
    const maxStep = slewEff * st.dt;
    if (md > maxStep && md > 1e-9) {
      wantX = st.cmdX + mdx / md * maxStep;
      wantY = st.cmdY + mdy / md * maxStep;
    }
  }
  st.cmdX = wantX;
  st.cmdY = wantY;
  st.hasCmd = true;
  w.tx = wantX;
  w.ty = wantY;
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
    tel.rPod = rPod;
    tel.rStation = rSt;
    tel.phase = phase;
    tel.fuel = world.fuel;
    const ddx = w.x - pod.x, ddy = w.y - pod.y;
    tel.dWellPod = Math.hypot(ddx, ddy);
    const cosang = (adx * ddx + ady * ddy) / Math.max(1e-9, amag * tel.dWellPod);
    tel.dirErr = Math.acos(Math.max(-1, Math.min(1, cosang))) * 180 / Math.PI;
  }
}

// tools/simtest.ts
var args = process.argv.slice(2);
var path = args.find((a) => !a.startsWith("--"));
var maxTU = Number(args.find((a) => /^\d+(\.\d+)?$/.test(a)) ?? 80);
var verbose = args.includes("--verbose");
var only = args.find((a) => a.startsWith("--level="))?.split("=")[1];
if (!path) {
  console.error("\u7528\u6CD5: node tools/simtest.mjs <levels.json> [maxTU] [--verbose] [--level=ID]");
  process.exit(2);
}
var doc = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
var rows = [];
function specA(level, key) {
  const b = level.bodies.find((x) => x.id === key);
  if (!b?.orbit) return 0;
  return b.orbit.e > 1e-6 ? 0 : b.orbit.a;
}
var levels = only ? doc.levels.filter((l) => l.id === only) : doc.levels;
console.log(`[simtest] ${levels.length} \u5173\uFF0C\u6BCF\u5173\u6700\u591A ${maxTU} TU \u6A21\u62DF\u65F6\u95F4`);
console.log("id      \u7ED3\u679C  \u7528\u65F6TU  \u9001\u8FBE \u635F\u6BC1  \u6700\u8FD1\u8DDD  \u6700\u5C0F|v_rel|  \u71C3\u6599\u0394v   \u0394E/E      \u0394L/L      \u6B65\u6570/\u5B50\u6B65");
for (const level of levels) {
  const world = createWorld(level, doc, 1);
  if (args.includes("--init")) {
    console.log(`   [init] ${level.id} \u7269\u4F53 ${world.bodies.length}\uFF1A`);
    for (const b of world.bodies.slice(0, 40)) {
      const bad = !isFinite(b.x) || !isFinite(b.y) || !isFinite(b.vx) || !isFinite(b.vy);
      if (bad || world.bodies.length <= 10) {
        console.log(`     ${bad ? "\u2718" : "\u2714"} ${b.key.padEnd(10)} ${b.kind.padEnd(9)} x=${b.x} y=${b.y} vx=${b.vx} vy=${b.vy}`);
      }
    }
    const nb = world.bodies.filter((b) => !isFinite(b.x) || !isFinite(b.vx));
    console.log(`   [init] \u975E\u6709\u9650\u521D\u59CB\u72B6\u6001\u7684\u7269\u4F53\u6570 = ${nb.length}${nb.length ? " \u2192 " + nb.map((b) => b.key).join(",") : ""}`);
  }
  const pilot = createPilot();
  let minDock = Infinity;
  let minVrel = Infinity;
  let t = 0;
  const dt = 1 / 60;
  let lastLog = 0;
  const trace = args.includes("--trace");
  const keplerOnly = args.includes("--kepler");
  const tel = {
    active: false,
    targetIndex: -1,
    distance: 0,
    closing: 0,
    aDes: 0,
    rPod: 0,
    rStation: 0,
    phase: "idle",
    fuel: 0,
    dWellPod: 0,
    dirErr: 0,
    deadband: false
  };
  const events = [];
  const eventsSeen = /* @__PURE__ */ new Set();
  const rRange = /* @__PURE__ */ new Map();
  const star = world.primaries.find((b) => b.kind === "star" || b.kind === "blackhole");
  let precheck = "";
  if (star) {
    const pod = world.pods[0];
    const lim = rocheLimit(star.radius, sphereDensity(star.mass, star.radius), sphereDensity(pod.mass, pod.radius) || 2.6);
    const r0 = Math.hypot(pod.x - star.x, pod.y - star.y);
    precheck = r0 < lim ? `\u26A0\u521D\u59CB\u534A\u5F84 ${r0.toFixed(2)} < \u6D1B\u5E0C\u6781\u9650 ${lim.toFixed(2)}` : "";
  }
  while (t < maxTU && world.status === "running") {
    if (keplerOnly) {
      world.well.engaged = false;
      world.well.mass = 0;
      world.well.targetMass = 0;
    } else {
      autopilot(world, pilot, tel);
    }
    advance(world, dt, 12);
    if (args.includes("--init") && t < 0.06) {
      const nb = world.bodies.filter((b) => !isFinite(b.x) || !isFinite(b.y) || !isFinite(b.vx) || !isFinite(b.vy));
      console.log(`   [step t=${t.toFixed(3)}] \u975E\u6709\u9650\u7269\u4F53 ${nb.length}${nb.length ? " \u2192 " + nb.slice(0, 6).map((b) => `${b.key}(${b.kind}) x=${b.x} vx=${b.vx} ax=${b.ax}`).join(" | ") : ""}`);
    }
    t += dt;
    for (const ev of world.fx) {
      if (!eventsSeen.has(ev.kind + (ev.text ?? ""))) {
        eventsSeen.add(ev.kind + (ev.text ?? ""));
        events.push(`t=${t.toFixed(2)} ${ev.kind}${ev.text ? "\u300C" + ev.text + "\u300D" : ""} @(${ev.x.toFixed(2)},${ev.y.toFixed(2)}) mag=${ev.mag.toFixed(2)}`);
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
      const r2 = Math.hypot(b.x - world.primaries[0].x, b.y - world.primaries[0].y);
      if (!rRange.has(b.key)) rRange.set(b.key, { min: r2, max: r2, a: specA(level, b.key) });
      const e = rRange.get(b.key);
      e.min = Math.min(e.min, r2);
      e.max = Math.max(e.max, r2);
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
      console.log(`   t=${t.toFixed(1)} podR=${Math.hypot(p.x, p.y).toFixed(2)} rSt=${tel.rStation.toFixed(2)} |v|=${Math.hypot(p.vx, p.vy).toFixed(3)} dDock=${d.toFixed(3)} |vrel|=${rv.toFixed(3)} wellR=${Math.hypot(world.well.x, world.well.y).toFixed(2)} dwp=${tel.dWellPod.toFixed(2)} dirErr=${tel.dirErr.toFixed(0)}\xB0 mass=${world.well.mass.toFixed(3)} fuel=${world.fuel.toFixed(1)} ${tel.phase}`);
    }
  }
  const ok = world.status === "won";
  if (events.length && (verbose || trace)) {
    console.log("   \u4E8B\u4EF6: " + events.join("\n         "));
  }
  if (keplerOnly) {
    console.log("   \u5F00\u666E\u52D2\u56DE\u5F52\uFF08\u65E0\u5F15\u529B\u4E95\uFF09\uFF1A");
    for (const [k, v] of rRange) {
      const circ = v.a > 0;
      const dev = circ ? Math.abs(v.max - v.min) / v.a : 0;
      const okK = !circ || dev < 0.02;
      console.log(`     ${k.padEnd(10)} a=${v.a.toFixed(3)} r\u2208[${v.min.toFixed(3)}, ${v.max.toFixed(3)}] \u76F8\u5BF9\u8D77\u4F0F=${(dev * 100).toFixed(2)}% ${okK ? "\u2714" : "\u2718 \u8F68\u9053\u5F62\u72B6\u4E0D\u5BF9\uFF08\u521D\u59CB\u72B6\u6001\u4E0D\u81EA\u6D3D\uFF09"}`);
    }
  }
  rows.push({
    id: level.id,
    ok,
    time: world.time,
    deliv: world.level.podsDelivered,
    lost: world.level.podsLost,
    minDock: minDock === Infinity ? NaN : minDock,
    minVrel: minVrel === Infinity ? NaN : minVrel,
    fuel: world.level.fuelUsed,
    dE: world.stats.energyDrift,
    dL: world.stats.angularDrift,
    steps: world.stats.steps,
    substeps: world.stats.substeps,
    note: precheck || (ok ? "" : `status=${world.status}`)
  });
  const r = rows[rows.length - 1];
  console.log(
    `${r.id.padEnd(8)} ${(ok ? "\u6210\u529F" : "\u672A\u8FBE\u6210").padEnd(5)} ${r.time.toFixed(1).padStart(6)} ${String(r.deliv).padStart(5)} ${String(r.lost).padStart(4)}  ${(isNaN(r.minDock) ? "-" : r.minDock.toFixed(3)).padStart(7)} ${(isNaN(r.minVrel) ? "-" : r.minVrel.toFixed(3)).padStart(9)}  ${r.fuel.toFixed(2).padStart(6)}  ${r.dE.toExponential(2)}  ${r.dL.toExponential(2)}  ${r.steps}/${r.substeps}${r.note ? "  " + r.note : ""}`
  );
}
var won = rows.filter((r) => r.ok).length;
var worstDE = Math.max(...rows.map((r) => r.dE));
var anyNaN = rows.some((r) => !isFinite(r.dE) || !isFinite(r.time));
console.log(`
[simtest] \u901A\u5173 ${won}/${rows.length}\uFF1B\u6700\u5927 \u0394E/E=${worstDE.toExponential(2)}\uFF1BNaN=${anyNaN}`);
var hardFail = anyNaN || worstDE > 0.01;
process.exit(hardFail ? 1 : 0);
