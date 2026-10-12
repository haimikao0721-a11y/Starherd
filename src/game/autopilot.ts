/**
 * 自动驾驶（引力牵引制导）：也被"演示模式(ATTRACT)"与自动化验收复用。
 *
 * 制导律：把货舱需要的加速度取为 PD 控制
 *     a_des = kp·(D − P) + kd·(v_station − v_pod)
 * 再反解引力井应该待在哪里：
 *     场加速度 a(r) = G·M/(r²+ε²)·cut(r)，令 a(r) = |a_des| 解出 r，井放在货舱沿 a_des 方向 r 处。
 * 这不是作弊——井依然要靠自己的推进器飞过去，玩家在同一条物理规则下操作。
 */
import type { Body, World } from '../sim/types';
import { EPS, FIELD_ACCEL_MAX, WELL_MASS_MAX, WELL_MASS_MIN, WELL_RANGE } from '../sim/constants';
import { keplerPeriod, pointAccel, stateToElements, tidalTearRadius, wellAccel } from '../sim/physics';

export interface PilotState {
  podIndex: number;
  mode: 'idle' | 'track';
  /** 上一次切换目标的模拟时间 */
  switched: number;
  /** 累计推力（供演示模式做"AI 也在烧燃料"的可视化） */
  thrustAcc: number;
  /** 限速后的指令点（世界坐标） */
  cmdX: number; cmdY: number; hasCmd: boolean;
  /** 两次决策之间的实时步长（供限速使用） */
  dt: number;
  /** 交会停滞检测：历史最近距离与对应时刻（用于触发"复飞"） */
  lastBest: number;
  lastBestT: number;
  /** 复飞执行到哪个时刻为止 */
  retryUntil: number;
  retryCount: number;
}

export function createPilot(): PilotState {
  return { podIndex: -1, mode: 'idle', switched: -99, thrustAcc: 0, cmdX: 0, cmdY: 0, hasCmd: false, dt: 1 / 60,
    lastBest: Infinity, lastBestT: 0, retryUntil: 0, retryCount: 0 };
}

export interface PilotTelemetry {
  active: boolean; targetIndex: number; distance: number; closing: number; aDes: number;
  rPod: number; rStation: number; phase: 'spiral' | 'terminal' | 'idle'; fuel: number;
  /** 井与货舱的实际距离 */
  dWellPod: number;
  /** 期望加速度方向与实际拉力方向之间的夹角（度）——制导质量的关键指标 */
  dirErr: number;
  /** 是否处于制导死区（关场滑行） */
  deadband: boolean;
  /** 本步触发的避碰约束数量（诊断用） */
  avoid?: number;
  /** 是否处于"近星点过低、中断接近"的 abort 状态 */
  abort?: boolean;
}

const KV = 1.5;            // 末段速度误差增益
const A_MAX_CMD = 0.6;     // 指令加速度上限（场投影器额定 1.1，留出余量）
const K_A = 0.4;           // 半长轴误差 → 切向加速度增益
const A_TANGENT = 0.08;    // 切向加速度上限（低推力转移：越小越保圆，越大越快但越容易把 e 推大）
const KR_E = 1.35;         // 径向速度阻尼（压偏心率，保持轨道近圆）
const PHASE_OFFSET = 0.04; // 相位漂移用的高度偏置（RU）：制造周期差去追上空间站
// 实测对照：把上限从 0.25 放大到 0.60（想用"真正的相位轨道"加快漂移）**反而退化**（5/12 → 3/12，
// L1-2 与 L3-1 掉出）——激进相位机动会破坏本来收敛的轨迹。相位规划需要"提前算好整条路径"，
// 不是把局部偏置调大就能解决，故保留 0.25。
const PHASE_MAX_OFFSET = 0.25;
const RNDZ_GATE = 1.2;     // 进入交会段（速度匹配）的距离门限（RU）：原先只有 0.3，
                           // 中段完全没有制导，只能靠半长轴控制"撞运气"，实测 1~4 RU 处反复过冲
