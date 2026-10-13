# 《牧星者 / STARHERD》设计圣经 v1.0（冻结）

> 一句话：**你不是射手，你是引力源。** 用真实的牛顿引力去搬运货物。
> 交互动词只有一个（鼠标拖动引力井），但由此涌现出的策略空间来自真实天体力学：
> 引力弹弓、霍曼转移、气动刹车、洛希极限撕裂、拉格朗日点驻留、火箭方程燃料预算。

作者：DSH Agent　｜　项目根：`C:\Users\a\Desktop\LagrangeCourier`

---

## 0. 交付形态（三种入口，同一份代码）

| 入口 | 命令 | 说明 |
|---|---|---|
| 桌面窗口（主推） | 双击 `Starherd.exe` | PyInstaller 单文件；pywebview/WebView2 原生窗口；无浏览器地址栏 |
| 网页模式 | 双击 `启动网页版.bat` / `python python/mission_control.py --web` | 本地 HTTP + WebSocket，浏览器打开 `http://127.0.0.1:PORT` |
| 开发模式 | `python python/mission_control.py --dev --regen` | 重新生成素材 + 起服务 + esbuild watch |

三种形态共用 `web/ dist/ assets/`，Python 是宿主（Mission Control），TypeScript 是仿真与渲染。

---

## 1. 单位制：归一化天文单位（canonical units）

真实公式与真实常数，但尺度归一到渲染友好的数量级（天体力学标准做法，`μ = G·M = 1`）：

- `G = 1`，恒星质量 `M★ = 1` → `μ★ = 1`
- 距离单位 `1 RU`，时间单位 `1 TU`；渲染 `1 RU = 128 px`（相机可缩放）
- 圆轨道速度 `v_c = √(μ/r)`，在 `r = 1` 处 `v_c = 1`
- 开普勒第三定律 `T = 2π√(a³/μ)`，在 `a = 1` 处 `T = 2π ≈ 6.283 TU`
- 时间映射 `1 TU = 1.6 s`（实时），即基准轨道周期约 10 s，肉眼可跟随
- 燃料：`Isp = 320 s`，`g0 = 9.80665 m/s²`（保留真实常数用于齐奥尔科夫斯基公式的展示）

> 代码里所有公式按真实形式书写，常数集中在 `src/sim/constants.ts`，便于审查。

---

## 2. 物理内核（全部为教科书公式，Python 端可独立复核）

实现于 `src/sim/`，TypeScript，固定步长积分。

| # | 现象 | 公式 | 用途 |
|---|---|---|---|
| 1 | 万有引力 | `a_i = Σ_j G·m_j·(r_j−r_i)/(|r|²+ε²)^{3/2}`（Plummer 软化 ε） | 一切运动 |
| 2 | 分层引力 | 主天体（≤14）互为 N 体；轻体（货舱/碎片/小行星）按测试粒子只感受主天体+引力井 | 物理正确且 O(N) |
| 3 | 辛积分器 | 速度 Verlet / KDK 蛙跳，`h = 1/120 TU` | 长期能量守恒 |
| 4 | 自适应子步 | 当任意 `r < 4ε` 或 `|v|·h > 0.4·r` 时把 h 二分（上限 8 级） | 近星点不炸 |
| 5 | 辐射压 | `a_rad = (L·Q_pr·A)/(4π·r²·c·m)`，代码中以 `k_rad·A/(r²·m)` 表示 | 光帆货舱被推离恒星 |
| 6 | 星风脉冲 | `Δv = (Φ·A/m)·(1/r²)·(t/τ)·e^{−t/τ}`，周期性爆发 | 定时把轨道吹歪 |
| 7 | 星云阻力 | `F_d = −½·ρ(r)·C_d·A·|v_rel|·v_rel`，星云以 `ω` 共转，`v_rel = v − ω×r` | 气动刹车（真实减速手段） |
| 8 | 洛希极限 | `d_R ≈ R_p·(2·ρ_p/ρ_s)^{1/3}` | 太近则潮汐撕裂成碎片 |
| 9 | 潮汐梯度 | `Δa = 2·G·M·Δr/r³` | 碎片拉伸、结构应力 |
| 10 | 碰撞合并 | 完全非弹性 `v' = (m₁v₁+m₂v₂)/(m₁+m₂)`；碎片弹开用恢复系数 `e = 0.55` | 动量守恒 |
| 11 | 引力井弹簧阻尼 | `M_w·ẍ = −k(x−x_mouse) − c·ẋ`，`ζ = c/(2√(k·M_w))` | 鼠标手感：拖一个"有重量"的天体 |
| 12 | 火箭方程 | `Δv = I_sp·g₀·ln(m₀/m_f)`，`ṁ = |F_thrust|/(I_sp·g₀)` | 燃料不是魔法：移动井所需的推力即消耗 |
| 13 | 解体阈值 | 对接需 `|v_rel| < v_max` 且 `r < r_dock`；撞击 `Δv > v_crit` 则货舱损毁 | 关卡目标与失败条件 |
| 14 | 角动量/能量审计 | `E = Σ½mv² − ΣΣ Gm_im_j/r`，`L = Σ m(r×v)` | Python 裁判打分（物理保真度） |
| 15 | 拉格朗日点 | `L1: r ≈ R·(m/(3M))^{1/3}`，`L4/L5` 与两天体成等边三角形 | 关卡设计（稳定停泊位） |
| 16 | 霍曼转移 | `Δv₁ = √(μ/r₁)(√(2r₂/(r₁+r₂)) − 1)` | Python 计算"标准答案"燃料基准 |
| 17 | 引力时间膨胀 | `Δt_∞ = Δt/√(1 − r_s/r)`（黑洞关卡时间流速可视化） | 视觉与节奏创意 |
| 18 | 广义相对论进动 | `a_GR = (G·M·h²)/(c²·r⁴)` 后牛顿修正项 | 黑洞关卡近日点进动（真实效应） |

