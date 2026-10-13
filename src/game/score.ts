/** 计分：四项分解 × 难度系数 + 连击奖励（见 docs/DESIGN.md §5） */
import type { ScoreBreakdown, World } from '../sim/types';
import { SKILLED_TIME_FACTOR } from '../sim/constants';

const WEIGHTS = { time: 0.35, fuel: 0.30, fidelity: 0.20, survival: 0.15 };

export function gradeFor(score: number): string {
  if (score >= 900) return 'S';
  if (score >= 780) return 'A';
  if (score >= 640) return 'B';
  if (score >= 480) return 'C';
  return 'D';
}

export interface VerdictLike {
  grade: string; fidelity: number; note: string; energy_drift: number; angular_drift: number;
}

export function computeScore(world: World, verdict: VerdictLike | null, newBest: boolean): ScoreBreakdown {
  const lv = world.level;
  const time = Math.max(world.time, 0.001);
  // 时间因子：par_time 是"物理最短时间"（≥1.25×霍曼转移），人类不可能贴着它完成，
  // 因此满分基准取 2.5×par_time，提前完成最多 1.25 倍加成。
  const parTimeScore = Math.max(lv.parTime * SKILLED_TIME_FACTOR, 12);
  const timeFactor = clamp(parTimeScore / time, 0, 1.25);
  // 燃料因子：飞船 Δv 预算的 55% 视为"优秀飞行员"的基准消耗
  const parDv = lv.fuelCapacity * 0.55;
  const fuelFactor = clamp(parDv / Math.max(lv.fuelUsed, 0.02), 0, 1.25);
  const fidelityFactor = verdict ? clamp(verdict.fidelity, 0, 1) : clamp(lv.fidelityFactor, 0, 1);
  // 存活因子：按送达货舱的完整度加权（硬对接会掉完整度）
  let integrity = 0;
  for (const p of world.pods) if (p.delivered) integrity += p.integrity;
  const survivalFactor = clamp(integrity / Math.max(1, lv.podsTotal), 0, 1);

  const base = WEIGHTS.time * timeFactor + WEIGHTS.fuel * fuelFactor
    + WEIGHTS.fidelity * fidelityFactor + WEIGHTS.survival * survivalFactor;
  const diffScale = 0.85 + 0.03 * lv.difficulty;
  const comboBonus = lv.combo * 25;
  const success = world.status === 'won';
  const raw = 1000 * base * diffScale + comboBonus;
  const score = Math.max(0, Math.round(success ? raw : raw * 0.35));

  return {
    score, grade: gradeFor(score),
    timeFactor, fuelFactor, fidelityFactor, survivalFactor,
    time, parTime: parTimeScore,
    fuelUsed: lv.fuelUsed, parFuel: lv.fuelCapacity,
    delivered: lv.podsDelivered, total: lv.podsTotal, lost: lv.podsLost, combo: lv.combo,
    fidelityGrade: verdict?.grade ?? lv.fidelityGrade,
    fidelityNote: verdict?.note ?? lv.fidelityNote,
    energyDrift: verdict?.energy_drift ?? world.stats.energyDrift,
    // 多段航程：结算页要交代清楚（目标第 4 项要求的结算支持）
    legsDone: world.level.objectiveIndex ?? 0,
    legsTotal: world.level.objectivesTotal ?? 1,
    angularDrift: verdict?.angular_drift ?? world.stats.angularDrift,
    difficulty: lv.difficulty, newBest, success,
    title: success ? '任务完成' : '任务失败',
    subtitle: success
      ? (integrity >= lv.podsTotal ? '全部货舱完好送达' : '货舱有损伤，但任务达成')
      : '再接再厉：先让货舱进入一条能追上空间站的轨道',
  };
}

function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }
