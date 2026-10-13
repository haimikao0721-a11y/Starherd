/**
 * STARHERD — 共享类型契约（冻结 v1.0）
 * 单位制：归一化天文单位 G=1, mu_star=1, 1 RU=128px, 1 TU=1.6s
 * 本文件是 sim / render / audio / game 之间唯一的类型真相来源。
 */

export interface Vec2 { x: number; y: number; }

/* ------------------------------------------------------------------ 关卡数据 */

export type BodyKind = 'star' | 'planet' | 'blackhole' | 'asteroid' | 'station' | 'debris';
export type SimBodyKind = BodyKind | 'pod' | 'shard' | 'well';

/**
 * 开普勒轨道要素。
 * `parent` 为空 = 绕系统主天体（μ = mu_star）；填了父天体的 id = **层级轨道**（卫星）：
 * 状态 = 父天体状态 + 以父天体 μ 解算的相对轨道（拼锥近似，与真实任务设计一致）。
 */
export interface OrbitSpec { a: number; e: number; omega: number; M0: number; parent?: string; }

export interface BodySpec {
  id: string; kind: BodyKind; mass: number; radius: number;
  orbit: OrbitSpec | null; tint: number; tag?: string; rs?: number;
}
export interface PodSpec {
  id: string; mass: number; radius: number; hull: number; sail: number; orbit: OrbitSpec | null;
  /** 货舱级别 id（见下方 POD_CLASSES）。缺失或未知一律按 'standard' 处理（向后兼容旧关卡数据）。 */
  class?: string;
}
export interface HazardSpec {
  /** tidal = 启用洛希极限撕裂（第 1~2 章默认关闭，避免用高级机制惩罚新手） */
  kind: 'wind' | 'killzone' | 'jet' | 'tidal';
  period: number; phase: number; strength: number; tag?: string;
  x?: number; y?: number; r?: number;
}
export interface NebulaSpec { x: number; y: number; r: number; density: number; omega: number; }

/** 关卡内的定时事件（目前支持宇宙风暴：一道推进的力场锋面）。 */
export interface EventSpec {
  kind: 'storm' | 'rescue' | 'flare' | 'wave' | 'shower';
  /** 首次触发时刻（TU） */
  t0: number;
  /** 周期（TU）；0 = 只出现一次 */
  period: number;
  /** 锋面推进方向（弧度，0 = +x） */
  dir: number;
  /** 锋面速度（RU/TU） */
  speed: number;
  /** 锋面厚度（RU）：越厚影响时间越长 */
  width: number;
  /** 锋面内的加速度（RU/TU²），方向与 dir 相反则把货舱往回推 */
  accel: number;
  /** （rescue 专用）船体泄漏速率：每秒扣多少结构强度；0.02 ≈ 50 秒解体 */
  leakRate?: number;
  /** （flare / wave 专用）事件持续时长（TU）；缺省 flare 1.2 / wave 2.5 */
  duration?: number;
  /** （shower 专用）每次撒入的碎石数量与单块质量/半径 */
  count?: number;
  rockMass?: number;
  rockRadius?: number;
}

/** 事件运行时状态（供 HUD 预警与渲染使用）。 */
export interface EventRuntime {
  kind: 'storm' | 'rescue' | 'flare' | 'wave' | 'shower';
  /** 锋面中心位置（世界坐标） */
  x: number;
  y: number;
  dir: number;
  /** 距离抵达本关作业区还有多少 TU（负数 = 已经过境） */
  eta: number;
  /** 是否正在影响作业区 */
  active: boolean;
}

/** 多段目标的一段：把货舱送到某天体附近的泊位。 */
export interface ObjectiveSpec {
  /** 目标天体的 key（与 bodies 里的 key 对应） */
  body: string;
  /** 相对该天体的偏移（RU） */
  offset?: { x: number; y: number };
  /** 泊位半径（缺省沿用关卡 dock.radius） */
  radius?: number;
  /** 软对接速度门限（缺省沿用关卡 dock.v_max） */
  v_max?: number;
  label_zh?: string;
  label_en?: string;
}

