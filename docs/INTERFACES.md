# 接口冻结 v1.0（跨语言契约，勿擅自改）

所有并行工作以本文件为唯一契约。改契约＝改本文件＋通知集成方（主 Agent）。

## 0. 文件归属（禁止越界写别人的文件）

| 归属 | 文件 |
|---|---|
| **W-assets** | `python/png_writer.py` `python/wav_writer.py` `python/music_gen.py` `python/assets_gen.py` |
| **W-host** | `python/paths.py` `python/save.py` `python/host.py` `python/mission_control.py` |
| **W-pack** | `python/window.py` `python/build_exe.py` `python/selftest.py` `build_exe.bat` `启动游戏.bat` `启动网页版.bat` `LagrangeCourier.spec` |
| **W-physics** | `python/physics_ref.py` `python/levelgen.py` |
| **主 Agent** | `src/**` `web/**` `tools/**` `docs/**` `tsconfig.json` `package.json` |
| **只读** | `docs/DESIGN.md` `docs/INTERFACES.md` |

目录（已创建）：`python/ src/{engine,sim,render,audio,game,ui,net} web/ assets/{audio,art,data} dist/ docs/ tools/ build/`

---

## 1. Python 模块 API（冻结签名）

```python
# paths.py  (W-host)
def app_root() -> Path          # 开发态=项目根；frozen 态=sys._MEIPASS
def data_root() -> Path         # 可写目录：%LOCALAPPDATA%\Starherd
def assets_dir() -> Path        # app_root()/assets
def web_dir() -> Path           # app_root()/web
def dist_dir() -> Path          # app_root()/dist
def is_frozen() -> bool

# assets_gen.py  (W-assets)
def generate_all(force: bool = False, seed: int = 20260101) -> dict
    # 生成 assets/audio/*.wav, assets/art/*.png, assets/audio/music_*.json, assets/data/manifest.json
    # 返回 manifest dict；已存在且 force=False 时跳过（但 manifest 缺失则重建）
def verify_manifest() -> tuple[bool, list[str]]   # (ok, 不一致文件列表)

# levelgen.py  (W-physics)
def generate_levels(force: bool = False) -> dict   # 写 assets/data/systems.json，返回该 dict

# physics_ref.py  (W-physics)
def energy(state: dict) -> float
def angular_momentum(state: dict) -> float
def linear_momentum(state: dict) -> tuple[float, float]
def grade_fidelity(energy_drift: float, angular_drift: float) -> tuple[str, float]  # ("S", 1.0)
def hohmann_dv(mu: float, r1: float, r2: float) -> float
def circular_velocity(mu: float, r: float) -> float
def escape_velocity(mu: float, r: float) -> float
def kepler_period(mu: float, a: float) -> float
def roche_limit(r_primary: float, rho_primary: float, rho_secondary: float) -> float
def lagrange_points(m1: float, m2: float, r: float) -> dict  # {"L1":x,"L2":x,"L3":x,"L4":(x,y),"L5":(x,y)} 相对主星，副星在 +x 轴

# save.py  (W-host)
def default_state() -> dict
def load_state() -> dict
def write_state(state: dict) -> None
def merge_result(state: dict, result: dict, verdict: dict | None) -> dict  # 返回更新后的 state

# host.py  (W-host)
class MissionControl:
    def __init__(self, port: int = 8760, mode: str = "window", root: Path | None = None,
                 on_client_ready=None, on_quit=None) -> None
    async def start(self) -> int        # 返回实际端口（占用则 +1 递增，最多试 20 个）
    async def stop(self) -> None
    @property
    def url(self) -> str                # http://127.0.0.1:<port>/

# window.py  (W-pack)
def open_window(url: str, title: str = "牧星者 / STARHERD",
                width: int = 1600, height: int = 900, on_close=None) -> int
    # 优先 pywebview(EdgeChromium/WebView2)，失败回退 Edge/Chrome --app=，再失败回退默认浏览器
    # 阻塞直到窗口关闭，返回 0/1；on_close() 在窗口关闭时调用一次

def open_browser(url: str) -> bool      # 默认浏览器打开
def backend_name() -> str               # "pywebview" | "edge-app" | "chrome-app" | "browser"

# mission_control.py  (W-host, 入口)
# CLI: --web | --window | --dev | --regen | --port N | --no-browser | --assets-only
#      | --levels-only | --selftest | --print-url
# 默认(无参): 窗口模式（失败自动回退浏览器）
# 启动顺序: 校验/生成素材 → 生成关卡 → 起 HTTP+WS → 打印 URL → 开窗口 → 关窗即优雅退出
# 运行期把 {"port":p,"pid":os.getpid(),"url":u,"started":ts} 写入 data_root()/runtime.json
```