const R_MIN = 0.25;        // 井与货舱的最小力臂（避免近场反馈弹射）
const R_MAX = 1.0;
const V_APPROACH_MAX = 0.25; // 末段接近速度上限（对接环 v_max 通常 0.18~0.35）
const TAU = Math.PI * 2;
const accT = { x: 0, y: 0 };
const tmpA = { x: 0, y: 0 };
const DIR_DEADBAND = 0.50;  // 井的方向死区（弧度，约 29°）。扫描实测的最优点：
                            // 0.20→3/12、0.35→5/12、**0.50→6/12**、0.65→4/12、0.85→3/12。
                            // 这是燃料经济性与控制响应性的真实折中：死区太小则飞船持续奔波烧油，
                            // 太大则井位跟不上方向变化、控制力不足。  // 井的方向死区（弧度，约 20°）：阈值内保持井位不动以省燃料
const SLEW_FAST = 1.1;     // 指令点移动速率（RU/TU）：SLEW 扫描实测 1.1 最优（0.6/0.8/0.9 分别得 3/2/3 关）
const SLEW_SAVE = 0.6;     // 备用：油量告急时的省油速率（实测燃料自适应版本 4/12，比固定 1.1 的 5/12 更差，故未启用）
// 实测证据：L2-2 在 t=42.7 就 fuel=0.0，井被甩到 17~19 RU 外（dwp=19），此后所有指令都落空。
// 原值 1.1 RU/TU 让飞船在关卡里长途奔波，油全花在"追指令点"上。降到 0.6 让井贴着货舱工作。
const A_DEAD = 0.03;       // 制导死区：所需加速度小于此值就关场滑行（避免方向噪声）
const KEEP_OUT = 0.5;      // 恒星规避半径（RU）
const AVOID_MARGIN = 0.06; // 避碰净空（RU）：实心天体半径之外还要留出的余量
const AVOID_RANGE = 3.5;   // 只在危险半径的 3.5 倍以内才干预
const AVOID_GAIN = 1.35;   // 避碰排斥增益