export interface LevelSpec {
  id: string; index: number; chapter: number;
  name_zh: string; name_en: string; difficulty: number;
  /** 定时事件（可选）：宇宙风暴等 */
  events?: EventSpec[];
  /** 多段目标（可选）：按顺序送达的泊位序列。缺省 = 单一 dock，行为不变。 */
  objectives?: ObjectiveSpec[];
  /** 难度档位（tools/difficulty_probe.py 用 AI 探针实测写入）：普通/困难/挑战 */
  difficulty_label?: string;
  /** 燃料预算系数（可选）：fuelCapacity = (40 + 6×难度) × 该值 */
  fuel_scale?: number;
  mu_star: number; bounds: number;
  camera: { x: number; y: number; zoom: number };
  bodies: BodySpec[]; pods: PodSpec[];
  dock: { body: string; offset?: Vec2; radius: number; v_max: number };
  hazards: HazardSpec[]; nebulae: NebulaSpec[];
  par_time: number; par_fuel: number;
  hint_zh: string; hint_en: string;
  solution?: { method: string; dv_min: number; notes: string };
  palette?: string;
}

export interface ChapterSpec {
  index: number; name_zh: string; name_en: string; palette: string; music: string; desc_zh: string;
}
export interface LevelsDoc {
  version: string; generated_at: string;
  constants: { G: number; mu_star: number; epsilon: number; time_scale: number; isp: number; g0: number };
  chapters: ChapterSpec[]; levels: LevelSpec[];
}

/* ------------------------------------------------------------------ 货舱级别（cargo pod variants） */

/**
 * 货舱级别：**只给参数、不改公式**。级别用到的那四个量本来就已经喂进既有公式，
 * 这里只是把"一组自洽的参数"打包命名，让玩家在 HUD / 简报里一眼看出这舱是什么脾气：
 *
 *   mass   → 光压 a_rad = K_RAD·sail·A/(r²·m)、星云阻力 a_drag ∝ 1/m、碰撞 Δv = j/m
 *   radius → 迎风面积 A = πr²、碰撞截面、潮汐梯度 Δa = 2μΔr/r³、洛希极限 ∝ ρ^(−1/3)
 *   hull   → 结构强度 = Body.integrity 初值（硬对接后完整性 0.55）
 *   sail   → 光帆系数，直接乘在光压上（step.ts 调 radiationAccel 时传入）
 *
 * ⚠️ 必须说清的一件事：引力井（场投影器）是**运动学加速度耦合**——它对任何质量给出同样的
 *    加速度（等效原理式的场，不是恒力拖拽），所以"重舱更难拉动"在这个模型里**不成立**，
 *    FIELD_ACCEL_MAX 也正是按这个前提标定的。重舱的真实代价/收益全部落在 1/m 项上：
 *    光压与星云减速只剩 1/3（失去"免费刹车"），撞击后果也只有 1/3（敢硬闯碎石带）。
 */
export type PodClassId = 'standard' | 'heavy' | 'fragile' | 'sailer';

export interface PodClass {
  id: PodClassId;
  /** 中文名（HUD 画布上按 ≤4 汉字排版，不换行不截断） */
  nameZh: string;
  nameEn: string;
  mass: number;
  radius: number;
  hull: number;
  sail: number;
  /** 标签色（十六进制，供 HUD 的 rgba() 与简报页内联样式复用） */
  color: string;
  /** 一句话特性说明：简报页与 HUD 悬停提示直接显示 */
  note: string;
}

/**
 * 级别参数表（权威）。基准 = 当前 12 关的货舱（mass 2e-05 / radius 0.012 / hull 1 / sail 0.7），
 * 辐射压标定见 constants.K_RAD：标准舱在 r=1 处的光压 = 恒星引力的 2.0%。
 * 潮汐撕裂半径取自 constants.tidalTearRadius(μ=1, m, r)：标准舱 0.557 RU。
 */