## 2. HTTP 接口（host.py 实现）

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/` | `web/index.html` |
| GET | `/app.js` `/styles.css` | `dist/app.js` `web/styles.css` |
| GET | `/assets/<sub>/<file>` | `assets/` 下真实文件（正确 MIME，`Cache-Control: no-cache`） |
| GET | `/api/health` | `{"ok":true,"version":"1.0.0","pid":123,"port":8760,"mode":"window","backend":"pywebview","uptime":12.3,"assets_ok":true}` |
| GET | `/api/manifest` | manifest.json 内容 |
| GET | `/api/levels` | systems.json 内容 |
| GET | `/api/save` | 存档 dict |
| POST | `/api/save` | body=存档 dict → `{"ok":true}` |
| POST | `/api/result` | body=result dict → verdict dict（同 WS `verdict`） |
| POST | `/api/telemetry` | body=telemetry dict → `{"ok":true}` |
| POST | `/api/selftest` | body=自检报告 → 落盘 `data_root()/selftest.json`，返回 `{"ok":true}` |
| GET | `/api/selftest` | 上次自检报告（无则 `{"ok":false}`） |
| POST | `/api/quit` | 优雅退出 → `{"ok":true}` |

WebSocket：`ws://127.0.0.1:<port>/ws`（同端口，aiohttp）

### 2.1 WS 协议（JSON 文本帧）

**客户端 → 服务端**
```jsonc
{"t":"hello","version":"1.0.0","mode":"web|window","ua":"..."}
{"t":"telemetry","level_id":"L1-1","sim_time":12.5,"body_count":42,
 "ke":0.512,"pe":-1.02,"energy":-0.508,"angular_momentum":1.31,"momentum":[0.001,-0.002]}
{"t":"result","level_id":"L1-1","success":true,"time":38.2,"fuel_used":0.19,"par_time":42.0,
 "par_fuel":0.22,"pods_total":3,"pods_delivered":3,"pods_lost":0,"score":812,
 "energy_drift":2.1e-6,"angular_drift":1.4e-6,"attempts":1}
{"t":"save","state":{...}}
{"t":"log","level":"warn","msg":"...","data":{}}
{"t":"bye"}
```

**服务端 → 客户端**
```jsonc
{"t":"welcome","version":"1.0.0","mode":"window","backend":"pywebview",
 "server_time":1767225600.0,"port":8760,
 "config":{"time_scale":1.6,"phys_hz":120,"epsilon":0.02,"isp":320.0,"g0":9.80665,
           "autotest":false,"vsync":true,"max_substeps":8},
 "levels":{"version":"1.0","constants":{...},"levels":[...]},
 "manifest":{...},"music_index":[{"name":"loop1","file":"audio/music_loop1.json","bpm":92}],
 "save":{...},"asset_base":"/assets/"}
{"t":"verdict","level_id":"L1-1","grade":"S","energy_drift":2.1e-6,"angular_drift":1.4e-6,
 "fidelity":1.0,"par_ok":true,"note":"能量漂移 2.1e-06，达到辛积分器理论精度","score_bonus":0}
{"t":"hint","text":"先让货舱进椭圆轨道，再在远星点点火减速"}
{"t":"pong","client_time":1767225600.0}
{"t":"shutdown"}
```
服务端 10 s 无消息发 `ping`，30 s 无响应关闭该连接。客户端 1 Hz 发 `telemetry`。