export function autopilot(world: World, st: PilotState, tel?: PilotTelemetry): void {
  const w = world.well;
  const dock = world.dock;

  // ---- 选靶：选**最容易送达**的货舱，而不是"离站最近"的 ----
  // 过关只要求送达规定数量（多数关卡 1 个即可），所以"最近"是错的启发式：离站很近但相位差
  // 很大的货舱，实际比"远一点但已在对接相位上"的更难送。评分 = 相位弧长 + 0.8×轨道半径差。
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
    if (i === st.podIndex) { curD = d; curScore = score; }
    if (score < bestScore) { bestScore = score; bestD = d; best = i; }
  }
  // **目标滞回**（原先 `st.switched` 字段声明了却从未使用 = 没有滞回）：
  // 每步都重选目标会让两个货舱来回抢夺引力井，结果是两个都被拖着走、两个都丢。
  // 实测证据：失败的 2 货舱关卡全部报「损毁 2」，而通过的 2 货舱关卡都是「送达 1 损毁 1」。
  // 规则：沿用当前目标，除非别的货舱容易 30% 以上（或当前目标已失效）。
  {
    const cur = st.podIndex >= 0 && st.podIndex < world.pods.length ? world.pods[st.podIndex] : null;
    if (cur && cur.alive && !cur.delivered && best !== st.podIndex
      && Number.isFinite(curScore) && bestScore > 0.7 * curScore) {
      best = st.podIndex;
      bestD = curD;
      bestScore = curScore;
    }
  }
  if (best < 0) {
    st.mode = 'idle';
    w.engaged = false;
    if (tel) { tel.active = false; tel.targetIndex = -1; }
    return;
  }
  st.podIndex = best;
  const pod: Body = world.pods[best];
  const station = world.primaries.find((p) => p.id === dock.bodyId);
  const svx = station ? station.vx : 0;
  const svy = station ? station.vy : 0;

  // ---- 交会停滞 → 复飞（go-around）----
  // 真实飞行员在进近停滞时会复飞重来。探针原先会在原地干耗到超时——实测 L2-2 / L3-2 / L4-2
  // 三关都是"贴到 0.4~1.4 RU，然后一直耗到 90 TU 任务失败"。这里给一个简单的复飞：
  // 最近距离 14 TU 没有实质改善就抬轨重来（最多 4 次）。实测：宽松版中性（6/12 不变），
  // 收紧到 8 TU / 0.06（更积极复飞）反而退化到 5/12——复飞本身要花燃料，不能太频繁。
  const nowT = Number.isFinite(world.stats.time) ? world.stats.time : 0;
  if (bestD < st.lastBest - 0.02) { st.lastBest = bestD; st.lastBestT = nowT; }
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
  let phase: 'spiral' | 'terminal' | 'idle' = 'spiral';
  const star = world.primaries.find((b) => b.kind === 'star' || b.kind === 'blackhole') ?? world.primaries[0];
  const mu = star ? star.mu : 1;
  const vc = Math.sqrt(mu / rPod);
  // 切向单位向量，方向取货舱实际运动方向
  const thx = -rhaty, thy = rhatx;
  const sgn = pod.vx * thx + pod.vy * thy >= 0 ? 1 : -1;
  const tvx0 = sgn * thx, tvy0 = sgn * thy;

  const dx = dock.x - pod.x, dy = dock.y - pod.y;
  const sep = Math.hypot(dx, dy) || 1e-6;

  if (sep > RNDZ_GATE) {
    // ---- 阶段一：轨道要素制导（低推力转移的标准做法）----
    // 控制量取"半长轴 a"而不是"半径 r"：r 在椭圆轨道上周期性摆动，用它做反馈会激发
    // 径向振荡（实测货舱从 2.41 荡到 0.81 再荡出去）；而 a 是轨道要素，在一个周期内单调，
    // 于是控制器是一阶系统、不会过冲。切向推力改变 a，径向阻尼压住偏心率。
    const els = stateToElements(pod.x, pod.y, pod.vx, pod.vy, mu);
    const Tst = keplerPeriod(mu, Math.max(rSt, 1e-6)); // 空间站轨道周期（相位规划用）
    const aOsc = isFinite(els.a) && els.a > 0 ? els.a : rPod;
    let aTarget = rSt;
    const angPod = Math.atan2(pod.y, pod.x);
    const angSt = Math.atan2(dock.y, dock.x);
    let dAng = angSt - angPod;
    while (dAng > Math.PI) dAng -= 2 * Math.PI;
    while (dAng < -Math.PI) dAng += 2 * Math.PI;
    // 相位漂移：同高度同速度的两个天体角距永远不变，必须制造周期差才能会合（真实 phasing 机动）。
    // 偏置随相位差增大（|dAng|×0.18，封顶 0.25）：太小则漂移赶不上时限，太大则打乱收敛中的轨迹。
    // 已证伪的替代方案（都实测更差，记录在此避免重复）：
    //   · N 圈相位规划器 δa = a·Δθ/(3πN) + 燃料预算 → 5/12（换关不增关，即使叠加方向死区也是 4/12）；
    //   · 相位偏置上限放大到 0.60 → 3/12；
    //   · **分段降轨 + 停车轨道**（先降到站上方 8% 停车、消相位、再降末段）→ 5/12（L1-2 掉出）。
    // 三者都指向同一结论：相位/降轨必须与**井的移动燃料**一起做全局优化，局部改动只会换关。
    if (Math.abs(dAng) > 0.12) {
      const phOff = Math.min(PHASE_MAX_OFFSET, Math.max(PHASE_OFFSET, Math.abs(dAng) * 0.18));
      aTarget = rSt - Math.sign(dAng) * phOff;
    }
    // 复飞：进近停滞时先抬到站轨道之上重新建立几何关系（而不是原地耗到超时）
    if (retrying) aTarget = rSt + 0.15;
    let da = aOsc - aTarget;
    // 近星点安全底线：真正会被潮汐撕碎的是近星点 a(1−e)，不是半长轴。
    // 没有这一层，螺旋转移会把偏心率越推越大，近星点最终跌破撕裂半径（实测货舱在 0.59 处被撕）。
    // 另外必须叠加**中心天体表面**下限：第 1~2 章关掉了撕裂机制，但撞进恒星一样会毁掉货舱
    // （实测自动驾驶就是这样把货舱"坠入恒星"的，事件发生在 r=0.34，远在撕裂半径之内）。
    const tearR = tidalTearRadius(mu, pod.mass, pod.radius) * 1.35;
    const core = world.primaries.find((b) => (b.kind === 'star' || b.kind === 'blackhole') && b.alive);
    const surfR = (core ? core.radius : 0.12) + 0.14;
    const safePeri = Math.max(tearR, surfR);
    const peri = aOsc * (1 - Math.max(0, Math.min(0.95, els.e)));
    if (peri < safePeri) {
      // 越贴近底线，拉起越强；深俯冲时给一个压倒性的顺行偏置
      const depth = Math.min(1, (safePeri - peri) / safePeri);
      da = Math.max(da, (safePeri - peri) * (3 + 14 * depth));
    }
    // 近星点保护：降轨切向力只在"远离近星点"时全量施加。
    // r/a > 1 = 在远星点一侧（此时降轨最安全）；< 1 = 在近星点一侧（继续猛拉会把偏心率越推越大，
    // 货舱会一头扎向中心天体）。这是真实低推力转移里的 periapsis-protection 策略。
    const rRatio = rPod / Math.max(aOsc, 1e-6);
    const periGuard = rRatio > 1 ? 1 : 0.25 + 0.75 * Math.max(0, (rRatio - 0.75) / 0.25);
    const at = Math.max(-A_TANGENT, Math.min(A_TANGENT, -K_A * da * periGuard));
    const at0 = Math.max(-A_TANGENT, Math.min(A_TANGENT, -K_A * da));
    adx = at * tvx0;
    ady = at * tvy0;
    // 偏心率越高，径向阻尼越强：高 e 轨道会周期性扎向中心天体（实测 L1-1 货舱被拉到 r=0.36，
    // 而空间站在 1.10 —— 半长轴没错，是偏心率失控）。
    const eBoost = 1 + 6 * Math.min(0.8, Math.max(0, els.e));
    adx += -KR_E * eBoost * vRad * rhatx;
    ady += -KR_E * eBoost * vRad * rhaty;
    phase = 'spiral';
  } else {
    // ---- 阶段二：末段交会（速度匹配 + 受控接近速度）----
    // 接近速度随距离收敛到 0，于是末端 |v_rel|→0，自然满足对接门限。
    const ux0 = dx / sep, uy0 = dy / sep;
    // 末段安全（真实"自杀式刹车"判据）：若当前接近速度所需减速度超过场能力，
    // 就放弃继续贴近，改为纯速度匹配（先把相对速度压下来）。
    // 没有这一层，实测会出现"对接速度超限"撞环，随后被弹飞 6.6 RU 脱离作用范围。
    const vClose = -((pod.vx - svx) * ux0 + (pod.vy - svy) * uy0);
    const aNeeded = vClose > 0 ? (vClose * vClose) / Math.max(2 * sep, 1e-6) : 0;
    // 接近速度按**本关对接窗口**自适应：窗口小的关卡必须更柔和（否则会硬对接损毁货舱）
    const vLim = Math.max(0.05, (dock.vMax || 0.3) * 0.55);
    const vApp = aNeeded > FIELD_ACCEL_MAX * 0.8 ? 0 : Math.min(vLim, sep * 0.45);
    adx = KV * (svx + ux0 * vApp - pod.vx);
    ady = KV * (svy + uy0 * vApp - pod.vy);
    phase = 'terminal';
  }

  // ---- 障碍规避（避碰约束）----
  // 实测失败里多数是碰撞损毁：撞恒星（L1-2 坠入恒星）、撞行星（L3-x）、撞小行星（L4-3）。
  // 原先制导只关心"把半长轴降到站的轨道"，完全不看路径上有什么——真实交会任务里避碰是必做一步。
  // 做法：对每个实心天体算"接近速度所需减速度"，在危险半径的 AVOID_RANGE 倍以内按紧迫度加排斥项。
  // 必须放在 if/else **之后**：它是对两个阶段的共同修正，放进分支里会破坏控制律。
  for (const b of world.bodies) {
    if (!b.alive) continue;
    if (b.kind !== 'star' && b.kind !== 'blackhole' && b.kind !== 'planet' && b.kind !== 'asteroid') continue;
    const dbx = pod.x - b.x;
    const dby = pod.y - b.y;
    const rb = Math.hypot(dbx, dby);
    const danger = b.radius + AVOID_MARGIN;
    // **分级避碰参数**：越致命、越密集的天体，预警越早、越柔和。
    // 早做小侧向修正远比晚做径向刹车省推力——碎石带里有几十颗，必须提前绕开而不是逐个急刹。
    // 恒星/黑洞改用"**更大的安全气泡 + 更短预测窗口**"：在多星系统里伴星沿弯曲轨道运动，
    // 5 TU 的线性外推会明显偏离真实位置；把窗口收回到 3 TU、同时把气泡放大，等效地更早开始绕开。
    // **加宽门限但紧迫度按距离分级**：门限太窄会让上面的预测窗口失效（天体还在几 RU 外就被
    // `rb > outer` 跳过，等进入范围已来不及侧移——实测 L2-2/L3-1 都撞在行星上）；
    // 但若给远天体固定的最小推力，又会持续扰动本来正常的轨迹（实测 6/12 → 4/12）。
    // 正确折中：把网撒大（门限 6×危险半径），推力仍随当前距离衰减（远 → 几乎为 0）。
    const isAsteroid = b.kind === 'asteroid';
    const isBig = b.kind === 'star' || b.kind === 'blackhole';
    const range = isAsteroid ? AVOID_RANGE * 1.7 : AVOID_RANGE;
    const horizon = isBig ? 3.0 : 4.0;
    const dangerEff = danger + (isBig ? 0.06 : 0);
    const outer = dangerEff * range;
    // 实测对照（三种门限策略，同一份代码其它部分不变）：
    //   窄门限 + 距离分级紧迫度 → **6/12**（最优）
    //   去掉距离门、按预测距离给最小紧迫度 → 4/12（远天体持续小推力扰动轨迹）
    //   宽门限（×1.7/×2.6）+ 距离分级 → 5/12
    // 因此保留窄门限：预测窗口只在"已经进入警戒圈"后生效，这时距离外推是准的。
    if (rb > outer) continue;
    // **不要用"当前距离"提前 continue**：那会让上面的预测窗口完全失效——天体还在 4 RU 外
    // 就被 `rb > outer` 跳过，等它进入范围时已经来不及侧移。实测 L2-2/L3-1 都是"撞击行星"。
    // 正确做法：先算预测最近接近距离，用它驱动紧迫度（至少保留 15% 权重，于是有温和的早期修正）。
    const nbx = dbx / (rb || 1e-9);
    const nby = dby / (rb || 1e-9);
    const rvx = pod.vx - b.vx;
    const rvy = pod.vy - b.vy;
    const vCloseB = rvx * nbx + rvy * nby;
    if (vCloseB > 0) continue; // 正在远离，不干预
    const vv2 = rvx * rvx + rvy * rvy;
    const tca = vv2 > 1e-12 ? -(dbx * rvx + dby * rvy) / vv2 : 0;
    if (tca < 0) continue;
    const tH = Math.min(tca, horizon);
    const miss = Math.hypot(dbx + rvx * tH, dby + rvy * tH);
    if (miss > dangerEff) continue; // 预测不会撞上 → 不动它
    const need = (vCloseB * vCloseB) / Math.max(2 * Math.max(rb - dangerEff, 1e-3), 1e-6);
    const urgency = Math.max(0, 1 - rb / outer);
    // **紧急时允许用满场强**：常规制导上限 0.6，但俯冲救不回来时（紧迫度高）必须放开到
    // 额定场强 1.1——实测 L1-2 就是这样"坠入恒星"的：指令被 0.6 卡住，拉不起来。
    const cap = urgency > 0.5 ? FIELD_ACCEL_MAX : A_MAX_CMD;
    const k = Math.min(cap, need) * urgency * AVOID_GAIN;
    if (k <= 0) continue;
    adx += nbx * k;
    ady += nby * k;
    if (tel) tel.avoid = (tel.avoid ?? 0) + 1;
  }

  // ---- 近星点 abort（两个阶段共用）----
  // 实测 L1-2：货舱在末段交会时被拉到 r=0.28（空间站还在 1.14），随后 2.5 TU 内坠入恒星。
  // 原因是近星点保护只写在螺旋段里，**末段交会完全绕过它**——而末段恰恰是最容易俯冲的时候。
  // 真实交会任务的正确做法：近星点低于安全线就中断接近、先抬轨道（abort），再重新交会。
  {
    const elsA = stateToElements(pod.x, pod.y, pod.vx, pod.vy, mu);
    const aA = Number.isFinite(elsA.a) && elsA.a > 0 ? elsA.a : rPod;
    const periA = aA * (1 - Math.max(0, Math.min(0.95, elsA.e)));
    const coreA = world.primaries.find((b) => (b.kind === 'star' || b.kind === 'blackhole') && b.alive);
    const safeA = Math.max(tidalTearRadius(mu, pod.mass, pod.radius) * 1.35,
      (coreA ? coreA.radius : 0.12) + 0.14);
    // 实测对比：加死区（只在大幅低于安全线时介入）反而更差——L1-2 会重新丢掉；
    // 不加死区时 L1-2 能以最小相对速度 0.003 完美软对接。故保留"低于安全线即介入"。
    if (periA < safeA) {
      const deficit = safeA - periA;
      // 顺行推力（沿速度方向）抬高近星点；越危急越强
      const kA = Math.min(A_MAX_CMD, deficit * 6) * (phase === 'terminal' ? 1.0 : 0.5);
      adx += vhx * kA;
      ady += vhy * kA;
      if (tel) tel.abort = true;
    }
  }

  let amag = Math.hypot(adx, ady);
  if (amag < 1e-6) { adx = vhx; ady = vhy; amag = 1e-3; }
  const scale = Math.min(1, A_MAX_CMD / amag);
  adx *= scale; ady *= scale; amag = Math.min(amag, A_MAX_CMD);

  // 死区：所需修正量已经很小的时候，方向本身是噪声，此时若还按 |a| 反解力臂，
  // 井会被放到 1 RU 外的一个随机方向上（实测 dirErr 冲到 159°，把飞船带进恒星）。
  // 正确做法：把场强压到最低并保持井位，让货舱自由滑行。
  if (amag < A_DEAD && sep < 0.15) {
    w.mass = WELL_MASS_MIN;
    w.targetMass = WELL_MASS_MIN;
    w.engaged = true;
    w.repel = false;
    w.precise = true;
    st.cmdX = w.x; st.cmdY = w.y; st.hasCmd = true;
    if (tel) {
      tel.active = true; tel.targetIndex = best; tel.distance = sep;
      tel.closing = 0; tel.aDes = amag; tel.rPod = rPod; tel.rStation = rSt;
      tel.phase = phase; tel.fuel = world.fuel; tel.dWellPod = Math.hypot(w.x - pod.x, w.y - pod.y);
      tel.dirErr = 0; tel.deadband = true;
    }
    return;
  }
  if (tel) tel.deadband = false;

  // 需要的加速度越小 → 井放得越远（长力臂、柔和）；越大 → 井贴近货舱（短力臂、强硬）。
  // 再按 a = G·M/r²·cut(r) 反解出恰好产生该加速度的场强，并受额定场强上限约束。
  const rWant = R_MIN + (R_MAX - R_MIN) * (1 - Math.min(1, amag / 0.9));
  const r = Math.max(R_MIN, Math.min(R_MAX, rWant));
  // **按井的"实际"距离反解场强**：井是有惯性的飞船，会滞后于指令位置。
  // 实测 dwp（井-货舱距离）在 2.42 ↔ 0.27 之间乱摆；若按期望距离算场强，井比预期更近时
  // 实际拉力会远超指令值 → 货舱被拽成 0.58↔1.47 的极度偏心轨道，最后扎进恒星（实测"坠入恒星" r=0.15）。
  const rActual = Math.hypot(w.x - pod.x, w.y - pod.y);
  // 取 min(期望, 实际)：井比预期更近时按更近的距离算 → 场强更小 → 不会超拉；
  // 井比预期更远时也按实际的更近距离算（保守），宁可欠拉也不超拉。
  const rEff = Math.max(R_MIN, Math.min(r, rActual));
  const cut = 1 / (1 + Math.pow(rEff / WELL_RANGE, 6));
  const mass = Math.max(WELL_MASS_MIN, Math.min(WELL_MASS_MAX, (amag * rEff * rEff) / Math.max(cut, 1e-3)));

  const ux = adx / (amag || 1), uy = ady / (amag || 1);
  let wantX = pod.x + ux * r;
  let wantY = pod.y + uy * r;

  // ---- 井的方向死区（省燃料的关键）----
  // 物理上有用的是**力的方向**，井的具体位置只是手段。只要期望方向与"当前井位相对货舱的方向"
  // 夹角在阈值内，就保持井位不动——避免飞船为几十度的方向变化持续奔波。
  // 实测证据：L2-2 在 t=42.7 就 fuel=0、井被甩到 17~19 RU 外（dwp=19），此后所有指令全部落空；
  // L4-1/L4-2 同样把预算（100/106）烧光。燃料都花在"追指令点"上，而不是用在拉货舱上。
  if (st.hasCmd) {
    const cdx = st.cmdX - pod.x;
    const cdy = st.cmdY - pod.y;
    const cd = Math.hypot(cdx, cdy);
    if (cd > 1e-6 && cd < R_MAX * 1.6) {
      const cosT = (cdx * ux + cdy * uy) / cd;
      if (cosT > Math.cos(DIR_DEADBAND)) { wantX = st.cmdX; wantY = st.cmdY; }
    }
  }

  // 恒星规避：飞船一旦被恒星引力俘获就再也出不来（r=0.14 处引力 51 RU/TU²，推力上限只有 3），
  // 因此强制把指令点沿径向推到安全带之外。
  const wr = Math.hypot(w.x, w.y);
  if (wr < KEEP_OUT) {
    const k = (KEEP_OUT + 0.25) / Math.max(wr, 1e-3);
    wantX = w.x * k;
    wantY = w.y * k;
  }

  // 指令点限速（避免井被高频拽动，从而省燃料、也更像人操作）
  if (st.hasCmd) {
    const mdx = wantX - st.cmdX, mdy = wantY - st.cmdY;
    const md = Math.hypot(mdx, mdy);
    // **燃料自适应速率**：SLEW 扫描实测——固定 1.1 时 5/12（但教学关慢：L1-2 要 113 TU），
    // 固定 0.6 时教学关飞快（L1-2 只要 12.9 TU）却把 L2-3/L3-1 弄丢（2~3/12）。
    // 根因是燃料经济性：油多时可长途机动，油少时必须让井贴着货舱工作（实测 L2-2 油尽后井被甩到 19 RU 外）。
    const slewEff = SLEW_FAST; // 见下方注释：自适应版本实测更差（4/12），故固定用 1.1
    const maxStep = slewEff * st.dt;
    if (md > maxStep && md > 1e-9) {
      wantX = st.cmdX + (mdx / md) * maxStep;
      wantY = st.cmdY + (mdy / md) * maxStep;
    }
  }
  st.cmdX = wantX; st.cmdY = wantY; st.hasCmd = true;

  w.tx = wantX;
  w.ty = wantY;
  w.mass = mass;
  w.targetMass = mass;
  w.engaged = true;
  w.repel = false;
  w.precise = false;
  st.mode = 'track';
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
    tel.dirErr = (Math.acos(Math.max(-1, Math.min(1, cosang))) * 180) / Math.PI;
  }
}
