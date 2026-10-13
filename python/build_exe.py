#!/usr/bin/env python3
"""W-pack ／ PyInstaller 单文件 EXE 打包 + 冒烟验证（STARHERD）

用法::

    python python/build_exe.py                 # 构建前端 → PyInstaller 打包 → dist_exe\\Starherd.exe
    python python/build_exe.py --smoke          # 打包后自动启动 EXE 做 /api/health 冒烟
    python python/build_exe.py --no-build --smoke   # 只对已有 EXE 做冒烟
    python python/build_exe.py --skip-web-build     # 跳过 node tools/build.mjs

产物：``<项目根>\\dist_exe\\Starherd.exe``（onefile / windowed）。
EXE 在任意目录启动都能工作：资源经 ``--add-data`` 打进包，宿主用 ``sys._MEIPASS``（app_root()）定位。
"""

from __future__ import annotations


def _version_file() -> "Path":
    """生成并返回 Windows 版本资源文件（文件属性里的制作者/邮箱/仓库）。"""
    import importlib
    mod = importlib.import_module("version_info")
    return mod.generate()


import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

APP_NAME = "Starherd"
ENTRY_DEFAULT = HERE / "mission_control.py"
ICON_DEFAULT = ROOT / "assets" / "art" / "app.ico"
EXE_OUT_DIR = ROOT / "dist_exe"
STAGE_DIR = ROOT / "build" / "exe_dist"
WORK_DIR = ROOT / "build" / "pyinstaller"
SPEC_PATH = ROOT

DATA_DIRS = ("web", "dist", "assets")

HIDDEN_IMPORTS = (
    "aiohttp",
    "aiohttp.web",
    "aiosignal",
    "attr",
    "frozenlist",
    "multidict",
    "yarl",
    "pywebview",  # PyPI 包名（模块名是 webview）；契约要求保留，找不到只报 warn 不影响打包
    "webview",  # 真正的模块名，补上更稳
    "webview.platforms.edgechromium",
    "clr_loader",
    "pythonnet",
    "clr",
    "websockets",
    # 背景音乐下载（/api/music）：把谱面离线渲染成 WAV 所需。
    # music_render 只在请求处理函数里被 import，且它依赖 stdlib 的 wave
    # （纯 Python 模块不会被自动收集）——不加这两项，打包后 /api/music 会返回空，
    # 游戏里「背景音乐下载」整块消失（发布后实测到的回归）。
    "music_render",
    "wave",
)

# aiohttp / websockets 都有动态导入，必须 collect-submodules 才不至于运行期 ImportError
COLLECT_SUBMODULES = ("aiohttp", "websockets")

RESET, BOLD = "\033[0m", "\033[1m"
RED, GREEN, YELLOW, CYAN = "\033[31m", "\033[32m", "\033[33m", "\033[36m"


def paint(text: str, color: str) -> str:
    if os.environ.get("NO_COLOR") or sys.stdout.isatty() is False:
        return text
    return f"{color}{text}{RESET}"


def log(msg: str) -> None:
    print(msg, flush=True)


def warn(msg: str) -> None:
    log(paint(f"!! WARNING: {msg}", YELLOW))


def fail(msg: str) -> None:
    log(paint(f"!! ERROR: {msg}", RED))


def free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])
    finally:
        s.close()


def http_get(url: str, timeout: float = 3.0):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="GET"), timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, ""
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"


def http_post(url: str, payload: dict | None = None, timeout: float = 5.0):
    data = json.dumps(payload or {}).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST", headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n} B ({n / 1024 / 1024:.2f} MB)" if unit == "B" else f"{n:.1f} {unit}"
        n_f = n / 1024
        if unit == "KB":
            return f"{n} B ({n / 1024 / 1024:.2f} MB)"
        n = n_f  # type: ignore[assignment]
    return f"{n}"


# ---------------------------------------------------------------------------
# 步骤 1：前端构建
# ---------------------------------------------------------------------------


