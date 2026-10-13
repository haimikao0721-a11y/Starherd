// src/sim/constants.ts
var TIME_SCALE = 1.6;
var PHYS_HZ = 120;
var DT = 1 / (PHYS_HZ * TIME_SCALE);
var SHIP_MASS = 6e-5;
var OMEGA = 2 * Math.PI / 0.5;
var ZETA = 0.85;
var ZETA_PRECISE = 1;
var K_SPRING = SHIP_MASS * OMEGA * OMEGA;
var C_DAMP = 2 * ZETA * Math.sqrt(K_SPRING * SHIP_MASS);
var C_DAMP_PRECISE = 2 * ZETA_PRECISE * Math.sqrt(K_SPRING * SHIP_MASS);

// src/sim/physics.ts
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

// tools/reltest.ts
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
var MU = 1;
var A = 1.5;
var E = 0.3;
function integrateOrbits(rel, steps, dt2) {
  const rp = A * (1 - E);
  const vp = Math.sqrt(MU * (1 + E) / (A * (1 - E)));
  let x = rp;
  let y = 0;
  let vx = 0;
  let vy = vp;
  const acc = { x: 0, y: 0 };
  const accel = (px, py, pvx, pvy, out) => {
    const r2 = px * px + py * py;
    const r = Math.sqrt(r2);
    const k = MU / (r2 * r);
    out.x = -k * px;
    out.y = -k * py;
    if (rel) relAccel(px, py, pvx, pvy, MU, out);
  };
  const angles = [];
  let prevR = Infinity;
  let prevPrevR = Infinity;
  let armed = true;
  let lastPeriR = rp;
  for (let s = 0; s < steps; s++) {
    accel(x, y, vx, vy, acc);
    vx += acc.x * dt2 * 0.5;
    vy += acc.y * dt2 * 0.5;
    x += vx * dt2;
    y += vy * dt2;
    accel(x, y, vx, vy, acc);
    vx += acc.x * dt2 * 0.5;
    vy += acc.y * dt2 * 0.5;
    const r = Math.hypot(x, y);
    if (!armed && r > lastPeriR * 1.05) armed = true;
    if (armed && prevR < prevPrevR && r > prevR) {
      angles.push(Math.atan2(y, x));
      lastPeriR = r;
      armed = false;
    }
    prevPrevR = prevR;
    prevR = r;
  }
  return angles;
}
console.log("=".repeat(70));
console.log("  1PN \u76F8\u5BF9\u8BBA\u8FDB\u52A8\uFF1A\u89E3\u6790\u5BF9\u7167");
console.log("=".repeat(70));
console.log(`  \u03BC=${MU}  a=${A}  e=${E}  c=${C_LIGHT}\uFF08\u6E38\u620F\u5355\u4F4D RU/TU\uFF09`);
var dOmega = 6 * Math.PI * MU / (C_LIGHT * C_LIGHT * A * (1 - E * E));
console.log(`  \u89E3\u6790\u503C\uFF1A\u0394\u03D6 = 6\u03C0\u03BC/(c\xB2a(1\u2212e\xB2)) = ${dOmega.toExponential(4)} rad/\u5708 = ${(dOmega * 180 / Math.PI).toFixed(4)}\xB0/\u5708`);
var T = 2 * Math.PI * Math.sqrt(A * A * A / MU);
var dt = T / 4e4;
var orbits = 12;
var withRel = integrateOrbits(true, Math.round(orbits * 4e4) + 4e4, dt);
var noRel = integrateOrbits(false, Math.round(orbits * 4e4) + 4e4, dt);
console.log(`  \u79EF\u5206\uFF1A\u6BCF\u5708 40000 \u6B65\uFF0C\u5171\u7EA6 ${orbits} \u5708\uFF1B\u68C0\u51FA\u8FD1\u661F\u70B9 ${withRel.length} \u6B21\uFF08\u542B 1PN\uFF09 / ${noRel.length} \u6B21\uFF08\u7EAF\u725B\u987F\uFF09`);
function advances(angles) {
  const out = [];
  for (let i = 1; i < angles.length; i++) {
    let d = angles[i] - angles[i - 1];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    out.push(d);
  }
  return out;
}
var advRel = advances(withRel);
var advNewt = advances(noRel);
var meanRel = advRel.length ? advRel.reduce((a, b) => a + b, 0) / advRel.length : 0;
var meanNewt = advNewt.length ? advNewt.reduce((a, b) => a + b, 0) / advNewt.length : 0;
check("\u68C0\u51FA\u8DB3\u591F\u591A\u7684\u8FD1\u661F\u70B9", advRel.length >= 8, `${advRel.length} \u6B21\u8FDB\u52A8\u6837\u672C`);
check(
  "\u7EAF\u725B\u987F\u8F68\u9053\u4E0D\u8FDB\u52A8\uFF08\u5BF9\u7167\u7EC4\uFF09",
  Math.abs(meanNewt) < dOmega * 0.25,
  `\u725B\u987F\u6BCF\u5708 ${meanNewt.toExponential(3)} rad\uFF08\u671F\u671B\u22480\uFF09`
);
var relErr = Math.abs(meanRel - dOmega) / dOmega;
check(
  "1PN \u8FDB\u52A8\u4E0E\u89E3\u6790\u503C\u4E00\u81F4\uFF08\u5BB9\u5DEE 20%\uFF09",
  relErr < 0.2,
  `\u6570\u503C ${meanRel.toExponential(4)} vs \u89E3\u6790 ${dOmega.toExponential(4)} rad/\u5708\uFF0C\u76F8\u5BF9\u8BEF\u5DEE ${(relErr * 100).toFixed(1)}%`
);
check("1PN \u8FDB\u52A8\u65B9\u5411\u4E3A\u6B63\uFF08\u987A\u884C\u65CB\u8FDB\uFF09", meanRel > 0, `${meanRel.toExponential(3)} > 0`);
var A2 = 0.9;
var dOmega2 = 6 * Math.PI * MU / (C_LIGHT * C_LIGHT * A2 * (1 - E * E));
var ratioNum = dOmega2 / dOmega;
var ratioWant = A / A2;
check(
  "\u89E3\u6790\u5F0F\u6807\u5EA6\uFF1Aa \u8D8A\u5C0F\u8FDB\u52A8\u8D8A\u5927",
  dOmega2 > dOmega,
  `a=${A2} \u65F6 ${dOmega2.toExponential(3)} > a=${A} \u65F6 ${dOmega.toExponential(3)} rad/\u5708`
);
check(
  "\u89E3\u6790\u5F0F\u6807\u5EA6\uFF1A\u6BD4\u503C \u2248 A/a\u2082",
  Math.abs(ratioNum - ratioWant) / ratioWant < 0.05,
  `\u5B9E\u5F97\u6BD4\u503C ${ratioNum.toFixed(3)} vs \u671F\u671B ${ratioWant.toFixed(3)}\uFF08\u0394\u03D6 \u221D 1/a\uFF09`
);
console.log("-".repeat(70));
console.log(`  1PN \u8FDB\u52A8\u6D4B\u8BD5\uFF1A${pass} \u901A\u8FC7 / ${fail} \u5931\u8D25`);
process.exit(fail ? 1 : 0);
