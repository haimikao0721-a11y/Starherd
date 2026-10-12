/**
 * src/ui/format.ts — HUD / 菜单共用的数字格式化（纯函数、无副作用、NaN 安全）
 *
 * 单位约定（见 docs/DESIGN.md §1）：
 *   距离 RU、时间 TU、Δv 为飞船预算单位（RU/TU）、漂移量为无量纲相对量。
 * 设计原则：
 *   1. 任何非有限值（NaN / ±Infinity）都返回占位符，绝不让 "NaN" 出现在 HUD 上；
 *   2. HUD 是等宽字体 + 传感器风格，所以数值一律定宽（定点 / 3 位有效数字 / 科学计数法）；
 *   3. 不做本地化（不用 toLocaleString），保证不同机器上输出完全一致，便于自动验收。
 */

/** 无效值占位符（数值） */
const NA = '--';
/** 无效值占位符（时间） */
const NA_TIME = '--:--';

/** 有限性守卫：NaN / ±Infinity → fallback */
export function safe(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

/** 数值钳制 */
export function clamp(v: number, a: number, b: number): number {
  const x = safe(v);
  return x < a ? a : x > b ? b : x;
}

/** 钳制到 0..1 */
export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** 两位补零（用于 mm:ss / h:mm:ss） */
export function pad2(n: number): string {
  const i = Math.max(0, Math.floor(safe(n)));
  return i < 10 ? '0' + i : String(i);
}

/** 固定小数位：fmtFixed(1.9023, 2) → "1.90"（digits 钳制 0..8） */
export function fmtFixed(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return NA;
  return v.toFixed(clamp(Math.floor(digits), 0, 8));
}

/**
 * 三位有效数字（HUD 的场强等量级跨越很大的数值用）：
 *   0        → "0.00"
 *   0.008    → "0.00800"
 *   0.022    → "0.0220"
 *   1.9023   → "1.90"
 *   1234     → "1.23e+3"（toPrecision 在指数 ≥ digits 时切到科学计数法，保留原样）
 */
export function fmtSig(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return NA;
  const d = clamp(Math.floor(digits), 1, 8);
  if (v === 0) return (0).toFixed(d - 1);
  return v.toPrecision(d);
}

/**
 * Δv 预算显示策略（Δv 是玩家最常盯的数字，量级 0..60）：
 *   |v| >= 100 → 1 位小数（"120.5"）
 *   |v| >= 1   → 2 位小数（"24.00"）
 *   |v| < 1    → 3 位小数（"0.083"，霍曼参考解量级）
 *   0          → "0.00"
 */
export function fmtDv(v: number): string {
  if (!Number.isFinite(v)) return NA;
  if (v === 0) return '0.00';
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

/**
 * 科学计数法（规范化指数：去掉前导零，保留正负号）：
 *   2.1e-6  → "2.10e-6"
 *   -1.4e-6 → "-1.40e-6"
 *   0       → "0.00e+0"
 *   1234.5  → "1.23e+3"
 *   1e21    → "1.00e+21"
 * 与 fmtSig 的 toPrecision 输出风格保持一致（指数带符号）。
 */
export function fmtSci(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return NA;
  const d = clamp(Math.floor(digits), 0, 8);
  const s = v.toExponential(d);
  const m = /^(-?[\d.]+)e([+-]?)(\d+)$/.exec(s);
  if (!m) return s;
  const sign = m[2] === '-' ? '-' : '+';
  return `${m[1]}e${sign}${String(Number(m[3]))}`;
}

/** 带符号科学计数法（守恒量漂移）："+2.10e-6" / "-1.40e-6" / "0.00e+0" */
export function fmtDrift(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return NA;
  const s = fmtSci(v, digits);
  return v > 0 ? '+' + s : s;
}

/**
 * 时间 mm:ss（≥ 1 小时用 h:mm:ss）；负数/非有限值 → "--:--"
 *   mode='round'（默认，用于已用时间）
 *   mode='floor'（用于倒计时 / 剩余时间，绝不虚报）
 *   fmtTime(59.6) → "01:00"；fmtTime(3599.6) → "1:00:00"；fmtTime(125) → "02:05"
 */
export function fmtTime(sec: number, mode: 'round' | 'floor' = 'round'): string {
  if (!Number.isFinite(sec) || sec < 0) return NA_TIME;
  let t = mode === 'floor' ? Math.floor(sec) : Math.round(sec);
  const h = Math.floor(t / 3600);
  t -= h * 3600;
  const m = Math.floor(t / 60);
  t -= m * 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(t)}`;
  return `${pad2(m)}:${pad2(t)}`;
}

/**
 * 粗粒度时长（存档总时长 / 统计页）：
 *   45 → "45s"；125 → "2m 05s"；7325 → "2h 01m"
 */
export function fmtDurationShort(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return NA;
  const t = Math.floor(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `${h}h ${pad2(m)}m`;
  if (m > 0) return `${m}m ${pad2(s)}s`;
  return `${s}s`;
}

/** 0..1 → 百分比：fmtPct(0.875) → "88%"；fmtPct(0.875, 1) → "87.5%" */
export function fmtPct(v: number, digits = 0): string {
  if (!Number.isFinite(v)) return NA;
  return (v * 100).toFixed(clamp(Math.floor(digits), 0, 3)) + '%';
}

/** 千分位整数：fmtInt(12345.6) → "12,346"（不用 toLocaleString，保证可复现） */
export function fmtInt(v: number): string {
  if (!Number.isFinite(v)) return NA;
  const n = Math.round(v);
  const neg = n < 0;
  const s = String(Math.abs(n));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return neg ? '-' + out : out;
}

/** 显式带符号定点数：+1.20 / -0.35 / -0.00 保留符号 */
export function fmtSigned(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return NA;
  const s = v.toFixed(clamp(Math.floor(digits), 0, 8));
  return v > 0 ? '+' + s : s;
}

/** 0..1 的比值显示（资源条百分比用）：内部已钳制，避免 "112%" 这种脏数据 */
export function fmtRatioPct(num: number, den: number, digits = 0): string {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return NA;
  return fmtPct(clamp01(num / den), digits);
}