## 3. `assets/data/systems.json` schema（W-physics 产出，契约核心）

```jsonc
{
  "version": "1.0",
  "generated_at": "2026-01-01T00:00:00Z",
  "constants": {"G":1.0,"mu_star":1.0,"epsilon":0.02,"time_scale":1.6,"isp":320.0,"g0":9.80665},
  "chapters": [
    {"index":1,"name_zh":"双星摇篮","name_en":"Binary Cradle","palette":"loop1",
     "music":"loop1","desc_zh":"..."}
  ],
  "levels": [
    {
      "id":"L1-1","index":1,"chapter":1,"name_zh":"首次接触","name_en":"First Contact",
      "difficulty":1,"mu_star":1.0,"bounds":6.0,
      "camera":{"x":0.0,"y":0.0,"zoom":1.0},
      "bodies":[
        {"id":"star","kind":"star","mass":1.0,"radius":0.16,"orbit":null,"tint":0,"tag":"主序星"},
        {"id":"planetA","kind":"planet","mass":0.0008,"radius":0.045,
         "orbit":{"a":2.35,"e":0.03,"omega":0.0,"M0":0.7},"tint":1,"tag":"岩质行星"},
        {"id":"stationA","kind":"station","mass":0.00004,"radius":0.03,
         "orbit":{"a":1.55,"e":0.0,"omega":0.0,"M0":2.1},"tint":2,"tag":"中继站"}
      ],
      "pods":[
        {"id":"p1","mass":0.00002,"radius":0.012,"hull":1.0,"sail":0.7,
         "orbit":{"a":1.9,"e":0.06,"omega":0.4,"M0":1.2}}
      ],
      "dock":{"body":"stationA","offset":{"x":0.0,"y":0.0},"radius":0.09,"v_max":0.09},
      "hazards":[{"kind":"wind","period":14.0,"phase":0.0,"strength":0.0006,"tag":"星风"}],
      "nebulae":[{"x":1.2,"y":-0.8,"r":0.9,"density":0.02,"omega":0.35}],
      "par_time":42.0,"par_fuel":0.22,
      "hint_zh":"按住左键把货舱拉出原轨道，接近空间站时松开让惯性完成对接",
      "hint_en":"...",
      "solution":{"method":"hohmann","dv_min":0.0831,"notes":"r1→r2 霍曼转移 + 一次圆化"}
    }
  ]
}
```

**约定**
- `orbit`：以恒星为焦点的开普勒要素 `a`(半长轴) `e`(偏心率) `omega`(近日点幅角,弧度) `M0`(历元平近点角,弧度)。`null`＝静止于世界原点。
- 世界坐标：恒星在原点，`1 RU = 128 px`。`x` 右、`y` 下（与 canvas 一致）；轨道角 `M` 逆时针为负 y 方向。
- `kind` ∈ `star|planet|blackhole|asteroid|station|debris`
- `tint` 是配色索引 0..5，闭环到渲染调色板。
- 必须满足：`pods` 至少 1 个、`dock.body` 必须存在于 `bodies`、所有 `orbit.a < bounds`。
- 20 关 = 5 章（3+3+3+3+8）；`index` 与 `difficulty` 均为**连续唯一的 1..20**；`par_time`/`par_fuel` 必须由真实公式估算（不得写死常数）。
- 第 4 章允许 `kind:"blackhole"`，需额外字段 `"rs":0.03`（史瓦西半径）。
- 可选字段：`events`（随机事件）、`objectives`（多段航段，>1 时 HUD 与结算页显示航段）、`fuel_scale`（预算系数，只改预算不改物理）、`difficulty_label`（探针实测档位）。

## 4. `assets/data/manifest.json` schema（W-assets 产出）