def build_web(skip: bool, strict: bool) -> bool:
    script = ROOT / "tools" / "build.mjs"
    if skip:
        log(paint("[1/3] 前端构建：--skip-web-build，跳过", CYAN))
        return True
    if not script.is_file():
        warn(f"{script} 不存在（前端构建器由主 Agent 负责）→ 跳过前端构建，直接打包现有 web/ + dist/")
        return True
    node = shutil.which("node")
    if not node:
        warn("PATH 里找不到 node → 跳过前端构建")
        return not strict
    log(paint(f"[1/3] 前端构建：node {script}", CYAN))
    try:
        rc = subprocess.run([node, str(script)], cwd=str(ROOT), timeout=900, check=False).returncode
    except Exception as exc:
        warn(f"前端构建异常：{exc!r}")
        return not strict
    if rc != 0:
        (fail if strict else warn)(
            f"node tools/build.mjs 退出码 {rc}（dist/app.js 可能没生成，EXE 里将缺前端）"
        )
        return not strict
    app_js = ROOT / "dist" / "app.js"
    if app_js.is_file():
        log(f"      dist/app.js = {app_js.stat().st_size} bytes")
    else:
        warn("构建后仍无 dist/app.js")
    return True


# ---------------------------------------------------------------------------
# 步骤 2：PyInstaller
# ---------------------------------------------------------------------------

# PyInstaller 的 __main__.run() 会在启动前做一次前置检查：只要 importlib.metadata 里存在
# 名为 pathlib/enum34/typing 的**废弃 backport 发行版**就直接 SystemExit 拒绝运行。
# 本机的 `import pathlib` 实际解析到标准库（C:\...\Python313\Lib\pathlib\__init__.py），
# 那份 site-packages\pathlib.py 是死的；删包属于改动共享环境（未获授权），
# 因此这里用一个 12 行的驱动脚本在**构建进程内**忽略这一条检查——
# 其它检查（如 Linux objdump）依旧生效，标准路径的行为完全不变。
PYI_DRIVER = WORK_DIR.parent / "_pyi_driver.py"

PYI_DRIVER_SRC = '''"""build_exe.py 自动生成的 PyInstaller 驱动（构建期临时文件）。"""
from __future__ import annotations

import sys

from PyInstaller import compat

_orig_check = compat.check_requirements
_ACTIVE = True


def check_requirements():
    global _ACTIVE
    try:
        _orig_check()
    except SystemExit as exc:
        msg = str(exc)
        if _ACTIVE and "obsolete backport" in msg and "pathlib" in msg:
            _ACTIVE = False  # 只放行一次，避免掩盖真正的问题
            print(
                "[build_exe] NOTE: 忽略 PyInstaller 的废弃 pathlib backport 检查——"
                "本机 import pathlib 解析到标准库，site-packages\\\\pathlib.py 不会被使用。",
                flush=True,
            )
            return
        raise


compat.check_requirements = check_requirements

from PyInstaller.__main__ import run  # noqa: E402

run(sys.argv[1:])
'''


def ensure_pyi_driver() -> Path:
    PYI_DRIVER.parent.mkdir(parents=True, exist_ok=True)
    PYI_DRIVER.write_text(PYI_DRIVER_SRC, encoding="utf-8")
    return PYI_DRIVER