export const POD_CLASSES: Record<PodClassId, PodClass> = {
  /**
   * 标准舱：基准参数，逐位等于改造前的关卡数据。
   * 打法：没有短板也没有借力——拉得动、撞得起、光压可以忽略（2%）。
   */
  standard: {
    id: 'standard', nameZh: '标准舱', nameEn: 'STANDARD',
    mass: 2e-5, radius: 0.012, hull: 1.0, sail: 0.7,
    color: '#9fb3c8',
    note: '标准舱：基准型（光压 2% 恒星引力）。各项参数居中，拉得动也撞得起，不需要为它改打法。',
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
    id: 'heavy', nameZh: '重舱', nameEn: 'HEAVY',
    mass: 6e-5, radius: 0.012, hull: 1.0, sail: 0.7,
    color: '#ffb347',
    note: '重舱：质量 ×3 —— 光压/星云减速/撞击后果都只剩 1/3（可硬闯碎石带、可贴行星过洛希极限），但别指望光压和星云帮你刹车。',
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
    id: 'fragile', nameZh: '易碎舱', nameEn: 'FRAGILE',
    mass: 8e-6, radius: 0.0102, hull: 0.55, sail: 0.55,
    color: '#ff4d5e',
    note: '易碎舱：低密度壳薄（hull 0.55）—— 撕裂半径外扩 15%（0.643 RU），撞击解体门槛降到 40%，接近必须更柔和。',
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
    id: 'sailer', nameZh: '大帆舱', nameEn: 'SAILER',
    mass: 1.2e-5, radius: 0.012, hull: 0.9, sail: 1.9,
    color: '#c9a6ff',
    note: '大帆舱：光帆系数 1.9、质量 ×0.6 —— 光压是标准舱的 4.5 倍（r=1 处≈恒星引力的 9%），可靠它省 Δv，也会被它推出轨道。',
  },
};

/** 表内全部级别 id（顺序 = 简报页/图例的展示顺序） */
export const POD_CLASS_IDS: PodClassId[] = ['standard', 'heavy', 'fragile', 'sailer'];
/** 缺省级别：class 缺失或未知时按它处理（= 改造前的行为） */
export const DEFAULT_POD_CLASS: PodClassId = 'standard';

/** 级别查找：缺失/未知 id → 标准舱（向后兼容旧关卡数据） */
export function podClass(id?: string | null): PodClass {
  if (id) {
    const hit = (POD_CLASSES as Record<string, PodClass | undefined>)[id];
    if (hit) return hit;
  }
  return POD_CLASSES[DEFAULT_POD_CLASS];
}

/**
 * 关卡数据 → 实际生效的货舱参数。
 *  · class 缺失 / 'standard'：原样使用 spec 的数值（= 当前 12 关的参数，行为逐位不变）；
 *  · 其余级别：用 POD_CLASSES 的权威参数覆盖 mass/radius/hull/sail（"class" 是唯一开关，
 *    关卡数据因此只需要加一个字段，不必重写物理量，也不必跑 levelgen 重生成）。
 */
export function resolvePodSpec(spec: PodSpec): { cls: PodClass; mass: number; radius: number; hull: number; sail: number } {
  const cls = podClass(spec.class);
  if (cls.id === DEFAULT_POD_CLASS) {
    return { cls, mass: spec.mass, radius: spec.radius, hull: spec.hull ?? 1, sail: spec.sail ?? 1 };
  }
  return { cls, mass: cls.mass, radius: cls.radius, hull: cls.hull, sail: cls.sail };
}

/** 本关货舱构成统计（简报页"标准舱 ×1 · 易碎舱 ×1"，按 POD_CLASS_IDS 顺序） */
export function podClassCounts(pods: readonly { class?: string }[]): { cls: PodClass; n: number }[] {
  const out: { cls: PodClass; n: number }[] = [];
  for (const p of pods) {
    const cls = podClass(p.class);
    const hit = out.find((o) => o.cls.id === cls.id);
    if (hit) hit.n++;
    else out.push({ cls, n: 1 });
  }
  const rank = (id: PodClassId): number => POD_CLASS_IDS.indexOf(id);
  out.sort((a, b) => rank(a.cls.id) - rank(b.cls.id));
  return out;
}

