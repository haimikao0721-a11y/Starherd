/**
 * transfer.ts —— 轨道转移的两种经典方案：霍曼（两冲量）与双椭圆（三冲量）。
 *
 * 物理
 * ----
 * **霍曼转移**（共面圆轨道 r₁ → r₂，两冲量）：
 *     Δv = √(μ/r₁)·(√(2r₂/(r₁+r₂)) − 1) + √(μ/r₂)·(1 − √(2r₁/(r₁+r₂)))
 *   在 r₂/r₁ < 11.94 时它是最省的**双冲量**方案。
 *
 * **双椭圆转移**（r₁ → r_b → r₂，三冲量）：
 *     ① 在 r₁ 加速，把远拱点抬到 r_b
 *     ② 在 r_b 加速，把近拱点从 r₁ 抬到 r₂
 *     ③ 在 r₂ 减速（逆行），圆化
 *   当 r₂/r₁ > 11.94 时，取足够大的 r_b，它**比霍曼更省**——代价是时间长得离谱。
 *   这是"省燃料 vs 花时间"的经典权衡，也是本作想让玩家看见的东西。
 *
 * 文献对照（写进单元测试）：
 *   · 阈值 r₂/r₁ ≈ 11.94（r_b 取最优时）
 *   · r_b → ∞ 的渐近阈值 ≈ 15.58
 * `tools/transfertest.ts` 会对这两个数做数值验证——用外部结论检验实现，而不是自己算完自己信。
 */

export interface TransferPlan {
  /** 方案名 */
  kind: 'hohmann' | 'bi-elliptic';
  /** 总 Δv（RU/TU） */
  dv: number;
  /** 各次点火的大小（RU/TU） */
  burns: number[];
  /** 中间远拱点半径（霍曼方案下等于 r₂） */
  rb: number;
  /** 转移耗时（TU）；双椭圆通常远大于霍曼 */
  time: number;
}

/** 圆轨道速度 */
export function circularSpeed(mu: number, r: number): number {
  return Math.sqrt(mu / Math.max(1e-12, r));
}

/** 霍曼转移的 Δv 与耗时 */
export function hohmann(mu: number, r1: number, r2: number): TransferPlan {
  const a = 0.5 * (r1 + r2);
  const dv1 = circularSpeed(mu, r1) * (Math.sqrt((2 * r2) / (r1 + r2)) - 1);
  const dv2 = circularSpeed(mu, r2) * (1 - Math.sqrt((2 * r1) / (r1 + r2)));
  const period = 2 * Math.PI * Math.sqrt((a * a * a) / mu);      // 整个椭圆的周期
  return { kind: 'hohmann', dv: Math.abs(dv1) + Math.abs(dv2), burns: [dv1, dv2], rb: r2, time: period * 0.5 };
}

/** 双椭圆转移：给定中间远拱点 r_b */
export function biElliptic(mu: number, r1: number, r2: number, rb: number): TransferPlan {
  const rbb = Math.max(rb, r2 * 1.0000001, r1 * 1.0000001);
  // ① 在 r1 加速：圆速度 → 椭圆（近拱 r1、远拱 rbb）的近拱速度
  const vPeri1 = Math.sqrt((2 * mu * rbb) / (r1 * (r1 + rbb)));
  const dv1 = vPeri1 - circularSpeed(mu, r1);
  // ② 在 rbb：从"r1→rbb 椭圆"的远拱速度，变到"r2→rbb 椭圆"的远拱速度
  const vApo1 = Math.sqrt((2 * mu * r1) / (rbb * (r1 + rbb)));
  const vApo2 = Math.sqrt((2 * mu * r2) / (rbb * (r2 + rbb)));
  const dv2 = vApo2 - vApo1;
  // ③ 在 r2：从"r2→rbb 椭圆"的近拱速度，减速到圆速度
  const vPeri2 = Math.sqrt((2 * mu * rbb) / (r2 * (r2 + rbb)));
  const dv3 = vPeri2 - circularSpeed(mu, r2);
  // 耗时：两条半个椭圆
  const t1 = Math.PI * Math.sqrt(Math.pow(0.5 * (r1 + rbb), 3) / mu);
  const t2 = Math.PI * Math.sqrt(Math.pow(0.5 * (r2 + rbb), 3) / mu);
  return {
    kind: 'bi-elliptic',
    dv: Math.abs(dv1) + Math.abs(dv2) + Math.abs(dv3),
    burns: [dv1, dv2, dv3],
    rb: rbb,
    time: t1 + t2,
  };
}

/**
 * 在给定 r_b 搜索范围内找最省的双椭圆方案。
 * 搜索用对数网格 + 局部细化——目标函数对 r_b 是单峰的（先降后升），不必上复杂优化。
 */
export function bestBiElliptic(mu: number, r1: number, r2: number, rMax = 1e5): TransferPlan {
  let best: TransferPlan | null = null;
  // 对数网格
  const lo = Math.log(Math.max(r2 * 1.0000001, r1 * 1.0000001));
  const hi = Math.log(Math.max(rMax, r2 * 2));
  const N = 400;
  for (let i = 0; i <= N; i++) {
    const rb = Math.exp(lo + ((hi - lo) * i) / N);
    const p = biElliptic(mu, r1, r2, rb);
    if (!best || p.dv < best.dv) best = p;
  }
  // 在最优附近细化
  if (best) {
    const c = Math.log(best.rb);
    const span = (hi - lo) / N;
    for (let i = -20; i <= 20; i++) {
      const rb = Math.exp(c + (span * i) / 20);
      const p = biElliptic(mu, r1, r2, rb);
      if (p.dv < best.dv) best = p;
    }
  }
  return best as TransferPlan;
}

/** 给出两个方案中更省的那个（并列时取霍曼：时间短得多） */
export function recommendTransfer(mu: number, r1: number, r2: number): {
  best: TransferPlan; hohmannPlan: TransferPlan; biPlan: TransferPlan; ratio: number;
} {
  const h = hohmann(mu, r1, r2);
  const b = bestBiElliptic(mu, r1, r2);
  const ratio = Math.max(r1, r2) / Math.min(r1, r2);
  return { best: b.dv < h.dv - 1e-12 ? b : h, hohmannPlan: h, biPlan: b, ratio };
}
