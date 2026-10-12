"""W-pack ／ 桌面窗口后端（STARHERD）

契约（docs/INTERFACES.md §1，冻结）::

    open_window(url, title="牧星者 / STARHERD",
                width=1600, height=900, on_close=None) -> int
    open_browser(url) -> bool
    backend_name() -> str   # "pywebview" | "edge-app" | "chrome-app" | "browser"

实现要点
--------
1. 优先 pywebview（EdgeChromium / WebView2 原生窗口，无地址栏）。
   任何异常（含 pythonnet / .NET 加载失败、WebView2 运行时缺失）都被捕获并回退。
2. 回退顺序：pywebview → Edge ``--app=<url>`` → Chrome ``--app=<url>`` → 默认浏览器。
   app 模式使用 ``subprocess.Popen`` + 独立临时 ``--user-data-dir``，窗口关闭即进程退出，
   ``wait()`` 之后才返回。
3. ``on_close()`` 在「窗口关闭 / 进程结束 / Ctrl+C / 进程退出」时**恰好调用一次**
   （线程安全 once 标志）。
4. Windows 高 DPI：``SetProcessDpiAwareness(1)``，失败静默忽略。
5. app 模式进程可被 ``terminate()``（必要时 ``taskkill /T /F``）杀干净，不留孤儿进程。

调试用环境变量（不影响正常路径）
--------------------------------
``LAGRANGE_FORCE_BACKEND``     : pywebview|edge-app|chrome-app|browser，从该级开始回退链。
``LAGRANGE_DISABLE_PYWEBVIEW`` : 1 = 让 pywebview 这一级必然失败（用于验证回退链）。
``LAGRANGE_WINDOW_NO_WAIT``    : 1 = 最后一级（默认浏览器）回退不阻塞等待 Ctrl+C。
"""

from __future__ import annotations

import ctypes
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser

__all__ = ["open_window", "open_browser", "backend_name", "enable_dpi_awareness"]

DEFAULT_TITLE = "牧星者 / STARHERD"
DEFAULT_WIDTH = 1600
DEFAULT_HEIGHT = 900
MIN_SIZE = (1024, 640)
BACKGROUND_COLOR = "#05070f"

IS_WINDOWS = sys.platform.startswith("win")

# ---------------------------------------------------------------------------
# 全局状态（线程安全）
# ---------------------------------------------------------------------------

_LOCK = threading.RLock()
_LAST_BACKEND: str | None = None
_ACTIVE_PROC: subprocess.Popen | None = None
_ACTIVE_WIN = None  # 当前 pywebview 窗口（供 close_window() 从其它线程销毁）
_LAST_RC = 1

EDGE_PATHS = (
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
)
CHROME_PATHS = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
)


def _log(msg: str) -> None:
    print(f"[window] {msg}", flush=True)


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------


def enable_dpi_awareness() -> bool:
    """Windows 高 DPI 感知；任何失败都静默忽略。"""
    if not IS_WINDOWS:
        return False
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)  # PROCESS_SYSTEM_DPI_AWARE
        return True
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
        return True
    except Exception:
        return False


class _Once:
    """线程安全的「恰好一次」回调包装。"""

    def __init__(self, fn=None) -> None:
        self._fn = fn
        self._lock = threading.Lock()
        self._fired = False

    @property
    def fired(self) -> bool:
        with self._lock:
            return self._fired

    def __call__(self) -> None:
        with self._lock:
            if self._fired:
                return
            self._fired = True
        fn = self._fn
        if fn is None:
            return
        try:
            fn()
        except Exception as exc:  # 回调异常绝不能影响收尾流程
            _log(f"on_close 回调异常（已忽略）: {exc!r}")


def _find_browser(paths) -> str | None:
    for p in paths:
        if os.path.isfile(p):
            return p
    # PATH 里找
    for name in ("msedge.exe", "chrome.exe"):
        found = shutil.which(name)
        if found:
            return found
    return None


def _reset_globals() -> None:
    global _LAST_BACKEND, _ACTIVE_PROC, _LAST_RC
    with _LOCK:
        _LAST_BACKEND = None
        _ACTIVE_PROC = None
        _LAST_RC = 1