/* ------------------------------------------------------------------ 素材 */

export interface ManifestEntry {
  name: string; file: string; bytes: number; sha256: string;
  seconds?: number; peak?: number; rate?: number; channels?: number; w?: number; h?: number;
}
export interface Manifest {
  version: string; generator: string; seed: number; generated_at: string;
  audio: ManifestEntry[]; art: ManifestEntry[]; music: ManifestEntry[];
  total_bytes: number;
}
export interface MusicSection { start_bar: number; name: string; intensity: number; }
export interface MusicNote {
  t: number; dur: number; midi: number; vel: number;
  track: 'pad' | 'bass' | 'arp' | 'perc' | 'lead'; intensity: number;
}
export interface MusicScore {
  name: string; bpm: number; bars: number; beats_per_bar: number;
  key: string; mode: string; scale: number[];
  sections: MusicSection[]; notes: MusicNote[];
}
export interface MusicIndexEntry { name: string; file: string; bpm: number; bars?: number; beats_per_bar?: number; key?: string; mode?: string; }

/** 素材仓库：由 game 层在 PRELOAD 阶段填充，render/audio 只读。 */
export interface AssetStore {
  readonly manifest: Manifest;
  readonly ready: boolean;
  image(name: string): HTMLImageElement | undefined;
  audioBuffer(name: string): AudioBuffer | undefined;
  audioUrl(name: string): string;
  music(name: string): MusicScore | undefined;
  musicIndex: MusicIndexEntry[];
  assetBase: string;
}

/* ------------------------------------------------------------------ 世界状态 */

export interface Body {
  id: number; key: string; kind: SimBodyKind; tag: string;
  mass: number; mu: number; radius: number;
  x: number; y: number; vx: number; vy: number;
  ax: number; ay: number;
  /** 上一物理步的位置，渲染插值用 */
  px: number; py: number;
  alive: boolean; integrity: number;
  area: number; cd: number; qpr: number;
  docked: boolean; delivered: boolean; lost: boolean;
  tint: number; ang: number; spin: number;
  /** true=参与互相 N 体（主天体） */
  primary: boolean;
  /** 碰撞闪光剩余时间 */
  contact: number;
  /** 受击反馈：最近一次冲击强度 */
  jolt: number;
  /** 拖尾环形缓冲 */
  trailX: Float32Array; trailY: Float32Array; trailN: number; trailHead: number; trailTick: number;
  /** 潮汐应力累积（用于撕裂前的视觉预警） */
  stress: number;
  /** 持续处于撕裂区的时间（TU）：结构解体需要应力持续作用，不是瞬时判定 */
  tearT: number;
  /** 存在时长（TU），碎片会因寿命到期而消散 */
  life: number;
  /** 黑洞引力时间膨胀因子（视觉） */
  dilation: number;
  /** 货舱级别 id（仅 kind='pod'；其余天体不填）。见 POD_CLASSES。 */
  class?: string;
  /** 光帆系数（仅 kind='pod'）：辐射压 a = K_RAD·sail·A/(r²m) 的 sail。
   *  其余天体缺省 1，与改造前一致（小行星/碎片的光压不受货舱级别影响）。 */
  sail?: number;
  /** 结构强度（来自货舱级别）：耀斑等事件按它决定伤害倍率 */
  hull?: number;
}

