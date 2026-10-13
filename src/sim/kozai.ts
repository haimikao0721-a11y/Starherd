/**
 * kozai.ts —— Kozai-Lidov（KL）机制的解析判据与周期。
 *
 * 物理
 * ----
 * 在**层级三体**（内双星 + 远距离伴星）里，伴星的引力扰动会让**内轨的偏心率周期性振荡**，
 * 同时内轨与外轨的**相对倾角**基本不变——这就是 Kozai-Lidov 机制。
 * 四极近似下（内轨远小于外轨、外轨近似圆），振荡上下限满足
 *
 *     e_max = sqrt(1 − (5/3)·cos²i)
 *
 * 于是有一个**临界倾角**
 *
 *     i_crit = arccos( sqrt(3/5) ) ≈ 39.23°
 *
 * 当 i < i_crit 时根号内为负 → **不会发生 KL 振荡**；i 越接近 90°，e_max 越接近 1
 * （近星点可以一直低到几乎撞上内双星）。KL 周期（四极近似）常用形式
 *
 *     T_KL ≈ (8/15π) · (m₁+m₂+m₃)/m₃ · (P_out²/P_in) · (1 − e_out²)^{3/2}
 *
 * 注意：不同文献对 T_KL 的常数因子取法不同（8/15π、4/3 等），所以本模块的测试
 * **只断言标度关系**（∝ P_out²/P_in 等），不断言绝对数值——这是刻意的诚实。
 *
 * 与本作的关系：L2-1「层级三合星」正是这种构型。上一轮我在调关卡稳定性时，
 * 边缘配置被 KL 抽干、伴星被甩出去——现在把这个机制**显式**做出来给玩家看。
 */

/** 临界倾角（弧度）：arccos(sqrt(3/5)) ≈ 39.23° */
export const I_CRIT = Math.acos(Math.sqrt(3 / 5));

/** KL 是否可能发生（倾角是否超过临界值） */
export function kozaiActive(incl: number): boolean {
  return Math.cos(incl) * Math.cos(incl) < 3 / 5;
}

/**
 * 四极近似下的最大偏心率；倾角低于临界值时返回当前偏心率（即不振荡）。
 * @returns { emax, active }
 */
export function kozaiEmax(incl: number, e0: number): { emax: number; active: boolean } {
  const c2 = Math.cos(incl) * Math.cos(incl);
  const inner = 1 - (5 / 3) * c2;
  if (inner <= 0) return { emax: e0, active: false };
  // KL 振荡下还有一个由初始偏心率决定的守恒量（Kozai 常数），这里给出常用的上限式
  const emax = Math.sqrt(Math.min(1, inner));
  return { emax: Math.max(emax, e0), active: true };
}

/**
 * KL 振荡是否会把**内双星**推向相撞。
 *
 * 判据（物理上成立的版本）：KL 把内轨偏心率抬到 e_max 后，内轨近星点
 *     r_p = a_in · (1 − e_max)
 * 若 r_p 小于内双星自身的间距 sepInner，两者就会相遇 → 危险。
 *
 * 早先我写成"与外形轨道半径的 5% 比较"，那是量纲对但物理错——真正会撞上的是内双星，
 * 不是外轨。
 */
export function kozaiCollisionRisk(sepInner: number, aIn: number, emax: number): boolean {
  const rp = aIn * (1 - emax);
  return rp < sepInner;
}

/**
 * KL 振荡周期（四极近似的常用形式）。
 *
 * @param m1,m2    内双星质量
 * @param m3       伴星质量
 * @param aIn,aOut 内轨半长轴、外轨半长轴（同一长度单位）
 * @param eOut     外轨偏心率
 */
export function kozaiPeriod(m1: number, m2: number, m3: number,
  aIn: number, aOut: number, eOut: number): number {
  const mTot = m1 + m2 + m3;
  // P ∝ a^{3/2}（μ 用总质量，标度关系足够）
  const pIn = Math.pow(Math.max(1e-9, aIn), 1.5);
  const pOut = Math.pow(Math.max(1e-9, aOut), 1.5);
  const factor = (8 / (15 * Math.PI)) * (mTot / Math.max(1e-9, m3));
  const ecc = Math.pow(Math.max(0, 1 - eOut * eOut), 1.5);
  return factor * (pOut * pOut / Math.max(1e-9, pIn)) * ecc;
}

/**
 * 由一组天体的质量/轨道挑出"层级三体"构型（内双星 + 伴星），供 HUD 显示 KL 状态。
 *
 * @returns null 表示该关不是层级三体（不显示 KL 面板，而不是显示一个假的）
 */
export function pickHierarchy(
  bodies: Array<{ id: string; mass: number; orbit: { a: number; e: number; parent?: string } | null }>,
  rootId: string,
): { inner: string; outer: string; aIn: number; eIn: number; aOut: number; eOut: number;
     mIn1: number; mIn2: number; mOut: number } | null {
  const byId = new Map(bodies.map((b) => [b.id, b]));
  // 找"有父天体、且父天体还绕更外层转"的最深两级
  let best: { inner: string; outer: string } | null = null;
  let bestRatio = 0;
  for (const b of bodies) {
    if (!b.orbit || !b.orbit.parent) continue;
    const parent = byId.get(b.orbit.parent);
    if (!parent || !parent.orbit) continue;               // 父天体必须也在绕转 → 层级构型
    const ratio = parent.orbit.a / Math.max(1e-9, b.orbit.a);
    if (ratio > bestRatio) { bestRatio = ratio; best = { inner: b.id, outer: parent.id }; }
  }
  if (!best) return null;
  const innerB = byId.get(best.inner);
  const outerB = byId.get(best.outer);
  if (!innerB || !outerB || !innerB.orbit || !outerB.orbit) return null;
  const host = byId.get(outerB.orbit.parent ?? rootId);
  return {
    inner: best.inner, outer: best.outer,
    aIn: innerB.orbit.a, eIn: innerB.orbit.e,
    aOut: outerB.orbit.a, eOut: outerB.orbit.e,
    mIn1: innerB.mass, mIn2: outerB.mass,
    mOut: host ? host.mass : outerB.mass,
  };
}
