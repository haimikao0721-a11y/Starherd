"""host.py — 《牧星者》任务控制中心宿主（W-host）。

契约：docs/INTERFACES.md §1（MissionControl API）与 §2（HTTP + WebSocket 协议）。

单端口（默认 8760 起，占用则 +1 递增，最多试 20 个）同时提供：
  * HTTP 静态：`/`→web/index.html、`/app.js`→dist/app.js、`/styles.css`→web/styles.css、
    `/assets/<sub>/<file>`→assets/ 下真实文件（正确 MIME + `Cache-Control: no-cache`）
  * HTTP API：`/api/health|manifest|levels|save|result|telemetry|selftest|quit`
  * WebSocket：`/ws`（aiohttp，同端口，多连接）

静态文件缺失一律 404（绝不 500）；素材/关卡数据缺失时先尝试调用 W-assets / W-physics 的
生成器，仍失败则使用内置最小回退数据并在日志里明确警告，保证页面不白屏。
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import mimetypes
import os
import re
import sys
import tempfile
import webbrowser
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

# **顶层静态导入**：`music_render` 原先只在请求处理函数里 import，
# PyInstaller 冻结后该模块没被打进包 → /api/music 返回空 → 游戏里"背景音乐下载"整块消失
# （开发模式正常、打包后失效的典型问题）。放顶层后分析阶段必然收集到。
try:
    import music_render  # noqa: F401
except Exception:  # noqa: BLE001
    music_render = None  # type: ignore[assignment]
from typing import Any, Callable, Optional

from aiohttp import WSMsgType, web

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import paths  # noqa: E402
import save as save_mod  # noqa: E402

VERSION = "1.3.1"
LOG = logging.getLogger("lagrange.host")

TITLE = "牧星者 / STARHERD"
HOST = "127.0.0.1"
PORT_ATTEMPTS = 20
ASSET_BASE = "/assets/"

#: welcome.config 默认值（会被 systems.json 的 constants 覆盖）
DEFAULT_CONFIG = {
    "time_scale": 1.6,
    "phys_hz": 120,
    "epsilon": 0.02,
    "isp": 320.0,
    "g0": 9.80665,
    "autotest": False,
    "vsync": True,
    "max_substeps": 8,
}

_CONFIG_KEYS = ("time_scale", "epsilon", "isp", "g0")

_EXTRA_MIME = {
    ".js": ("text/javascript", "utf-8"),
    ".mjs": ("text/javascript", "utf-8"),
    ".css": ("text/css", "utf-8"),
    ".html": ("text/html", "utf-8"),
    ".htm": ("text/html", "utf-8"),
    ".json": ("application/json", "utf-8"),
    ".map": ("application/json", "utf-8"),
    ".svg": ("image/svg+xml", "utf-8"),
    ".txt": ("text/plain", "utf-8"),
    ".png": ("image/png", None),
    ".gif": ("image/gif", None),
    ".jpg": ("image/jpeg", None),
    ".jpeg": ("image/jpeg", None),
    ".webp": ("image/webp", None),
    ".ico": ("image/x-icon", None),
    ".wav": ("audio/wav", None),
    ".ogg": ("audio/ogg", None),
    ".mp3": ("audio/mpeg", None),
    ".m4a": ("audio/mp4", None),
    ".woff2": ("font/woff2", None),
    ".wasm": ("application/wasm", None),
}

_TRUTHY = ("1", "true", "yes", "on", "y")


# --------------------------------------------------------------------------- 小工具

def _iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _json(payload: Any, status: int = 200) -> web.Response:
    text = json.dumps(payload, ensure_ascii=False)
    return web.Response(body=text.encode("utf-8"), status=status,
                        content_type="application/json", charset="utf-8",
                        headers={"Cache-Control": "no-cache"})


def _read_json_file(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        LOG.warning("读取 JSON 失败 %s：%r", path, exc)
        return None


def _mime_for(path: Path) -> tuple[str, Optional[str]]:
    ext = path.suffix.lower()
    if ext in _EXTRA_MIME:
        return _EXTRA_MIME[ext]
    guessed, _ = mimetypes.guess_type(str(path))
    if guessed:
        if guessed.startswith("text/") or guessed in ("application/json", "image/svg+xml"):
            return guessed, "utf-8"
        return guessed, None
    return "application/octet-stream", None


def hohmann_dv(mu: float, r1: float, r2: float) -> float:
    """霍曼转移总 Δv（双脉冲，教科书写法；physics_ref 不可用时用于回退 par 估算）。"""
    if r1 <= 0 or r2 <= 0 or mu <= 0:
        return 0.0
    a_t = 0.5 * (r1 + r2)
    dv1 = math.sqrt(mu / r1) * (math.sqrt(2.0 * r2 / (r1 + r2)) - 1.0)
    dv2 = math.sqrt(mu / r2) * (1.0 - math.sqrt(2.0 * r1 / (r1 + r2)))
    return abs(dv1) + abs(dv2)


# --------------------------------------------------------------------------- 内置回退数据

def fallback_systems() -> dict:
    """最小可玩回退关卡：1 恒星 + 1 空间站 + 1 货舱（满足 INTERFACES §3 全部约定）。

    par_time / par_fuel 由真实公式估算（霍曼转移时间 + 齐奥尔科夫斯基反解），不是写死常数。
    """
    mu = 1.0
    isp, g0, time_scale = 320.0, 9.80665, 1.6
    a_station, a_pod, bounds = 1.55, 1.9, 6.0

    a_t = 0.5 * (a_pod + a_station)
    t_transfer = math.pi * math.sqrt(a_t ** 3 / mu)          # 半个转移椭圆周期（TU）
    par_time = t_transfer * time_scale * 1.15                # 秒，留 15% 操作余量
    dv_min = hohmann_dv(mu, a_pod, a_station)                # 归一化单位 Δv
    v_exhaust = 0.4                                          # 归一化有效排气速度
    par_fuel = 1.0 - math.exp(-dv_min / v_exhaust)           # 火箭方程反解

    return {
        "version": "1.0",
        "generated_at": _iso_now(),
        "generator": "host.py:fallback_systems（内置回退数据）",
        "constants": {"G": 1.0, "mu_star": mu, "epsilon": 0.02,
                      "time_scale": time_scale, "isp": isp, "g0": g0},
        "chapters": [
            {"index": 1, "name_zh": "双星摇篮", "name_en": "Binary Cradle",
             "palette": "loop1", "music": "loop1", "desc_zh": "单恒星教学：对接、慢动作、燃料概念（回退数据）"},
            {"index": 2, "name_zh": "碎石带", "name_en": "Debris Belt",
             "palette": "loop2", "music": "loop2", "desc_zh": "小行星带、星风脉冲与星云气动刹车（回退数据）"},
            {"index": 3, "name_zh": "双星共振", "name_en": "Binary Resonance",
             "palette": "loop3", "music": "loop3", "desc_zh": "双星系统、L4/L5 稳定岛与混沌轨道（回退数据）"},
            {"index": 4, "name_zh": "深渊视界", "name_en": "Abyss Horizon",
             "palette": "loop4", "music": "loop4", "desc_zh": "黑洞、洛希撕裂与后牛顿进动（回退数据）"},
        ],
        "levels": [
            {
                "id": "L1-1", "index": 1, "chapter": 1,
                "name_zh": "首次接触", "name_en": "First Contact",
                "difficulty": 1, "mu_star": mu, "bounds": bounds,
                "camera": {"x": 0.0, "y": 0.0, "zoom": 1.0},
                "bodies": [
                    {"id": "star", "kind": "star", "mass": 1.0, "radius": 0.16, "orbit": None,
                     "tint": 0, "tag": "主序星"},
                    {"id": "stationA", "kind": "station", "mass": 0.00004, "radius": 0.03,
                     "orbit": {"a": a_station, "e": 0.0, "omega": 0.0, "M0": 2.1},
                     "tint": 2, "tag": "中继站"},
                ],
                "pods": [
                    {"id": "p1", "mass": 0.00002, "radius": 0.012, "hull": 1.0, "sail": 0.7,
                     "orbit": {"a": a_pod, "e": 0.0, "omega": 0.0, "M0": 1.2}},
                ],
                "dock": {"body": "stationA", "offset": {"x": 0.0, "y": 0.0},
                         "radius": 0.09, "v_max": 0.09},
                "hazards": [],
                "nebulae": [],
                "par_time": round(par_time, 3),
                "par_fuel": round(par_fuel, 4),
                "hint_zh": "按住左键把货舱拉出原轨道，接近空间站时松开让惯性完成对接",
                "hint_en": "Hold LMB to pull the pod out of orbit, release near the station and let inertia dock it",
                "solution": {"method": "hohmann", "dv_min": round(dv_min, 4),
                             "notes": "内置回退关卡（W-assets / W-physics 产物缺失）："
                                      f"r={a_pod}→{a_station}，转移时间 {t_transfer:.3f} TU，"
                                      f"Δv_min={dv_min:.4f}"},
            }
        ],
    }


def fallback_manifest() -> dict:
    """空 manifest（W-assets 尚未产出时使用）：结构合法但不含任何素材条目。"""
    return {
        "version": "1.0",
        "generator": "host.py:fallback_manifest（内置回退数据）",
        "seed": 0,
        "generated_at": _iso_now(),
        "audio": [],
        "art": [],
        "music": [],
        "total_bytes": 0,
    }


def _fallback_hint(levels: dict, level_id: Optional[str]) -> Optional[str]:
    items = levels.get("levels") if isinstance(levels, dict) else None
    if not isinstance(items, list) or not items:
        return None
    chosen = None
    for item in items:
        if isinstance(item, dict) and level_id and item.get("id") == level_id:
            chosen = item
            break
    if chosen is None:
        chosen = items[0] if isinstance(items[0], dict) else None
    if not chosen:
        return None
    return chosen.get("hint_zh") or chosen.get("hint_en")


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in _TRUTHY


# --------------------------------------------------------------------------- 宿主

class MissionControl:
    """HTTP 静态 + API + WebSocket 同端口的宿主进程。"""

    def __init__(self, port: int = 8760, mode: str = "window", root: Optional[Path] = None,
                 on_client_ready: Optional[Callable] = None,
                 on_quit: Optional[Callable] = None) -> None:
        self.base_port = int(port) if int(port) > 0 else 8760
        self.port = 0
        self.mode = str(mode or "window")
        self.root = Path(root) if root else None
        self._on_client_ready = on_client_ready
        self._on_quit = on_quit

        self._app: Optional[web.Application] = None
        self._runner: Optional[web.AppRunner] = None
        self._site: Optional[web.TCPSite] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._clients: set[web.WebSocketResponse] = set()
        self._tasks: set[asyncio.Task] = set()

        self._started_at = time.time()
        self._state: Optional[dict] = None
        self._levels: Optional[dict] = None
        self._levels_fallback = False
        self._manifest: Optional[dict] = None
        self._manifest_fallback = False
        self._assets_ok = False
        self._assets_bad_files: list[str] = []
        self._assets_checked_mtime: float | None = None
        self._last_telemetry: Optional[dict] = None
        self._last_verdict: Optional[dict] = None
        self._selftest_report: Optional[dict] = None
        self._stopped = False
        self._quit_requested = False

        self.quit_flag = threading.Event()
        self.quit_event: Optional[asyncio.Event] = None

        # 心跳阈值（契约：10 s 无消息 ping，30 s 无响应断开）；可用环境变量覆盖以便自动化测试
        self.ping_interval = _env_float("LAGRANGE_PING_INTERVAL", 10.0)
        self.ping_timeout = _env_float("LAGRANGE_PING_TIMEOUT", 30.0)

        self.backend = _detect_backend()

    # ---------------------------------------------------------------- 路径

    def _root(self) -> Path:
        return self.root if self.root else paths.app_root()

    def _web_dir(self) -> Path:
        return self._root() / "web"

    def _dist_dir(self) -> Path:
        return self._root() / "dist"

    def _assets_dir(self) -> Path:
        return self._root() / "assets"

    def _systems_path(self) -> Path:
        return self._assets_dir() / "data" / "systems.json"

    def _manifest_path(self) -> Path:
        return self._assets_dir() / "data" / "manifest.json"

    # ---------------------------------------------------------------- 属性

    @property
    def url(self) -> str:
        return f"http://{HOST}:{self.port}/"

    @property
    def state(self) -> dict:
        if self._state is None:
            self._state = save_mod.load_state()
        return self._state

    @property
    def levels(self) -> dict:
        return self._get_levels()

    @property
    def manifest(self) -> dict:
        return self._get_manifest()

    def set_backend(self, name: str) -> None:
        """由 mission_control / window.py 汇报实际生效的显示后端。"""
        if name:
            self.backend = str(name)

    def set_on_quit(self, cb: Optional[Callable]) -> None:
        self._on_quit = cb

    # ---------------------------------------------------------------- 数据装载

    def _ensure_data_files(self) -> None:
        """缺失的系统数据：先请 W-assets / W-physics 生成，失败则记警告（回退数据兜底）。"""
        need_manifest = not self._manifest_path().is_file()
        need_systems = not self._systems_path().is_file()
        if not need_manifest and not need_systems:
            return

        if need_manifest:
            try:
                import assets_gen  # type: ignore
                assets_gen.generate_all()
            except Exception as exc:  # noqa: BLE001
                LOG.warning("assets_gen 不可用（%r），将使用内置回退 manifest", exc)
        if need_systems:
            try:
                import levelgen  # type: ignore
                levelgen.generate_levels()
            except Exception as exc:  # noqa: BLE001
                LOG.warning("levelgen 不可用（%r），将使用内置回退关卡", exc)

    def _load_levels(self) -> None:
        data = _read_json_file(self._systems_path())
        if isinstance(data, dict) and isinstance(data.get("levels"), list) and data["levels"]:
            self._levels = data
            self._levels_fallback = False
        else:
            if not self._levels_fallback:
                LOG.warning("assets/data/systems.json 缺失或非法 → 使用内置最小回退关卡（1 恒星+1 空间站+1 货舱）")
            self._levels = fallback_systems()
            self._levels_fallback = True

    def _load_manifest(self) -> None:
        data = _read_json_file(self._manifest_path())
        if isinstance(data, dict) and any(isinstance(data.get(k), list) for k in ("audio", "art", "music")):
            self._manifest = data
            self._manifest_fallback = False
        else:
            if not self._manifest_fallback:
                LOG.warning("assets/data/manifest.json 缺失或非法 → 使用内置空 manifest")
            self._manifest = fallback_manifest()
            self._manifest_fallback = True

    def _get_levels(self) -> dict:
        if self._levels is None or (self._levels_fallback and self._systems_path().is_file()):
            self._load_levels()
        return self._levels or fallback_systems()

    def _get_manifest(self) -> dict:
        if self._manifest is None or (self._manifest_fallback and self._manifest_path().is_file()):
            self._load_manifest()
        return self._manifest or fallback_manifest()

    def _manifest_mtime(self) -> float:
        try:
            return self._manifest_path().stat().st_mtime
        except OSError:
            return 0.0

    def _assets_ok_now(self) -> bool:
        """素材完好性按 manifest 的 mtime 缓存：manifest 变了才重新校验（sha256 不便宜）。"""
        mtime = self._manifest_mtime()
        if self._assets_checked_mtime is None or mtime != self._assets_checked_mtime:
            self._assets_ok = self._compute_assets_ok()
            self._assets_checked_mtime = mtime
        return bool(self._assets_ok)

    def _compute_assets_ok(self) -> bool:
        """素材完好性：优先用 W-assets 的 verify_manifest()，否则自行抽查 manifest 列出的文件。"""
        # 冻结环境不要走 assets_gen 这条路：它是**构建期**模块，按源码树的相对路径校验素材，
        # 在 PyInstaller 解包目录里必然失配，会让打包版一直报 assets_ok=false（实际素材是好的）。
        import sys as _sys
        if not getattr(_sys, "frozen", False):
            try:
                import assets_gen  # type: ignore
                ok, bad = assets_gen.verify_manifest()
                self._assets_bad_files = list(bad or [])
                return bool(ok)
            except Exception:  # noqa: BLE001
                pass

        manifest = self._get_manifest()
        missing: list[str] = []
        total = 0
        for key in ("audio", "art", "music"):
            for entry in manifest.get(key) or []:
                if not isinstance(entry, dict):
                    continue
                rel = entry.get("file")
                if not isinstance(rel, str) or not rel:
                    continue
                total += 1
                if not (self._assets_dir() / rel).is_file():
                    missing.append(rel)
        self._assets_bad_files = missing
        return bool(total) and not missing

    def _music_index(self) -> list[dict]:
        """manifest.music → welcome.music_index（只保留契约字段 name/file/bpm）。"""
        out: list[dict] = []
        for entry in (self._get_manifest().get("music") or []):
            if not isinstance(entry, dict):
                continue
            out.append({"name": entry.get("name"), "file": entry.get("file"),
                        "bpm": entry.get("bpm")})
        return out

    # ---------------------------------------------------------------- 生命周期

    async def start(self) -> int:
        """起服务，返回实际端口（占用则 +1 递增，最多试 20 个）。"""
        self._loop = asyncio.get_running_loop()
        if self.quit_event is None:
            self.quit_event = asyncio.Event()
        self._started_at = time.time()
        self._stopped = False

        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._prepare_data)

        self._app = self._build_app()
        last_err: Optional[BaseException] = None
        for offset in range(PORT_ATTEMPTS):
            candidate = self.base_port + offset
            runner = web.AppRunner(self._app, access_log=None)
            await runner.setup()
            site = web.TCPSite(runner, HOST, candidate)
            try:
                await site.start()
            except OSError as exc:
                last_err = exc
                try:
                    await runner.cleanup()
                except Exception:  # noqa: BLE001
                    pass
                continue
            self._runner, self._site, self.port = runner, site, candidate
            break

        if not self.port:
            raise RuntimeError(
                f"无法在 {self.base_port}..{self.base_port + PORT_ATTEMPTS - 1} 范围内绑定端口：{last_err!r}")

        self._write_runtime()
        LOG.info("Mission Control 已启动：%s（模式 %s，后端 %s）", self.url, self.mode, self.backend)
        if self._levels_fallback:
            LOG.warning("当前使用内置回退关卡数据（W-physics 的 systems.json 不可用）")
        if self._manifest_fallback:
            LOG.warning("当前使用内置空 manifest（W-assets 的 manifest.json 不可用）")
        if not self._assets_ok:
            LOG.warning("素材校验未通过（assets_ok=false，缺失 %d 个文件）", len(self._assets_bad_files))
        return self.port

    def _prepare_data(self) -> None:
        self._ensure_data_files()
        self._load_levels()
        self._load_manifest()
        self._assets_ok = self._compute_assets_ok()
        self._assets_checked_mtime = self._manifest_mtime()
        if self._state is None:
            self._state = save_mod.load_state()

    async def stop(self) -> None:
        """干净关闭：取消后台任务 → 关 WS → 释放端口 → 清除 runtime.json。"""
        if self._stopped:
            return
        self._stopped = True

        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

        for ws in list(self._clients):
            try:
                await ws.close(code=1001, message=b"server shutdown")
            except Exception:  # noqa: BLE001
                pass
        self._clients.clear()

        if self._runner is not None:
            try:
                await self._runner.cleanup()      # 关闭 TCPSite 并释放端口
            except Exception as exc:  # noqa: BLE001
                LOG.warning("关闭 HTTP 服务时出错：%r", exc)
        self._runner = None
        self._site = None

        self._remove_runtime()
        LOG.info("Mission Control 已停止（端口 %s 已释放）", self.port)

    def cleanup_runtime(self) -> None:
        """非 asyncio 上下文里的兜底清理（进程即将退出时删除 runtime.json）。"""
        try:
            self._remove_runtime()
        except Exception:  # noqa: BLE001
            pass

    # ---------------------------------------------------------------- runtime.json

    def _write_runtime(self) -> None:
        payload = {"port": self.port, "pid": os.getpid(), "url": self.url,
                   "started": _iso_now(), "mode": self.mode, "backend": self.backend}
        try:
            path = paths.runtime_path()
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError as exc:
            LOG.warning("写入 runtime.json 失败：%r", exc)

    def _remove_runtime(self) -> None:
        path = paths.runtime_path()
        try:
            if not path.is_file():
                return
            data = _read_json_file(path)
            if isinstance(data, dict) and data.get("pid") not in (None, os.getpid()):
                return  # 属于另一个实例，不动它
            path.unlink()
        except OSError as exc:
            LOG.warning("删除 runtime.json 失败：%r", exc)

    # ---------------------------------------------------------------- 路由

    def _build_app(self) -> web.Application:
        app = web.Application(client_max_size=64 * 1024 * 1024)
        app.router.add_get("/", self._h_index)
        app.router.add_get("/index.html", self._h_index)
        app.router.add_get("/app.js", self._h_app_js)
        app.router.add_get("/styles.css", self._h_styles)
        app.router.add_get("/favicon.ico", self._h_favicon)
        app.router.add_get(r"/assets/{tail:.*}", self._h_asset)
        app.router.add_get("/api/health", self._h_health)
        # 打开外部链接（游戏内「关于本作」的仓库/主页/Star 按钮）：交给系统默认浏览器，
        # 这样 WebView 自身不会导航走（否则游戏页面会被替换掉）
        app.router.add_post("/api/open", self._h_open_post)
        app.router.add_get("/api/manifest", self._h_manifest)
        app.router.add_get("/api/levels", self._h_levels)
        # 背景音乐下载（只服务 EXE / 网页模式：离线单文件没有宿主，因此天然没有这个入口）
        app.router.add_get("/api/music", self._h_music_list)
        app.router.add_get(r"/api/music/{sid}.wav", self._h_music_wav)
        app.router.add_get("/api/save", self._h_save_get)
        app.router.add_post("/api/save", self._h_save_post)
        app.router.add_post("/api/result", self._h_result_post)
        app.router.add_post("/api/telemetry", self._h_telemetry_post)
        app.router.add_get("/api/selftest", self._h_selftest_get)
        app.router.add_post("/api/selftest", self._h_selftest_post)
        app.router.add_post("/api/quit", self._h_quit_post)
        app.router.add_get("/ws", self._h_ws)
        app.router.add_route("*", "/{tail:.*}", self._h_notfound)
        return app

    # ---------------------------------------------------------------- 打开外部链接

    async def _h_open_post(self, req: web.Request) -> web.Response:
        """用系统默认浏览器打开一个 https 链接（只允许 https，禁止本地/内网地址）。"""
        try:
            body = await req.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"error": "bad json"}, status=400)
        url = str((body or {}).get("url", "")).strip()
        if len(url) > 512 or not re.match(r"^https://[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+$", url):
            return web.json_response({"error": "only https allowed"}, status=400)
        try:
            host = (urlsplit(url).hostname or "").lower()
        except Exception:  # noqa: BLE001
            host = ""
        if not host or host in ("localhost", "127.0.0.1", "::1") or host.endswith((".local", ".internal")):
            return web.json_response({"error": "host not allowed"}, status=400)
        try:
            webbrowser.open(url)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("打开链接失败 %s: %r", url, exc)
            return web.json_response({"ok": False, "error": "open failed"}, status=500)
        LOG.info("已在默认浏览器打开：%s", url)
        return web.json_response({"ok": True, "url": url})

    # ---------------------------------------------------------------- 背景音乐下载

    async def _h_music_list(self, req: web.Request) -> web.Response:
        """列出可下载的背景音乐（谱面 → 离线渲染成 WAV，缓存到临时目录）。"""
        try:
            import music_render
            tracks = music_render.list_scores()
        except Exception as exc:  # noqa: BLE001
            LOG.warning("music_render 不可用: %r", exc)
            return web.json_response({"tracks": []})
        for t in tracks:
            t["url"] = f"/api/music/{t['id']}.wav"
        return web.json_response({"tracks": tracks, "available": True})

    async def _h_music_wav(self, req: web.Request) -> web.Response:
        """按需渲染某一首为 WAV 并下载（首次约 10 秒，之后走缓存）。"""
        sid = str(req.match_info.get("sid", ""))
        if not re.fullmatch(r"[a-z0-9_]{1,16}", sid):
            return web.json_response({"error": "bad id"}, status=400)
        src = self._assets_dir() / "audio" / f"music_{sid}.json"
        if not src.exists():
            return web.json_response({"error": "not found"}, status=404)
        cache = Path(tempfile.gettempdir()) / "lc_music_cache"
        dst = cache / f"Starherd_{sid}.wav"
        loop = asyncio.get_running_loop()
        try:
            if not dst.exists():
                import music_render
                await loop.run_in_executor(None, lambda: music_render.render_one(sid, cache))
            data = await loop.run_in_executor(None, dst.read_bytes)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("渲染音乐失败 %s: %r", sid, exc)
            return web.json_response({"error": "render failed"}, status=500)
        return web.Response(
            body=data, content_type="audio/wav",
            headers={"Content-Disposition": f'attachment; filename="{dst.name}"'},
        )

    # ---------------------------------------------------------------- 静态

    async def _read_static(self, path: Path) -> Optional[web.Response]:
        try:
            data = await asyncio.get_running_loop().run_in_executor(None, path.read_bytes)
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError, PermissionError, OSError):
            return None
        ctype, charset = _mime_for(path)
        return web.Response(body=data, content_type=ctype, charset=charset,
                            headers={"Cache-Control": "no-cache"})

    def _not_found(self, what: str) -> web.Response:
        return web.Response(
            status=404, content_type="text/html", charset="utf-8",
            headers={"Cache-Control": "no-cache"},
            text=("<html><head><meta charset=\"utf-8\"><title>404</title></head>"
                  f"<body style=\"background:#05070f;color:#7f8ea3;font-family:monospace\">"
                  f"<h1>404</h1><p>{what}</p>"
                  "<p>宿主已在运行，但该资源尚未生成（可能由其他并行工作者负责）。</p>"
                  "</body></html>"))

    async def _h_index(self, request: web.Request) -> web.Response:
        resp = await self._read_static(self._web_dir() / "index.html")
        return resp or self._not_found("web/index.html 尚未生成")

    async def _h_app_js(self, request: web.Request) -> web.Response:
        resp = await self._read_static(self._dist_dir() / "app.js")
        return resp or self._not_found("dist/app.js 尚未构建")

    async def _h_styles(self, request: web.Request) -> web.Response:
        resp = await self._read_static(self._web_dir() / "styles.css")
        return resp or self._not_found("web/styles.css 尚未生成")

    async def _h_favicon(self, request: web.Request) -> web.Response:
        resp = await self._read_static(self._web_dir() / "favicon.ico")
        if resp is None:
            resp = await self._read_static(self._assets_dir() / "art" / "spark.png")
        return resp or web.Response(status=404, headers={"Cache-Control": "no-cache"})

    async def _h_asset(self, request: web.Request) -> web.Response:
        tail = request.match_info.get("tail", "")
        base = self._assets_dir()
        if not tail or "\\" in tail or tail.startswith("/"):
            return self._not_found("非法素材路径")
        parts = [p for p in tail.split("/") if p]
        if not parts or any(p in (".", "..") for p in parts) or ":" in parts[0]:
            return self._not_found("非法素材路径")
        target = base.joinpath(*parts)
        try:
            resolved = target.resolve()
            base_resolved = base.resolve()
        except OSError:
            return self._not_found(f"素材不存在：{tail}")
        if base_resolved != resolved and base_resolved not in resolved.parents:
            return self._not_found("素材路径越界")
        if not resolved.is_file():
            return self._not_found(f"素材不存在：{tail}")
        resp = await self._read_static(resolved)
        return resp or self._not_found(f"素材不可读：{tail}")

    async def _h_notfound(self, request: web.Request) -> web.Response:
        if request.path.startswith("/api/"):
            return _json({"ok": False, "error": "not found", "path": request.path}, 404)
        return self._not_found(f"未知路径：{request.path}")

    # ---------------------------------------------------------------- API

    async def _h_health(self, request: web.Request) -> web.Response:
        return _json({
            "ok": True,
            "version": VERSION,
            "pid": os.getpid(),
            "port": self.port,
            "mode": self.mode,
            "backend": self.backend,
            "uptime": round(time.time() - self._started_at, 3),
            "assets_ok": self._assets_ok_now(),
        })

    async def _h_manifest(self, request: web.Request) -> web.Response:
        return _json(self._get_manifest())

    async def _h_levels(self, request: web.Request) -> web.Response:
        return _json(self._get_levels())

    async def _h_save_get(self, request: web.Request) -> web.Response:
        return _json(self.state)

    async def _h_save_post(self, request: web.Request) -> web.Response:
        body = await self._read_body(request)
        if body is None:
            return _json({"ok": False, "error": "请求体必须是 JSON 对象"}, 400)
        try:
            save_mod.write_state(body)
        except OSError as exc:
            LOG.error("写存档失败：%r", exc)
            return _json({"ok": False, "error": f"写存档失败：{exc!r}"}, 500)
        self._state = save_mod.load_state()
        return _json({"ok": True})

    async def _h_result_post(self, request: web.Request) -> web.Response:
        body = await self._read_body(request)
        if body is None:
            return _json({"ok": False, "error": "请求体必须是 JSON 对象"}, 400)
        verdict = self._apply_result(body)
        await self._broadcast_async(verdict)
        return _json(verdict)

    async def _h_telemetry_post(self, request: web.Request) -> web.Response:
        body = await self._read_body(request)
        if body is None:
            return _json({"ok": False, "error": "请求体必须是 JSON 对象"}, 400)
        self._last_telemetry = body
        return _json({"ok": True})

    async def _h_selftest_post(self, request: web.Request) -> web.Response:
        body = await self._read_body(request)
        if body is None:
            body = {}
        self._selftest_report = body
        try:
            paths.selftest_path().write_text(
                json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError as exc:
            LOG.error("写 selftest.json 失败：%r", exc)
            return _json({"ok": False, "error": f"写 selftest.json 失败：{exc!r}"}, 500)
        return _json({"ok": True})

    async def _h_selftest_get(self, request: web.Request) -> web.Response:
        report = self._selftest_report
        if report is None:
            report = _read_json_file(paths.selftest_path())
        if not isinstance(report, dict):
            return _json({"ok": False})
        return _json(report)

    async def _h_quit_post(self, request: web.Request) -> web.Response:
        loop = asyncio.get_running_loop()
        loop.call_later(0.15, lambda: asyncio.ensure_future(self._request_quit()))
        return _json({"ok": True})

    async def _read_body(self, request: web.Request) -> Optional[dict]:
        try:
            body = await request.json()
        except Exception as exc:  # noqa: BLE001
            LOG.warning("解析请求体失败：%r", exc)
            return None
        return body if isinstance(body, dict) else None

    # ---------------------------------------------------------------- 结算

    def _grade_result(self, result: dict) -> dict:
        """调 physics_ref.grade_fidelity() 判级；失败回退 ("B", 0.7)。"""
        energy_drift = _as_float(result.get("energy_drift"), 0.0)
        angular_drift = _as_float(result.get("angular_drift"), 0.0)
        grade, fidelity = "B", 0.7
        try:
            import physics_ref  # type: ignore
            graded = physics_ref.grade_fidelity(energy_drift, angular_drift)
            if isinstance(graded, (tuple, list)) and len(graded) >= 2:
                grade = str(graded[0]).upper()
                fidelity = float(graded[1])
        except Exception as exc:  # noqa: BLE001
            LOG.warning("physics_ref.grade_fidelity 不可用（%r）→ 回退评级 B/0.7", exc)

        elapsed = _as_float(result.get("time"), 0.0)
        fuel = _as_float(result.get("fuel_used"), 0.0)
        par_time = _as_float(result.get("par_time"), 0.0)
        par_fuel = _as_float(result.get("par_fuel"), 0.0)
        par_ok = bool(par_time > 0 and par_fuel > 0 and elapsed <= par_time and fuel <= par_fuel)
        bonus = {"S": 40, "A": 20}.get(grade, 0)

        note = (f"能量漂移 {energy_drift:.3g}，角动量漂移 {angular_drift:.3g}，"
                f"保真度 {fidelity:.2f}（{grade}）")
        if result.get("success") is False:
            note += "；本局未达成对接目标"
        if not par_ok:
            note += "；未达 par 基准"

        return {
            "t": "verdict",
            "level_id": result.get("level_id"),
            "grade": grade,
            "energy_drift": energy_drift,
            "angular_drift": angular_drift,
            "fidelity": fidelity,
            "par_ok": par_ok,
            "note": note,
            "score_bonus": bonus,
        }

    def _apply_result(self, result: dict) -> dict:
        """判级 → 合并存档 → 落盘，返回 verdict。"""
        verdict = self._grade_result(result)
        self._last_verdict = verdict
        try:
            state = self._state if isinstance(self._state, dict) else save_mod.load_state()
            self._state = save_mod.merge_result(state, result, verdict)
            save_mod.write_state(self._state)
        except OSError as exc:
            LOG.error("结算落盘失败：%r", exc)
        return verdict

    # ---------------------------------------------------------------- WebSocket

    async def _h_ws(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=None, max_msg_size=8 * 1024 * 1024,
                                   autoping=True, compress=False)
        await ws.prepare(request)
        self._clients.add(ws)
        peer = request.remote or "?"
        LOG.info("WS 连接建立：%s（当前 %d 个连接）", peer, len(self._clients))

        autotest = self._query_autotest(request)
        last_rx = time.time()
        ping_sent = 0.0
        try:
            while True:
                try:
                    msg = await ws.receive(timeout=2.0)
                except asyncio.TimeoutError:
                    now = time.time()
                    if now - last_rx >= self.ping_timeout:
                        LOG.info("WS %s 超过 %.0fs 无响应，断开", peer, self.ping_timeout)
                        await ws.close(code=1001, message=b"heartbeat timeout")
                        break
                    if now - last_rx >= self.ping_interval and now - ping_sent >= self.ping_interval:
                        await ws.send_json({"t": "ping"})
                        ping_sent = now
                    continue
                except ConnectionResetError:
                    break

                if msg.type == WSMsgType.TEXT:
                    last_rx = time.time()
                    ping_sent = 0.0
                    try:
                        payload = json.loads(msg.data)
                    except ValueError:
                        LOG.warning("WS %s 收到非法 JSON，忽略", peer)
                        continue
                    if not isinstance(payload, dict):
                        continue
                    should_break = await self._on_ws_message(ws, payload, autotest)
                    if should_break:
                        break
                elif msg.type == WSMsgType.BINARY:
                    last_rx = time.time()
                    LOG.debug("WS %s 收到二进制帧（%d 字节），忽略", peer, len(msg.data or b""))
                elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED):
                    break
                elif msg.type == WSMsgType.ERROR:
                    LOG.warning("WS %s 错误：%r", peer, ws.exception())
                    break
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            LOG.warning("WS %s 处理异常：%r", peer, exc)
        finally:
            self._clients.discard(ws)
            try:
                if not ws.closed:
                    await ws.close()
            except Exception:  # noqa: BLE001
                pass
            LOG.info("WS 连接关闭：%s（剩余 %d 个连接）", peer, len(self._clients))
        return ws

    async def _on_ws_message(self, ws: web.WebSocketResponse, payload: dict, autotest: bool) -> bool:
        """处理一条客户端消息；返回 True 表示应关闭该连接。"""
        kind = payload.get("t")
        if kind == "hello":
            await ws.send_json(self._welcome_payload(autotest))
            state = self.state if isinstance(self._state, dict) else {}
            hint = _fallback_hint(self._get_levels(), (state or {}).get("last_level"))
            if hint:
                await ws.send_json({"t": "hint", "text": hint})
            try:
                if callable(self._on_client_ready):
                    try:
                        self._on_client_ready()
                    except TypeError:
                        self._on_client_ready(ws)
            except Exception as exc:  # noqa: BLE001
                LOG.warning("on_client_ready 回调异常：%r", exc)
            return False

        if kind == "result":
            verdict = self._apply_result(payload)
            await ws.send_json(verdict)
            return False

        if kind == "telemetry":
            self._last_telemetry = payload
            return False

        if kind == "save":
            # 契约 §2.1 未定义服务端对 save 的应答帧，这里只落盘，不回帧
            state = payload.get("state")
            if isinstance(state, dict):
                try:
                    save_mod.write_state(state)
                    self._state = save_mod.load_state()
                    LOG.info("WS 存档已写入：%s", paths.save_path())
                except OSError as exc:
                    LOG.error("WS 存档写入失败：%r", exc)
            return False

        if kind == "ping":
            await ws.send_json({"t": "pong", "client_time": payload.get("client_time")})
            return False

        if kind == "pong":
            return False

        if kind == "log":
            LOG.log(_log_level(payload.get("level")), "[client] %s %s", payload.get("msg"), payload.get("data") or "")
            return False

        if kind == "bye":
            await ws.send_json({"t": "shutdown"})
            await ws.close(code=1000, message=b"bye")
            return True

        LOG.debug("WS 未知消息类型：%r", kind)
        return False

    def _query_autotest(self, request: web.Request) -> bool:
        """autotest 从 URL 查询参数推断，其次环境变量（LAGRANGE_AUTOTEST / AUTOTEST）。"""
        raw = request.rel_url.query.get("autotest")
        if raw is not None and str(raw).strip() != "":
            return _truthy(raw)
        for name in ("LAGRANGE_AUTOTEST", "AUTOTEST"):
            value = os.environ.get(name)
            if value:
                return _truthy(value)
        return False

    def _welcome_payload(self, autotest: bool) -> dict:
        config = dict(DEFAULT_CONFIG)
        constants = (self._get_levels() or {}).get("constants")
        if isinstance(constants, dict):
            for key in _CONFIG_KEYS:
                if key in constants:
                    config[key] = constants[key]
        config["autotest"] = bool(autotest)
        settings = (self.state or {}).get("settings")
        if isinstance(settings, dict) and "vsync" in settings:
            config["vsync"] = bool(settings["vsync"])

        return {
            "t": "welcome",
            "version": VERSION,
            "mode": self.mode,
            "backend": self.backend,
            "server_time": time.time(),
            "port": self.port,
            "config": config,
            "levels": self._get_levels(),
            "manifest": self._get_manifest(),
            "music_index": self._music_index(),
            "save": self.state,
            "asset_base": ASSET_BASE,
        }

    # ---------------------------------------------------------------- 广播 / 退出

    async def _broadcast_async(self, obj: dict) -> int:
        sent = 0
        for ws in list(self._clients):
            try:
                await ws.send_json(obj)
                sent += 1
            except Exception:  # noqa: BLE001
                self._clients.discard(ws)
        return sent

    def broadcast(self, obj: dict) -> None:
        """向所有 WS 连接推送一条消息（线程安全；可在窗口关闭回调里调用）。"""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            asyncio.run_coroutine_threadsafe(self._broadcast_async(obj), loop)
        except RuntimeError:
            pass

    async def _request_quit(self) -> None:
        if self._quit_requested:
            return
        self._quit_requested = True
        LOG.info("收到退出请求，准备优雅关闭")
        if self.quit_event is not None:
            self.quit_event.set()
        self.quit_flag.set()
        if callable(self._on_quit):
            try:
                result = self._on_quit()
                if asyncio.iscoroutine(result):
                    await result
            except Exception as exc:  # noqa: BLE001
                LOG.warning("on_quit 回调异常：%r", exc)
        else:
            await self.stop()

    def request_quit(self) -> None:
        """线程安全的退出请求（窗口关闭等场景）。"""
        loop = self._loop
        if loop is None or loop.is_closed():
            self.quit_flag.set()
            return
        try:
            asyncio.run_coroutine_threadsafe(self._request_quit(), loop)
        except RuntimeError:
            self.quit_flag.set()

    def wait_quit(self, timeout: Optional[float] = None) -> bool:
        """同步等待退出（供窗口模式的非 asyncio 主线使用）。"""
        return self.quit_flag.wait(timeout)


# --------------------------------------------------------------------------- 模块级辅助

def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = float(raw)
        return value if value > 0 else default
    except ValueError:
        return default


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        if isinstance(value, bool) or value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _log_level(name: Any) -> int:
    table = {"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING,
             "warning": logging.WARNING, "error": logging.ERROR, "critical": logging.CRITICAL}
    return table.get(str(name or "info").lower(), logging.INFO)


def _detect_backend() -> str:
    """尽力探测当前显示后端（window.py 由 W-pack 提供，可能尚不存在）。"""
    try:
        import window  # type: ignore
        name = window.backend_name()
        if isinstance(name, str) and name:
            return name
    except Exception:  # noqa: BLE001
        pass
    return "browser"


__all__ = ["MissionControl", "VERSION", "DEFAULT_CONFIG", "fallback_systems", "fallback_manifest"]