export interface Well {
  engaged: boolean; repel: boolean; precise: boolean;
  mass: number; targetMass: number;
  k: number; c: number;
  x: number; y: number; vx: number; vy: number; px: number; py: number;
  /** 鼠标/制导给出的目标点 */
  tx: number; ty: number;
  /** 目标点的速度前馈（上一步的目标位置与估计速度）—— 让飞船跟随运动目标而不是制动到零，
   *  否则跟随 0.7 RU/TU 的目标需要 15 RU/TU² 的控制力，远超推力上限 3，飞船会彻底跟不上 */
  ltx: number; lty: number; tvx: number; tvy: number;
  /** 本帧实际施加的推力大小（决定燃料消耗与音效） */
  thrust: number;
  intensity: number;
  polarity: number;
  /** 恒星灼烧程度 0..1（>0 = 处于保护区，正在被光球层烘烤并紧急离场）；
   *  用于 HUD 警告与红色脉冲。见 step.ts 的安全阀与 constants.STAR_KEEPOUT */
  hot: number;
}

export interface Nebula { x: number; y: number; r: number; density: number; omega: number; }

export type FxKind =
  | 'impact' | 'dock' | 'lost' | 'fragment' | 'tear' | 'wind' | 'pulse'
  | 'ignite' | 'thruster' | 'warn' | 'win' | 'fail' | 'soi' | 'enter' | 'countdown';

export interface FxEvent {
  kind: FxKind;
  x: number; y: number;
  nx: number; ny: number;
  mag: number;
  tint: number;
  sound?: string;
  text?: string;
}

export interface SimStats {
  steps: number; substeps: number; ke: number; pe: number; energy: number;
  angularMomentum: number; momentumX: number; momentumY: number;
  energy0: number; angular0: number; time: number;
  energyDrift: number; angularDrift: number;
  lastStepMs: number; lastStats: number;
}

export interface LevelRuntime {
  id: string; index: number; chapter: number;
  nameZh: string; nameEn: string; difficulty: number;
  parTime: number; parFuel: number;
  hintZh: string; hintEn: string;
  palette: string; music: string;
  podsTotal: number; podsDelivered: number; podsLost: number;
  elapsed: number; fuelUsed: number; fuelCapacity: number; attempts: number;
  fidelityGrade: string; fidelityFactor: number; fidelityNote: string;
  solution: { method: string; dvMin: number; notes: string };
  bounds: number;
  /** 事件运行时状态（每帧由 sim 更新，HUD/渲染读取） */
  events?: EventSpec[]; timeLimit: number;
  /** 手感的即时反馈 */
  combo: number; comboTimer: number;

  /** 多段目标（从 spec 拷入；缺省为 undefined 表示单站） */
  objectives?: ObjectiveSpec[];
  /** 当前航段序号（0 起） */
  objectiveIndex: number;
  /** 总航段数（单站关为 1） */
  objectivesTotal: number;
}

export interface PredictedPath {
  bodyId: number; xs: Float32Array; ys: Float32Array; n: number;
  /** 预测是否命中恒星/黑洞（用于画警示） */
  hazard: boolean;
}

export type WorldStatus = 'running' | 'won' | 'lost';

export interface World {
  time: number; frame: number;
  G: number; epsilon: number; bounds: number;
  bodies: Body[];
  primaries: Body[];
  /** 事件运行时状态（每步由 sim 更新，HUD 与渲染读取） */
  events?: EventRuntime[];
  pods: Body[];
  shards: Body[];
  well: Well;
  level: LevelRuntime;
  dock: { bodyId: number; x: number; y: number; ox: number; oy: number; radius: number; vMax: number; pulse: number };
  nebulae: Nebula[];
  hazards: HazardSpec[];
  windTimer: number; windActive: number;
  status: WorldStatus;
  statusTimer: number;
  /** 算力耗尽后场投影器会掉线，直到算力恢复到迟滞阈值 */
  fieldEnabled: boolean;
  fuel: number; fuelCapacity: number; compute: number; computeMax: number;
  timeScale: number; slowmo: number;
  fx: FxEvent[];
  predicted: PredictedPath[];
  stats: SimStats;
  /** 事件计数器，供音频引擎判断"刚刚发生了什么" */
  counters: Record<string, number>;
}