def backend_name() -> str:
    """返回本条进程使用的桌面后端名。

    尚未开过窗口时做一次可用性探测（mission_control.py 用它填 /api/health 的 backend）。
    """
    forced = (os.environ.get("LAGRANGE_FORCE_BACKEND") or "").strip().lower()
    if forced in ("pywebview", "edge-app", "chrome-app", "browser"):
        return forced
    with _LOCK:
        if _LAST_BACKEND:
            return _LAST_BACKEND
    try:
        import webview  # noqa: F401

        return "pywebview"
    except Exception:
        pass
    if _find_browser(EDGE_PATHS):
        return "edge-app"
    if _find_browser(CHROME_PATHS):
        return "chrome-app"
    return "browser"


# ---------------------------------------------------------------------------
# 进程管理
# ---------------------------------------------------------------------------


def _terminate_tree(proc: subprocess.Popen, timeout: float = 5.0) -> None:
    """尽力杀掉 app 模式浏览器进程树，避免孤儿进程。"""
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.terminate()
    except Exception:
        pass
    try:
        proc.wait(timeout=timeout)
        return
    except Exception:
        pass
    if IS_WINDOWS:
        try:
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            )
            return
        except Exception:
            pass
    try:
        proc.kill()
    except Exception:
        pass
    try:
        proc.wait(timeout=timeout)
    except Exception:
        pass


def _set_active_proc(proc) -> None:
    global _ACTIVE_PROC
    with _LOCK:
        _ACTIVE_PROC = proc


def _install_signal_handlers(once: _Once):
    """Ctrl+C 时也保证 on_close 恰好一次 + 杀掉 app 模式进程。返回可恢复的旧 handler。"""
    old = {}
    if not IS_WINDOWS and threading.current_thread() is not threading.main_thread():
        return old

    def _handler(signum, frame):  # pragma: no cover - 交互路径
        _log(f"收到信号 {signum}，正在收尾…")
        once()
        with _LOCK:
            proc = _ACTIVE_PROC
        _terminate_tree(proc)
        raise KeyboardInterrupt

    for sig_name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        sig = getattr(signal, sig_name, None)
        if sig is None:
            continue
        try:
            old[sig] = signal.getsignal(sig)
            signal.signal(sig, _handler)
        except Exception:
            old.pop(sig, None)
    return old


def _restore_signal_handlers(old) -> None:
    for sig, handler in (old or {}).items():
        try:
            signal.signal(sig, handler)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 各级后端
# ---------------------------------------------------------------------------


def _wait_interruptible(proc: subprocess.Popen, poll: float = 0.25):
    """轮询等待子进程退出。

    ``proc.wait()`` 不带超时会一直阻塞在 C 层（Windows 上是 WaitForSingleObject），
    主线程回不到字节码层 → **Ctrl+C 的 Python 信号处理器根本没机会执行** →
    用户按 Ctrl+C 后卡住、浏览器被留在后台（孤儿进程）。
    用 0.25 s 短超时轮询，既保证窗口关闭即返回，也保证 Ctrl+C 立刻生效。
    """
    while True:
        try:
            return proc.wait(timeout=poll)
        except subprocess.TimeoutExpired:
            continue


def _kill_by_marker(marker: str, rounds: int = 3, delay: float = 0.6) -> int:
    """清理命令行里带唯一标记（= app 模式临时 user-data-dir）的浏览器残留进程。

    ``terminate()`` 只会杀掉启动器进程，Edge/Chrome 的 renderer/gpu 子进程要过 1-2 秒
    才自行退出；这里按「唯一临时目录」精确清扫，绝不会误伤用户自己的浏览器
    （过滤器同时限定进程名 ∈ {msedge.exe, chrome.exe}，并排除 PowerShell 自身）。
    """
    if not IS_WINDOWS or not marker or "'" in marker or '"' in marker:
        return 0
    ps = (
        "$ErrorActionPreference='SilentlyContinue';"
        "Get-CimInstance Win32_Process |"
        " Where-Object { $_.ProcessId -ne $PID"
        " -and ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe')"
        f" -and $_.CommandLine -like '*{marker}*' }} |"
        " ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Output $_.ProcessId }"
    )
    killed = 0
    for _ in range(rounds):
        try:
            out = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                capture_output=True,
                text=True,
                timeout=25,
            ).stdout
        except Exception:
            return killed
        pids = [ln.strip() for ln in (out or "").splitlines() if ln.strip().isdigit()]
        killed += len(pids)
        if not pids:
            return killed
        time.sleep(delay)
    return killed


