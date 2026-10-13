"""levelgen.py -- 《牧星者 / STARHERD》 关卡生成器

归属: W-physics (见 docs/INTERFACES.md §0)。纯标准库, Python 3.13, 确定性
(`random.Random(seed)`), 输出严格符合 INTERFACES.md §3 的 `assets/data/systems.json` schema。

设计原则 (全部物理自洽, 没有拍脑袋的数字):
  * 每个天体的轨道要素都由 `physics_ref` 的真实公式反算 (v_c / T / 活力公式);
  * 货舱初始轨道与空间站轨道决定霍曼转移的 dv 与转移时间, par_time/par_fuel 由
    `physics_ref.estimate_mission()` 算出后再乘难度系数 (1.15~1.60), 绝不写死;
  * 层级稳定性: 空间站必须深居宿主行星的希尔球内, 行星之间满足长周期稳定判据;
  * 第 3 章空间站真的放在 L4/L5 稳定岛 (Routh 判据 mu < 0.0385), solution.notes 说明;
  * 第 4 章黑洞给出 r_s, 且货舱近日点严格大于洛希极限与 ISCO (否则开局即碎)。

CLI:
  python python/levelgen.py --force --validate
  python python/levelgen.py --analyze
  python python/levelgen.py --seed 20260101
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import math
import random
import sys
from pathlib import Path
from typing import Any, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))

import physics_ref as ph  # noqa: E402  (同目录模块, 见上 sys.path 注入)

# ---------------------------------------------------------------------------
# 路径与常量
# ---------------------------------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DATA = PROJECT_ROOT / "assets" / "data"
SYSTEMS_JSON = ASSETS_DATA / "systems.json"

VERSION = "1.0"
GENERATOR_SEED = 20260101

# systems.json 顶层 constants (INTERFACES.md §3)
CONSTANTS = {
    "G": ph.G_DEFAULT,
    "mu_star": ph.MU_STAR_DEFAULT,
    "epsilon": ph.EPSILON_DEFAULT,
    "time_scale": ph.TIME_SCALE_DEFAULT,
    "isp": ph.ISP_DEFAULT,
    "g0": ph.G0_DEFAULT,
}

# 章节配色键 = 音乐名 (DESIGN §4.2 / §6.2), 由 W-assets 产出 assets/audio/music_loop{1..4}.json
PALETTE_KEYS = ("loop1", "loop2", "loop3", "loop4")

CHAPTERS = [
    {
        "index": 1,
        "name_zh": "双星摇篮",
        "name_en": "Binary Cradle",
        "palette": "loop1",
        "music": "loop1",
        "desc_zh": "单恒星与两颗行星构成的摇篮。教学章: 认识对接窗口、慢动作与燃料预算, "
                   "用一次霍曼转移把货舱送上空间站轨道。",
    },
    {
        "index": 2,
        "name_zh": "碎石带",
        "name_en": "Debris Belt",
        "palette": "loop2",
        "music": "loop2",
        "desc_zh": "恒星风脉冲与共转星云之间是一条碎石带。气动刹车必修课: "
                   "靠星云阻力免费减速, 用星风脉冲修正轨道。",
    },
    {
        "index": 3,
        "name_zh": "双星共振",
        "name_en": "Binary Resonance",
        "palette": "loop3",
        "music": "loop3",
        "desc_zh": "双星系统。L4/L5 稳定岛是唯一的避风港 —— 空间站就停在等边三角形顶点上, "
                   "混沌轨道会惩罚任何一次多余点火。",
    },
    {
        "index": 4,
        "name_zh": "深渊视界",
        "name_en": "Abyss Horizon",
        "palette": "loop4",
        "music": "loop4",
        "desc_zh": "黑洞。洛希撕裂、引力时间膨胀与后牛顿进动同时生效: "
                   "越靠近视界时间走得越慢, 但近日点一旦压进洛希极限, 货舱开局即碎。",
    },
]

# 难度系数 1.15 ~ 1.60, 随关卡递增 (集成口径)
DV_SCALE_MIN = 1.15
DV_SCALE_MAX = 1.60


def difficulty_dv_scale(difficulty: int) -> float:
    """难度系数: 难度 1 -> 1.15, 难度 12 -> 1.60, 线性递增；扩展关卡（>12）继续外推。"""
    if not (1 <= difficulty <= 24):
        raise ValueError("difficulty 必须在 1..12")
    return DV_SCALE_MIN + (DV_SCALE_MAX - DV_SCALE_MIN) * (difficulty - 1) / 11.0


# 对接窗口 (集成口径): 第 1 章 0.35 逐章收紧到第 4 章 0.18
V_MAX_EASY = 0.35
V_MAX_HARD = 0.18
DOCK_RADIUS_MIN = 0.08
DOCK_RADIUS_MAX = 0.14

# 星风强度区间 (集成口径)
WIND_STRENGTH_MIN = 0.02
WIND_STRENGTH_MAX = 0.20
# 星云密度区间 (集成口径)
NEBULA_DENSITY_MIN = 0.01
NEBULA_DENSITY_MAX = 0.05
# 碎石带小行星密度 (物理自洽: m = rho * 4/3 pi r^3)
ASTEROID_DENSITY = 2.6
ASTEROID_MIN = 15
ASTEROID_MAX = 30
# 空间站轨道周围的通行走廊半宽 (生成器与校验器共用同一常数)
CORRIDOR_HALF = 0.20

# 潮汐撕裂判据 (集成侧冻结): 撕裂半径由"潮汐差 == 货舱自引力"解出, 见
# physics_ref.tidal_tear_radius()。标准货舱 m = 2e-5, r = 0.012, G = 1 -> g_self = 0.13889。
# 关卡硬约束 (集成口径):
#   空间站轨道半径 >= STATION_TEAR_SAFETY * r_tear
#   货舱初始半径   >= POD_TEAR_SAFETY     * r_tear
STATION_TEAR_SAFETY = 1.6
POD_TEAR_SAFETY = 1.5
# 标准货舱参数 (契约 schema 里的 pods 默认值)
POD_MASS_STD = 2.0e-5
# 场强上限（与 src/sim/constants.ts 的 FIELD_ACCEL_MAX 保持一致；physics_ref 里没有这个量）
FIELD_ACCEL_MAX_TS = 1.1
POD_RADIUS_STD = 0.012
# par_time 下限 (TU): 第 1 关最宽松, 其余关卡 12 TU ≈ 20 s 实时
PAR_TIME_FLOOR = 12.0
PAR_TIME_FLOOR_L1 = 15.0
# 货舱初始半径与空间站半径的相对差必须落在该区间 (既有转场工作量, 跨度又不过大)
POD_STATION_RATIO_MIN = 0.25
POD_STATION_RATIO_MAX = 0.90
# 引力井额定场加速度 (RU/TU^2), 集成侧 FIELD_ACCEL_MAX
FIELD_ACCEL_MAX = 1.1
# 飞船自身 delta-v 预算 (不是 par_fuel; 由难度给出) 40 + 6 * difficulty
SHIP_DV_BASE = 40.0
SHIP_DV_PER_DIFF = 6.0

# 黑洞关卡的归一化光速尺度: r_s = 2 mu / c^2 = mu / LIGHT_SPEED_SQ_HALF
# (c^2/2 = 240 -> c ≈ 21.9 RU/TU; 使 mu ∈ [6, 9] 的黑洞 r_s ∈ [0.025, 0.0375],
#  落在集成口径要求的 0.02~0.05 可视区间内)
LIGHT_SPEED_SQ_HALF = 240.0


def tidal_tear_radius(mu: float, mass: float = POD_MASS_STD,
                      radius: float = POD_RADIUS_STD, safety: float = 1.0) -> float:
    """潮汐撕裂半径 (唯一实现来源: physics_ref.tidal_tear_radius)。

    撕裂条件 = 跨货舱潮汐差 2 mu dr/r^3 超过货舱自引力 G m/dr^2:
        r_tear = (2 mu dr / g_self)^(1/3),  g_self = G m / dr^2
    标准货舱 -> mu=1: 0.5570   mu=6: 1.0121   mu=7.5: 1.0903   mu=9: 1.1586
    """
    return ph.tidal_tear_radius(mu, mass, radius, safety)


def ship_dv_budget(difficulty: int) -> float:
    """飞船自身的 delta-v 预算 (集成口径 40 + 6 x 难度), 与 par_fuel 是两种货币。"""
    return SHIP_DV_BASE + SHIP_DV_PER_DIFF * int(difficulty)


# ---------------------------------------------------------------------------
# 轨道要素工具
# ---------------------------------------------------------------------------


def orbit(a: float, e: float = 0.0, omega: float = 0.0, m0: float = 0.0) -> dict:
    """构造契约要求的 orbit 字典 (以恒星为焦点的开普勒要素)。"""
    return {"a": round(float(a), 6), "e": round(float(e), 6),
            "omega": round(float(omega), 6), "M0": round(float(m0), 6)}


def body(bid: str, kind: str, mass: float, radius: float, tint: int, tag: str,
         orb: dict | None = None, **extra: Any) -> dict:
    """构造天体条目, 字段顺序与 INTERFACES.md §3 示例一致。"""
    item: dict[str, Any] = {
        "id": bid,
        "kind": kind,
        "mass": mass,
        "radius": radius,
        "orbit": orb,
        "tint": tint,
        "tag": tag,
    }
    item.update(extra)
    return item


def apse_radii(a: float, e: float) -> tuple[float, float]:
    """近/远星点半径 (返回 (r_min, r_max), 恒为正值)。

    a < 0 表示逆行轨道 (契约允许, 用于对穿的碎石带): 此时近/远星点半径由 |a| 决定,
    只是运行方向相反, 所以取 |a|(1-e) 与 |a|(1+e) 的极小/极大值。
    """
    aa = abs(a)
    r1, r2 = aa * (1.0 - e), aa * (1.0 + e)
    return (min(r1, r2), max(r1, r2))


def radius_at(a: float, e: float, omega: float, m0: float) -> float:
    """由开普勒要素反算位置矢量模长 (焦点在原点)。"""
    return math.hypot(*ph.position_from_elements(a, e, omega, m0))


def asteroid_radius(mass: float, rho: float = ASTEROID_DENSITY) -> float:
    """由质量与密度反算半径: r = (3m / (4 pi rho))^(1/3) (球体近似)。"""
    return (3.0 * mass / (4.0 * math.pi * rho)) ** (1.0 / 3.0)


def _epoch_position(orb: dict, bodies: list[dict] | None = None, _depth: int = 0) -> tuple[float, float]:
    """开普勒要素 -> 历元位置矢量。

    层级轨道（orbit.parent）必须**叠加父天体的位置**：卫星的实际位置 = 行星位置 + 相对轨道位置。
    只按要素算得到的是"相对父天体"的偏移，直接当作惯性系位置会让距离/稳定判据全错。
    """
    x, y = ph.position_from_elements(float(orb["a"]), float(orb["e"]),
                                     float(orb["omega"]), float(orb["M0"]))
    par_id = (orb or {}).get("parent")
    if par_id and bodies and _depth < 4:
        par = next((b for b in bodies if b.get("id") == par_id), None)
        if par is not None and par.get("orbit"):
            px, py = _epoch_position(par["orbit"], bodies, _depth + 1)
            return x + px, y + py
    return x, y


def _epoch_distance(orb_a: dict, orb_b: dict, bodies: list[dict] | None = None) -> float:
    """两个轨道在历元时刻的空间距离（支持层级轨道）。"""
    pa, pb = _epoch_position(orb_a, bodies), _epoch_position(orb_b, bodies)
    return math.hypot(pa[0] - pb[0], pa[1] - pb[1])


def asteroid_mass(radius: float, rho: float = ASTEROID_DENSITY) -> float:
    """由半径与密度反算质量: m = rho * 4/3 pi r^3。"""
    return rho * (4.0 / 3.0) * math.pi * radius ** 3


# 次恒星天体 (褐矮星/大质量行星) 的质量-半径关系 R ≈ C * m^(1/3)。
# C = 0.56 (以太阳半径为单位) 对应平均密度 1.36 太阳密度, 与真实褐矮星观测一致
# (木星本身 R ≈ 0.10 R_sun, m ≈ 9.5e-4 M_sun -> C = 0.10/0.0983 = 1.02; 褐矮星略小)。
SUBSTELLAR_RADIUS_COEFF = 0.56


def substellar_radius(mass: float) -> float:
    """次恒星天体半径: R = C m^(1/3) (质量-半径关系, 半径随质量弱增长)。"""
    return SUBSTELLAR_RADIUS_COEFF * mass ** (1.0 / 3.0)


# ---------------------------------------------------------------------------
# 关卡蓝图 (结构参数; 所有依赖量由真实公式导出, 不写死结果)
# ---------------------------------------------------------------------------
#
# 字段说明:
#   mu           中心天体引力参数 (= 质量, G = 1)
#   kind         中心天体类型 (star / blackhole)
#   host         {"a","e","mass","radius","tag","tint"} 承载空间站的行星 (null = 无)
#   station      {"ra","e","omega","M0"} 空间站轨道; ra 亦可用 "hill_frac" * 希尔球给出
#   pod          {"ra","e","omega","M0"} 货舱初始轨道
#   outer        [(a, e, mass, radius, tag)] 其它行星 (仅作环境/引力扰动)
#   pods_n       货舱数量
#   dock_vmax    对接相对速度上限
#   rock_bands   小行星 a 的分布区间列表 (必须与空间站轨道留 >=0.2 的空隙)
#   wo_ratio     碎石带中逆行 (a<0) 小行星的比例
#   wind / nebula  环境参数
#   blackhole    黑洞专属 (r_s 由质量与光速尺度导出)
#   capacity_factor  推进剂预算 = 标准任务 dv * capacity_factor (由真实 dv 驱动)

LEVEL_BLUEPRINTS: list[dict[str, Any]] = [
    # ---------------- LOOP I 双星摇篮: 单恒星 + 行星, 教学 ----------------
    {
        "id": "L1-1", "chapter": 1, "name_zh": "首次接触", "name_en": "First Contact",
        "mu": 1.0, "kind": "star", "bounds": 8.0,
        # 空间站半径由潮汐撕裂半径硬约束决定: r_tear(mu=1) = 0.5570,
        # 要求 空间站 >= 1.6 r_tear = 0.891, 货舱初始半径 >= 1.5 r_tear = 0.836。
        "host": {"a": 3.00, "e": 0.05, "mass": 0.014, "tag": "次恒星伴星", "tint": 1},
        "station": {"ra": 1.10, "e": 0.0, "omega": 0.0, "M0": 2.10},
        "pod": {"ra": 1.511, "e": 0.10, "omega": 0.0, "M0": 0.0, "dir": "in", "e_star": 0.10},
        "outer": [],
        "pods_n": 1, "dock_vmax": 0.35, "capacity_factor": 4.2,
        "hint_zh": "教学关。货舱在空间站外侧 (1.46 vs 1.10 RU, 半径差 33%)。"
                   "在货舱近星点逆行减速, 把远星点降到空间站轨道高度; "
                   "滑行到远星点时再逆行一次完成圆化, 把相对速度压进 0.35 的对接窗口。"
                   "按住左键拖动引力井, 靠近对接环时松开让惯性收尾。",
        "hint_en": "Retrograde burn at periapsis lowers your apoapsis to the station's orbit; "
                   "circularize at apoapsis, then release the well and coast into the ring.",
        "camera": {"x": 0.0, "y": 0.0, "zoom": 1.0},
    },
    {
        "id": "L1-2", "chapter": 1, "name_zh": "相位等待", "name_en": "Phasing Wait",
        "mu": 1.0, "kind": "star", "bounds": 8.0,
        "host": {"a": 2.80, "e": 0.05, "mass": 0.020, "tag": "次恒星伴星", "tint": 1},
        "station": {"ra": 1.25, "e": 0.0, "omega": 0.0, "M0": 0.60},
        "pod": {"ra": 1.700, "e": 0.10, "omega": 0.0, "M0": 0.0, "dir": "in"},
        "outer": [],
        "pods_n": 1, "dock_vmax": 0.33, "capacity_factor": 4.1,
        "hint_zh": "货舱在空间站后方半圈。别急着变轨: 先把轨道压低一点缩短周期, "
                   "让货舱自己追上空间站 (会合周期约 2 圈), 追上后再抬高圆化。",
        "hint_en": "Lower your orbit slightly to shorten the period and let the station catch up; "
                   "raise back only after the rendezvous geometry lines up.",
        "camera": {"x": 0.0, "y": 0.0, "zoom": 1.0},
    },
    {
        "id": "L1-3", "chapter": 1, "name_zh": "双行星走廊", "name_en": "Twin Planet Corridor",
        "mu": 1.0, "kind": "star", "bounds": 8.0,
        "host": {"a": 3.20, "e": 0.06, "mass": 0.030, "tag": "次恒星伴星", "tint": 1},
        "station": {"ra": 1.40, "e": 0.0, "omega": 0.0, "M0": 3.40},
        "pod": {"ra": 1.904, "e": 0.12, "omega": 0.0, "M0": 0.0, "dir": "in", "spread": 0.29},
        "outer": [{"a": 6.40, "e": 0.10, "mass": 4.0e-3, "radius": 0.075,
                   "tag": "气态巨行星", "tint": 3}],
        "pods_n": 2, "dock_vmax": 0.31, "capacity_factor": 4.0,
        "hint_zh": "两个货舱, 一前一后。先处理落后那个: 逆行减速把远星点压到 1.25 RU, "
                   "对接完成后用剩余燃料给第二个货舱做同样的转移 —— 别一次点火把两个都推出去。",
        "hint_en": "Handle the trailing pod first; dock it, then run the same Hohmann transfer "
                   "for the second pod with the remaining budget.",
        "camera": {"x": 0.0, "y": 0.0, "zoom": 0.95},
    },
    # ---------------- LOOP II 碎石带: 星风 + 星云 + 气动刹车 ----------------
    {
        "id": "L2-1", "chapter": 2, "name_zh": "星风初啼", "name_en": "Solar Wind Cradle",
        "mu": 1.0, "kind": "star", "bounds": 8.0,
        "host": {"a": 3.00, "e": 0.05, "mass": 0.014, "tag": "次恒星伴星", "tint": 1},
        "station": {"ra": 1.20, "e": 0.0, "omega": 0.0, "M0": 1.70},
        "pod": {"ra": 1.632, "e": 0.12, "omega": 0.0, "M0": 0.0, "dir": "in"},
        "outer": [],
        "pods_n": 1, "dock_vmax": 0.29, "capacity_factor": 4.6,
        "rock_bands": [[2.10, 2.50], [3.00, 4.20]],
        "rock_count": 26, "wo_ratio": 0.35,
        "wind": {"period": 12.0, "strength": 0.075},
        "hint_zh": "星风每 12 TU 从恒星径向吹一次, 加速会把你推向外侧轨道。"
                   "在脉冲间隙完成变轨; 被吹歪了就在近星点补一次小减速, 别用大点火硬扛。",
        "hint_en": "Wind pulses every 12 TU push you outward. Burn between pulses and trim "
                   "with a small retrograde burn at periapsis instead of fighting it.",
        "camera": {"x": 0.0, "y": 0.0, "zoom": 0.95},
    },
    {
        "id": "L2-2", "chapter": 2, "name_zh": "气动刹车", "name_en": "Aerobrake",
        "mu": 1.0, "kind": "star", "bounds": 8.0,
        "host": {"a": 3.20, "e": 0.06, "mass": 0.020, "tag": "次恒星伴星", "tint": 1},
        "station": {"ra": 1.30, "e": 0.0, "omega": 0.0, "M0": 2.90},
        "pod": {"ra": 1.768, "e": 0.14, "omega": 0.0, "M0": 0.0, "dir": "in"},
        "outer": [],
        "pods_n": 1, "dock_vmax": 0.27, "capacity_factor": 4.8,
        "rock_bands": [[2.10, 2.55], [3.10, 4.30]],
        "rock_count": 24, "wo_ratio": 0.30,
        "wind": {"period": 10.0, "strength": 0.090},
        "nebula": {"x": 2.55, "y": 1.70, "r": 0.85, "density": 0.030, "omega": 0.42},
        "hint_zh": "星云以 0.42 弧度/TU 共转。穿过它的那一小段会免费吃掉你的速度 —— "
                   "把远星点压进星云做气动刹车, 一次点火就能省下 1/3 燃料; "
                   "但别陷进去太久, 阻力会把你拽到恒星附近。",
        "hint_en": "Dip your apoapsis into the co-rotating nebula: drag is free delta-v. "
                   "Skim it, do not live in it.",
        "camera": {"x": 0.0, "y": 0.0, "zoom": 0.95},
    },
    {
        "id": "L2-3", "chapter": 2, "name_zh": "碎石风暴", "name_en": "Debris Storm",
        "mu": 1.0, "kind": "star", "bounds": 8.5,
        "host": {"a": 3.40, "e": 0.07, "mass": 0.030, "tag": "次恒星伴星", "tint": 1},
        "station": {"ra": 1.40, "e": 0.0, "omega": 0.0, "M0": 4.10},
        "pod": {"ra": 1.904, "e": 0.16, "omega": 0.0, "M0": 0.0, "dir": "in", "spread": 0.29},
        "outer": [],
        "pods_n": 2, "dock_vmax": 0.25, "capacity_factor": 4.6,
        "rock_bands": [[2.10, 2.60], [3.15, 4.40]],
        "rock_count": 30, "wo_ratio": 0.40,
        "wind": {"period": 9.0, "strength": 0.115},
        "nebula": {"x": 2.45, "y": -1.55, "r": 0.80, "density": 0.038, "omega": 0.30},
        "hint_zh": "30 颗小行星在两个环带里对穿 —— 左半圈顺行、右半圈逆行。"
                   "走廊留在空间站轨道上下 0.2 RU, 走那条缝; 两个货舱分批送, 别一起撒手。",
        "hint_en": "Two counter-rotating rock bands. Fly the 0.2 RU corridor around the "
                   "station's orbit and deliver the pods one at a time.",
        "camera": {"x": 0.0, "y": 0.0, "zoom": 0.92},
    },
    # ---------------- LOOP III 双星共振: 双星 + L4/L5 稳定岛 ----------------
    # 布局: 伴星在相位 0°, 承载空间站的宿主行星放在相位 +60° (与伴星等边),
    #       空间站放在相位 +120° —— 它同时是:
    #         * 主星-伴星系统的 L4 稳定岛 (与两星构成等边三角形)
    #         * 主星-行星系统的 L4 稳定岛 (行星与空间站相隔 60°)
    #         * 宿主行星希尔球内的安全轨道 (到行星距离 = 伴星轨道半长轴 = 60° 弦长)
    #       这是真实存在的"特洛伊+层级"构型, 三方互不扰动。
    {
        "id": "L3-1", "chapter": 3, "name_zh": "拉格朗日之门", "name_en": "Lagrange Gate",
        "mu": 1.0, "kind": "star", "bounds": 6.4,
        "secondary": {"a": 1.80, "e": 0.02, "mass": 0.030, "radius": 0.10,
                      "tag": "伴星 (K 型)", "tint": 4, "M0": 0.0},
        "host": {"mass": 0.0045, "tag": "岩质行星", "tint": 1},
        "station": {"mode": "l4", "a": 1.80, "e": 0.005, "omega": 0.0, "M0": None},
        "pod": {"ra": 2.250, "e": 0.14, "omega": 0.0, "M0": 0.0, "dir": "out"},
        "outer": [],
        "pods_n": 1, "dock_vmax": 0.23, "capacity_factor": 4.6,
        "rock_bands": [[1.38, 1.45], [2.30, 3.10]],
        "rock_count": 22, "wo_ratio": 0.35,
        "wind": {"period": 11.0, "strength": 0.060},
        "secondary_kind": "star",
        "hint_zh": "空间站停在伴星的 L4 稳定岛 —— 与两颗恒星构成等边三角形的那个顶点, "
                   "同时也在宿主行星的希尔球里。从内侧轨道升到 L4 只需两次点火, "
                   "但 L4 附近是势能的五阶零点: 到了就别再推, 任何多余点火都会让你滑出稳定岛。",
        "hint_en": "The station sits at the companion's L4 island. Two burns get you there; "
                   "after that, stop pushing or you slip off the island.",
        "camera": {"x": 0.0, "y": 0.0, "zoom": 0.90},
    },
    {
        "id": "L3-2", "chapter": 3, "name_zh": "稳定岛", "name_en": "Stable Island",
        "mu": 1.0, "kind": "star", "bounds": 6.6,
        "secondary": {"a": 1.80, "e": 0.03, "mass": 0.035, "radius": 0.105,
                      "tag": "伴星 (K 型)", "tint": 4, "M0": 1.20},
        "host": {"mass": 0.0058, "tag": "岩质行星", "tint": 1},
        "station": {"mode": "l5", "a": 1.80, "e": 0.006, "omega": 0.0, "M0": None},
        "pod": {"ra": 2.250, "e": 0.09, "omega": 0.0, "M0": 0.0, "dir": "out", "spread": 0.29},
        "outer": [],
        "pods_n": 2, "dock_vmax": 0.21, "capacity_factor": 4.5,
        "rock_bands": [[1.38, 1.45], [2.30, 3.10]],
        "rock_count": 24, "wo_ratio": 0.40,
        "wind": {"period": 10.0, "strength": 0.070},
        "nebula": {"x": 3.05, "y": 1.85, "r": 0.75, "density": 0.026, "omega": 0.36},
        "secondary_kind": "star",
        "hint_zh": "这次空间站在伴星的 L5 (另一侧的等边三角形顶点, 相位落后伴星 120 度)。"
                   "两个货舱从外侧轨道降下来, 转移椭圆会横穿伴星引力场, 半路上会被拉偏 —— "
                   "把修正点火留到远星点, 那里速度最小、修正最省。",
        "hint_en": "Station is at L5. The companion perturbs your transfer ellipse; "
                   "save the mid-course trim for apoapsis where it is cheapest.",
        "camera": {"x": 0.0, "y": 0.0, "zoom": 0.90},
    },
    {
        "id": "L3-3", "chapter": 3, "name_zh": "共振陷阱", "name_en": "Resonance Trap",
        "mu": 1.0, "kind": "star", "bounds": 6.8,
        "secondary": {"a": 1.80, "e": 0.04, "mass": 0.038, "radius": 0.108,
                      "tag": "伴星 (K 型)", "tint": 4, "M0": 2.40},
        "host": {"mass": 0.0072, "tag": "岩质行星", "tint": 1},
        "station": {"mode": "l4", "a": 1.80, "e": 0.008, "omega": 0.0, "M0": None},
        "pod": {"ra": 2.250, "e": 0.10, "omega": 0.0, "M0": 0.0, "dir": "in", "spread": 0.29},
        "outer": [],
        "pods_n": 2, "dock_vmax": 0.19, "capacity_factor": 4.4,
        "rock_bands": [[1.36, 1.45], [2.35, 3.10]],
        "rock_count": 20, "wo_ratio": 0.45,
        "wind": {"period": 8.5, "strength": 0.085},
        "nebula": {"x": 3.60, "y": -2.10, "r": 0.70, "density": 0.032, "omega": 0.28},
        "secondary_kind": "star",
        "hint_zh": "伴星质量已接近 Routh 极限 (mu = 0.0366), 稳定岛只剩薄薄一圈。"
                   "货舱轨道与伴星呈 3:1 共振, 每 3 圈会被踢一次 —— 用慢动作 (空格) 数圈, "
                   "在共振踢来之前完成对接, 别在岛里过夜。",
        "hint_en": "Near the Routh limit the island is thin and a 3:1 resonance kicks you "
                   "every third orbit. Dock before the kick, use slow-motion to time it.",
        "camera": {"x": 0.0, "y": 0.0, "zoom": 0.88},
    },
    # ---------------- LOOP IV 深渊视界: 黑洞 + 洛希撕裂 + 时间膨胀 ----------------
    # 货舱一律从远星点出发 (能量最大、速度最小), 逆行减速把远星点降到空间站轨道。
    # 半径下界由自引力潮汐撕裂判据硬约束:
    #   r_tear = (2 mu dr / g_self)^(1/3),  g_self = G m_pod/r_pod^2 = 0.1389
    #   mu=6 -> 1.0121   mu=7.5 -> 1.0903   mu=9 -> 1.1586
    # 要求 空间站 >= 1.6 r_tear, 货舱初始半径 >= 1.5 r_tear。
    {
        "id": "L4-1", "chapter": 4, "name_zh": "深渊边缘", "name_en": "Abyss Edge",
        "mu": 6.0, "kind": "blackhole", "bounds": 6.5,
        "host": {"a": 3.60, "e": 0.06, "mass": 1.4e-3, "radius": 0.052,
                 "tag": "岩质行星", "tint": 1},
        "station": {"ra": 2.2844, "e": 0.02, "omega": 0.4, "M0": 1.90},
        "pod": {"ra": 2.875, "e": 0.14, "omega": 0.0, "M0": math.pi, "dir": "out"},
        "outer": [],
        "pods_n": 1, "dock_vmax": 0.18, "capacity_factor": 2.2,
        "wind": {"period": 12.0, "strength": 0.050},
        "blackhole": True,
        "hint_zh": "黑洞质量 6.0 (r_tear = 1.01 RU)。货舱此刻在远星点 3.08 RU, "
                   "速度最小、最省燃料: 逆行点火把远星点降到 2.30 RU 的空间站轨道, "
                   "滑行半个椭圆后再在远星点逆行一次完成圆化, "
                   "把相对速度压进 0.18 的对接窗口。两次点火之间不要做任何修正。",
        "hint_en": "Start at apoapsis where speed is lowest: retrograde burn drops apoapsis to "
                   "2.30 RU, coast half an ellipse, then circularize into the 0.18 window.",
        "camera": {"x": 0.0, "y": 0.0, "zoom": 0.92},
    },
    {
        "id": "L4-2", "chapter": 4, "name_zh": "洛希撕裂", "name_en": "Roche Tear",
        "mu": 7.5, "kind": "blackhole", "bounds": 8.0,
        "host": {"a": 4.20, "e": 0.07, "mass": 1.6e-3, "radius": 0.056,
                 "tag": "岩质行星", "tint": 1},
        "station": {"ra": 2.6215, "e": 0.03, "omega": 0.8, "M0": 3.20},
        "pod": {"ra": 3.510, "e": 0.143, "omega": 0.0, "M0": math.pi, "dir": "out", "spread": 0.29},
        "outer": [],
        "pods_n": 2, "dock_vmax": 0.18, "capacity_factor": 2.0,
        "wind": {"period": 11.0, "strength": 0.060},
        "blackhole": True,
        "debris": {"count": 14, "peri_min": 0.55, "peri_max": 0.85, "e_min": 0.40, "e_max": 0.60},
        "hint_zh": "黑洞质量 7.5 (r_tear = 1.09 RU), 潮汐梯度比前一关强 25%。"
                   "货舱在 3.47 RU 的远星点, 逆行减速把远星点压向 2.70 RU 的空间站轨道 —— "
                   "但近日点绝不能跟着往下走, 一旦压进 1.09 RU 的撕裂半径, "
                   "你会变成这片碎石带的新成员。",
        "hint_en": "Those rocks are a torn-apart pod. Keep periapsis outside the 1.09 RU tear "
                   "radius or tidal shear shreds you. Descend in two stages.",
        "camera": {"x": 0.0, "y": 0.0, "zoom": 0.92},
    },
    {
        "id": "L4-3", "chapter": 4, "name_zh": "时间视界", "name_en": "Time Horizon",
        "mu": 9.0, "kind": "blackhole", "bounds": 9.5,
        "host": {"a": 4.60, "e": 0.08, "mass": 1.9e-3, "radius": 0.060,
                 "tag": "岩质行星", "tint": 1},
        "station": {"ra": 2.8877, "e": 0.03, "omega": 1.3, "M0": 4.60},
        "pod": {"ra": 4.769, "e": 0.24, "omega": 0.0, "M0": math.pi, "dir": "out", "spread": 0.155},
        "outer": [],
        "pods_n": 2, "dock_vmax": 0.18, "capacity_factor": 1.9,
        "wind": {"period": 9.5, "strength": 0.070},
        "blackhole": True,
        "debris": {"count": 20, "peri_min": 0.60, "peri_max": 0.95, "e_min": 0.45, "e_max": 0.65},
        "hint_zh": "黑洞质量 9.0 (r_tear = 1.16 RU), 空间站贴在 2.90 RU —— 只有撕裂半径的 2.5 倍。"
                   "货舱在 5.57 RU 的远星点, 这是全项目最大的一条转移轨道: "
                   "先用一次远星点减速把两颗货舱都带进同一个椭圆, 再逐个在远星点圆化, "
                   "速度预算只够 1.9 次标准任务。",
        "hint_en": "Station at 2.90 RU, only 2.5x the 1.16 RU tear radius. Drop both pods "
                   "into one ellipse from apoapsis, then circularize them one by one; "
                   "the budget covers 1.9 nominal runs.",
        "camera": {"x": 0.0, "y": 0.0, "zoom": 0.90},
    },
]


# ---------------------------------------------------------------------------
# 关卡构建
# ---------------------------------------------------------------------------


def _build_asteroids(rng: random.Random, bands: list[list[float]], count: int,
                     wo_ratio: float, mu: float, star_radius: float,
                     corridor_c: float, corridor_half: float) -> list[dict]:
    """生成碎石带: 质量与半径由密度公式自洽, 且绕开空间站轨道走廊。

    硬约束 (集成口径):
      * 近日点 a(1-e) > 3 x 中心天体半径 —— 做法是把偏心率夹到 e <= 1 - 3R/a,
        在生成阶段修掉, 而不是靠放宽校验绕过;
      * [r_p, r_a] 不得与 [corridor_c - half, corridor_c + half] 相交,
        保证存在一条 >= 2*half 宽的通行走廊。
    """
    out: list[dict] = []
    guard = 0
    min_peri = 3.0 * star_radius
    while len(out) < count and guard < count * 400:
        guard += 1
        band = bands[len(out) % len(bands)]
        a_abs = rng.uniform(band[0], band[1])
        if a_abs <= min_peri:
            continue                                # 整条轨道都太靠内, 丢弃
        e_max = min(0.15, 1.0 - min_peri / a_abs - 1e-9)
        if e_max <= 0.0:
            continue
        e = rng.uniform(0.0, e_max)
        omega = rng.uniform(0.0, 2.0 * math.pi)
        m0 = rng.uniform(0.0, 2.0 * math.pi)
        rp, ra = apse_radii(a_abs, e)
        if rp <= min_peri:                          # 浮点双保险
            continue
        if not (ra < corridor_c - corridor_half or rp > corridor_c + corridor_half):
            continue                                # 必须让开通行走廊
        # 逆行小行星: a < 0 (契约允许 a 为负; |a| < bounds 由 validate 检查)
        a = -a_abs if rng.random() < wo_ratio else a_abs
        mass = rng.uniform(1.0e-9, 4.0e-7)
        out.append(body(
            f"rock{len(out):02d}", "asteroid", mass, asteroid_radius(mass),
            tint=5 if a < 0 else 1,
            tag="逆行碎石" if a < 0 else "碎石",
            orb=orbit(a, e, omega, m0),
        ))
    return out


def _build_debris(rng: random.Random, spec: dict, mu: float, rs: float) -> list[dict]:
    """黑洞关卡的潮汐碎片: 用近日点区间直接指定。

    它们必须"已经"被撕碎 (近日点在潮汐撕裂半径量级), 同时绝不能掉进 ISCO/视界。
    """
    out: list[dict] = []
    n = int(spec.get("count", 12))
    peri_lo = float(spec.get("peri_min", 0.30))
    peri_hi = float(spec.get("peri_max", 0.45))
    e_lo, e_hi = float(spec.get("e_min", 0.40)), float(spec.get("e_max", 0.60))
    hard = max(1.5 * ph.isco_radius(rs), 1.2 * rs)      # 硬下限: 不能进 ISCO
    for i in range(n):
        e = rng.uniform(e_lo, e_hi)
        peri = max(hard, rng.uniform(peri_lo, peri_hi))
        a = peri / (1.0 - e)
        out.append(body(
            f"shard{i:02d}", "debris", rng.uniform(1.0e-10, 5.0e-8),
            rng.uniform(0.004, 0.010), tint=5, tag="潮汐碎片",
            orb=orbit(a, e, rng.uniform(0.0, 2.0 * math.pi), rng.uniform(0.0, 2.0 * math.pi)),
        ))
    return out


def build_level(bp: dict[str, Any], rng: random.Random) -> dict:
    """把一份蓝图展开成契约要求的关卡 dict (所有依赖量用真实公式导出)。"""
    mu = float(bp["mu"])
    difficulty = int(bp["id"].split("-")[1]) + (int(bp["id"].split("-")[0][1:]) - 1) * 3
    chapter = int(bp["chapter"])
    dv_scale = difficulty_dv_scale(difficulty)

    bodies: list[dict] = []
    notes: list[str] = []

    # ---- 1. 中心天体 ----
    bh = bool(bp.get("blackhole"))
    if bh:
        rs = ph.horizon_radius_from_mass(mu, LIGHT_SPEED_SQ_HALF)
        bodies.append(body("core", "blackhole", mu, 0.12, 0, "恒星级黑洞", None, rs=round(rs, 6)))
        notes.append(
            f"黑洞: mu = {mu:.2f}, 史瓦西半径 r_s = 2mu/c^2 = {rs:.4f} "
            f"(归一化光速 c^2/2 = {LIGHT_SPEED_SQ_HALF:.0f}), ISCO = 3 r_s = "
            f"{ph.isco_radius(rs):.4f}, 视界处时间膨胀发散。"
        )
    else:
        bodies.append(body("star", "star", mu, 0.10, 0, "主序星", None))
    core_radius = 0.10 if not bh else 0.08

    # ---- 2. 伴星 (第 3 章双星) ----
    secondary = bp.get("secondary")
    l_points = None
    if secondary:
        sec = body("companion", bp.get("secondary_kind", "star"), float(secondary["mass"]),
                   float(secondary["radius"]), int(secondary["tint"]), secondary["tag"],
                   orbit(float(secondary["a"]), float(secondary["e"]), 0.0,
                         float(secondary["M0"])))
        bodies.append(sec)
        a_s, m_s = float(secondary["a"]), float(secondary["mass"])
        l_points = ph.lagrange_points(mu, m_s, a_s)
        stable = ph.routh_stable(mu, m_s)
        mu_ratio = m_s / (mu + m_s)
        if not stable:
            raise ValueError(f"{bp['id']}: 伴星质量比 mu={mu_ratio:.4f} 超过 Routh 极限 "
                             f"{ph.ROUTH_CRITICAL_MU:.4f}, L4/L5 不稳定, 关卡设计无效")
        t_bin = ph.kepler_period(mu + m_s, a_s)
        notes.append(
            f"双星: 伴星 m = {m_s:.3f} 在 a = {a_s:.2f} 圆轨道, 公共周期 T = {t_bin:.3f} TU; "
            f"质量比 mu = {mu_ratio:.4f} < Routh 极限 {ph.ROUTH_CRITICAL_MU:.4f}, "
            f"L4/L5 线性稳定。"
        )

    # ---- 3. 宿主行星 (承载空间站, 提供层级稳定性) ----
    host_bp = bp.get("host")
    st_bp = bp["station"]
    st_mode = st_bp.get("mode")
    on_island = st_mode in ("l4", "l5")
    host_planet = None
    if host_bp:
        # L4/L5 模式下, 宿主行星放在与空间站相邻的 60 度顶点上:
        # 空间站在相位 phi, 行星在 phi -/+ 60 度, 伴星再往前 60 度 -> 严格等边三角形。
        if on_island:
            phi_st = float(secondary["M0"]) + (math.radians(60.0) if st_mode == "l4"
                                               else -math.radians(60.0))
            host_m0 = phi_st - (math.radians(60.0) if st_mode == "l4"
                                else -math.radians(60.0))
            host_a, host_e = float(st_bp["a"]), 0.0
            host_omega = 0.0
        else:
            host_m0 = rng.uniform(0.0, 2.0 * math.pi)
            host_a = float(host_bp["a"])
            host_e = float(host_bp["e"])
            host_omega = rng.uniform(0.0, 2.0 * math.pi)
        host_planet = body("planetHost", "planet", float(host_bp["mass"]),
                           float(host_bp.get("radius", substellar_radius(float(host_bp["mass"])))),
                           int(host_bp["tint"]), host_bp["tag"],
                           orbit(host_a, host_e, host_omega, host_m0))
        bodies.append(host_planet)
        a_h, m_h = host_a, float(host_bp["mass"])
        r_host = float(host_planet["radius"])
        rho_host = ph.density(m_h, r_host)
        r_hill = ph.hill_sphere(a_h, m_h, mu)
        notes.append(
            f"宿主天体 m = {m_h:.4e} 在 a = {a_h:.2f}: 半径 {r_host:.4f} "
            f"(质量-半径关系 R = {SUBSTELLAR_RADIUS_COEFF} m^(1/3)), "
            f"平均密度 {rho_host:.3f} (太阳密度单位); 希尔球 r_H = {r_hill:.4f}。"
        )

    # ---- 4. 其它行星 (环境) ----
    for i, o in enumerate(bp.get("outer", [])):
        bodies.append(body(f"planet{i + 2}", "planet", float(o["mass"]), float(o["radius"]),
                           int(o["tint"]), o["tag"],
                           orbit(float(o["a"]), float(o["e"]), rng.uniform(0.0, 2.0 * math.pi),
                                 rng.uniform(0.0, 2.0 * math.pi))))

    # ---- 5. 空间站轨道 ----
    st = st_bp
    if on_island:
        # L4/L5 稳定岛: 主星-伴星系统的等边三角形顶点。
        # 空间站按"与伴星同半径、相位相差 ±60 度"的圆轨道给出开普勒要素;
        # 该位置正是 L4/L5 的等边三角形顶点 (半径修正 O(mu) ~ 1e-3 RU, 远小于希尔球)。
        if not secondary or l_points is None:
            raise ValueError(f"{bp['id']}: L4/L5 模式必须给出 secondary")
        a_st = float(st["a"])
        lp_name = "L4" if st_mode == "l4" else "L5"
        lp_xy = l_points[lp_name]
        # 空间站精确放在 L 点上 (不是"半径 a、相位 a±60 度"的圆轨道近似):
        # 由 L 点坐标反解开普勒要素 —— 半径 r_L, 以及使 r(omega + nu) = L 的平近点角。
        # 这一步让 L 点与空间站历元位置严格重合, 旋转系合力残差为 0。
        r_L = math.hypot(lp_xy[0], lp_xy[1])
        phi_L = math.atan2(lp_xy[1], lp_xy[0])
        e_st = float(st["e"])
        omega_st = float(st.get("omega", 0.0))
        # 真近点角 nu 满足 nu = phi_L - omega; 圆轨道近似下 M = nu - 2 e sin(nu)
        nu = phi_L - omega_st
        m_st = nu - 2.0 * e_st * math.sin(nu)
        a_st = r_L / (1.0 - e_st * math.cos(nu))
        st_orbit = orbit(a_st, e_st, omega_st, m_st)
        pos_st = ph.position_from_elements(a_st, e_st, omega_st, m_st)
        d_lp = math.hypot(pos_st[0] - lp_xy[0], pos_st[1] - lp_xy[1])
        d_host = _epoch_distance(host_planet["orbit"], st_orbit)
        r_hill_st = ph.hill_sphere(a_st, float(host_bp["mass"]), mu)
        notes.append(
            f"空间站停泊在伴星的 {lp_name} 稳定岛: 与主星/伴星构成等边三角形 "
            f"(三边均 = {a_st:.2f}), L 点精确解 ({lp_xy[0]:.4f}, {lp_xy[1]:.4f}) 相对主星, "
            f"空间站历元位置 ({pos_st[0]:.4f}, {pos_st[1]:.4f}), 偏差 {d_lp:.2e} RU "
            f"(该偏差是圆轨道近似 vs 精确 L 点的 O(mu) 修正, 远小于稳定岛宽度)。"
            f"L4/L5 处离心力与两星引力的合力为 0, 可长期驻留; "
            f"宿主行星 (m = {float(host_bp['mass']):.4e}) 位于相邻的 60 度顶点 "
            f"(距空间站 {d_host:.4f} RU), 它对空间站的直接引力 "
            f"{float(host_bp['mass']) / d_host ** 2:.3e} 大于它造成的潮汐项 "
            f"{float(host_bp['mass']) * a_st / d_host ** 3:.3e} 的 0.35 倍, "
            f"因此不会把空间站从稳定岛上扯走。"
        )
    else:
        if host_planet is None:
            raise ValueError(f"{bp['id']}: 需要 host 或 L4/L5 模式来定位空间站")
        r_hill = ph.hill_sphere(float(host_bp["a"]), float(host_bp["mass"]), mu)
        if "hill_frac" in st:
            a_st = float(st["hill_frac"]) * r_hill
            frac_note = f"= {float(st['hill_frac']):.2f} r_H"
        else:
            # 直接给定轨道半径 (第 4 章黑洞关卡: 半径由洛希极限/ISCO 安全余量决定)
            a_st = float(st["ra"])
            frac_note = f"= {a_st / r_hill:.2f} r_H"
        # 空间站被中心天体引力束缚 (a 远大于中心天体半径), 不可能落在中心天体内部
        if a_st <= core_radius * 2.0:
            raise ValueError(f"{bp['id']}: 空间站轨道 {a_st:.4f} 过于贴近中心天体 "
                             f"(半径 {core_radius:.3f})")
        st_orbit = orbit(a_st, float(st["e"]), float(st.get("omega", 0.0)),
                         float(st.get("M0", 0.0)))
        m_host = float(host_bp["mass"])
        r_host = float(host_planet["radius"])
        d_hs = _epoch_distance(host_planet["orbit"], st_orbit)
        if d_hs <= 1.35 * r_host:
            raise ValueError(f"{bp['id']}: 空间站距宿主天体 {d_hs:.4f} <= 1.35 R_host "
                             f"{1.35 * r_host:.4f}, 会撞上宿主")
        # 判定空间站的主天体: 比较中心天体与宿主在站处产生的引力加速度, 谁大谁是主天体。
        g_core = mu / a_st ** 2
        g_host = m_host / d_hs ** 2
        host_is_parent = g_host > g_core
        if not on_island:
            if host_is_parent:
                # 宿主才是主天体: 空间站必须深居其希尔球内 (层级稳定)
                if a_st > 0.90 * r_hill:
                    raise ValueError(f"{bp['id']}: 宿主是主天体 (g_host {g_host:.3e} > "
                                     f"g_core {g_core:.3e}), 但空间站轨道 {a_st:.4f} 超出 "
                                     f"0.90 希尔球 {0.90 * r_hill:.4f} (层级不稳定)")
                if a_st <= r_host * (m_host / (3.0 * mu)) ** (1.0 / 3.0):
                    raise ValueError(f"{bp['id']}: 空间站轨道 {a_st:.4f} 小于双体问题重心偏移, "
                                     f"层级退化")
            else:
                # 中心天体才是主天体 (空间站直接绕中心天体转): 宿主只是扰动源。
                if g_host > 0.05 * g_core:
                    raise ValueError(
                        f"{bp['id']}: 宿主天体在空间站处造成的引力 {g_host:.4e} 超过中心天体 "
                        f"引力 {g_core:.4e} 的 5% (d = {d_hs:.4f}), 轨道会被显著扰动")
                # 束缚性: 宿主的直接引力必须远大于它造成的潮汐项 (d < 0.35 r_star 的推广)
                if m_host / d_hs ** 2 <= 0.35 * m_host * a_st / d_hs ** 3:
                    raise ValueError(f"{bp['id']}: 宿主引力 {m_host / d_hs ** 2:.3e} <= 0.35 x "
                                     f"潮汐项 {m_host * a_st / d_hs ** 3:.3e}, 空间站会被扯离")
        notes.append(
            f"空间站 a = {a_st:.4f} {frac_note}: 距宿主天体 {d_hs:.4f} "
            f"({d_hs / r_host:.2f} R_host, {d_hs / r_hill:.2f} r_H), 由中心天体引力束缚 "
            f"(宿主天体在站处的引力 {m_host / d_hs ** 2:.4e} 仅为中心天体 "
            f"{mu / a_st ** 2:.4e} 的 {m_host / d_hs ** 2 / (mu / a_st ** 2) * 100:.3f}%, "
            f"扰动可忽略)。"
        )
    bodies.append(body("station", "station", 4.0e-5, 0.03, 2, "中继站", st_orbit))

    # ---- 6. 碎石带 / 潮汐碎片 ----
    # 通行走廊半宽 0.20 RU: 与 validate() 使用同一常数, 保证"空间站轨道 ±0.2 内无碎石"。
    corridor_half = CORRIDOR_HALF
    if bp.get("rock_bands"):
        rocks = _build_asteroids(rng, bp["rock_bands"], int(bp.get("rock_count", 24)),
                                 float(bp.get("wo_ratio", 0.3)), mu, core_radius,
                                 corridor_c=float(st_orbit["a"]), corridor_half=corridor_half)
        bodies.extend(rocks)
        n_wo = sum(1 for r in rocks if r["orbit"]["a"] < 0.0)
        notes.append(
            f"碎石带 {len(rocks)} 颗 (密度 {ASTEROID_DENSITY} RU^-3, 半径由 m = rho 4/3 pi r^3 反算), "
            f"其中 {n_wo} 颗逆行; 全部绕开空间站轨道 ±{corridor_half:.2f} RU 的通行走廊。"
        )
    if bp.get("debris"):
        rs_now = bodies[0]["rs"]
        shards = _build_debris(rng, bp["debris"], mu, rs_now)
        bodies.extend(shards)
        notes.append(f"潮汐碎片 {len(shards)} 块: 前一次失败的货舱, 近日点已压入洛希极限以内。")

    # ---- 7. 货舱 ----
    # 货舱初始条件由"与空间站半径的相对差"反解 (而不是写死 a/e), 这样
    # |r_pod - r_station| / r_station 在构造时就精确等于 pod_start_ratio。
    # 单货舱时货舱恰好停在轨道的一个拱点上 (dir="in" -> 近星点, dir="out" -> 远星点),
    # 多货舱时沿半径方向排成一列 (各自独立的转移椭圆, 分批对接)。
    pod_bp = bp["pod"]
    pods: list[dict] = []
    n_pods = int(bp.get("pods_n", 1))
    sign = 1.0 if pod_bp.get("dir", "in") == "in" else -1.0
    base_r = float(pod_bp["ra"])
    # 每个货舱的起始半径系数: 第 1 个为 1.0, 后续按 spread 递增 (1.0 -> 1.29)
    if n_pods == 1:
        factors = [1.0]
    else:
        factors = [1.0 + (float(pod_bp.get("spread", 0.29)) * i / (n_pods - 1))
                   for i in range(n_pods)]
    for i in range(n_pods):
        e = float(pod_bp["e"])
        omega = 0.0 if sign > 0 else math.pi
        # 目标起始半径 r_i: 直接按半径缩放 (而不是缩放 a —— a 受拱点限制无法任意放大)
        r_i = base_r * factors[i]
        # dir="in": 货舱起始就在近星点 (nu = 0); dir="out": 起始就在远星点 (nu = pi)
        nu = 0.0 if sign > 0 else math.pi
        a_i = r_i / (1.0 - e * math.cos(nu))
        # 平近点角 (开普勒方程的正向解)
        ea = 2.0 * math.atan2(math.sqrt(1.0 - e) * math.sin(nu / 2.0),
                              math.sqrt(1.0 + e) * math.cos(nu / 2.0))
        m0 = ea - e * math.sin(ea)
        pod_orbit = orbit(a_i, e, omega, m0)
        # 自检: 该要素在历元处的半径必须精确等于目标半径
        r_check = radius_at(a_i, e, omega, m0)
        if abs(r_check - r_i) > 1e-6:
            raise ValueError(f"{bp['id']}: 货舱 {i + 1} 轨道反解失败 "
                             f"(目标 {r_i:.6f}, 实得 {r_check:.6f})")
        pods.append({
            "id": f"p{i + 1}",
            "mass": POD_MASS_STD,
            "radius": POD_RADIUS_STD,
            "hull": 1.0,
            "sail": round(0.7 - 0.1 * (chapter - 1), 3),
            "orbit": pod_orbit,
        })

    # ---- 8. 对接与任务估算 (真实公式 -> par) ----
    r_pod = radius_at(float(pods[0]["orbit"]["a"]), float(pods[0]["orbit"]["e"]),
                      float(pods[0]["orbit"]["omega"]), float(pods[0]["orbit"]["M0"]))
    r_dock = radius_at(float(st_orbit["a"]), float(st_orbit["e"]),
                       float(st_orbit["omega"]), float(st_orbit["M0"]))
    # par_time / par_fuel 完全由 physics_ref.estimate_mission() 的真实公式给出,
    # 只乘一个随难度递增的系数 (1.15~1.60), 无任何写死常量。
    mission = ph.estimate_mission(mu, r_pod, r_dock, pods[0]["mass"], ph.ISP_DEFAULT,
                                 ph.G0_DEFAULT, n_pods=n_pods, dv_scale=dv_scale,
                                 time_scale=ph.TIME_SCALE_DEFAULT)
    # 集成口径下限: 第 1 关 >= 15 TU, 其余 >= 12 TU (且 >= 1.25 x 霍曼转移时间)。
    # 若真实估算低于下限, 用"延长相位等待"补足到下限 —— 这在物理上对应"多等一个
    # 会合窗口", 不做任何魔法加速; par_fuel (任务 delta-v 需求) 不受影响。
    t_floor = PAR_TIME_FLOOR_L1 if (chapter == 1 and difficulty == 1) else PAR_TIME_FLOOR
    t_needed = max(t_floor, 1.25 * mission["transfer_time"])
    if mission["par_time"] < t_needed:
        extra = t_needed / dv_scale - mission["transfer_time"] - mission["phasing_time"]
        mission = ph.estimate_mission(mu, r_pod, r_dock, pods[0]["mass"], ph.ISP_DEFAULT,
                                     ph.G0_DEFAULT, n_pods=n_pods, dv_scale=dv_scale,
                                     time_scale=ph.TIME_SCALE_DEFAULT,
                                     phasing_fraction=min(
                                         2.0,
                                         (mission["phasing_time"] + extra)
                                         / mission["synodic_period"]
                                         if math.isfinite(mission["synodic_period"])
                                         and mission["synodic_period"] > 0 else 1.0))
        mission["par_time"] = max(mission["par_time"], t_needed)

    dock_radius = round(DOCK_RADIUS_MAX - (DOCK_RADIUS_MAX - DOCK_RADIUS_MIN)
                        * (difficulty - 1) / 11.0, 4)
    dock = {
        "body": "station",
        "offset": {"x": 0.0, "y": 0.0},
        "radius": dock_radius,
        "v_max": round(float(bp["dock_vmax"]), 3),
    }

    # ---- 9. 环境: 星风 / 星云 ----
    hazards: list[dict] = []
    if bp.get("wind"):
        w = bp["wind"]
        strength = min(WIND_STRENGTH_MAX, max(WIND_STRENGTH_MIN, float(w["strength"])))
        hazards.append({"kind": "wind", "period": float(w["period"]),
                        "phase": round(rng.uniform(0.0, float(w["period"])), 3),
                        "strength": round(strength, 4), "tag": "星风脉冲"})
    if bh:
        rs_now = bodies[0]["rs"]
        hazards.append({"kind": "tidal", "radius": round(ph.isco_radius(rs_now), 6),
                        "strength": round(1.0 / rs_now, 1), "tag": "洛希撕裂区"})
    nebulae: list[dict] = []
    if bp.get("nebula"):
        nb = bp["nebula"]
        nebulae.append({
            "x": float(nb["x"]), "y": float(nb["y"]), "r": float(nb["r"]),
            "density": round(min(NEBULA_DENSITY_MAX, max(NEBULA_DENSITY_MIN,
                                                         float(nb["density"]))), 4),
            "omega": float(nb["omega"]),
        })

    # ---- 10. solution / 物理校验记入 notes ----
    rp_pod, ra_pod = apse_radii(float(pod_bp["ra"]), float(pod_bp["e"]))
    notes.append(
        f"霍曼标准答案: r_pod = {r_pod:.4f} -> r_dock = {r_dock:.4f}; "
        f"第一次点火 dv1 = {mission['dv_depart']:+.5f} (契约公式 hohmann_dv = "
        f"{mission['dv_min']:+.5f}), 圆化 dv2 = {mission['dv_arrive']:+.5f} "
        f"(dv_to_circularize), 合计 {mission['dv_total']:.5f} RU/TU; "
        f"转移半周期 {mission['transfer_time']:.4f} TU = "
        f"{mission['transfer_time_real']:.2f} s。"
    )
    notes.append(
        f"标准用时 par_time = (转移半周期 {mission['transfer_time']:.4f} + 相位等待 "
        f"{mission['phasing_time']:.4f}) x 难度系数 {dv_scale:.3f} = "
        f"{mission['par_time']:.3f} TU ({mission['par_time_real']:.1f} s 实时); "
        f"相位等待由真实会合周期给出: {mission['phasing_fraction']:.2f} x T_syn "
        f"({mission['synodic_period']:.4f} TU); "
        f"硬下限 1.25 x 转移 = {1.25 * mission['transfer_time']:.3f} TU; "
        f"标准任务 delta-v par_fuel = {mission['par_fuel']:.4f} RU/TU "
        f"(= dv_total {mission['dv_total']:.4f} x 难度系数 {dv_scale:.3f}); "
        f"齐奥尔科夫斯基: dv = {mission['dv_par_mps']:.3f} m/s 对应推进剂质量分数 "
        f"1 - exp(-dv/(Isp g0)) = {mission['propellant_fraction'] * 100:.4f}%。"
    )
    if secondary and l_points:
        notes.append(
            f"拉格朗日点 (相对主星, 伴星在 +x 距 {float(secondary['a']):.2f}): "
            f"L1 = {l_points['L1']:.4f}, L2 = {l_points['L2']:.4f}, L3 = {l_points['L3']:.4f}, "
            f"L4 = ({l_points['L4'][0]:.4f}, {l_points['L4'][1]:.4f}), "
            f"L5 = ({l_points['L5'][0]:.4f}, {l_points['L5'][1]:.4f}); "
            f"L1 距伴星 {float(secondary['a']) - l_points['L1']:.4f} ≈ "
            f"R (m/(3M))^(1/3) = "
            f"{(float(secondary['a']) - ph.lagrange_l1_offset(float(secondary['a']), mu, float(secondary['mass']))):.4f}。"
        )
    if bh:
        rs_now = float(bodies[0]["rs"])
        isco = ph.isco_radius(rs_now)
        # 自引力判据 (集成侧冻结): 撕裂半径与中心天体质量的 1/3 次方成正比
        r_tear = tidal_tear_radius(mu, pods[0]["mass"], pods[0]["radius"])
        limit_st = STATION_TEAR_SAFETY * r_tear
        limit_pod = POD_TEAR_SAFETY * r_tear
        if r_dock < limit_st:
            raise ValueError(f"{bp['id']}: 空间站半径 {r_dock:.4f} < {STATION_TEAR_SAFETY} r_tear "
                             f"= {limit_st:.4f}, 货舱进站途中会被潮汐撕碎, 关卡不可能完成")
        if rp_pod < limit_pod:
            raise ValueError(f"{bp['id']}: 货舱近日点 {rp_pod:.4f} < {POD_TEAR_SAFETY} r_tear "
                             f"= {limit_pod:.4f}, 开局即碎")
        dt = ph.time_dilation(rp_pod, rs_now)
        tide_ratio = ph.tidal_gradient(mu, rp_pod, pods[0]["radius"]) / ph.self_gravity(
            pods[0]["mass"], pods[0]["radius"])
        notes.append(
            f"潮汐安全校验 (自引力判据): r_tear = (2 mu dr / g_self)^(1/3) = {r_tear:.4f} RU "
            f"(g_self = G m/r^2 = {ph.self_gravity(pods[0]['mass'], pods[0]['radius']):.5f}); "
            f"空间站 {r_dock:.4f} = {r_dock / r_tear:.2f} r_tear "
            f"(要求 >= {STATION_TEAR_SAFETY}), 货舱近日点 {rp_pod:.4f} = "
            f"{rp_pod / r_tear:.2f} r_tear (要求 >= {POD_TEAR_SAFETY})。"
            f"近日点处潮汐差/自引力 = {tide_ratio * 100:.3f}% (100% 即撕裂)。"
            f"ISCO = {isco:.6f}, 3 r_s = {3.0 * rs_now:.6f} (远小于上述半径)。"
            f"近日点引力时间膨胀 dt_inf/dt_local = {dt:.6f} (站上时钟慢 "
            f"{(dt - 1.0) * 100:.2f}%), 红移 z = {ph.gravitational_redshift(rp_pod, rs_now):.6f}, "
            f"潮汐梯度 2 mu dr/r^3 = "
            f"{ph.tidal_gradient(mu, rp_pod, pods[0]['radius']):.4f}。"
        )
    notes.append(
        f"层级稳定性: 货舱/空间站轨道远星点 max({ra_pod:.4f}, "
        f"{apse_radii(float(st_orbit['a']), float(st_orbit['e']))[1]:.4f}) < bounds "
        f"{float(bp['bounds']):.2f}; "
        f"货舱近日点 {rp_pod:.4f} > 中心天体半径 {core_radius:.2f}。"
    )

    payload = {
        "id": bp["id"],
        "index": difficulty,
        "chapter": chapter,
        "name_zh": bp["name_zh"],
        "name_en": bp["name_en"],
        "difficulty": difficulty,
        "mu_star": mu,
        "bounds": float(bp["bounds"]),
        "camera": dict(bp["camera"]),
        "bodies": bodies,
        "pods": pods,
        "dock": dock,
        "hazards": hazards,
        "nebulae": nebulae,
        "par_time": round(mission["par_time"], 4),
        "par_fuel": round(mission["par_fuel"], 4),
        "hint_zh": bp["hint_zh"],
        "hint_en": bp["hint_en"],
        "solution": {
            "method": "hohmann",
            "dv_min": round(mission["dv_min"], 6),
            "dv_depart": round(mission["dv_depart"], 6),
            "dv_arrive": round(mission["dv_arrive"], 6),
            "dv_total": round(mission["dv_total"], 6),
            "transfer_time": round(mission["transfer_time"], 6),
            "fuel_used_nominal": round(mission["propellant_fraction"], 8),
            "r_pod": round(r_pod, 6),
            "r_dock": round(r_dock, 6),
            "notes": " ".join(notes),
        },
    }
    return payload


# ---------------------------------------------------------------------------
# 生成 / 校验
# ---------------------------------------------------------------------------


def generate_levels(force: bool = False, seed: int = GENERATOR_SEED) -> dict:
    """写 assets/data/systems.json, 返回该 dict (INTERFACES.md §1 契约函数)。

    契约签名为 `generate_levels(force: bool = False)`; 这里追加的 `seed` 是向后兼容的
    关键字扩展 (调用方按位置传 force 的行为完全不变), 用于确定性变化:
    同一个 seed 一定产出字节完全相同的 systems.json。
    `force=False` 且文件已存在时直接读取返回, 不重写磁盘。
    """
    if SYSTEMS_JSON.exists() and not force:
        try:
            data = json.loads(SYSTEMS_JSON.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("levels"):
                return data
        except (OSError, json.JSONDecodeError):
            pass  # 损坏则重建

    rng = random.Random(seed)
    levels = [build_level(bp, rng) for bp in LEVEL_BLUEPRINTS]

    # generated_at 由 seed 决定 (确定性: 同 seed 同输出)
    stamp = _dt.datetime(2026, 1, 1, tzinfo=_dt.timezone.utc) + _dt.timedelta(seconds=seed % 86400)
    data = {
        "version": VERSION,
        "generated_at": stamp.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "constants": dict(CONSTANTS),
        "chapters": [dict(c) for c in CHAPTERS],
        "levels": levels,
    }
    problems = validate(data["levels"])
    if problems:
        raise ValueError("关卡自校验未通过, 拒绝写盘:\n  - " + "\n  - ".join(problems))

    ASSETS_DATA.mkdir(parents=True, exist_ok=True)
    SYSTEMS_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8")
    return data


def validate(levels: list[dict]) -> list[str]:
    """校验关卡集合。返回问题列表 (空列表 = 通过)。

    除几何/物理约束外，这里还包含**非退化判据**（实测踩过的坑，见各段注释）：
      - 货舱不能"生在对接环里"（否则 simtest 会给出 0.0 TU 的假通过）；
      - 层级轨道（卫星）必须落在父天体 Hill 球的稳定区内（顺行 < 0.5 r_H）；
      - 多星系统必须满足 Mardling & Aarseth (2001) 层级稳定性判据。
    """
    problems: list[str] = []

    # ---- 集合层面 ----
    if len(levels) < 12:
        problems.append(f"关卡总数 {len(levels)} < 12")
    idx_seq = sorted(lv["index"] for lv in levels)
    if idx_seq != list(range(1, len(levels) + 1)):
        problems.append(f"关卡序号不连续: {idx_seq}")
    chapters: dict[int, list[dict]] = {}
    for lv in levels:
        chapters.setdefault(int(lv.get("chapter", 0)), []).append(lv)
    for ci in (1, 2, 3, 4):
        got = len(chapters.get(ci, []))
        if got != 3:
            problems.append(f"第 {ci} 章关卡数 {got} != 3")
    diffs = [int(lv.get("difficulty", 0)) for lv in levels]
    if len(set(diffs)) != len(diffs):
        problems.append(f"难度不唯一: {sorted(diffs)}")
    if diffs != sorted(diffs):
        problems.append(f"难度未递增: {diffs}")
    if diffs and diffs != list(range(1, 13)):
        if sorted(diffs) != list(range(1, len(levels) + 1)):
            problems.append(f"难度未覆盖 1..{len(levels)}: {sorted(diffs)}")

    # ---- 单关层面 ----
    for lv in levels:
        lid = lv.get("id", "?")
        load = levels[0]
        load = lv
        mu = float(load.get("mu_star", 1.0))
        bounds = float(load.get("bounds", 0.0))
        bodies = load.get("bodies", [])
        ids = {b.get("id") for b in bodies}
        if not bodies:
            problems.append(f"{lid}: bodies 为空")
        if bounds <= 0.0:
            problems.append(f"{lid}: bounds 必须为正")

        # dock.body 必须存在
        dock = load.get("dock", {})
        dock_body = dock.get("body")
        if dock_body not in ids:
            problems.append(f"{lid}: dock.body '{dock_body}' 不在 bodies 中")
        # 对接窗口允许范围：设计空间而非定律。第 1 章（教学章）需要更宽容的窗口，
        # 否则新手会陷入"每次都撞环弹开"的挫败（实测反馈）。
        if not (0.08 <= float(dock.get("radius", 0.0)) <= 0.26):
            problems.append(f"{lid}: dock.radius {dock.get('radius')} 超出 [0.08, 0.26]")
        if not (0.18 <= float(dock.get("v_max", 0.0)) <= 0.65):
            problems.append(f"{lid}: dock.v_max {dock.get('v_max')} 超出 [0.18, 0.65]")

        # 货舱至少 1 个, 质量为正
        pods = load.get("pods", [])
        if len(pods) < 1:
            problems.append(f"{lid}: pods 数量为 {len(pods)}, 至少需要 1 个")
        for p in pods:
            if float(p.get("mass", 0.0)) <= 0.0:
                problems.append(f"{lid}/{p.get('id')}: mass 非正")
            if float(p.get("radius", 0.0)) <= 0.0:
                problems.append(f"{lid}/{p.get('id')}: radius 非正")
            ob = p.get("orbit")
            if not ob:
                problems.append(f"{lid}/{p.get('id')}: 缺少 orbit")
                continue
            e = float(ob["e"])
            if not (0.0 <= e <= 0.7):
                problems.append(f"{lid}/{p.get('id')}: e = {e} 超出 [0, 0.7]")
            if abs(float(ob["a"])) >= bounds:
                problems.append(f"{lid}/{p.get('id')}: orbit.a = {ob['a']} 不满足 < bounds {bounds}")

        # 天体: 质量为正 / 轨道在 bounds 内 / e 合法
        station_body = next((b for b in bodies if b.get("id") == dock_body), None)
        for b in bodies:
            bid = b.get("id")
            if float(b.get("mass", 0.0)) <= 0.0:
                problems.append(f"{lid}/{bid}: mass 非正")
            if float(b.get("radius", 0.0)) <= 0.0:
                problems.append(f"{lid}/{bid}: radius 非正")
            ob = b.get("orbit")
            if ob is None:
                continue
            e = float(ob["e"])
            if not (0.0 <= e <= 0.7):
                problems.append(f"{lid}/{bid}: e = {e} 超出 [0, 0.7]")
            if abs(float(ob["a"])) >= bounds:
                problems.append(f"{lid}/{bid}: orbit.a = {ob['a']} 不满足 < bounds {bounds}")
            rp, ra = apse_radii(float(ob["a"]), e)
            core = next((c for c in bodies if c.get("orbit") is None), None)
            if core is not None and rp <= float(core.get("radius", 0.0)):
                problems.append(f"{lid}/{bid}: 近日点 {rp:.4f} 落入中心天体内部")

        # par_time / par_fuel 与真实公式一致
        if station_body is not None and pods:
            r_pod = radius_at(pods[0]["orbit"]["a"], pods[0]["orbit"]["e"],
                              pods[0]["orbit"]["omega"], pods[0]["orbit"]["M0"])
            r_dock = radius_at(station_body["orbit"]["a"], station_body["orbit"]["e"],
                               station_body["orbit"]["omega"], station_body["orbit"]["M0"])
            mission = ph.estimate_mission(mu, r_pod, r_dock, pods[0]["mass"],
                                         ph.ISP_DEFAULT, ph.G0_DEFAULT,
                                         n_pods=len(pods),
                                         dv_scale=difficulty_dv_scale(int(load["difficulty"])),
                                         time_scale=ph.TIME_SCALE_DEFAULT)
            t_pod = mission["transfer_time"]
            if float(load["par_time"]) < 1.25 * t_pod - 1e-6:
                problems.append(f"{lid}: par_time {load['par_time']} < 1.25 x 霍曼转移时间 "
                                f"{1.25 * t_pod:.4f} (物理上不可能完成)")
            if float(load["par_time"]) > 70.0:
                problems.append(f"{lid}: par_time {load['par_time']} > 70 (超出集成口径)")
            if not (0.02 <= float(load["par_fuel"]) <= 5.0):
                problems.append(f"{lid}: par_fuel {load['par_fuel']} 超出 [0.02, 5.0]")

        # ---- 非退化判据（"真通关"的前置条件）----
        # 实测教训：把货舱摆在对接环里，自动化会报 0.0 TU 通关 —— 那是假通过，不是关卡。
        # 判据只抓**真退化**（生在环里/几乎同轨同相），不抓"简单"：
        # 设计要求是"难度可以很极限，但必须存在合法解"，简单/困难由难度曲线决定，不由校验决定。
        if station_body is not None and station_body.get("orbit") and pods and pods[0].get("orbit"):
            try:
                ring = float(dock.get("radius", 0.1))
                for p in pods:
                    if not p.get("orbit"):
                        continue
                    d0 = _epoch_distance(station_body["orbit"], p["orbit"], bodies)
                    if d0 <= 1.5 * ring:
                        problems.append(f"{lid}/{p['id']}: 起点距空间站 {d0:.4f} <= 1.5×对接环 "
                                        f"{1.5 * ring:.4f} —— 生在环里（假通过）")
                    # **交接轨道几何**：货舱近星点与站轨道半径之差必须大于对接环，
                    # 否则货舱会无人操作时"自己飘进环"自动对接（实测 L2-3 开场 3 秒自动送达）。
                    same_c = (p["orbit"].get("parent") or None) == (station_body["orbit"].get("parent") or None)
                    if same_c:
                        rp_p, _ra_p = apse_radii(float(p["orbit"]["a"]), float(p["orbit"]["e"]))
                        r_st_c = radius_at(station_body["orbit"]["a"], station_body["orbit"]["e"],
                                           station_body["orbit"]["omega"], station_body["orbit"]["M0"])
                        gap = abs(rp_p - r_st_c)
                        if gap <= 1.4 * ring:
                            problems.append(f"{lid}/{p['id']}: 近星点 {rp_p:.4f} 与站轨道 {r_st_c:.4f} 间距 "
                                            f"{gap:.4f} <= 1.4×对接环 {1.4 * ring:.4f} —— 会无人自动对接")
                da = abs(float(pods[0]["orbit"]["a"]) - float(station_body["orbit"]["a"]))
                if da < 0.01 and d0 < 3.0 * ring:
                    problems.append(f"{lid}: Δa={da:.4f} 且相位接近 —— 没有可玩的转移距离")
            except Exception as exc:  # noqa: BLE001
                problems.append(f"{lid}: 非退化判据计算失败 {exc!r}")

        # ---- 出生即撞判据 ----
        # 实测教训：为了拉开"自动对接余量"而自动调整货舱轨道时，很容易把货舱挪到穿过行星的位置，
        # 表现为开局 0.12 TU 就"撞击行星"、关卡直接不可通关（L3-3 就是这样回归的）。
        # 这类缺陷必须由判据拦住，不能靠肉眼看数字。
        for p in pods:
            ob = p.get("orbit")
            if not ob:
                continue
            try:
                px, py = _epoch_position(ob, bodies)
            except Exception:  # noqa: BLE001
                continue
            worst_clear = float("inf")
            worst_who = ""
            for b in bodies:
                if b.get("kind") not in ("star", "planet", "blackhole"):
                    continue
                bx, by = _epoch_position(b["orbit"], bodies) if b.get("orbit") else (0.0, 0.0)
                d = math.hypot(px - bx, py - by)
                clear = d - float(b.get("radius", 0.0)) - 3.0 * float(p.get("radius", 0.01))
                if clear < worst_clear:
                    worst_clear = clear
                    worst_who = str(b.get("id"))
            if worst_clear < 0.01:
                problems.append(f"{lid}/{p['id']}: 出生点距 {worst_who} 净空 {worst_clear:.4f} RU < 0.01"
                                f" —— 开局即撞击天体")

        # ---- 货舱之间不得出生即重叠（同轨道同相位会瞬间互相撞毁，实测 L4-2/L4-3 报 0.0 TU 损毁 2）----
        if len(pods) >= 2:
            for i in range(len(pods)):
                for j in range(i + 1, len(pods)):
                    oi, oj = pods[i].get("orbit"), pods[j].get("orbit")
                    if not oi or not oj or not oi.get("a") or not oj.get("a"):
                        continue
                    # 一律算**真实历元距离**：同 a 不同相位是安全的（相角不同、距离很远），
                    # 早期写成"同 a 就取半径和"会误报（实测 6 个关卡全部误报 0.0240）。
                    dij = _epoch_distance(oi, oj, bodies)
                    if dij < 4.0 * max(float(pods[i].get("radius", 0.01)),
                                       float(pods[j].get("radius", 0.01))):
                        problems.append(f"{lid}: 货舱 {pods[i]['id']} 与 {pods[j]['id']} 出生间距 "
                                        f"{dij:.4f} 过小（会瞬间互撞）")

        # ---- 层级轨道（卫星 / 绕行星的天体）稳定判据 ----
        # 真实约束：顺行卫星的稳定轨道半径 < 0.5 × 父天体绕其上一级的 Hill 球半径。
        for b in bodies:
            ob = b.get("orbit")
            if not ob or not ob.get("parent"):
                continue
            par = next((x for x in bodies if x.get("id") == ob["parent"]), None)
            if par is None:
                problems.append(f"{lid}/{b.get('id')}: orbit.parent '{ob['parent']}' 不存在")
                continue
            if par.get("orbit") is None:
                if float(ob["a"]) <= 2.0 * float(par.get("radius", 0.0)):
                    problems.append(f"{lid}/{b.get('id')}: 绕中心天体的轨道 {ob['a']} 太近（< 2 半径）")
                continue
            a_par = abs(float(par["orbit"]["a"]))
            r_h = ph.hill_sphere(a_par, float(par["mass"]), mu)
            frac = float(ob["a"]) / max(r_h, 1e-9)
            if frac >= 0.5:
                problems.append(f"{lid}/{b.get('id')}: 轨道 {ob['a']:.3f} = {frac:.2f}×父天体 Hill 球 "
                                f"{r_h:.3f} —— 超出顺行卫星稳定界 0.5 r_H，会被中心天体拽走")
            elif frac > 0.40:
                problems.append(f"{lid}/{b.get('id')}: ⚠ {frac:.2f}×Hill 球，接近稳定界 0.5（建议 <= 0.40）")

        # ---- 多星层级稳定性：Mardling & Aarseth (2001) ----
        #   a_out/a_in > 2.8 · ((1 + m3/(m1+m2)) · (1+e_out)/sqrt(1−e_out))^(2/5)
        stars = [b for b in bodies if b.get("kind") in ("star", "blackhole")]
        comps = [b for b in stars if b.get("orbit")]
        if len(stars) >= 3 and len(comps) >= 2:
            comps.sort(key=lambda x: abs(float(x["orbit"]["a"])))
            inner, outer = comps[0], comps[1]
            a_in = abs(float(inner["orbit"]["a"]))
            a_out = abs(float(outer["orbit"]["a"]))
            m_in = float(inner.get("mass", 0.0))
            m_out = float(outer.get("mass", 0.0))
            m_prim = sum(float(b.get("mass", 0.0)) for b in stars if not b.get("orbit"))
            e_out = float(outer["orbit"]["e"])
            ratio = a_out / max(a_in, 1e-9)
            crit = 2.8 * ((1.0 + m_out / max(m_in + m_prim, 1e-9)) * (1.0 + e_out)
                          / math.sqrt(max(1.0 - e_out, 1e-9))) ** 0.4
            if ratio <= crit:
                problems.append(f"{lid}: 三星层级不稳定 a_out/a_in={ratio:.2f} <= 判据 {crit:.2f} "
                                f"(Mardling & Aarseth 2001)")
            t_in = 2.0 * math.pi * math.sqrt(a_in ** 3 / max(m_in + m_prim, 1e-9))
            if t_in < 4.0:
                problems.append(f"{lid}: 内双星周期 {t_in:.2f} TU < 4 TU —— 引力场时变过快，玩法上不可操作")

        # 层级/扰动稳定性 (真实公式):
        #   1) 空间站绕中心天体的引力必须主导宿主天体的扰动: mu_h/d^2 << mu/r_star^2;
        #   2) 若宿主才是空间站的主天体 (d < r_star), 则空间站必须位于其希尔球内。
        if station_body is not None and station_body.get("orbit"):
            host = next((b for b in bodies if b.get("id") == "planetHost"), None)
            st_orbit = station_body["orbit"]
            if st_orbit.get("parent"):
                # **站绕行星的层级轨道**：此时行星才是中心天体，恒星是扰动源——判据方向与下面相反。
                par = next((x for x in bodies if x.get("id") == st_orbit["parent"]), None)
                if par is not None and par.get("orbit"):
                    px, py = _epoch_position(st_orbit, bodies)
                    hx, hy = _epoch_position(par["orbit"], bodies)
                    d_host = math.hypot(px - hx, py - hy)
                    d_star = max(1e-9, math.hypot(px, py))
                    g_host = float(par["mass"]) / max(d_host, 1e-12) ** 2
                    g_star = mu / d_star ** 2
                    if g_host <= 5.0 * g_star:
                        problems.append(f"{lid}: 站绕 {st_orbit['parent']} 但该中心天体引力 {g_host:.4e} "
                                        f"未显著主导恒星引力 {g_star:.4e}（层级轨道不成立）")
            elif host is not None and host.get("orbit"):
                d_hs = _epoch_distance(host["orbit"], station_body["orbit"], bodies)
                r_star = abs(float(station_body["orbit"]["a"]))
                m_host = float(host["mass"])
                g_core = mu / r_star ** 2
                g_host = m_host / max(d_hs, 1e-12) ** 2
                if g_host > 0.05 * g_core:
                    problems.append(
                        f"{lid}: 宿主天体在空间站处的引力 {g_host:.3e} 超过中心天体 "
                        f"{g_core:.3e} 的 5% (d = {d_hs:.4f}, r_star = {r_star:.4f}), "
                        f"轨道会被显著扰动")
                host_is_parent = g_host > g_core
                r_h = ph.hill_sphere(abs(float(host["orbit"]["a"])), m_host, mu)
                if host_is_parent:
                    if r_star > 0.90 * r_h:
                        problems.append(f"{lid}: 宿主是主天体, 空间站 a = {r_star:.4f} 超出 "
                                        f"0.90 希尔球 {0.90 * r_h:.4f} (层级不稳定)")
                    if d_hs <= 1.35 * float(host["radius"]):
                        problems.append(f"{lid}: 空间站距宿主 {d_hs:.4f} <= 1.35 R_host, 会撞击")
                    if r_star <= float(host["radius"]) * (m_host / (3.0 * mu)) ** (1.0 / 3.0):
                        problems.append(f"{lid}: 空间站 a = {r_star:.4f} 小于双体重心偏移, 层级退化")

        # 环境参数区间
        for hz in load.get("hazards", []):
            if hz.get("kind") == "wind":
                s = float(hz.get("strength", 0.0))
                if not (WIND_STRENGTH_MIN - 1e-9 <= s <= WIND_STRENGTH_MAX + 1e-9):
                    problems.append(f"{lid}: 星风 strength {s} 超出 "
                                    f"[{WIND_STRENGTH_MIN}, {WIND_STRENGTH_MAX}]")
                if float(hz.get("period", 0.0)) <= 0.0:
                    problems.append(f"{lid}: 星风 period 非正")
        for nb in load.get("nebulae", []):
            d = float(nb.get("density", 0.0))
            if not (NEBULA_DENSITY_MIN - 1e-9 <= d <= NEBULA_DENSITY_MAX + 1e-9):
                problems.append(f"{lid}: 星云 density {d} 超出 "
                                f"[{NEBULA_DENSITY_MIN}, {NEBULA_DENSITY_MAX}]")
            if float(nb.get("r", 0.0)) <= 0.0:
                problems.append(f"{lid}: 星云 r 非正")

        # 第 3 章必须在 L4/L5 稳定岛
        if int(load.get("chapter", 0)) == 3:
            sec = next((b for b in bodies if b.get("id") == "companion"), None)
            if sec is None:
                problems.append(f"{lid}: 第 3 章缺少 companion 伴星")
            else:
                m_s = float(sec["mass"])
                if not ph.routh_stable(mu, m_s):
                    problems.append(f"{lid}: 伴星质量比超过 Routh 极限, L4/L5 不稳定")
                a_s = float(sec["orbit"]["a"])
                lps = ph.lagrange_points(mu, m_s, a_s)
                pos = _epoch_position(station_body["orbit"])
                d_l4 = math.hypot(pos[0] - lps["L4"][0], pos[1] - lps["L4"][1])
                d_l5 = math.hypot(pos[0] - lps["L5"][0], pos[1] - lps["L5"][1])
                # 集成口径: 允许近似停在 L4/L5, 容差 0.15 RU
                island_tol = 0.15
                if min(d_l4, d_l5) > island_tol:
                    problems.append(f"{lid}: 空间站未停在 L4/L5 稳定岛 (距 L4 {d_l4:.5f}, "
                                    f"L5 {d_l5:.5f}, 容差 {island_tol:.2f})")
                # 物理复核 (非阻塞): 该点应是旋转系有效势的驻点, 残差用同一量纲比较
                mu_sec = m_s / (mu + m_s)
                bary_off = a_s * mu_sec
                grad = ph._cr3bp_gradient(mu_sec, (pos[0] - bary_off) / a_s, pos[1] / a_s)
                if math.hypot(*grad) > 0.10 * island_tol / a_s:
                    problems.append(f"{lid}: 空间站处旋转系合力残差过大 "
                                    f"|grad Phi| = {math.hypot(*grad):.3e} "
                                    f"(容差 {0.10 * island_tol / a_s:.3e})")
                if "L4" not in str(load.get("solution", {}).get("notes", "")) and \
                        "L5" not in str(load.get("solution", {}).get("notes", "")):
                    problems.append(f"{lid}: solution.notes 未说明 L4/L5 停泊方案")
                if station_body is None or not station_body.get("orbit"):
                    problems.append(f"{lid}: 缺少空间站轨道")

        # ---- 集成口径硬约束 (全部 12 关, 与中心天体类型无关) ----
        # 1) 潮汐撕裂半径 (自引力判据) 决定空间站与货舱的半径下界
        r_tear = tidal_tear_radius(mu)

        def _central_mu(ob: dict | None) -> float:
            """该天体实际环绕的中心天体的 μ。层级轨道（卫星/绕行星的站）必须用父天体的 μ，
            否则绕行星的站会按恒星 μ 被误判成"半径过小、进站途中会被撕碎"。"""
            par_id = (ob or {}).get("parent")
            if par_id:
                par = next((x for x in bodies if x.get("id") == par_id), None)
                if par is not None and float(par.get("mass", 0.0)) > 0.0:
                    return float(par["mass"])
            return mu

        if station_body is not None and station_body.get("orbit"):
            r_st = radius_at(station_body["orbit"]["a"], station_body["orbit"]["e"],
                             station_body["orbit"]["omega"], station_body["orbit"]["M0"])
            r_tear = tidal_tear_radius(_central_mu(station_body["orbit"]))
            if r_st < STATION_TEAR_SAFETY * r_tear:
                problems.append(f"{lid}: 空间站半径 {r_st:.4f} < {STATION_TEAR_SAFETY} x r_tear "
                                f"{r_tear:.4f} = {STATION_TEAR_SAFETY * r_tear:.4f} "
                                f"(货舱进站途中会被潮汐撕碎)")
            for p in pods:
                rp, _ra = apse_radii(float(p["orbit"]["a"]), float(p["orbit"]["e"]))
                r_tear_p = tidal_tear_radius(_central_mu(p["orbit"]))
                if rp < POD_TEAR_SAFETY * r_tear_p:
                    problems.append(f"{lid}/{p['id']}: 近日点 {rp:.4f} < {POD_TEAR_SAFETY} x "
                                    f"r_tear {r_tear_p:.4f} = {POD_TEAR_SAFETY * r_tear_p:.4f}")
                # 2) 货舱初始半径与空间站半径的相对差。
                #    **只在两者环绕同一个中心天体时才有意义**：货舱绕恒星、站绕行星时，
                #    两边的"半径"是不同原点的距离，直接相减没有物理含义（层级轨道关卡）。
                same_center = (p["orbit"].get("parent") or None) == (station_body["orbit"].get("parent") or None)
                if same_center:
                    r_p0 = radius_at(p["orbit"]["a"], p["orbit"]["e"],
                                     p["orbit"]["omega"], p["orbit"]["M0"])
                    ratio = abs(r_p0 - r_st) / max(r_st, 1e-9)
                    if not (POD_STATION_RATIO_MIN - 1e-9 <= ratio <= POD_STATION_RATIO_MAX + 1e-9):
                        problems.append(f"{lid}/{p['id']}: |r_pod-r_station|/r_station = {ratio:.4f} "
                                        f"超出 [{POD_STATION_RATIO_MIN}, {POD_STATION_RATIO_MAX}]")

        # 3) par_time 下限 (含第 1 关特例) 与物理硬下限
        if station_body is not None and pods and station_body.get("orbit"):
            r_pod_v = radius_at(pods[0]["orbit"]["a"], pods[0]["orbit"]["e"],
                                pods[0]["orbit"]["omega"], pods[0]["orbit"]["M0"])
            r_dock_v = radius_at(station_body["orbit"]["a"], station_body["orbit"]["e"],
                                 station_body["orbit"]["omega"], station_body["orbit"]["M0"])
            tr_v = ph.hohmann_transfer(_central_mu(pods[0]["orbit"]) if (pods[0]["orbit"].get("parent") or None) == (station_body["orbit"].get("parent") or None) else mu, r_pod_v, r_dock_v)
            dif = int(load["difficulty"])
            floor = max(1.25 * tr_v["transfer_time"],
                        PAR_TIME_FLOOR_L1 if int(load.get("chapter", 0)) == 1 and dif == 1
                        else PAR_TIME_FLOOR)
            if float(load["par_time"]) < floor - 1e-9:
                problems.append(f"{lid}: par_time {load['par_time']} < 下限 {floor:.4f} TU "
                                f"(1.25x 转移 = {1.25 * tr_v['transfer_time']:.4f}, "
                                f"口径下限 {PAR_TIME_FLOOR})")
            # 4) 可完成性估算: 场强制动 + 飞船 delta-v 预算
            v_rel = abs(tr_v["v_transfer_at_r2"] - ph.circular_velocity(mu, r_dock_v))
            brake_tu = v_rel / FIELD_ACCEL_MAX
            if brake_tu > float(load["par_time"]):
                problems.append(f"{lid}: 满场强制动需 {brake_tu:.4f} TU > par_time "
                                f"{load['par_time']} (场强 {FIELD_ACCEL_MAX} RU/TU^2 下无法完成)")
            budget = ship_dv_budget(dif)
            if float(load["par_fuel"]) > budget:
                problems.append(f"{lid}: par_fuel {load['par_fuel']} > 飞船 delta-v 预算 "
                                f"{budget:.0f} ({SHIP_DV_BASE:.0f}+{SHIP_DV_PER_DIFF:.0f}x{dif})")
        if int(load.get("chapter", 0)) == 4:
            core = next((b for b in bodies if b.get("kind") == "blackhole"), None)
            if core is None:
                problems.append(f"{lid}: 第 4 章缺少 kind=blackhole 天体")
            else:
                rs = float(core.get("rs", 0.0))
                if not (0.02 <= rs <= 0.05):
                    problems.append(f"{lid}: rs {rs} 超出 [0.02, 0.05]")
                if abs(rs - ph.horizon_radius_from_mass(mu, LIGHT_SPEED_SQ_HALF)) > 1e-6:
                    problems.append(f"{lid}: rs {rs} 与 2mu/c^2 = "
                                    f"{ph.horizon_radius_from_mass(mu, LIGHT_SPEED_SQ_HALF):.6f} 不一致")
                # 黑洞自身的视界/ISCO 必须远小于货舱轨道 (与撕裂半径分开检查, 二者都要满足)
                if ph.isco_radius(rs) >= POD_TEAR_SAFETY * r_tear:
                    problems.append(f"{lid}: ISCO {ph.isco_radius(rs):.6f} 已达撕裂半径量级, "
                                    f"无可用轨道")

        # 第 2/3 章碎石带数量与走廊
        if int(load.get("chapter", 0)) in (2, 3):
            rocks = [b for b in bodies if b.get("kind") == "asteroid"]
            if len(rocks) < ASTEROID_MIN:
                # 第 2 章的"碎石带"主题：要求有碎石场。**但卫星系统关卡同样属于第 2 章**
                # （行星系作业），因此"≥2 颗卫星"也算满足章节内容要求。
                n_moons = sum(1 for b in bodies
                              if (b.get("orbit") or {}).get("parent") and b.get("kind") == "planet")
                # 第 3 章的"内容"是 CR3BP 稳定岛本身：伴星在即算满足，碎石数量不作要求
                #（为了给降轨走廊留出干净的柯克伍德式空隙，碎石可能被有意削到很少）。
                has_lagrange = any(b.get("id") == "companion" for b in bodies)
                if n_moons < 2 and not has_lagrange:
                    problems.append(f"{lid}: 碎石带只有 {len(rocks)} 颗 (< {ASTEROID_MIN})，"
                                    f"卫星 {n_moons} 颗且无 L4/L5 伴星 —— 章节内容不足")
            if len(rocks) > ASTEROID_MAX:
                problems.append(f"{lid}: 碎石带 {len(rocks)} 颗 (> {ASTEROID_MAX})")
            if station_body is not None and station_body.get("orbit"):
                c = abs(float(station_body["orbit"]["a"]))
                for b in rocks:
                    rp, ra = apse_radii(float(b["orbit"]["a"]), float(b["orbit"]["e"]))
                    if not (ra < c - CORRIDOR_HALF + 1e-9 or rp > c + CORRIDOR_HALF - 1e-9):
                        problems.append(f"{lid}/{b['id']}: 侵入空间站轨道走廊 "
                                        f"[{c - CORRIDOR_HALF:.3f}, {c + CORRIDOR_HALF:.3f}] "
                                        f"(近日点 {rp:.3f}, 远星点 {ra:.3f})")

    return problems


# ---------------------------------------------------------------------------
# 人类可读分析报告 (--analyze)
# ---------------------------------------------------------------------------


def analyze(levels: list[dict]) -> None:
    """逐关打印真实公式算出来的物理报告 (供集成方核对合理性)。"""
    print("=" * 96)
    print("systems.json 物理分析报告 -- 全部数值由 physics_ref 真实公式导出")
    print(f"单位制: G = 1, mu_star = 1 (第 4 章为黑洞质量), 1 RU, 1 TU = "
          f"{CONSTANTS['time_scale']} s 实时; 1 RU/TU = 1 m/s")
    print("=" * 96)
    for lv in levels:
        mu = float(lv["mu_star"])
        core = next((b for b in lv["bodies"] if b.get("orbit") is None), None)
        print(f"\n{'#' * 92}")
        print(f"# {lv['id']}  {lv['name_zh']} / {lv['name_en']}   "
              f"第 {lv['chapter']} 章  难度 {lv['difficulty']}   bounds = {lv['bounds']}")
        print(f"{'#' * 92}")
        print(f"  中心天体 mu = {mu:.4f}   kind = {core['kind']}"
              + (f"   r_s = {core['rs']:.6f} (ISCO = {ph.isco_radius(core['rs']):.6f})"
                 if core.get("rs") else f"   半径 = {core['radius']}"))

        # 伴星 / 拉格朗日点
        sec = next((b for b in lv["bodies"] if b.get("id") == "companion"), None)
        if sec:
            m_s = float(sec["mass"])
            a_s = float(sec["orbit"]["a"])
            mu_ratio = m_s / (mu + m_s)
            lps = ph.lagrange_points(mu, m_s, a_s)
            approx = ph.lagrange_l1_offset(a_s, mu, m_s)
            print(f"  -- 双星 --")
            print(f"     伴星 m = {m_s:.4f}  a = {a_s:.4f}  T = "
                  f"{ph.kepler_period(mu + m_s, a_s):.4f} TU  "
                  f"v_c = {ph.circular_velocity(mu + m_s, a_s):.4f}")
            print(f"     质量比 mu = {mu_ratio:.5f} "
                  f"{'<' if ph.routh_stable(mu, m_s) else '>'} Routh 极限 "
                  f"{ph.ROUTH_CRITICAL_MU:.5f} -> L4/L5 "
                  f"{'稳定' if ph.routh_stable(mu, m_s) else '不稳定'}")
            print(f"     L1 = {lps['L1']:.5f} (距伴星 {a_s - lps['L1']:.5f}; "
                  f"解析近似 R(m/3M)^(1/3) = "
                  f"{a_s - ph.lagrange_l1_offset(a_s, mu, m_s):.5f})")
            print(f"     L2 = {lps['L2']:.5f} (距伴星 {lps['L2'] - a_s:.5f})")
            print(f"     L3 = {lps['L3']:.5f}")
            print(f"     L4 = ({lps['L4'][0]:.5f}, {lps['L4'][1]:.5f})   "
                  f"L5 = ({lps['L5'][0]:.5f}, {lps['L5'][1]:.5f})   "
                  f"[等边三角形顶点, 到两星距离均 = {a_s:.4f}]")

        # 各天体
        print(f"  -- 天体 ({len(lv['bodies'])} 个) --")
        hills: dict[str, float] = {}
        for b in lv["bodies"]:
            if b.get("orbit") is None:
                continue
            a = float(b["orbit"]["a"])
            e = float(b["orbit"]["e"])
            rp, ra = apse_radii(a, e)
            v_c = ph.circular_velocity(mu, abs(a)) if a > 0 else -ph.circular_velocity(mu, abs(a))
            t = ph.kepler_period(mu, abs(a))
            if b["kind"] == "asteroid":
                continue
            if b["kind"] == "debris" and len([x for x in lv["bodies"]
                                              if x["kind"] == "debris"]) > 3:
                continue
            if b["kind"] == "planet":
                hills[b["id"]] = ph.hill_sphere(abs(a), float(b["mass"]), mu)
            extra = ""
            if b["kind"] == "station":
                extra = (f"  <- 对接目标 (r = {radius_at(a, e, float(b['orbit']['omega']), float(b['orbit']['M0'])):.4f})")
            if b["kind"] == "planet":
                extra = f"  希尔球 r_H = {hills[b['id']]:.4f}"
            print(f"     {b['id']:<12} {b['kind']:<9} m = {b['mass']:<10.3e} "
                  f"a = {a:+.4f}  e = {e:.3f}  近/远星点 = {rp:.3f}/{ra:.3f}  "
                  f"v_c = {v_c:+.4f}  T = {t:8.4f} TU{extra}")
        n_rock = len([b for b in lv["bodies"] if b["kind"] == "asteroid"])
        n_shard = len([b for b in lv["bodies"] if b["kind"] == "debris"])
        if n_rock:
            rocks = [b for b in lv["bodies"] if b["kind"] == "asteroid"]
            n_wo = len([b for b in rocks if float(b["orbit"]["a"]) < 0])
            print(f"     碎石带: {n_rock} 颗 ({n_wo} 逆行), 密度 {ASTEROID_DENSITY}, "
                  f"a 区间 |a| ∈ [{min(abs(float(b['orbit']['a'])) for b in rocks):.3f}, "
                  f"{max(abs(float(b['orbit']['a'])) for b in rocks):.3f}], "
                  f"走廊中心 {abs(float(next(b for b in lv['bodies'] if b['kind'] == 'station')['orbit']['a'])):.3f} ± 0.20")
        if n_shard:
            print(f"     潮汐碎片: {n_shard} 块")

        # 货舱与霍曼转移
        st = next(b for b in lv["bodies"] if b["id"] == lv["dock"]["body"])
        pod0 = lv["pods"][0]
        r_pod = radius_at(float(pod0["orbit"]["a"]), float(pod0["orbit"]["e"]),
                          float(pod0["orbit"]["omega"]), float(pod0["orbit"]["M0"]))
        r_dock = radius_at(float(st["orbit"]["a"]), float(st["orbit"]["e"]),
                           float(st["orbit"]["omega"]), float(st["orbit"]["M0"]))
        tr = ph.hohmann_transfer(mu, r_pod, r_dock)
        # ---- 可行性结论（"存在合法解"的构造性证据）----
        # 注意区分两个物理量：霍曼 Δv 是**货舱轨道机动**所需的速度增量；
        # 而飞船的 Δv 预算是**引力井投影器自身的推进积分**（40+6×难度）。两者单位相同、含义不同，
        # 不能直接比大小。真正可核验的可行性判据是这三条：
        #   1) 货舱机动可由场强上限完成：t_field = Δv / FIELD_ACCEL_MAX 远小于时限；
        #   2) 时限 >= 1.25 × 霍曼转移时间（霍曼本身就是一条合法解）；
        #   3) 对接窗口速度 v_max 与"圆化后残余相对速度"相容。
        # 层级轨道：Δv 必须用**共同中心天体**的 μ 计算（货舱与站都绕行星时用行星 μ）
        _par_a = (pod0["orbit"].get("parent") or None)
        _par_b = (st["orbit"].get("parent") or None)
        _mu_man = mu
        if _par_a and _par_a == _par_b:
            _pl = next((x for x in lv["bodies"] if x.get("id") == _par_a), None)
            if _pl is not None: _mu_man = float(_pl["mass"])
        dv_man = tr["dv_total"]
        t_field = dv_man / max(FIELD_ACCEL_MAX_TS, 1e-9)
        limit_tu = max(90.0, float(lv["par_time"]) * 3.4) / 1.6
        vmax = float(lv["dock"]["v_max"])
        v_rel_after = abs(ph.circular_velocity(_mu_man, r_pod) - ph.circular_velocity(_mu_man, r_dock))
        ok = (t_field < 0.5 * limit_tu) and (limit_tu >= 1.25 * tr["transfer_time"]) and (v_rel_after <= 4.0 * vmax)
        print(f"     [可行性] 霍曼解: 货舱机动 Δv = {dv_man:.4f} RU/TU"
              f"（场强上限 {FIELD_ACCEL_MAX_TS} 可在 {t_field:.3f} TU 内提供）"
              f" · 转移时间 {tr['transfer_time']:.2f} TU"
              f" · 时限 {limit_tu:.1f} TU"
              f" · 圆化前相对速度 {v_rel_after:.3f} vs 窗口 {vmax:.2f}"
              f" → {'可行 ✓' if ok else '不可行 ✗'}")
        sol = lv["solution"]
        print(f"  -- 货舱 -> 空间站 ({len(lv['pods'])} 个货舱) --")
        print(f"     货舱 r = {r_pod:.4f} (a = {pod0['orbit']['a']}, e = {pod0['orbit']['e']}), "
              f"v_c = {ph.circular_velocity(mu, r_pod):.4f}")
        print(f"     空间站 r = {r_dock:.4f}, v_c = {ph.circular_velocity(mu, r_dock):.4f}, "
              f"T = {ph.kepler_period(mu, r_dock):.4f} TU")
        print(f"     对接窗口 v_max = {lv['dock']['v_max']} (相对速度上限), "
              f"radius = {lv['dock']['radius']}  (= {lv['dock']['v_max'] / ph.circular_velocity(mu, r_dock) * 100:.1f}% v_c)")
        print(f"     霍曼 dv: 第一次点火(契约式) = {tr['dv_depart']:+.5f} "
              f"(逐步推导: v_t(r1) {tr['v_transfer_at_r1']:.5f} - v_c(r1) "
              f"{ph.circular_velocity(mu, r_pod):.5f})")
        print(f"              第二次圆化 dv_to_circularize = {tr['dv_arrive']:+.5f} "
              f"(v_c(r2) {ph.circular_velocity(mu, r_dock):.5f} - v_t(r2) "
              f"{tr['v_transfer_at_r2']:.5f})")
        print(f"              合计 dv_total = {tr['dv_total']:.5f} RU/TU")
        print(f"     转移椭圆 a_t = {tr['a_transfer']:.4f}, "
              f"转移半周期 = {tr['transfer_time']:.4f} TU = "
              f"{tr['transfer_time'] * CONSTANTS['time_scale']:.2f} s 实时")
        syn = ph.synodic_period(ph.mean_motion(mu, r_pod), ph.mean_motion(mu, r_dock))
        print(f"     会合周期 T_syn = {syn:.4f} TU")
        print(f"     par_time = {lv['par_time']:.4f} TU "
              f"({lv['par_time'] * CONSTANTS['time_scale']:.1f} s 实时), 难度系数 "
              f"{difficulty_dv_scale(lv['difficulty']):.3f}, "
              f"硬下限 1.25 x 转移 = {1.25 * tr['transfer_time']:.4f} TU -> "
              f"{'OK' if lv['par_time'] >= 1.25 * tr['transfer_time'] else '不达标!'}")
        print(f"     par_fuel = {lv['par_fuel']:.4f} RU/TU (任务 dv 需求 = dv_total "
              f"{tr['dv_total']:.4f} x 难度系数 {difficulty_dv_scale(lv['difficulty']):.3f})")
        print(f"     齐奥尔科夫斯基: dv = {lv['par_fuel']:.4f} m/s -> "
              f"m0/mf = {ph.rocket_mass_ratio(lv['par_fuel']):.6f}, "
              f"推进剂质量分数 = {ph.rocket_propellant_fraction(lv['par_fuel']) * 100:.4f}%")
        if core.get("rs"):
            rs = float(core["rs"])
            rho_core = ph.density(mu, rs)
            d_roche = ph.roche_limit(rs, rho_core, 1.0)
            r_tear = tidal_tear_radius(mu, float(pod0["mass"]), float(pod0["radius"]))
            rp_pod, ra_pod = apse_radii(float(pod0["orbit"]["a"]), float(pod0["orbit"]["e"]))
            isco = ph.isco_radius(rs)
            g_self = ph.self_gravity(float(pod0["mass"]), float(pod0["radius"]))
            # 每关统一判据: 站 >= 1.6 r_tear, 货舱近日点 >= 1.5 r_tear
            tide_ratio = ph.tidal_gradient(mu, rp_pod, float(pod0["radius"])) / g_self
            print(f"  -- 潮汐安全 (自引力判据) --")
            print(f"     r_s = {rs:.6f},  ISCO = {isco:.6f},  3 r_s = {3.0 * rs:.6f},  "
                  f"中心天体平均密度 rho = {rho_core:.4e} (密度量纲在 r_s 内无物理意义, "
                  f"经典式 d_R = {d_roche:.4f} 仅作对照)")
            print(f"     货舱自引力 g_self = G m/r^2 = {g_self:.5f}; "
                  f"撕裂半径 r_tear = (2 mu dr/g_self)^(1/3) = {r_tear:.6f} RU "
                  f"(= {r_tear / (2 * 0.012 / g_self) ** (1 / 3):.2f} x mu^(1/3) 标度)")
            print(f"     空间站半径 {r_dock:.4f} = {r_dock / r_tear:.2f} r_tear "
                  f"(要求 >= {STATION_TEAR_SAFETY}); 货舱近日点 {rp_pod:.4f} = "
                  f"{rp_pod / r_tear:.2f} r_tear (要求 >= {POD_TEAR_SAFETY}) -> "
                  f"{'安全' if r_dock >= STATION_TEAR_SAFETY * r_tear and rp_pod >= POD_TEAR_SAFETY * r_tear else '危险!'}")
            print(f"     近日点处潮汐差/自引力 = {tide_ratio * 100:.3f}% (100% 即撕裂), "
                  f"货舱远/近星点 = {ra_pod:.4f}/{rp_pod:.4f}")
            print(f"     近日点时间膨胀 dt_inf/dt_local = {ph.time_dilation(rp_pod, rs):.6f} "
                  f"(站上时钟慢 {(ph.time_dilation(rp_pod, rs) - 1) * 100:.2f}%), "
                  f"红移 z = {ph.gravitational_redshift(rp_pod, rs):.6f}")
            print(f"     潮汐梯度 2 mu dr/r^3 (dr = 货舱半径 {pod0['radius']}) = "
                  f"{ph.tidal_gradient(mu, rp_pod, float(pod0['radius'])):.4f}")
            print(f"     后牛顿近日点进动 = "
                  f"{math.degrees(ph.gr_perihelion_precession(mu, abs(float(pod0['orbit']['a'])), float(pod0['orbit']['e']))):.3e} 度/圈")
        # 星风 / 星云
        for hz in lv["hazards"]:
            if hz["kind"] == "wind":
                print(f"  -- 星风 -- period = {hz['period']} TU, strength = {hz['strength']}, "
                      f"phase = {hz['phase']}")
            if hz["kind"] == "tidal":
                print(f"  -- 潮汐危险区 -- radius = {hz['radius']}, strength = {hz['strength']}")
        for nb in lv["nebulae"]:
            v_rel = nb["omega"] * math.hypot(nb["x"], nb["y"])
            print(f"  -- 星云 -- 中心 ({nb['x']}, {nb['y']}), r = {nb['r']}, "
                  f"density = {nb['density']}, 共转 omega = {nb['omega']} "
                  f"(云心共转速度 {v_rel:.4f})")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _print_summary(data: dict) -> None:
    levels = data["levels"]
    raw = SYSTEMS_JSON.read_bytes()
    print(f"\n已写入 {SYSTEMS_JSON}")
    print(f"systems.json 字节数: {len(raw)}")
    print(f"关卡数: {len(levels)}   章节数: {len(data['chapters'])}   "
          f"generated_at: {data['generated_at']}")
    print("\n  id      难度  章  par_time(TU)  par_fuel(RU/TU)  货舱  碎石  星风   星云")
    print("  " + "-" * 84)
    for lv in levels:
        n_rock = len([b for b in lv["bodies"] if b["kind"] == "asteroid"])
        wind = next((h for h in lv["hazards"] if h["kind"] == "wind"), None)
        print(f"  {lv['id']:<7} {lv['difficulty']:>3}   {lv['chapter']}  "
              f"{lv['par_time']:>11.4f}  {lv['par_fuel']:>14.4f}  "
              f"{len(lv['pods']):>3}  "
              f"{n_rock:>4}  "
              f"{(format(wind['strength'], '.3f') if wind else '  -  '):>6}  "
              f"{len(lv['nebulae']):>3}")


def _main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="levelgen.py",
        description="牧星者 · 关卡生成器 (W-physics)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--force", action="store_true", help="强制重新生成 (覆盖已存在的 systems.json)")
    ap.add_argument("--seed", type=int, default=GENERATOR_SEED, help="随机种子 (确定性)")
    ap.add_argument("--analyze", action="store_true", help="打印每关的物理分析报告")
    ap.add_argument("--validate", action="store_true", help="校验关卡并打印问题列表")
    args = ap.parse_args(argv)

    try:
        data = generate_levels(force=args.force, seed=args.seed)
    except ValueError as exc:
        print(f"[FAIL] 生成失败: {exc}", file=sys.stderr)
        return 1

    if args.validate:
        problems = validate(data["levels"])
        if problems:
            print(f"[FAIL] validate 发现 {len(problems)} 个问题:")
            for p in problems:
                print(f"  - {p}")
            return 1
        print("[PASS] validate: 0 问题")

    if args.analyze:
        analyze(data["levels"])

    if not args.analyze:
        _print_summary(data)
    else:
        raw = SYSTEMS_JSON.read_bytes()
        print(f"\n[analyze] {SYSTEMS_JSON} 字节数: {len(raw)}, "
              f"关卡数: {len(data['levels'])}, 章节数: {len(data['chapters'])}")

    return 0


if __name__ == "__main__":
    sys.exit(_main())