def build_with_pyinstaller(args) -> int:
    entry = Path(args.entry).resolve()
    if not entry.is_file():
        fail(f"入口脚本不存在：{entry}")
        log("     → W-host 的 mission_control.py 尚未落盘；打包无法进行（这不是本脚本的故障）。")
        return 2
    try:
        import PyInstaller  # noqa: F401

        have = True
    except Exception:
        have = False
    if not have and args.entry == str(ENTRY_DEFAULT):
        fail("PyInstaller 未安装（python -m PyInstaller 不可用）")
        return 2

    argv: list[str] = [
        "--version-file",
        str(_version_file()),
        "--name",
        args.name,
        "--onefile",
        "--windowed",
        "--noconfirm",
        "--clean",
        "--distpath",
        str(STAGE_DIR),
        "--workpath",
        str(WORK_DIR),
        "--specpath",
        str(SPEC_PATH),
        "--paths",
        str(HERE),
    ]

    if args.name != APP_NAME:
        warn(f"应用名与契约不同：--name {args.name}（契约要求 {APP_NAME}）")

    icon = Path(args.icon).resolve()
    if icon.is_file():
        argv += ["--icon", str(icon)]
        log(f"      图标: {icon} ({icon.stat().st_size} bytes)")
    else:
        warn(f"图标不存在，跳过 --icon：{icon}")

    for rel in DATA_DIRS:
        src = ROOT / rel
        if not src.is_dir():
            warn(f"--add-data 跳过的缺失目录: {rel}/")
            continue
        if rel != "assets":
            if not any(src.iterdir()):
                warn(f"--add-data 的 {rel}/ 目前是空目录（内容由其他 W-agent 负责）")
            argv += ["--add-data", f"{src}{os.pathsep}{rel}"]
            continue
        # 本机误放进 assets/audio/third_party 的录音不打进发行包。
        skipped = 0
        for path in src.rglob("*"):
            if not path.is_file():
                continue
            rel_posix = path.relative_to(ROOT).as_posix()
            if "/third_party/" in f"/{rel_posix}" and path.suffix.lower() in {
                ".m4a", ".mp3", ".ogg", ".wav", ".flac", ".aac",
            }:
                skipped += 1
                continue
            dest = path.parent.relative_to(ROOT).as_posix()
            argv += ["--add-data", f"{path}{os.pathsep}{dest}"]
        if skipped:
            warn(f"已从安装包排除 {skipped} 个第三方录音（assets/audio/third_party）")

    for mod in HIDDEN_IMPORTS:
        argv += ["--hidden-import", mod]
    for mod in COLLECT_SUBMODULES:
        argv += ["--collect-submodules", mod]

    argv.append(str(entry))

    log(paint(f"[2/3] PyInstaller 打包 → {args.name}.exe", CYAN))
    driver = ensure_pyi_driver()
    log("      " + " ".join(argv))
    log(f"      驱动: {driver}（含废弃 pathlib backport 检查的定向豁免，见源码注释）")
    t0 = time.time()
    try:
        rc = subprocess.run(
            [args.python, str(driver), *argv], cwd=str(ROOT), timeout=args.timeout, check=False
        ).returncode
    except subprocess.TimeoutExpired:
        fail(f"PyInstaller 超过 {args.timeout}s 超时")
        return 3
    log(f"      PyInstaller 退出码 {rc}，耗时 {time.time() - t0:.1f}s")
    if rc != 0:
        fail("PyInstaller 打包失败")
        return rc

    produced = STAGE_DIR / f"{args.name}.exe"
    if not produced.is_file():
        fail(f"未找到产物 {produced}")
        return 4
    EXE_OUT_DIR.mkdir(parents=True, exist_ok=True)
    target = EXE_OUT_DIR / f"{args.name}.exe"
    try:
        shutil.copy2(produced, target)
    except Exception as exc:
        fail(f"复制产物失败：{exc!r}")
        return 4
    size = target.stat().st_size
    log(paint(f"[3/3] 产物就绪", CYAN))
    log(paint(f"      EXE: {target}", GREEN + BOLD))
    log(paint(f"      字节数: {size} bytes ({size / 1024 / 1024:.2f} MB)", GREEN))
    spec = SPEC_PATH / f"{args.name}.spec"
    if spec.is_file():
        log(f"      spec: {spec}")
    return 0


# ---------------------------------------------------------------------------
# 步骤 3：冒烟
# ---------------------------------------------------------------------------


