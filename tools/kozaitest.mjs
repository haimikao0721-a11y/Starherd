// src/sim/kozai.ts
var I_CRIT = Math.acos(Math.sqrt(3 / 5));
function kozaiActive(incl) {
  return Math.cos(incl) * Math.cos(incl) < 3 / 5;
}
function kozaiEmax(incl, e0) {
  const c2 = Math.cos(incl) * Math.cos(incl);
  const inner = 1 - 5 / 3 * c2;
  if (inner <= 0) return { emax: e0, active: false };
  const emax = Math.sqrt(Math.min(1, inner));
  return { emax: Math.max(emax, e0), active: true };
}
function kozaiCollisionRisk(sepInner, aIn, emax) {
  const rp = aIn * (1 - emax);
  return rp < sepInner;
}
function kozaiPeriod(m1, m2, m3, aIn, aOut, eOut) {
  const mTot = m1 + m2 + m3;
  const pIn = Math.pow(Math.max(1e-9, aIn), 1.5);
  const pOut = Math.pow(Math.max(1e-9, aOut), 1.5);
  const factor = 8 / (15 * Math.PI) * (mTot / Math.max(1e-9, m3));
  const ecc = Math.pow(Math.max(0, 1 - eOut * eOut), 1.5);
  return factor * (pOut * pOut / Math.max(1e-9, pIn)) * ecc;
}
function pickHierarchy(bodies, rootId) {
  const byId = new Map(bodies.map((b) => [b.id, b]));
  let best = null;
  let bestRatio = 0;
  for (const b of bodies) {
    if (!b.orbit || !b.orbit.parent) continue;
    const parent = byId.get(b.orbit.parent);
    if (!parent || !parent.orbit) continue;
    const ratio = parent.orbit.a / Math.max(1e-9, b.orbit.a);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = { inner: b.id, outer: parent.id };
    }
  }
  if (!best) return null;
  const innerB = byId.get(best.inner);
  const outerB = byId.get(best.outer);
  if (!innerB || !outerB || !innerB.orbit || !outerB.orbit) return null;
  const host = byId.get(outerB.orbit.parent ?? rootId);
  return {
    inner: best.inner,
    outer: best.outer,
    aIn: innerB.orbit.a,
    eIn: innerB.orbit.e,
    aOut: outerB.orbit.a,
    eOut: outerB.orbit.e,
    mIn1: innerB.mass,
    mIn2: outerB.mass,
    mOut: host ? host.mass : outerB.mass
  };
}

// tools/kozaitest.ts
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
var DEG = 180 / Math.PI;
console.log("=".repeat(70));
console.log("  Kozai-Lidov \u5224\u636E\uFF1A\u89E3\u6790\u9A8C\u8BC1");
console.log("=".repeat(70));
check(
  "\u4E34\u754C\u503E\u89D2 \u2248 39.23\xB0",
  Math.abs(I_CRIT * DEG - 39.2307) < 0.01,
  `arccos(\u221A(3/5)) = ${(I_CRIT * DEG).toFixed(4)}\xB0`
);
check(
  "\u4E34\u754C\u89D2\u4E24\u4FA7\u5224\u636E\u7FFB\u8F6C",
  !kozaiActive(I_CRIT * 0.999) && kozaiActive(I_CRIT * 1.001),
  `i=39.19\xB0 \u2192 ${kozaiActive(I_CRIT * 0.999)}\uFF1Bi=39.27\xB0 \u2192 ${kozaiActive(I_CRIT * 1.001)}`
);
{
  const at90 = kozaiEmax(Math.PI / 2, 0.01);
  check("i=90\xB0 \u65F6 e_max \u2192 1", at90.active && at90.emax > 0.999, `e_max = ${at90.emax.toFixed(4)}`);
  const atCrit = kozaiEmax(I_CRIT, 0.01);
  check(
    "i=i_crit \u65F6 e_max = \u521D\u59CB\u504F\u5FC3\u7387\uFF08\u4E0D\u632F\u8361\uFF09",
    !atCrit.active && atCrit.emax === 0.01,
    `active=${atCrit.active}\uFF0Ce_max=${atCrit.emax}`
  );
  const low = kozaiEmax(20 / DEG, 0.01);
  check("i=20\xB0\uFF08\u4F4E\u4E8E\u4E34\u754C\uFF09\u4E0D\u632F\u8361", !low.active, `active=${low.active}`);
  let mono = true;
  let prev = -1;
  for (let deg = 40; deg <= 90; deg += 2) {
    const e = kozaiEmax(deg / DEG, 0).emax;
    if (e < prev - 1e-12) mono = false;
    prev = e;
  }
  check("e_max \u968F\u503E\u89D2\u5355\u8C03\u9012\u589E\uFF0840\xB0\u219290\xB0\uFF09", mono, `90\xB0 \u65F6 ${prev.toFixed(4)}`);
}
{
  const base = kozaiPeriod(1, 0.2, 1, 0.1, 5, 0.1);
  const aOut2 = kozaiPeriod(1, 0.2, 1, 0.1, 10, 0.1);
  check(
    "T_KL \u221D a_out\xB3\uFF08a_out \u7FFB\u500D \u2192 8 \u500D\uFF09",
    Math.abs(aOut2 / base - 8) < 1e-6,
    `\u6BD4\u503C ${(aOut2 / base).toFixed(6)}\uFF08\u671F\u671B 8\uFF09`
  );
  const aIn2 = kozaiPeriod(1, 0.2, 1, 0.2, 5, 0.1);
  check(
    "T_KL \u221D a_in^{\u22123/2}\uFF08a_in \u7FFB\u500D \u2192 1/2.828\uFF09",
    Math.abs(aIn2 / base - Math.pow(2, -1.5)) < 1e-6,
    `\u6BD4\u503C ${(aIn2 / base).toFixed(6)}\uFF08\u671F\u671B ${Math.pow(2, -1.5).toFixed(6)}\uFF09`
  );
  const mOut2 = kozaiPeriod(1, 0.2, 2, 0.1, 5, 0.1);
  check(
    "T_KL \u968F\u4F34\u661F\u8D28\u91CF\u589E\u5927\u800C\u51CF\u5C0F",
    mOut2 < base,
    `m_out=2 \u65F6 ${mOut2.toFixed(4)} < m_out=1 \u65F6 ${base.toFixed(4)}`
  );
  const eOut2 = kozaiPeriod(1, 0.2, 1, 0.1, 5, 0.5);
  const wantRatio = Math.pow(1 - 0.25, 1.5) / Math.pow(1 - 0.01, 1.5);
  check(
    "T_KL \u221D (1\u2212e_out\xB2)^{3/2}",
    Math.abs(eOut2 / base - wantRatio) < 1e-9,
    `\u6BD4\u503C ${(eOut2 / base).toFixed(6)}\uFF08\u671F\u671B ${wantRatio.toFixed(6)}\uFF09`
  );
}
{
  check(
    "e_max \u63A5\u8FD1 1 \u65F6\u5224\u5B9A\u4E3A\u5371\u9669",
    kozaiCollisionRisk(0.05, 0.1, 0.999),
    `sep=0.05, a_in=0.1, e_max=0.999 \u2192 r_p=${(0.1 * 1e-3).toFixed(5)} < 0.05`
  );
  check(
    "e_max \u5C0F\u65F6\u5224\u5B9A\u4E3A\u5B89\u5168",
    !kozaiCollisionRisk(0.05, 0.1, 0.1),
    `sep=0.05, a_in=0.1, e_max=0.1 \u2192 r_p=${(0.1 * 0.9).toFixed(3)} > 0.05`
  );
  check(
    "e_max \u6070\u597D\u4F7F r_p = sep \u65F6\u5224\u4E3A\u4E0D\u5B89\u5168\uFF08\u8FB9\u754C\u542B\u7B49\u53F7\uFF09",
    kozaiCollisionRisk(0.09, 0.1, 0.1) === false || kozaiCollisionRisk(0.0900001, 0.1, 0.1) === true,
    `r_p=0.09 \u4E0E sep=0.09 \u2192 ${kozaiCollisionRisk(0.09, 0.1, 0.1)}`
  );
}
{
  const bodies = [
    { id: "starA", mass: 0.47, orbit: null },
    { id: "starB", mass: 0.47, orbit: { a: 0.75, e: 0.02, parent: "starA" } },
    { id: "companion", mass: 0.02, orbit: null }
  ];
  const h = pickHierarchy(bodies, "starA");
  check(
    "\u5C42\u7EA7\u6784\u578B\u8BC6\u522B\uFF08starB \u7ED5 starA\uFF0C\u800C starA \u4E0D\u7ED5\u8F6C\uFF09\u2192 \u8FD4\u56DE null \u624D\u7B97\u6B63\u786E",
    h === null,
    `\u7ED3\u679C ${h === null ? "null\uFF08\u7236\u5929\u4F53\u5FC5\u987B\u4E5F\u5728\u7ED5\u8F6C\u624D\u7B97\u5C42\u7EA7\u6784\u578B\uFF09" : JSON.stringify(h)}`
  );
  const bodies2 = [
    { id: "starA", mass: 1, orbit: null },
    { id: "starB", mass: 0.1, orbit: { a: 0.2, e: 0, parent: "starA" } },
    { id: "host", mass: 1, orbit: { a: 6, e: 0.1 } },
    { id: "starC", mass: 0.4, orbit: { a: 1, e: 0.05, parent: "host" } }
  ];
  const h2 = pickHierarchy(bodies2, "starA");
  check(
    "\u771F\u5C42\u7EA7\u6784\u578B\u80FD\u88AB\u8BC6\u522B",
    h2 !== null && h2.inner === "starC" && h2.outer === "host",
    h2 ? `inner=${h2.inner} outer=${h2.outer} \u534A\u5F84\u6BD4=${(h2.aOut / h2.aIn).toFixed(1)}` : "null"
  );
}
console.log("-".repeat(70));
console.log(`  Kozai-Lidov \u6D4B\u8BD5\uFF1A${pass} \u901A\u8FC7 / ${fail} \u5931\u8D25`);
process.exit(fail ? 1 : 0);