/* ------------------------------------------------------------------ 渲染/视图 */

export interface Quality {
  maxParticles: number; trails: boolean; bloom: boolean; chroma: boolean;
  fieldContours: boolean; starLayers: number; glowScale: number; targetFps: number;
  /** 场景渲染分辨率比例（1 = 原生；降低它把整场光栅化与最终合成都变快）。见 renderer.setQuality */
  renderScale: number;
}

export interface ViewState {
  w: number; h: number; dpr: number;
  zoom: number; targetZoom: number;
  shake: number; hitstop: number; flash: number; chroma: number;
  showField: boolean; showVectors: boolean; showPredict: boolean;
  showOrbits: boolean;
  slowmo: number; intensity: number;
  fade: number; uiAlpha: number;
  wellMode: 'attract' | 'repel' | 'idle';
  quality: Quality;
  /** 世界→屏幕：由 renderer 根据 zoom/camera 计算并对外提供 */
  camera: { x: number; y: number; zoom: number };
}

export interface Palette {
  id: string;
  bg: string; bg2: string;
  star: string; star2: string;
  pod: string; pod2: string;
  station: string; station2: string;
  well: string; well2: string;
  danger: string; danger2: string;
  orbit: string; orbit2: string;
  ui: string; uiDim: string; uiAccent: string;
  nebula: string;
  tints: string[];
}

/* ------------------------------------------------------------------ 视觉调色板 */

export const PALETTES: Record<string, Palette> = {
  loop1: {
    id: 'loop1', bg: '#05070f', bg2: '#0a1024',
    star: '#ffe9a8', star2: '#ff9d3c',
    pod: '#ffb347', pod2: '#ff7a1a',
    station: '#8ef7d0', station2: '#2ad6a0',
    well: '#ff4fd8', well2: '#a626ff',
    danger: '#ff4d5e', danger2: '#8c1020',
    orbit: '#59d9ff', orbit2: '#2a6cff',
    ui: '#9fb3c8', uiDim: '#44536b', uiAccent: '#59d9ff',
    nebula: 'nebula_loop1',
    tints: ['#ffe9a8', '#7fd4ff', '#8ef7d0', '#c9a6ff', '#ffb347', '#ff7d94'],
  },
  loop2: {
    id: 'loop2', bg: '#060508', bg2: '#1a1206',
    star: '#fff0c0', star2: '#ffb03c',
    pod: '#ffd166', pod2: '#ff8f1f',
    station: '#9ef0ff', station2: '#26b6d6',
    well: '#ff7a3c', well2: '#ff2d6f',
    danger: '#ff5a3c', danger2: '#7a1a08',
    orbit: '#ffd98e', orbit2: '#c07a1a',
    ui: '#c8b39f', uiDim: '#5b4a3b', uiAccent: '#ffb347',
    nebula: 'nebula_loop2',
    tints: ['#fff0c0', '#ffb03c', '#9ef0ff', '#ffd166', '#c9a6ff', '#ff7d94'],
  },
  loop3: {
    id: 'loop3', bg: '#04070c', bg2: '#0b1a2a',
    star: '#d6f0ff', star2: '#4fa8ff',
    pod: '#ffd9f0', pod2: '#ff6fd8',
    station: '#c7ff9e', station2: '#5fd62a',
    well: '#59d9ff', well2: '#2a6cff',
    danger: '#ff4d5e', danger2: '#5e0a2a',
    orbit: '#9ecbff', orbit2: '#3a5cff',
    ui: '#a7c0d8', uiDim: '#3b4c63', uiAccent: '#8ef7d0',
    nebula: 'nebula_loop3',
    tints: ['#d6f0ff', '#4fa8ff', '#c7ff9e', '#ffd9f0', '#ffb347', '#ff7d94'],
  },
  loop4: {
    id: 'loop4', bg: '#06040a', bg2: '#160416',
    star: '#ffd0ff', star2: '#8a2bff',
    pod: '#ffcf7a', pod2: '#ff5a1a',
    station: '#7affe0', station2: '#12a08a',
    well: '#c04fff', well2: '#5a1fff',
    danger: '#ff2d55', danger2: '#3a0016',
    orbit: '#d08cff', orbit2: '#5a1fff',
    ui: '#b9a7d8', uiDim: '#4a3b63', uiAccent: '#ff6fd8',
    nebula: 'nebula_loop4',
    tints: ['#ffd0ff', '#8a2bff', '#7affe0', '#ffcf7a', '#ff5a1a', '#ff2d55'],
  },
};

