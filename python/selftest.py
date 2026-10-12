#!/usr/bin/env python3
"""W-pack ／ 全自动端到端验收（STARHERD）

用法::

    python python/selftest.py                 # 起服务 → 无头浏览器跑 ?autotest=1 → 断言 → 收尾
    python python/selftest.py --port 8760
    python python/selftest.py --keep-open     # 跳过 /api/quit，保留服务供人工查看
    python python/selftest.py --no-shot       # 跳过浏览器渲染/截图断言

退出码：0 = 全部 PASS（SKIP 不算失败）；非 0 = 有 FAIL。

验收项
------
1. mission_control.py 存在（不存在时按 ``--wait-host`` 逻辑重试最多 60 s 后清晰 FAIL）
2. 子进程 stdout 出现 ``LAGRANGE_URL=`` 行
3. ``GET /api/health``  → ``ok:true``
4. ``GET /api/levels``  → 有 ``levels`` 且长度 ≥ 1
5. ``GET /api/manifest``→ 含 ``audio`` / ``art`` / ``music`` 三个键
6. 浏览器（优先 Playwright，否则无头 Edge/Chrome 截图）跑 ``?autotest=1``：
   无 ``Uncaught`` / ``Unhandled`` / ``Failed to load resource``（排除 favicon）等报错
7. 截图存在且 > 60 KB（真的渲染出内容），落到 ``docs/screenshots/selftest_desktop.png``
8. ``GET /api/selftest`` → ``ok:true``；未实现/无报告 → ``SKIP`` + 醒目警告（不算失败）
9. ``POST /api/quit`` → 子进程确认退出，临时文件清理
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# 常量 / 路径
# ---------------------------------------------------------------------------

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
HOST_SCRIPT = HERE / "mission_control.py"
SCREENSHOT_DIR = PROJECT_ROOT / "docs" / "screenshots"
SCREENSHOT_NAME = "selftest_desktop.png"
SCREENSHOT_MIN_BYTES = 60 * 1024  # > 60 KB

VIEW_W, VIEW_H = 1600, 900

EDGE_PATHS = (
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
)
CHROME_PATHS = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
)

ERROR_PATTERNS = ("uncaught", "unhandled", "failed to load resource", "[error:console", "net::err_")
IGNORE_PATTERNS = ("favicon",)

RESET, BOLD = "\033[0m", "\033[1m"
RED, GREEN, YELLOW, CYAN = "\033[31m", "\033[32m", "\033[33m", "\033[36m"


def _color_enabled() -> bool:
    if os.environ.get("NO_COLOR"):
        return False
    return sys.stdout.isatty() or os.environ.get("LAGRANGE_FORCE_COLOR", "") == "1"


def paint(text: str, color: str) -> str:
    return f"{color}{text}{RESET}" if _color_enabled() else text


def _safe_print(text: str) -> None:
    """宿主输出可能含控制台编码装不下的字符；打印失败不能影响抓 URL。"""
    try:
        print(text, flush=True)
    except Exception:
        try:
            sys.stdout.write(text.encode("ascii", "replace").decode("ascii") + "\n")
            sys.stdout.flush()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 结果收集
# ---------------------------------------------------------------------------


class Report:
    def __init__(self) -> None:
        self.items: list[tuple[str, str, str]] = []
        self._lock = threading.Lock()

    def _emit(self, status: str, name: str, detail: str = "", color: str = "") -> None:
        with self._lock:
            self.items.append((status, name, detail))
            head = paint(status, color) if color else status
            print(f"{head} {name}", flush=True)
            if detail:
                for line in str(detail).splitlines():
                    print(f"      {line}", flush=True)

    def passed(self, name: str, detail: str = "") -> None:
        self._emit("PASS", name, detail, GREEN)

    def failed(self, name: str, detail: str = "") -> None:
        self._emit("FAIL", name, detail, RED)

    def skipped(self, name: str, detail: str = "") -> None:
        self._emit("SKIP", name, detail, YELLOW)

    def warn(self, text: str) -> None:
        with self._lock:
            print(paint(f"!! WARNING: {text}", YELLOW), flush=True)

    def info(self, text: str) -> None:
        with self._lock:
            print(f"   {text}", flush=True)

    @property
    def failed_items(self) -> list[tuple[str, str, str]]:
        return [i for i in self.items if i[0] == "FAIL"]

    @property
    def skipped_items(self) -> list[tuple[str, str, str]]:
        return [i for i in self.items if i[0] == "SKIP"]


R = Report()


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------


def free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])
    finally:
        s.close()


def _reap_stale_tmpdirs(max_age_s: float = 6 * 3600) -> int:
    """清掉自己上次被强杀时留下的 lc_selftest_* 临时目录（>6h）。"""
    base = Path(tempfile.gettempdir())
    removed = 0
    try:
        entries = list(base.glob("lc_selftest_*"))
    except Exception:
        return 0
    now = time.time()
    for p in entries:
        try:
            if p.is_dir() and (now - p.stat().st_mtime) > max_age_s:
                shutil.rmtree(p, ignore_errors=True)
                removed += 1
        except Exception:
            continue
    return removed


def http_get(url: str, timeout: float = 10.0):
    """返回 (status, text)；连接失败返回 (None, 错误串)。"""
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read().decode("utf-8", "replace")
        except Exception:
            body = ""
        return exc.code, body
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"


def http_post(url: str, payload: dict | None = None, timeout: float = 10.0):
    data = json.dumps(payload if payload is not None else {}).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST", headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read().decode("utf-8", "replace")
        except Exception:
            body = ""
        return exc.code, body
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"


def http_json(url: str, timeout: float = 10.0):
    """返回 (status, obj_or_None, raw)。"""
    status, text = http_get(url, timeout=timeout)
    obj = None
    if text:
        try:
            obj = json.loads(text)
        except Exception:
            obj = None
    return status, obj, text


def find_browser(paths) -> str | None:
    for p in paths:
        if os.path.isfile(p):
            return p
    for name in ("msedge.exe", "chrome.exe"):
        found = shutil.which(name)
        if found:
            return found
    return None


_RUNTIME_PATH: Path | None = None


def runtime_json_path() -> Path | None:
    """契约 §1：宿主运行期把 {"port","pid","url","started"} 写到 data_root()/runtime.json。"""
    global _RUNTIME_PATH
    if _RUNTIME_PATH is not None:
        return _RUNTIME_PATH
    try:
        sys.path.insert(0, str(HERE))
        import paths  # type: ignore  # 只读使用 W-host 的路径契约模块

        _RUNTIME_PATH = Path(paths.runtime_path())
    except Exception:
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        root = Path(base) if base else Path.home() / "AppData" / "Local"
        _RUNTIME_PATH = root / "LagrangeCourier" / "runtime.json"
    return _RUNTIME_PATH


def read_runtime_json() -> dict:
    path = runtime_json_path()
    if path is None or not path.is_file():
        return {}
    try:
        obj = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return {}
    return obj if isinstance(obj, dict) else {}


def is_ignorable(line: str) -> bool:
    low = line.lower()
    return any(p in low for p in IGNORE_PATTERNS)


def is_error_line(line: str) -> bool:
    low = line.lower()
    return any(p in low for p in ERROR_PATTERNS)


def scan_error_lines(lines) -> list[str]:
    hits = []
    for line in lines:
        if not line:
            continue
        if is_error_line(line) and not is_ignorable(line):
            hits.append(line.strip())
    return hits


# 游戏自检报告（?autotest=1 → POST /api/selftest）的判别键
REPORT_MARKERS = ("checks", "errors", "world", "level_id", "score", "stamp", "results", "passed")


def _is_real_report(report) -> bool:
    """区分「host 的默认 {"ok":false}」与「游戏真的交了一份报告」。"""
    return isinstance(report, dict) and any(k in report for k in REPORT_MARKERS)


def _judge_selftest_report(report, st_status, st_raw: str, fresh: bool | None = None) -> tuple[str, str]:
    """返回 ("PASS"|"FAIL"|"SKIP", 说明)。

    ``fresh``：本次 ``?autotest=1`` 运行期间 ``data_root()/selftest.json`` 是否被重新写过。
    False 表示读到的是**上一轮遗留**的报告（例如 W-host 早先测接口时 POST 的那份），
    这种情况绝不能算通过，否则就是假绿。
    """
    if not _is_real_report(report):
        return (
            "SKIP",
            f"status={st_status} body={st_raw[:200]}\n"
            f"→ 游戏侧 ?autotest=1 尚未把报告 POST 到 /api/selftest（或 host.py 未实现该路由）。"
            f"本项按契约记 SKIP，不计失败。",
        )

    checks_raw = report.get("checks")
    checks = checks_raw if isinstance(checks_raw, list) else []
    errors_raw = report.get("errors")
    errors = [str(e) for e in errors_raw] if isinstance(errors_raw, list) else []
    failed = [c for c in checks if isinstance(c, dict) and c.get("ok") is not True]
    world = report.get("world") if isinstance(report.get("world"), dict) else {}
    if isinstance(checks_raw, list):
        summary = f"checks={len(checks)}（失败 {len(failed)}）"
    else:
        summary = f"checks={checks_raw!r}(非列表，无逐项明细)"
    summary += f" errors={len(errors) if isinstance(errors_raw, list) else errors_raw!r}"
    if world:
        summary += f" world={json.dumps(world, ensure_ascii=False)[:200]}"

    if fresh is False:
        return (
            "SKIP",
            f"{summary}\n报告文件 {report_snapshot()['path']} 在本次 ?autotest=1 运行期间**没有被更新**"
            f"（读到的是上一轮遗留内容）→ 本次自动化并没有产生新报告。\n"
            f"原始报告: {st_raw[:300]}",
        )

    if report.get("ok") is True and not failed:
        detail = ("本次运行新产出；" if fresh else "") + ("全部通过：" if checks else "") + summary
        return "PASS", detail

    lines = [summary]
    if report.get("ok") is not True:
        lines.append(f"报告 ok={report.get('ok')!r}")
    for c in failed[:20]:
        lines.append(f"  FAIL check: {c.get('name')} → {c.get('detail')}")
    if isinstance(errors_raw, list):
        for e in errors[:20]:
            lines.append(f"  error: {e}")
    lines.append(f"原始报告: {st_raw[:400]}")
    return "FAIL", "\n".join(lines)


def report_snapshot() -> dict:
    """``data_root()/selftest.json`` 的现状（用于判断报告是否本轮新产出）。"""
    rt = runtime_json_path()
    path = (rt.parent / "selftest.json") if rt else None
    if path is None:
        return {"path": "(未知)", "mtime": None, "size": None}
    try:
        st = path.stat()
        return {"path": str(path), "mtime": st.st_mtime, "size": st.st_size}
    except OSError:
        return {"path": str(path), "mtime": None, "size": None}


# ---------------------------------------------------------------------------
# 子进程管理（mission_control.py）
# ---------------------------------------------------------------------------


class HostProcess:
    """把宿主子进程的输出落到日志文件并实时 tail 它。

    用文件而非管道：``--keep-open`` 时 selftest 退出、管道读端关闭会让宿主写 stdout 报错，
    日志文件没有这个问题，同时仍能实时抓到 ``LAGRANGE_URL=``。
    """

    def __init__(self, script: Path, port: int, log_path: Path, extra_env: dict | None = None) -> None:
        self.script = script
        self.port = port
        self.log_path = log_path
        self.extra_env = extra_env or {}
        self.url: str | None = None
        self.url_source = "stdout"
        self.proc: subprocess.Popen | None = None
        self.lines: list[str] = []
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._tail_error: str | None = None
        self._offset = 0
        self._log_fh = None

    # -- 启动 ---------------------------------------------------------------
    def start(self) -> None:
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        if self.extra_env:
            env.update(self.extra_env)
        cmd = [
            sys.executable,
            str(self.script),
            "--dev",
            "--port",
            str(self.port),
            "--no-browser",
        ]
        R.info(f"启动宿主: {' '.join(cmd)}")
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self._log_fh = open(self.log_path, "w", encoding="utf-8", errors="replace")
        self.proc = subprocess.Popen(
            cmd,
            cwd=str(PROJECT_ROOT),
            stdout=self._log_fh,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            env=env,
        )
        threading.Thread(target=self._tail, daemon=True).start()

    def _tail(self) -> None:
        """按字节偏移增量读取日志（不用 tell()：文本迭代中 tell() 会抛 OSError）。"""
        while not self._stop.is_set():
            self._drain()
            if self.proc is not None and self.proc.poll() is not None:
                self._drain()
                return
            time.sleep(0.15)

    def _drain(self) -> None:
        try:
            with open(self.log_path, "rb") as fh:
                fh.seek(self._offset)
                chunk = fh.read()
        except FileNotFoundError:
            return
        except Exception as exc:
            with self._lock:
                if self._tail_error is None:
                    self._tail_error = f"{type(exc).__name__}: {exc}"
            return
        if not chunk:
            return
        cut = chunk.rfind(b"\n")
        if cut < 0:
            return  # 只有半行，等下一次
        usable = chunk[: cut + 1]
        self._offset += len(usable)
        for line in usable.decode("utf-8", "replace").splitlines():
            with self._lock:
                self.lines.append(line)
            if line.startswith("LAGRANGE_URL="):
                with self._lock:
                    if self.url is None:
                        self.url = line.split("=", 1)[1].strip()
            _safe_print(f"   [host] {line}")

    # -- 状态 ---------------------------------------------------------------
    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    @property
    def rc(self) -> int | None:
        return None if self.proc is None else self.proc.poll()

    def snapshot(self, n: int = 40) -> str:
        with self._lock:
            tail = self.lines[-n:]
            err = self._tail_error
        text = "\n".join(tail) if tail else "(无输出)"
        if err:
            text += f"\n[selftest] 读取宿主输出时出错: {err}"
        if self.log_path and self.log_path.is_file():
            text += f"\n[selftest] 宿主完整日志: {self.log_path}"
        return text

    def runtime_url(self) -> str | None:
        """兜底 URL 来源：data_root()/runtime.json（必须 pid 对得上，避免认错别人的服务）。"""
        obj = read_runtime_json()
        url = obj.get("url")
        if not isinstance(url, str) or not url.strip():
            return None
        mypid = self.proc.pid if self.proc is not None else None
        if obj.get("pid") == mypid:
            return url.strip()
        # 老宿主可能不写 pid：仅在端口吻合时接受，并明确标注
        if obj.get("pid") is None and obj.get("port") == self.port:
            return url.strip()
        return None

    def wait_url(self, deadline: float) -> str | None:
        while time.time() < deadline:
            with self._lock:
                if self.url:
                    return self.url
            # 兜底：runtime.json（与 stdout 抓取互为备份）
            rt = self.runtime_url()
            if rt:
                with self._lock:
                    self.url = rt
                    self.url_source = f"runtime.json ({runtime_json_path()})"
                return rt
            if not self.alive:
                break
            time.sleep(0.2)
        with self._lock:
            if self.url:
                return self.url
        return None

    # -- 收尾 ---------------------------------------------------------------
    def quit_via_api(self, timeout: float = 15.0) -> bool:
        if self.url is None:
            return False
        try:
            http_post(self.url.rstrip("/") + "/api/quit", {}, timeout=5.0)
        except Exception:
            pass
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not self.alive:
                return True
            time.sleep(0.25)
        return not self.alive

    def kill(self) -> None:
        self._stop.set()
        proc = self.proc
        if proc is None or proc.poll() is not None:
            self.close()
            return
        try:
            proc.terminate()
            proc.wait(timeout=6)
            return
        except Exception:
            pass
        try:
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            )
        except Exception:
            pass
        try:
            proc.kill()
        except Exception:
            pass

    def close(self) -> None:
        """关掉父进程持有的宿主日志句柄。

        Windows 上句柄未关时 shutil.rmtree 会删不掉日志文件，
        导致每次运行都在 %TEMP% 留一个 lc_selftest_* 目录。
        """
        fh = getattr(self, "_log_fh", None)
        if fh is not None:
            try:
                fh.close()
            except Exception:
                pass
            self._log_fh = None


# ---------------------------------------------------------------------------
# 浏览器渲染 / 截图
# ---------------------------------------------------------------------------


class BrowserRun:
    def __init__(self) -> None:
        self.backend = "none"
        self.error_lines: list[str] = []
        self.console_lines: list[str] = []
        self.shot_path: Path | None = None
        self.shot_bytes = 0
        self.note = ""


def _playwright_available() -> bool:
    try:
        import playwright.sync_api  # noqa: F401

        return True
    except Exception:
        return False


def _launch_pw_browser(pw, headed: bool, channel: str = "auto"):
    """按 bundled chromium → 系统 Edge → 系统 Chrome 的顺序启动 Playwright 浏览器。

    Playwright 包在、但浏览器内核没下载时，用 channel="msedge"/"chrome" 仍然能拿到
    完整的 Playwright 能力（rAF 真跑、能等自检报告、能截真图），
    比退化成 `--screenshot` 一次性截图强得多。
    """
    wants = [channel] if channel not in ("", "auto") else [None]
    if channel in ("", "auto"):
        wants += ["msedge", "chrome"]
    args = [
        "--autoplay-policy=no-user-gesture-required",
        "--hide-scrollbars",
        "--mute-audio",
        *([] if headed else ["--disable-gpu"]),
    ]
    last: Exception | None = None
    for ch in wants:
        try:
            browser = pw.chromium.launch(headless=not headed, channel=ch, args=args)
            return browser, (ch or "bundled-chromium")
        except Exception as exc:
            last = exc
            R.info(f"Playwright channel={ch or 'bundled'} 启动失败：{type(exc).__name__}: {exc}")
    raise last if last else RuntimeError("Playwright 无法启动任何浏览器")


def run_with_playwright(
    url: str,
    shot_path: Path,
    wait_ms: int,
    stop_flag,
    headed: bool = False,
    channel: str = "auto",
) -> BrowserRun:
    """Playwright（已安装时优先）。``headed=True`` 用有头窗口，rAF 一定在跑。"""
    from playwright.sync_api import sync_playwright

    run = BrowserRun()
    console: list[str] = []
    with sync_playwright() as pw:
        browser, used = _launch_pw_browser(pw, headed, channel)
        run.backend = f"playwright:{used}{'-headed' if headed else ''}"
        try:
            ctx = browser.new_context(
                viewport={"width": VIEW_W, "height": VIEW_H}, device_scale_factor=1
            )
            page = ctx.new_page()
            page.on(
                "console",
                lambda m: console.append(
                    f"[console.{m.type}] {m.text} @ {(m.location or {}).get('url', '')}"
                ),
            )
            page.on("pageerror", lambda e: console.append(f"[pageerror] {e}"))
            page.on(
                "requestfailed",
                lambda r: console.append(
                    f"[requestfailed] {r.url} {getattr(r, 'failure', None) or ''}"
                ),
            )
            page.goto(f"{url}?autotest=1", wait_until="load", timeout=60000)
            # 等 ?autotest=1 自检跑完（提前检测到报告就退出等待）
            deadline = time.time() + max(0.0, wait_ms / 1000.0)
            while time.time() < deadline:
                if stop_flag and stop_flag():
                    run.note = "检测到 /api/selftest 报告，提前结束等待"
                    break
                page.wait_for_timeout(500)
            shot_path.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(shot_path))
        finally:
            try:
                browser.close()
            except Exception:
                pass
    run.console_lines = console
    run.error_lines = scan_error_lines(console)
    _finalize_shot(run, shot_path)
    return run


def run_with_headless_browser(
    exe: str, url: str, shot_path: Path, wait_ms: int, tmpdir: Path
) -> BrowserRun:
    """回退：无头 Edge/Chrome 截图 + stderr 日志扫描。"""
    run = BrowserRun()
    run.backend = Path(exe).stem.lower()
    shot_path.parent.mkdir(parents=True, exist_ok=True)
    if shot_path.exists():
        try:
            shot_path.unlink()
        except Exception:
            pass
    user_data = tmpdir / "headless_profile"
    base = [
        exe,
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        f"--user-data-dir={user_data}",
        f"--window-size={VIEW_W},{VIEW_H}",
        f"--virtual-time-budget={int(wait_ms)}",
        f"--screenshot={shot_path}",
        "--enable-logging=stderr",
        "--v=1",
        f"{url}?autotest=1",
    ]
    rc, stderr_text = _run_capture(base, timeout=max(120.0, wait_ms / 1000.0 + 90.0))
    if not shot_path.exists() or shot_path.stat().st_size == 0:
        run.note = f"headless=new 未产出截图（rc={rc}），改用 --headless 重试"
        base[1] = "--headless"
        rc, stderr_text = _run_capture(base, timeout=max(120.0, wait_ms / 1000.0 + 90.0))
    lines = stderr_text.splitlines()
    run.console_lines = lines
    run.error_lines = scan_error_lines(lines)
    run.note = (run.note + f" rc={rc}").strip()
    _finalize_shot(run, shot_path)
    return run


def _finalize_shot(run: "BrowserRun", shot_path: Path) -> None:
    run.shot_path = shot_path
    try:
        run.shot_bytes = shot_path.stat().st_size if shot_path.is_file() else 0
    except OSError:
        run.shot_bytes = 0


def _run_capture(cmd: list[str], timeout: float) -> tuple[int | None, str]:
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except Exception as exc:
        return None, f"启动失败: {exc!r}"
    try:
        out, _ = proc.communicate(timeout=timeout)
        return proc.returncode, out or ""
    except subprocess.TimeoutExpired:
        try:
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            )
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        try:
            out, _ = proc.communicate(timeout=10)
        except Exception:
            out = ""
        return None, (out or "") + "\n[selftest] 无头浏览器超时被终止"
    finally:
        if proc.poll() is None:
            try:
                proc.kill()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="STARHERD 全自动端到端验收（W-pack）")
    ap.add_argument("--port", type=int, default=0, help="指定端口，0=随机空闲端口")
    ap.add_argument("--keep-open", action="store_true", help="跳过 /api/quit，保留服务供人工查看")
    ap.add_argument("--no-shot", action="store_true", help="跳过浏览器渲染与截图断言")
    ap.add_argument(
        "--wait-host",
        type=float,
        default=60.0,
        help="等待 mission_control.py 就绪并吐出 LAGRANGE_URL 的最长秒数（默认 60，0=不等）",
    )
    ap.add_argument(
        "--wait-ms",
        type=int,
        default=40000,
        help="?autotest=1 渲染等待毫秒数；无头回退直接用作 --virtual-time-budget（默认 40000）",
    )
    ap.add_argument(
        "--host-script",
        default=str(HOST_SCRIPT),
        help="宿主入口脚本路径（默认 python/mission_control.py，仅调试用）",
    )
    ap.add_argument(
        "--no-playwright", action="store_true", help="跳过 Playwright，强制走无头 Edge/Chrome 截图"
    )
    ap.add_argument(
        "--headed",
        action="store_true",
        help="Playwright 用有头窗口跑（rAF 一定在动；用于区分「游戏逻辑 bug」与「无头 rAF 被节流」）",
    )
    ap.add_argument("--show-console", type=int, default=0, help="额外打印前 N 行浏览器控制台输出")
    ap.add_argument(
        "--pw-channel",
        default="auto",
        help="Playwright 浏览器通道：auto|msedge|chrome|bundled-chromium（默认 auto 依次尝试）",
    )
    ap.add_argument(
        "--shot-dir", default=str(SCREENSHOT_DIR), help="截图输出目录（默认 docs/screenshots）"
    )
    return ap.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    t0 = time.time()
    host_script = Path(args.host_script).resolve()
    shot_dir = Path(args.shot_dir).resolve()
    shot_path = shot_dir / SCREENSHOT_NAME
    keep_open = bool(args.keep_open)

    print(paint("=" * 78, CYAN))
    print(paint("STARHERD ／ 全自动验收 (W-pack selftest)", BOLD))
    print(paint("=" * 78, CYAN))
    R.info(f"项目根: {PROJECT_ROOT}")
    R.info(f"宿主入口: {host_script}")
    R.info(f"Python: {sys.version.split()[0]} ({sys.executable})")

    host: HostProcess | None = None
    _reap_stale_tmpdirs()
    tmpdir = Path(tempfile.mkdtemp(prefix="lc_selftest_"))
    exit_code = 1
    try:
        # --- 1. 宿主脚本就绪（--wait-host 重试逻辑） ------------------------
        deadline = time.time() + max(0.0, args.wait_host)
        first_wait = True
        while not host_script.is_file():
            if time.time() >= deadline:
                break
            if first_wait:
                R.info(f"等待 {host_script.name} 出现（最多 {args.wait_host:.0f} s）…")
                first_wait = False
            time.sleep(2.0)
        if not host_script.is_file():
            R.failed(
                "宿主入口存在",
                f"找不到 {host_script}\n"
                f"→ W-host 尚未产出 mission_control.py；这是『宿主未就绪』，不是 selftest 脚本故障。\n"
                f"→ 等 W-host 落盘后重跑：python python\\selftest.py",
            )
            _summary(t0)
            return 1
        R.passed("宿主入口存在", str(host_script))

        # --- 2. 起服务，抓 LAGRANGE_URL -----------------------------------
        port = int(args.port) if args.port else free_port()
        R.info(f"端口: {port}")
        launched = False
        base_url = None
        url_deadline = time.time() + max(30.0, args.wait_host or 60.0)
        attempt = 0
        while time.time() < url_deadline and attempt < 3:
            attempt += 1
            host = HostProcess(host_script, port, tmpdir / f"host_attempt{attempt}.log")
            host.start()
            url = host.wait_url(url_deadline)
            if url:
                base_url = url.rstrip("/")
                launched = True
                break
            if host.alive:
                host.kill()
            R.info(f"第 {attempt} 次尝试未拿到 LAGRANGE_URL（宿主已退出 rc={host.rc}）")
            if time.time() < url_deadline:
                time.sleep(2.0)
        if not launched or host is None:
            R.failed(
                "宿主启动并打印 LAGRANGE_URL",
                "未在期限内从 stdout 抓到 `LAGRANGE_URL=` 行。宿主最后输出：\n"
                + (host.snapshot() if host else "(无)"),
            )
            _summary(t0)
            return 1
        R.passed(
            "宿主启动并打印 LAGRANGE_URL",
            f"LAGRANGE_URL={base_url} (第 {attempt} 次尝试，来源={host.url_source})",
        )

        # --- 3. HTTP 接口断言 ---------------------------------------------
        status, obj, raw = http_json(f"{base_url}/api/health")
        if status == 200 and isinstance(obj, dict) and obj.get("ok") is True:
            R.passed(
                "GET /api/health ok:true",
                f"version={obj.get('version')} mode={obj.get('mode')} backend={obj.get('backend')} "
                f"assets_ok={obj.get('assets_ok')}",
            )
        else:
            R.failed("GET /api/health ok:true", f"status={status} body={raw[:400]}")

        status, obj, raw = http_json(f"{base_url}/api/levels")
        levels = obj.get("levels") if isinstance(obj, dict) else None
        if status == 200 and isinstance(levels, list) and len(levels) >= 1:
            R.passed("GET /api/levels levels>=1", f"levels={len(levels)} 个")
            if len(levels) < 12:
                R.info(
                    f"注意：levels={len(levels)}，契约 §3 要求 12 关（4 章 × 3 关）；"
                    f"当前疑似 host 的内置回退关卡（W-physics 的 assets/data/systems.json 未就绪）"
                )
        else:
            R.failed(
                "GET /api/levels levels>=1",
                f"status={status} 解析结果={'有 levels' if isinstance(levels, list) else '无 levels 键'} "
                f"body={raw[:400]}",
            )

        status, obj, raw = http_json(f"{base_url}/api/manifest")
        if isinstance(obj, dict):
            missing = [k for k in ("audio", "art", "music") if k not in obj]
            if status == 200 and not missing:
                R.passed(
                    "GET /api/manifest 含 audio/art/music",
                    f"audio={len(obj.get('audio') or [])} art={len(obj.get('art') or [])} "
                    f"music={len(obj.get('music') or [])} total_bytes={obj.get('total_bytes')}",
                )
            else:
                R.failed(
                    "GET /api/manifest 含 audio/art/music",
                    f"status={status} 缺键={missing} body={raw[:400]}",
                )
        else:
            R.failed("GET /api/manifest 含 audio/art/music", f"status={status} body={raw[:400]}")

        # --- 4. 浏览器渲染 + 截图 ------------------------------------------
        base_report = None
        base_raw = None
        if not args.no_shot:
            base_report = report_snapshot()
            _st, _obj, base_raw = http_json(f"{base_url}/api/selftest", timeout=5.0)
            R.info(f"自检报告基线: {base_report['path']} mtime={base_report['mtime']} "
                   f"body={str(base_raw)[:80]}")
        if args.no_shot:
            R.skipped("无头浏览器无 JS 报错", "--no-shot：已跳过")
            R.skipped("截图存在且 > 60KB", "--no-shot：已跳过")
        else:
            run = _render_and_shoot(base_url, shot_path, args, tmpdir, base_report, base_raw)
            if run.shot_path and run.shot_path.exists():
                run.shot_bytes = run.shot_path.stat().st_size
            R.info(f"渲染后端: {run.backend} {('／ ' + run.note) if run.note else ''}")
            if args.show_console and run.console_lines:
                R.info(f"浏览器控制台前 {args.show_console} 行：")
                for line in run.console_lines[: args.show_console]:
                    R.info(f"  | {line}")
            if run.error_lines:
                R.failed(
                    f"无头浏览器无 JS 报错（{run.backend}）",
                    f"命中 {len(run.error_lines)} 行报错：\n" + "\n".join(run.error_lines[:30]),
                )
            else:
                R.passed(
                    f"无头浏览器无 JS 报错（{run.backend}）",
                    f"扫描 {len(run.console_lines)} 行日志，0 条 Uncaught/Unhandled/Failed to load resource",
                )
            if run.shot_bytes > SCREENSHOT_MIN_BYTES:
                R.passed(
                    "截图存在且 > 60KB",
                    f"{shot_path} = {run.shot_bytes} bytes "
                    f"({run.shot_bytes / 1024:.1f} KB)",
                )
            else:
                exists = bool(run.shot_path and run.shot_path.exists())
                why = (
                    "疑似纯色空页（前端未渲染出内容）"
                    if exists
                    else "截图未生成（浏览器没跑起来或没写出文件）"
                )
                R.failed(
                    "截图存在且 > 60KB",
                    f"{shot_path} = {run.shot_bytes} bytes ({run.shot_bytes / 1024:.1f} KB)，{why}",
                )

        # --- 5. /api/selftest（游戏自身 ?autotest=1 的报告） ---------------
        # 报告结构（主 Agent 冻结）：{"ok":bool,"checks":[{"name","ok","detail"}],
        #                             "errors":[str],"world":{...}}
        report = None
        st_status = None
        st_raw = ""
        for _ in range(16):  # 最多再等 8 s，容忍报告晚到
            st_status, report, st_raw = http_json(f"{base_url}/api/selftest")
            if _is_real_report(report) or st_status == 404:
                break
            time.sleep(0.5)
        fresh: bool | None = None
        if base_report is not None:
            after = report_snapshot()
            mtime_newer = bool(
                after.get("mtime") is not None
                and (base_report.get("mtime") is None or after["mtime"] > base_report["mtime"] + 1e-6)
            )
            content_changed = bool(st_raw) and st_raw != (base_raw or "")
            fresh = mtime_newer or content_changed
            R.info(f"报告新鲜度: 文件重写={mtime_newer} 内容变化={content_changed} → fresh={fresh}")
        status_kind, detail = _judge_selftest_report(report, st_status, st_raw, fresh)
        if status_kind != "PASS" and fresh is None:
            # --no-shot：本轮没跑浏览器，读到的报告必然是历史数据，不能据此判 FAIL
            status_kind = "SKIP"
            detail += "\n(--no-shot：未跑浏览器，报告必然是上一轮历史数据，故不计失败；" \
                      "要判定本次 ?autotest=1 是否真的通过，请不带 --no-shot 重跑)"
        if status_kind == "PASS":
            if fresh is None:
                detail += "（--no-shot：未跑浏览器，未做新鲜度校验，该报告可能来自上一轮）"
            R.passed("GET /api/selftest ok:true", detail)
        elif status_kind == "FAIL":
            R.failed("GET /api/selftest ok:true（游戏自检报告）", detail)
        else:
            R.skipped("GET /api/selftest ok:true", detail)
            R.warn(
                "后端/游戏自检报告缺失：/api/selftest 未返回 ok:true —— "
                "全自动通关验证尚未闭环，等前端 ?autotest=1 与 host.py 就绪后必须重跑。"
            )

        # --- 6. 收尾 -------------------------------------------------------
        if keep_open:
            R.skipped(
                "POST /api/quit 优雅退出",
                f"--keep-open：服务保留在 {base_url}（PID={host.proc.pid if host.proc else '?'}）",
            )
            kept = True
        else:
            ok_quit = host.quit_via_api()
            if ok_quit:
                R.passed("POST /api/quit 优雅退出", f"子进程已退出 rc={host.rc}")
            else:
                R.failed(
                    "POST /api/quit 优雅退出",
                    f"子进程未在 15 s 内退出（rc={host.rc}）；最后输出：\n{host.snapshot(15)}",
                )
            kept = False

        if not keep_open:
            exit_code = 1 if R.failed_items else 0
        else:
            exit_code = 1 if R.failed_items else 0
    finally:
        if host is not None:
            host.close()
            if not keep_open and host.alive:
                host.kill()
        if not keep_open:
            shutil.rmtree(tmpdir, ignore_errors=True)
        else:
            R.info(f"临时目录保留: {tmpdir}")

    _summary(t0)
    if exit_code == 0 and R.skipped_items:
        print(
            paint(
                f"注意：{len(R.skipped_items)} 项 SKIP（未实现），验收并未闭环。",
                YELLOW,
            )
        )
    return exit_code


def _render_and_shoot(
    base_url: str,
    shot_path: Path,
    args,
    tmpdir: Path,
    base_report: dict | None = None,
    base_raw: str | None = None,
) -> BrowserRun:
    """优先 Playwright，其次无头 Edge/Chrome 截图。"""

    def report_ready() -> bool:
        """本次运行是否已经产出**新**的自检报告（绝不拿上一轮遗留的报告提前退出等待）。"""
        try:
            mtime_newer = False
            if base_report is not None:
                after = report_snapshot()
                mtime_newer = bool(
                    after.get("mtime") is not None
                    and (
                        base_report.get("mtime") is None
                        or after["mtime"] > base_report["mtime"] + 1e-6
                    )
                )
            _, obj, raw = http_json(f"{base_url}/api/selftest", timeout=3.0)
            if not (isinstance(obj, dict) and obj.get("ok") is True):
                return False
            content_changed = bool(raw) and raw != (base_raw or "")
            return bool(mtime_newer or content_changed)
        except Exception:
            return False

    if not args.no_playwright and _playwright_available():
        try:
            return run_with_playwright(
                base_url,
                shot_path,
                args.wait_ms,
                report_ready,
                headed=args.headed,
                channel=args.pw_channel,
            )
        except Exception as exc:
            R.warn(f"Playwright 渲染失败（{type(exc).__name__}: {exc}）→ 回退无头 Edge/Chrome 截图")
    elif not args.no_playwright:
        R.info("Playwright 未安装 → 回退无头 Edge/Chrome 截图")

    exe = find_browser(EDGE_PATHS) or find_browser(CHROME_PATHS)
    if not exe:
        run = BrowserRun()
        run.note = "本机既无 Playwright 也无 Edge/Chrome，无法渲染"
        return run
    return run_with_headless_browser(exe, base_url, shot_path, args.wait_ms, tmpdir)


def _summary(t0: float) -> None:
    dt = time.time() - t0
    n_pass = sum(1 for i in R.items if i[0] == "PASS")
    n_fail = len(R.failed_items)
    n_skip = len(R.skipped_items)
    print(paint("-" * 78, CYAN))
    verdict = "PASS" if n_fail == 0 else "FAIL"
    color = GREEN if n_fail == 0 else RED
    print(
        paint(
            f"验收结论: {verdict}  (PASS={n_pass} FAIL={n_fail} SKIP={n_skip}, {dt:.1f}s)",
            color + BOLD,
        )
    )
    for status, name, detail in R.failed_items:
        print(paint(f"  FAIL {name}", RED))
        if detail:
            first = str(detail).splitlines()[0]
            print(f"       {first}")
    if n_skip:
        for _status, name, _detail in R.skipped_items:
            print(paint(f"  SKIP {name}", YELLOW))
    print(paint("-" * 78, CYAN))


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        print(paint("\nselftest 被中断", YELLOW))
        raise SystemExit(130)