**数值自检**：仿真每 1 s 向 Python 推送 `E`、`L`、`p` 快照，Python 用独立实现核对漂移，
输出保真度评级（S：`|ΔE/E| < 1e-5/s`，A：`<1e-4`，B：`<1e-3`，C：其余）。评级直接进总分。

---

## 3. 操作（鼠标为主，键盘辅助）

| 输入 | 行为 |
|---|---|
| **鼠标移动** | 引力井的**目标位置**（井通过弹簧阻尼追随，因此有惯性、有滞后、有重量感） |
| **鼠标左键按住** | 井通电（吸引）；松开则待机（质量归零，只保留探测器本体） |
| **鼠标右键按住** | 极性反转 → 斥力井（推开货物，用于紧急制动/防撞） |
| **鼠标滚轮** | 连续调节井质量 `M_w`（0.0005 → 0.05 M★） |
| **空格** | 时间膨胀 0.25×（慢动作），消耗"算力"槽，自动回复 |
| **1 / 2 / 3** | 质量预设：轻(精确) / 中(均衡) / 重(强引力，费燃料) |
| **Shift** | 精确模式：阻尼比 ζ→1.0（临界阻尼，跟手不甩尾） |
| **Tab** | 轨道预测：用同一积分器前推 6 s 的虚影轨迹（真实数值预测，非近似公式） |
| **G** | 引力场可视化：等势线（marching squares）+ 场向量箭头 |
| **F** | 惯性参考系：显示各天体速度矢量与轨道要素 |
| **R / Esc / M** | 重置关卡 / 暂停菜单 / 静音 |

---

## 4. 玩法循环与生命周期

### 4.1 单关循环（Loop）
`简报 → 布货 → 机动 → 对接 → 结算`。目标：把 N 个货舱送入空间站对接环，
在**燃料预算**与**限时**内完成；货舱自身脆弱（撞击/潮汐/星风/恒星都会毁掉它）。

### 4.2 章节循环（5 章 = 5 个 LOOP；第 5 章复用 loop3 调色板）
- **LOOP I 双星摇篮**：单恒星 + 2 行星，教学（对接、慢动作、燃料概念）
- **LOOP II 碎石带**：小行星带 + 星风脉冲 + 星云（气动刹车必修课）
- **LOOP III 双星共振**：双星系统，`L4/L5` 稳定岛，混沌轨道
- **LOOP IV 深渊视界**：黑洞，洛希撕裂，引力时间膨胀，后牛顿进动

### 4.3 进程生命周期（Process Lifecycle，Python 侧）
`spawn → 生成/校验素材(sha256) → 起 HTTP+WS → 选端口 → 开窗口/浏览器 → 心跳与遥测 → 存档 → 关窗即优雅退出（回收端口与子进程）`

### 4.4 游戏生命周期（TS 侧，有限状态机 + 场景栈）
`BOOT → PRELOAD → ATTRACT(演示) → MENU → BRIEFING → PLAY ⇄ PAUSE → DEBRIEF → CHAPTER → VICTORY/DEFEAT → SHUTDOWN`
每个场景实现 `enter/update/render/exit`；转场带淡入淡出；`SHUTDOWN` 会 flush 存档并关闭 WS。

### 4.5 多循环（并发循环体）
1. **渲染循环** `requestAnimationFrame`（带插值 alpha）
2. **物理循环** 固定步长 120 Hz 累加器（防死亡螺旋：单帧最多 6 步）
3. **音频循环** WebAudio 前瞻调度（25 ms lookahead，独立于 rAF）
4. **遥测循环** 1 Hz 向 Python 推送守恒量
5. **后台降级** `document.hidden` → 暂停物理与音频、停止遥测
6. **自检循环** `?autotest=1` 时以脚本化输入全自动跑完一关（供 EXE/网页自动化验收）