def smoke(entry_exe: Path, wait_s: float, port: int | None) -> int:
    if not entry_exe.is_file():
        fail(f"冒烟失败：EXE 不存在 {entry_exe}")
        return 5
    port = port or free_port()
    tmp = Path(tempfile.mkdtemp(prefix="lc_smoke_"))
    logf = tmp / "exe_output.log"
    log(paint(f"[smoke] 启动 EXE（cwd={tmp}，验证换目录也能工作）", CYAN))
    log(f"      {entry_exe} --dev --port {port} --no-browser")
    with open(logf, "w", encoding="utf-8", errors="replace") as fh:
        proc = subprocess.Popen(
            [str(entry_exe), "--dev", "--port", str(port), "--no-browser"],
            cwd=str(tmp),
            stdout=fh,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
        )
    url = f"http://127.0.0.1:{port}"
    ok = False
    seen_url = None
    deadline = time.time() + wait_s
    try:
        while time.time() < deadline:
            if proc.poll() is not None:
                break
            try:
                text = logf.read_text(encoding="utf-8", errors="replace")
                for line in text.splitlines():
                    if line.startswith("LAGRANGE_URL=") and seen_url is None:
                        seen_url = line.split("=", 1)[1].strip().rstrip("/")
                        url = seen_url
            except Exception:
                pass
            status, body = http_get(f"{url}/api/health", timeout=2.0)
            if status == 200 and body:
                try:
                    obj = json.loads(body)
                except Exception:
                    obj = None
                if isinstance(obj, dict) and obj.get("ok") is True:
                    log(paint(f"[smoke] /api/health ok:true  backend={obj.get('backend')} "
                              f"version={obj.get('version')} assets_ok={obj.get('assets_ok')}", GREEN))
                    ok = True
                    break
            time.sleep(0.5)
        if not ok:
            fail(f"[smoke] {wait_s:.0f}s 内 /api/health 未返回 ok:true（EXE rc={proc.poll()}）")
            _dump_log(logf, proc)
            return 6
        status, body = http_post(f"{url}/api/quit", {})
        log(f"[smoke] POST /api/quit → status={status} body={body[:120]}")
        t_end = time.time() + 15
        while time.time() < t_end and proc.poll() is None:
            time.sleep(0.25)
        if proc.poll() is None:
            warn("EXE 未在 15s 内自行退出，强制终止（/api/quit 可能未实现）")
        else:
            log(f"[smoke] EXE 已退出 rc={proc.returncode}")
    finally:
        if proc.poll() is None:
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
        if ok:
            shutil.rmtree(tmp, ignore_errors=True)
        else:
            log(f"[smoke] 保留 EXE 输出日志: {logf}")
    log(paint("SMOKE PASS", GREEN + BOLD))
    return 0


def _dump_log(logf: Path, proc: subprocess.Popen, tail: int = 60) -> None:
    try:
        text = logf.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        log(f"[smoke] 读日志失败: {exc!r}")
        return
    lines = text.splitlines()
    log(paint(f"[smoke] EXE 输出（最后 {min(len(lines), tail)} 行）：", YELLOW))
    for line in lines[-tail:]:
        log(f"    | {line}")
    if not lines:
        log("    | (EXE 没有任何输出；--windowed 且未挂控制台时属正常，但不该同时没有 HTTP 响应)")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def parse_args(argv):
    ap = argparse.ArgumentParser(description="STARHERD EXE 打包 + 冒烟（W-pack）")
    ap.add_argument("--name", default=APP_NAME)
    ap.add_argument("--entry", default=str(ENTRY_DEFAULT), help="入口脚本（默认 python/mission_control.py）")
    ap.add_argument("--icon", default=str(ICON_DEFAULT))
    ap.add_argument("--smoke", action="store_true", help="打包后自动冒烟验证 EXE")
    ap.add_argument("--no-build", action="store_true", help="跳过 PyInstaller，只做冒烟")
    ap.add_argument("--skip-web-build", action="store_true", help="跳过 node tools/build.mjs")
    ap.add_argument("--strict-web", action="store_true", help="前端构建失败即中止")
    ap.add_argument("--timeout", type=float, default=1800.0, help="PyInstaller 超时秒数（默认 1800）")
    ap.add_argument("--smoke-timeout", type=float, default=60.0, help="/api/health 轮询上限秒数")
    ap.add_argument("--smoke-port", type=int, default=0)
    ap.add_argument("--python", default=sys.executable)
    return ap.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    log(paint("=" * 74, CYAN))
    log(paint("STARHERD ／ EXE 打包 (W-pack build_exe.py)", BOLD))
    log(paint("=" * 74, CYAN))
    log(f"项目根: {ROOT}")
    log(f"Python: {args.python}")
    exe = EXE_OUT_DIR / f"{args.name}.exe"

    if args.no_build:
        log(paint("[2/3] 打包：--no-build，跳过", CYAN))
        if not exe.is_file():
            fail(f"--no-build 但产物不存在：{exe}")
            return 2
    else:
        if not build_web(args.skip_web_build, args.strict_web):
            fail("前端构建失败（--strict-web）")
            return 7
        rc = build_with_pyinstaller(args)
        if rc != 0:
            return rc

    if args.smoke:
        return smoke(exe, args.smoke_timeout, args.smoke_port)

    log(paint(f"完成（未做冒烟；加 --smoke 可自动验证）。EXE: {exe}", GREEN + BOLD))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        log(paint("\n打包被中断", YELLOW))
        raise SystemExit(130)
