// src/sim/transfer.ts
function circularSpeed(mu, r) {
  return Math.sqrt(mu / Math.max(1e-12, r));
}
function hohmann(mu, r1, r2) {
  const a = 0.5 * (r1 + r2);
  const dv1 = circularSpeed(mu, r1) * (Math.sqrt(2 * r2 / (r1 + r2)) - 1);
  const dv2 = circularSpeed(mu, r2) * (1 - Math.sqrt(2 * r1 / (r1 + r2)));
  const period = 2 * Math.PI * Math.sqrt(a * a * a / mu);
  return { kind: "hohmann", dv: Math.abs(dv1) + Math.abs(dv2), burns: [dv1, dv2], rb: r2, time: period * 0.5 };
}
function biElliptic(mu, r1, r2, rb) {
  const rbb = Math.max(rb, r2 * 1.0000001, r1 * 1.0000001);
  const vPeri1 = Math.sqrt(2 * mu * rbb / (r1 * (r1 + rbb)));
  const dv1 = vPeri1 - circularSpeed(mu, r1);
  const vApo1 = Math.sqrt(2 * mu * r1 / (rbb * (r1 + rbb)));
  const vApo2 = Math.sqrt(2 * mu * r2 / (rbb * (r2 + rbb)));
  const dv2 = vApo2 - vApo1;
  const vPeri2 = Math.sqrt(2 * mu * rbb / (r2 * (r2 + rbb)));
  const dv3 = vPeri2 - circularSpeed(mu, r2);
  const t1 = Math.PI * Math.sqrt(Math.pow(0.5 * (r1 + rbb), 3) / mu);
  const t2 = Math.PI * Math.sqrt(Math.pow(0.5 * (r2 + rbb), 3) / mu);
  return {
    kind: "bi-elliptic",
    dv: Math.abs(dv1) + Math.abs(dv2) + Math.abs(dv3),
    burns: [dv1, dv2, dv3],
    rb: rbb,
    time: t1 + t2
  };
}
function bestBiElliptic(mu, r1, r2, rMax = 1e5) {
  let best = null;
  const lo = Math.log(Math.max(r2 * 1.0000001, r1 * 1.0000001));
  const hi = Math.log(Math.max(rMax, r2 * 2));
  const N = 400;
  for (let i = 0; i <= N; i++) {
    const rb = Math.exp(lo + (hi - lo) * i / N);
    const p = biElliptic(mu, r1, r2, rb);
    if (!best || p.dv < best.dv) best = p;
  }
  if (best) {
    const c = Math.log(best.rb);
    const span = (hi - lo) / N;
    for (let i = -20; i <= 20; i++) {
      const rb = Math.exp(c + span * i / 20);
      const p = biElliptic(mu, r1, r2, rb);
      if (p.dv < best.dv) best = p;
    }
  }
  return best;
}
function recommendTransfer(mu, r1, r2) {
  const h = hohmann(mu, r1, r2);
  const b = bestBiElliptic(mu, r1, r2);
  const ratio = Math.max(r1, r2) / Math.min(r1, r2);
  return { best: b.dv < h.dv - 1e-12 ? b : h, hohmannPlan: h, biPlan: b, ratio };
}