---

## 5. 计分

`总分 = 1000 × (0.35·时间 + 0.30·燃料效率 + 0.20·物理保真度 + 0.15·货舱存活率) × 难度系数 + 连击奖励`

- 时间：`par_time / 实际时间`（par 由 Python 用霍曼转移估算）
- 燃料：`par_fuel / 实际消耗`（par 来自火箭方程反解）
- 保真度：Python 裁判评级 S/A/B/C = 1.0/0.85/0.7/0.5
- 存活：`送达 / 总数`
- 存档：`%LOCALAPPDATA%\Starherd\save.json`（章节解锁、最佳分、设置）

---

## 6. 素材管线（Python 程序化生成，全是磁盘上的真文件）

`python/assets_gen.py` 用**纯标准库**（`zlib`+`struct`+`wave`+`math`+`array`）生成：

### 6.1 音频 `assets/audio/*.wav`（44.1 kHz / 16 bit / 立体声）
| 文件 | 合成方式 |
|---|---|
| `ui_hover / ui_click / ui_back` | 正弦+指数包络，短促 |
| `pulse_attract / pulse_repel` | 低频正弦扫频 + FM |
| `thruster_loop` | 白噪 + 单极低通 + 带通共振，可循环 |
| `dock_success` | 加法合成钟声（基频+泛音列，非谐比例） |
| `dock_fail` | 下扫方波 + 失真 |
| `tidal_tear` | 噪声爆发 + 下扫 + 颗粒化 |
| `impact_rock / impact_hull` | 噪声 + 阻尼正弦簇 |
| `wind_warning` | 三连警笛（真实警报警度比 3:5:3） |
| `chapter_fanfare` | 大三和弦琶音 + 混响尾（Schroeder 简易混响） |
| `blackhole_rumble` | 次低频 + 缓慢相位漂移 |
| `countdown / ignition` | 节拍脉冲 / 噪声上升 |
| `sfx_manifest.json` | 名称、时长、峰值、sha256 |

### 6.2 音乐 `assets/audio/music_*.json`
每章一首（共 8 首：5 章主题 + 风暴 / 救援 / 终章）：小节、和弦进行、琶音型、BPM、调式（Phrygian/Aeolian/Lydian/Dorian）。
Python 生成**谱面 JSON**，TS 用 WebAudio 合成器实时演奏（pad + bass + arp + 打击），
并随游戏强度（`intensity`）叠加声部 —— 生成式自适应配乐。

### 6.3 贴图 `assets/art/*.png`（纯标准库 PNG 编码器）
`glow_soft.png`(径向衰减)、`glow_ring.png`、`star_field.png`(幂律亮度分布)、
`nebula_*.png`(fBm 值噪声，4 种配色)、`grid_hex.png`、`spark.png`、`shard.png`、
`vignette.png`、`lens_gradient.png`。全部 8/16 位 RGBA，供 Canvas2D 以 `lighter` 叠加，
**避免 `shadowBlur`**（性能杀手），保证 60 fps。

### 6.4 数据 `assets/data/`
`systems.json`（20 关，含轨道六要素、拉格朗日点、par_time/par_fuel、配色、提示）、
`manifest.json`（全量素材 sha256 + 尺寸，供宿主校验）。

---

## 7. 视觉风格：深空霓虹 / Deep-Space Neon

- 背景：近黑蓝 `#05070f` + fBm 星云（紫/青）+ 三层视差星场
- 主色：货舱琥珀 `#ffb347`、空间站玉白 `#8ef7d0`、引力井品红 `#ff4fd8`、
  危险红 `#ff4d5e`、轨道青 `#59d9ff`、UI 灰 `#7f8ea3`
- 技法：加性发光、轨迹残影（低 alpha 衰减层）、屏幕震动（按冲量）、命中定格、
  色差分离、冲击波环、引力等势线（真实等势面）、速度矢量箭头、颗粒化撕裂
- HUD：等宽字体、细线、传感器风格；左上资源条（燃料/算力/时间），右上守恒量实时曲线（E、L 漂移）

---

## 8. 验收标准（Definition of Done）

1. `python python/mission_control.py --web` 起服务，浏览器可完整通关第一章
2. `Starherd.exe` 双击开原生窗口，鼠标拖动有惯性手感，60 fps（1600×900）
3. 20 关数据由 `levelgen.py` 生成，`physics_ref.py` 能独立复核守恒量并给出评级
4. `assets/audio` 与 `assets/art` 中每个文件都是真实可播放/可解码的素材（Python 生成）
5. `python python/selftest.py` 全自动：起服务 → 无头浏览器跑 `?autotest=1` → 断言通过
6. 无 JS 报错；`tsc --noEmit` 与 `esbuild` 构建零错误