def _launch_app_mode(exe: str, url: str, width: int, height: int, once: _Once) -> int:
    """Edge/Chrome ``--app=`` 模式：阻塞到窗口关闭。"""
    user_data_dir = tempfile.mkdtemp(prefix="lc_webview_")
    args = [
        exe,
        f"--app={url}",
        f"--window-size={int(width)},{int(height)}",
        f"--user-data-dir={user_data_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate",
        "--allow-file-access-from-files",
    ]
    creationflags = 0
    if IS_WINDOWS:
        # 不弹额外控制台窗口
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    _log(f"app 模式启动: {exe}")
    proc = subprocess.Popen(
        args,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        creationflags=creationflags,
    )
    _set_active_proc(proc)
    try:
        rc = _wait_interruptible(proc)
    except KeyboardInterrupt:
        once()
        _terminate_tree(proc)
        rc = 130
    finally:
        _set_active_proc(None)
        once()
        leftovers = _kill_by_marker(user_data_dir)
        if leftovers:
            _log(f"清理 app 模式残留子进程 {leftovers} 个")
        try:
            shutil.rmtree(user_data_dir, ignore_errors=True)
        except Exception:
            pass
    try:
        return int(rc)
    except Exception:
        return 0


def _try_pywebview(url: str, title: str, width: int, height: int, once: _Once) -> int:
    """pywebview / EdgeChromium。任何异常向上抛，由调用方回退。"""
    global _ACTIVE_WIN
    import webview  # 可能 ImportError / pythonnet 加载失败

    win = webview.create_window(
        title,
        url,
        width=int(width),
        height=int(height),
        min_size=MIN_SIZE,
        background_color=BACKGROUND_COLOR,
        text_select=False,
        confirm_close=False,
    )
    _ACTIVE_WIN = win

    def _on_closed(*_a, **_kw):
        once()

    try:
        win.events.closed += _on_closed
    except Exception as exc:
        _log(f"绑定 closed 事件失败（忽略）: {exc!r}")

    _log("pywebview 启动（gui=edgechromium）")
    try:
        webview.start(gui="edgechromium", debug=False)
    finally:
        _ACTIVE_WIN = None
    once()
    return 0


def close_window() -> bool:
    """请求关闭当前窗口（供宿主收到 ``POST /api/quit`` 时调用）。

    没有这条链路时，"退出"按钮只会停掉宿主服务，而 ``open_window()`` 仍阻塞在
    ``webview.start()`` 上、窗口留在屏幕上变成僵尸页 —— 用户看到的就是"退出键没作用"。
    返回 True 表示已发出关闭请求。
    """
    with _LOCK:
        win = _ACTIVE_WIN
        proc = _ACTIVE_PROC
    if win is not None:
        try:
            win.destroy()
            _log("已请求销毁 pywebview 窗口")
            return True
        except Exception as exc:  # noqa: BLE001
            _log(f"销毁 pywebview 窗口失败：{exc!r}")
    if proc is not None:
        try:
            _terminate_tree(proc)
            _log("已终止 app 模式窗口进程")
            return True
        except Exception as exc:  # noqa: BLE001
            _log(f"终止 app 模式进程失败：{exc!r}")
    return False


def _fail_pywebview(**_kw) -> int:
    """LAGRANGE_DISABLE_PYWEBVIEW=1 时使用：模拟 pywebview 这一级失败。"""
    raise RuntimeError("pywebview 被 LAGRANGE_DISABLE_PYWEBVIEW 禁用（回退链验证用）")


def _try_browser_fallback(url: str, once: _Once) -> int:
    """最后一级：默认浏览器。open_browser 成功后按需阻塞等待 Ctrl+C。"""
    if not open_browser(url):
        once()
        return 1
    _log("已用默认浏览器打开；按 Ctrl+C 结束（或设 LAGRANGE_WINDOW_NO_WAIT=1 立即返回）")
    try:
        if os.environ.get("LAGRANGE_WINDOW_NO_WAIT", "").strip() not in ("", "0", "false"):
            once()
            return 0
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        once()
        return 0


# ---------------------------------------------------------------------------
# 公共 API
# ---------------------------------------------------------------------------