// tools/transfertest.ts
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
console.log("=".repeat(72));
console.log("  \u970D\u66FC vs \u53CC\u692D\u5706\uFF1A\u6570\u503C\u9A8C\u8BC1");
console.log("=".repeat(72));
{
  const r1 = 1;
  const r2 = 1.524;
  const h = hohmann(MU, r1, r2);
  const a = 0.5 * (r1 + r2);
  const vPeri = Math.sqrt(MU * (2 / r1 - 1 / a));
  const vApo = Math.sqrt(MU * (2 / r2 - 1 / a));
  const dvIndep = vPeri - circularSpeed(MU, r1) + (circularSpeed(MU, r2) - vApo);
  check(
    "\u970D\u66FC \u0394v \u4E0E vis-viva \u72EC\u7ACB\u590D\u7B97\u4E00\u81F4",
    Math.abs(h.dv - dvIndep) < 1e-12,
    `\u5B9E\u73B0 ${h.dv.toFixed(10)} vs \u72EC\u7ACB ${dvIndep.toFixed(10)}`
  );
  check(
    "\u970D\u66FC\u8017\u65F6 = \u534A\u4E2A\u8F6C\u79FB\u692D\u5706\u5468\u671F",
    Math.abs(h.time - Math.PI * Math.sqrt(a * a * a / MU)) < 1e-12,
    `T/2 = ${h.time.toFixed(6)} TU`
  );
}
{
  let below = 0;
  let above = 0;
  const ratios = [];
  for (let r2 = 2; r2 <= 40; r2 += 0.02) {
    const h = hohmann(MU, 1, r2);
    const b = bestBiElliptic(MU, 1, r2);
    if (b.dv < h.dv) {
      if (above === 0) ratios.push(r2);
      above++;
    } else below++;
  }
  const thr = ratios.length ? ratios[0] : NaN;
  console.log(`  \u626B\u63CF\u7ED3\u679C\uFF1A\u534A\u5F84\u6BD4 < ${thr.toFixed(2)} \u65F6\u970D\u66FC\u66F4\u7701\uFF1B\u2265 ${thr.toFixed(2)} \u65F6\u53CC\u692D\u5706\u66F4\u7701`);
  check(
    "\u9608\u503C \u2248 11.94\uFF08\u6587\u732E\u503C\uFF09",
    Math.abs(thr - 11.94) < 0.35,
    `\u6570\u503C\u9608\u503C ${thr.toFixed(2)} vs \u6587\u732E 11.94`
  );
  check("\u4E24\u79CD\u60C5\u5F62\u90FD\u51FA\u73B0\u8FC7\uFF08\u626B\u63CF\u6709\u6548\uFF09", below > 100 && above > 100, `below=${below} above=${above}`);
}
{
  const rBig = 1e9;
  let worst = 0;
  const rows = [];
  for (const r2 of [5, 12, 20, 40]) {
    const b = biElliptic(MU, 1, r2, rBig);
    const limit = Math.sqrt(2) - 1 + (Math.sqrt(2 / r2) - Math.sqrt(1 / r2));
    const err = Math.abs(b.dv - limit) / limit;
    if (err > worst) worst = err;
    rows.push(`r\u2082=${r2}: ${b.dv.toFixed(6)} vs \u6781\u9650 ${limit.toFixed(6)}`);
  }
  check("rb\u2192\u221E \u6536\u655B\u5230\u89E3\u6790\u629B\u7269\u7EBF\u6781\u9650\uFF08\u5BB9\u5DEE 1e-3\uFF09", worst < 1e-3, rows.join("\uFF1B"));
  console.log("  \u6CE8\uFF1A\u6587\u732E\u5E38\u5F15\u7684 15.58\uFF08\u53CC\u629B\u7269\u7EBF\u9608\u503C\uFF09\u5728\u672C\u5B9E\u73B0\u7684\u610F\u4E49\u4E0B**\u65E0\u6CD5\u590D\u73B0**\u2014\u2014");
  console.log("      \u624B\u7B97\u590D\u6838 R=12 \u65F6\u53CC\u629B\u7269\u7EBF 0.533787 < \u970D\u66FC 0.534148\uFF0C\u5DF2\u5728 R\u224811.9 \u5C31\u66F4\u7701\u3002");
  console.log("      \u8FD9\u91CC\u4E0D\u4E3A\u4E86\u51D1\u90A3\u4E2A\u6570\u5B57\u53BB\u6539\u4EE3\u7801\uFF0C\u6539\u4E3A\u65AD\u8A00\u53EF\u72EC\u7ACB\u63A8\u5BFC\u7684\u6781\u9650\u516C\u5F0F\u3002");
}
{
  const cases = [[1, 20], [1, 30], [1, 40]];
  let allSlower = true;
  const detail = [];
  for (const [r1, r2] of cases) {
    const h = hohmann(MU, r1, r2);
    const b = bestBiElliptic(MU, r1, r2);
    const slower = b.time > h.time;
    if (!slower) allSlower = false;
    detail.push(`r\u2082/r\u2081=${r2}\uFF1A\u970D\u66FC ${h.time.toFixed(1)} TU vs \u53CC\u692D\u5706 ${b.time.toFixed(1)} TU`);
  }
  check("\u53CC\u692D\u5706\u5FC5\u7136\u66F4\u6162\uFF08\u4EE3\u4EF7\u5FC5\u987B\u4E00\u8D77\u6210\u7ACB\uFF09", allSlower, detail.join("\uFF1B"));
}
{
  const near = recommendTransfer(MU, 1, 3);
  const far = recommendTransfer(MU, 1, 30);
  check("\u8FD1\u8DDD\u79BB\u63A8\u8350\u970D\u66FC", near.best.kind === "hohmann", `r\u2082/r\u2081=3 \u2192 ${near.best.kind}`);
  check("\u8FDC\u8DDD\u79BB\u63A8\u8350\u53CC\u692D\u5706", far.best.kind === "bi-elliptic", `r\u2082/r\u2081=30 \u2192 ${far.best.kind}`);
  check(
    "\u8FDC\u8DDD\u79BB\u65F6\u53CC\u692D\u5706\u786E\u5B9E\u66F4\u7701",
    far.biPlan.dv < far.hohmannPlan.dv,
    `\u970D\u66FC ${far.hohmannPlan.dv.toFixed(5)} vs \u53CC\u692D\u5706 ${far.biPlan.dv.toFixed(5)} RU/TU`
  );
  const save = (1 - far.biPlan.dv / far.hohmannPlan.dv) * 100;
  const slow = far.biPlan.time / far.hohmannPlan.time;
  console.log(`  r\u2082/r\u2081=30 \u65F6\uFF1A\u53CC\u692D\u5706\u7701 ${save.toFixed(1)}% \u71C3\u6599\uFF0C\u4F46\u8017\u65F6\u662F\u970D\u66FC\u7684 ${slow.toFixed(1)} \u500D`);
}
console.log("-".repeat(72));
console.log(`  \u8F6C\u79FB\u65B9\u6848\u6D4B\u8BD5\uFF1A${pass} \u901A\u8FC7 / ${fail} \u5931\u8D25`);
process.exit(fail ? 1 : 0);
