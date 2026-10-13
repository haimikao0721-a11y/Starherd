// src/sim/zvc.ts
function cr3bp(mA, mB, d) {
  const m1 = Math.max(mA, mB);
  const m2 = Math.min(mA, mB);
  const total = m1 + m2;
  const dd = Math.max(1e-9, d);
  return { mu: total > 0 ? m2 / total : 0, omega: Math.sqrt(total / (dd * dd * dd)), d: dd, m1, m2 };
}
function omegaEff(mu, x, y) {
  const r1 = Math.hypot(x + mu, y);
  const r2 = Math.hypot(x - 1 + mu, y);
  return 0.5 * (x * x + y * y) + (1 - mu) / Math.max(1e-12, r1) + mu / Math.max(1e-12, r2);
}
function jacobi(mu, x, y, vx, vy) {
  return 2 * omegaEff(mu, x, y) - (vx * vx + vy * vy);
}
function collinearX(mu, side) {
  const f = (x) => {
    const r1 = Math.abs(x + mu);
    const r2 = Math.abs(x - 1 + mu);
    const s1 = x + mu >= 0 ? 1 : -1;
    const s2 = x - 1 + mu >= 0 ? 1 : -1;
    return x - (1 - mu) * (s1 / (r1 * r1)) - mu * (s2 / (r2 * r2));
  };
  let lo;
  let hi;
  if (side === -1) {
    lo = -mu + 1e-6;
    hi = 1 - mu - 1e-6;
  } else if (side === 0) {
    lo = 1 - mu + 1e-6;
    hi = 1 - mu + 4;
  } else {
    lo = -mu - 4;
    hi = -mu - 1e-6;
  }
  let flo = f(lo);
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    const fm = f(mid);
    if (flo <= 0 === fm <= 0) {
      lo = mid;
      flo = fm;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}
function collinearC(mu, side) {
  const x = collinearX(mu, side);
  return 2 * omegaEff(mu, x, 0);
}
function triangularC(mu) {
  return 3 - mu + mu * mu;
}
function reachable(mu, C, x, y) {
  return 2 * omegaEff(mu, x, y) >= C;
}
function zvcMask(mu, C, x0, x1, y0, y1, nx, ny) {
  const blocked = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = y0 + (j + 0.5) / ny * (y1 - y0);
    for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) / nx * (x1 - x0);
      blocked[j * nx + i] = reachable(mu, C, x, y) ? 0 : 1;
    }
  }
  return { w: nx, h: ny, blocked };
}

// tools/zvctest.ts
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
var SQ3_2 = Math.sqrt(3) / 2;
console.log("=".repeat(70));
console.log("  CR3BP / Jacobi \u5E38\u6570\u5355\u5143\u6D4B\u8BD5");
console.log("=".repeat(70));
for (const mu of [1e-3, 0.01, 0.01215, 0.1, 0.3]) {
  const x4 = 0.5 - mu;
  const cNum = jacobi(mu, x4, SQ3_2, 0, 0);
  const cAna = triangularC(mu);
  check(
    `L4 \u89E3\u6790\u503C \u03BC=${mu}`,
    Math.abs(cNum - cAna) < 1e-9,
    `\u6570\u503C ${cNum.toFixed(9)} vs 3\u2212\u03BC+\u03BC\xB2 = ${cAna.toFixed(9)}`
  );
}
for (const mu of [1e-3, 0.01215, 0.1, 0.3]) {
  const c1 = collinearC(mu, -1);
  const c2 = collinearC(mu, 0);
  const c3 = collinearC(mu, 1);
  const c45 = triangularC(mu);
  check(
    `C \u5C42\u7EA7 \u03BC=${mu}`,
    c1 > c2 && c2 > c3 && c3 > c45,
    `L1 ${c1.toFixed(4)} > L2 ${c2.toFixed(4)} > L3 ${c3.toFixed(4)} > L4/5 ${c45.toFixed(4)}`
  );
}
{
  const mu = 0.01215;
  const table = [
    ["L1", collinearC(mu, -1), 3.1883],
    ["L2", collinearC(mu, 0), 3.1722],
    ["L3", collinearC(mu, 1), 3.0121],
    ["L4/L5", triangularC(mu), 2.988]
  ];
  for (const [nm, got, want] of table) {
    check(
      `\u5BF9\u7167\u5730\u6708\u7CFB\u6570\u8868 ${nm}`,
      Math.abs(got - want) < 2e-3,
      `\u7B97\u5F97 ${got.toFixed(4)}\uFF0C\u6587\u732E ${want.toFixed(4)}\uFF0C\u5DEE ${(got - want).toExponential(2)}`
    );
  }
}
{
  const mu = 0.01215;
  const pts = [[0.2, 0.1], [1.2, 0], [0.5, 0.8], [-1.5, 0.3]];
  let mono = true;
  let detail = "";
  for (const [x, y] of pts) {
    const weak = reachable(mu, 2.9, x, y);
    const strong = reachable(mu, 3.3, x, y);
    if (weak && !strong) {
    } else if (strong && !weak) {
      mono = false;
      detail = `(${x},${y}) \u53CD\u4F8B`;
    }
  }
  check("reachable \u5355\u8C03\uFF08C \u8D8A\u5927\u7981\u533A\u8D8A\u5927\uFF09", mono, detail || "4 \u4E2A\u91C7\u6837\u70B9\u5747\u6EE1\u8DB3");
}
{
  const mu = 0.01215;
  const mask = zvcMask(mu, 3.05, -1.5, 1.5, -1.5, 1.5, 60, 60);
  let blocked = 0;
  for (let i = 0; i < mask.blocked.length; i++) blocked += mask.blocked[i];
  const frac = blocked / mask.blocked.length;
  check(
    "zvcMask \u5C3A\u5BF8\u4E0E\u7981\u533A\u6BD4\u4F8B",
    mask.w === 60 && mask.h === 60 && frac > 0.05 && frac < 0.95,
    `${mask.w}\xD7${mask.h}\uFF0C\u7981\u533A\u5360\u6BD4 ${(frac * 100).toFixed(1)}%`
  );
}
{
  const c = cr3bp(0.03, 0.97, 2);
  const wantMu = 0.03;
  const wantOmega = Math.sqrt(1 / 8);
  check("cr3bp \u8D28\u91CF\u6BD4", Math.abs(c.mu - wantMu) < 1e-12, `\u03BC=${c.mu}`);
  check(
    "cr3bp \u5E73\u5747\u8FD0\u52A8",
    Math.abs(c.omega - wantOmega) < 1e-12,
    `\u03C9=${c.omega.toFixed(6)} vs ${wantOmega.toFixed(6)}`
  );
  check("cr3bp \u4FDD\u8BC1 m1 \u2265 m2", c.m1 >= c.m2, `m1=${c.m1} m2=${c.m2}`);
}
{
  const mu = 0.01215;
  const near = omegaEff(mu, -mu + 1e-4, 0);
  const far = omegaEff(mu, -mu, 1);
  check("omegaEff \u5728\u91CD\u5929\u4F53\u9644\u8FD1\u663E\u8457\u589E\u5927", near > far * 5, `${near.toFixed(2)} vs ${far.toFixed(2)}`);
}
console.log("-".repeat(70));
console.log(`  CR3BP \u5355\u5143\u6D4B\u8BD5\uFF1A${pass} \u901A\u8FC7 / ${fail} \u5931\u8D25`);
process.exit(fail ? 1 : 0);