def open_window(
    url: str,
    title: str = DEFAULT_TITLE,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
    on_close=None,
) -> int:
    """打开桌面窗口并阻塞到关闭。

    返回 0 = 成功打开过窗口（并已关闭）／1 = 所有后端都失败。
    ``on_close()`` 保证恰好调用一次。
    """
    global _LAST_BACKEND, _LAST_RC
    if not url:
        raise ValueError("open_window: url 不能为空")

    enable_dpi_awareness()
    once = _Once(on_close)
    old_handlers = _install_signal_handlers(once)
    forced = (os.environ.get("LAGRANGE_FORCE_BACKEND") or "").strip().lower()
    edge = _find_browser(EDGE_PATHS)
    chrome = _find_browser(CHROME_PATHS)

    plan: list[tuple[str, object]] = []
    if forced != "browser":
        if forced != "edge-app" and forced != "chrome-app":
            if os.environ.get("LAGRANGE_DISABLE_PYWEBVIEW", "").strip() not in ("", "0", "false"):
                plan.append(("pywebview", _fail_pywebview))
            else:
                plan.append(
                    ("pywebview", lambda **kw: _try_pywebview(url, title, width, height, once))
                )
        if edge and forced != "chrome-app":
            plan.append(("edge-app", lambda **kw: _launch_app_mode(edge, url, width, height, once)))
        if chrome:
            plan.append(("chrome-app", lambda **kw: _launch_app_mode(chrome, url, width, height, once)))
        plan.append(("browser", lambda **kw: _try_browser_fallback(url, once)))
    else:
        plan.append(("browser", lambda **kw: _try_browser_fallback(url, once)))

    rc = 1
    try:
        for name, launcher in plan:
            try:
                _log(f"尝试后端：{name}")
                rc = int(launcher() or 0)  # type: ignore[operator]
            except KeyboardInterrupt:
                once()
                rc = 130
                with _LOCK:
                    _LAST_BACKEND = name
                break
            except BaseException as exc:  # 含 pythonnet/.NET 加载期的各类异常
                _log(f"后端 {name} 失败：{type(exc).__name__}: {exc}")
                continue
            with _LOCK:
                _LAST_BACKEND = name
            break
    finally:
        once()
        _restore_signal_handlers(old_handlers)
        with _LOCK:
            proc = _ACTIVE_PROC
        if proc is not None and proc.poll() is None:
            _terminate_tree(proc)
            _set_active_proc(None)

    ok = rc in (0, 130)
    _LAST_RC = 0 if ok else 1
    return _LAST_RC


def open_browser(url: str) -> bool:
    """用系统默认浏览器打开 url；成功返回 True。"""
    if not url:
        return False
    try:
        if IS_WINDOWS:
            try:
                os.startfile(url)  # type: ignore[attr-defined]
                return True
            except Exception:
                pass
        return bool(webbrowser.open(url, new=2))
    except Exception as exc:
        _log(f"默认浏览器打开失败：{exc!r}")
        return False


# ---------------------------------------------------------------------------
# 自检 / 手动调试入口（不影响被 import 时的行为）
# ---------------------------------------------------------------------------


def _main(argv: list[str]) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="STARHERD 桌面窗口后端（W-pack）")
    ap.add_argument("--url", default="")
    ap.add_argument("--title", default=DEFAULT_TITLE)
    ap.add_argument("--width", type=int, default=DEFAULT_WIDTH)
    ap.add_argument("--height", type=int, default=DEFAULT_HEIGHT)
    ap.add_argument("--backend", default="", help="pywebview|edge-app|chrome-app|browser")
    ap.add_argument("--disable-pywebview", action="store_true",
                    help="让 pywebview 这一级必然失败，用于验证回退链")
    ap.add_argument("--backend-name", action="store_true", help="只打印 backend_name() 后退出")
    ap.add_argument("--probe", action="store_true", help="打印各后端可用性后退出")
    a = ap.parse_args(argv)

    if a.backend:
        os.environ["LAGRANGE_FORCE_BACKEND"] = a.backend
    if a.disable_pywebview:
        os.environ["LAGRANGE_DISABLE_PYWEBVIEW"] = "1"
    if a.backend_name:
        print(backend_name())
        return 0
    if a.probe:
        print(f"backend_name()={backend_name()}")
        print(f"edge={'yes' if _find_browser(EDGE_PATHS) else 'no'} ({_find_browser(EDGE_PATHS)})")
        print(f"chrome={'yes' if _find_browser(CHROME_PATHS) else 'no'} ({_find_browser(CHROME_PATHS)})")
        try:
            import webview  # noqa: F401

            pyw = "yes"
        except Exception as exc:
            pyw = f"no ({exc!r})"
        print(f"pywebview={pyw}")
        return 0

    if not a.url:
        ap.error("--url 必填（除非用 --probe / --backend-name）")
    fired = []
    rc = open_window(
        a.url,
        title=a.title,
        width=a.width,
        height=a.height,
        on_close=lambda: fired.append(time.time()),
    )
    print(f"open_window rc={rc} backend={backend_name()} on_close_calls={len(fired)}")
    return rc


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_main(sys.argv[1:]))