export const DEFAULT_QUALITY: Quality = {
  maxParticles: 2200, trails: true, bloom: true, chroma: true,
  fieldContours: true, starLayers: 3, glowScale: 1, targetFps: 60,
  renderScale: 0.62,
};

/* ------------------------------------------------------------------ 网络 */

export interface WelcomeMsg {
  t: 'welcome'; version: string; mode: string; backend: string;
  server_time: number; port: number;
  config: {
    time_scale: number; phys_hz: number; epsilon: number; isp: number; g0: number;
    autotest: boolean; vsync: boolean; max_substeps: number;
  };
  levels: LevelsDoc; manifest: Manifest; music_index: MusicIndexEntry[];
  save: SaveState; asset_base: string;
}
export interface VerdictMsg {
  t: 'verdict'; level_id: string; grade: string; energy_drift: number;
  angular_drift: number; fidelity: number; par_ok: boolean; note: string; score_bonus: number;
}
export interface SaveState {
  version: string;
  settings: {
    master: number; music: number; sfx: number; muted: boolean;
    quality: 'low' | 'mid' | 'high'; showField: boolean;
    /** 帧率上限：0 = 不限，可设 30/60/120（玩家反馈要求固定帧率生效） */
    fpsCap?: number;
    /** 渲染分辨率比例 0.35~1（玩家反馈"分辨率设置作用不大"→ 现在可手动调） */
    renderScale?: number;
    /** true = 由性能自动调节分辨率；false = 用 renderScale 固定值 */
    renderScaleAuto?: boolean;
    /** true = 物理用 60Hz 步长（弱机省 CPU）；false = 120Hz（默认，更精确） */
    physics60?: boolean;
  };
  unlocked_chapters: number;
  best_scores: Record<string, { score: number; grade: string; time: number; fuel: number }>;
  totals: { played: number; delivered: number; lost: number; playtime: number };
  last_level: string;
}

export const DEFAULT_SAVE: SaveState = {
  version: '1.0',
  settings: { master: 0.8, music: 0.55, sfx: 0.9, muted: false, quality: 'high', showField: true, fpsCap: 0, renderScaleAuto: true, physics60: false },
  unlocked_chapters: 1,
  best_scores: {},
  totals: { played: 0, delivered: 0, lost: 0, playtime: 0 },
  last_level: 'L1-1',
};

/* ------------------------------------------------------------------ 结算 */

export interface ScoreBreakdown {
  score: number; grade: string;
  timeFactor: number; fuelFactor: number; fidelityFactor: number; survivalFactor: number;
  time: number; parTime: number;
  fuelUsed: number; parFuel: number;
  delivered: number; total: number; lost: number; combo: number;
  fidelityGrade: string; fidelityNote: string;
  energyDrift: number; angularDrift: number;
  difficulty: number;
  /** 难度档位（由 tools/difficulty_probe.py 用 AI 探针实测写入）：普通/困难/挑战 */
  difficulty_label?: string;
  /** 燃料预算系数（可选）：fuelCapacity = (40 + 6*difficulty) × 该值。
   * 用于把「极限」关卡放宽成「难但能过」——只加预算，不改任何物理与几何。 */
  fuel_scale?: number; newBest: boolean; success: boolean;
  title: string; subtitle: string;
}

export const GRADE_LADDER = ['D', 'C', 'B', 'A', 'S'] as const;