```jsonc
{
  "version":"1.0","generator":"assets_gen.py","seed":20260101,"generated_at":"...",
  "audio":[{"name":"ui_click","file":"audio/ui_click.wav","bytes":15840,"seconds":0.18,
            "peak":0.82,"rate":44100,"channels":2,"sha256":"..."}],
  "art":[{"name":"glow_soft","file":"art/glow_soft.png","w":256,"h":256,"bytes":9124,"sha256":"..."}],
  "music":[{"name":"loop1","file":"audio/music_loop1.json","bpm":92,"bars":16,"beats_per_bar":4,
            "key":"A","mode":"aeolian","sha256":"..."}],
  "total_bytes":1234567
}
```
必需素材名（脚本/渲染按名索引，缺一不可）：
- audio：`ui_hover ui_click ui_back pulse_attract pulse_repel thruster_loop dock_success dock_fail tidal_tear impact_rock impact_hull wind_warning chapter_fanfare blackhole_rumble countdown ignition launch`
- art：`glow_soft glow_ring star_field nebula_loop1 nebula_loop2 nebula_loop3 nebula_loop4 grid_hex spark shard vignette lens_gradient ring_dock`
- music：`loop1 loop2 loop3 loop4 menu`

## 5. 音乐 JSON schema（W-assets 产出 → TS 音频引擎消费）

```jsonc
{"name":"loop1","bpm":92,"bars":16,"beats_per_bar":4,"key":"A","mode":"aeolian",
 "scale":[0,2,3,5,7,8,10],
 "sections":[{"start_bar":0,"name":"intro","intensity":0.2},
             {"start_bar":4,"name":"main","intensity":0.6},
             {"start_bar":12,"name":"outro","intensity":0.3}],
 "notes":[{"t":0.0,"dur":2.0,"midi":57,"vel":0.8,"track":"pad","intensity":0.2}]}
```
- `t`/`dur` 单位＝**拍**（不是秒），`midi` 为 MIDI 音高，`track` ∈ `pad|bass|arp|perc|lead`
- `intensity` ∈ 0..1：TS 只播放 `intensity <= 当前强度` 的音符 → 自适应配乐
- 时长 ≥ 32 拍，每章至少 4 个和弦变化

## 6. TypeScript 侧接口（主 Agent 冻结，详见 `src/sim/types.ts`）

```ts
// src/render/renderer.ts   (W-render)
export class Renderer {
  constructor(canvas: HTMLCanvasElement, opts: { assets: AssetStore; palette: Palette; quality: Quality })
  resize(w: number, h: number, dpr: number): void
  frame(world: World, alpha: number, dtReal: number, view: ViewState): void
  pushFx(ev: FxEvent): void
  setQuality(q: Partial<Quality>): void
  readonly stats: { fps: number; drawCalls: number; particles: number }
}
// src/audio/audio.ts      (W-audio)
export class AudioEngine {
  constructor(assets: AssetStore)
  async init(): Promise<void>          // 必须在用户手势后调用
  play(name: string, opts?: { gain?: number; rate?: number; pan?: number }): void
  loop(name: string, key: string, on: boolean, opts?: { gain?: number }): void
  setMusic(track: MusicScore | null): void
  setIntensity(x: number): void
  setMaster(gain: number): void
  setMuted(m: boolean): void
  duck(seconds: number): void
  readonly now: number                  // audio context time
}
// src/net/bridge.ts       (主 Agent)
export class Bridge { connect(url: string): Promise<Welcome>; send(msg: object): void; on(t: string, fn: (m: any) => void): void }
```

## 7. 验收命令（W-pack 负责）

```bash
python python/mission_control.py --assets-only      # 生成素材
python python/mission_control.py --levels-only      # 生成关卡
python python/mission_control.py --print-url --web  # 起服务打印 URL
python python/selftest.py                           # 无头浏览器 + WS 断言，退出码 0=通过
python python/build_exe.py                          # 产出 dist_exe/Starherd.exe
```
