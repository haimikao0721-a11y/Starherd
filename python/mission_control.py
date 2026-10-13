"""mission_control.py — 《牧星者》命令行入口（W-host）。

契约：docs/INTERFACES.md §1 末尾（CLI 与启动顺序）与 §7（验收命令）。

CLI：
    --web            网页模式：起服务 + 默认浏览器
    --window         桌面窗口模式（默认）：窗口失败自动回退浏览器
    --dev            开发模式：起服务、打印 URL、不自动开窗口
    --regen          强制重新生成素材与关卡数据
    --port N         起始端口（占用则 +1 递增，最多 20 个）
    --no-browser     不自动打开浏览器
    --assets-only    只生成素材后退出
    --levels-only    只生成关卡数据后退出
    --selftest       委托 python/selftest.py 自检（退出码 0=通过）
    --print-url      起服务后打印 LAGRANGE_URL=... 并保持运行（供自动化抓取）

启动顺序（契约）：校验/生成素材 → 生成关卡 → 起 HTTP+WS → 打印 URL → 开窗口 → 关窗即优雅退出。
Ctrl+C 与 `POST /api/quit` 均优雅退出（返回码 0）。
"""

from __future__ import annotations

import argparse
import asyncio
import os
import signal
import subprocess
import sys
import threading
import traceback
import webbrowser
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import paths  # noqa: E402
from host import MissionControl, TITLE, VERSION  # noqa: E402

_TRUTHY = ("1", "true", "yes", "on", "y")


# --------------------------------------------------------------------------- CLI

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mission_control.py",
        description="《牧星者 / STARHERD》任务控制中心（Python 宿主：HTTP + WebSocket + 窗口）",
        epilog=(
            "示例：\n"
            "  python python/mission_control.py                      # 桌面窗口（失败回退浏览器）\n"
            "  python python/mission_control.py --web                 # 浏览器网页版\n"
            "  python python/mission_control.py --dev --port 8801     # 开发模式（打印 URL，保持运行）\n"
            "  python python/mission_control.py --print-url --web     # 自动化：打印 LAGRANGE_URL 后保持运行\n"
            "  python python/mission_control.py --assets-only         # 只生成素材\n"
            "  python python/mission_control.py --levels-only         # 只生成关卡\n"
            "  python python/mission_control.py --selftest            # 端到端自检\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--web", action="store_true", help="网页模式：起服务后用默认浏览器打开")
    parser.add_argument("--window", action="store_true", help="桌面窗口模式（默认；失败自动回退浏览器）")
    parser.add_argument("--dev", action="store_true", help="开发模式：起服务并打印 URL，不自动开窗口")
    parser.add_argument("--regen", action="store_true", help="启动前强制重新生成素材与关卡数据")
    parser.add_argument("--port", type=int, default=8760, metavar="N",
                        help="起始端口（默认 8760；被占用则 +1 递增，最多试 20 个）")
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    parser.add_argument("--assets-only", action="store_true", help="只生成素材（assets/audio|art|data）后退出")
    parser.add_argument("--levels-only", action="store_true", help="只生成关卡数据（assets/data/systems.json）后退出")
    parser.add_argument("--selftest", action="store_true",
                        help="委托 python/selftest.py 执行自检，退出码 0=通过"
                             "（其后的未知参数原样转发，如 --no-shot / --keep-open）")
    parser.add_argument("--print-url", action="store_true",
                        help="起服务后打印一行 LAGRANGE_URL=http://127.0.0.1:<port>/ 并保持运行（供自动化抓取）")
    parser.add_argument("--version", action="version", version=f"LagrangeCourier Mission Control {VERSION}")
    return parser


def resolve_mode(args: argparse.Namespace) -> str:
    if args.dev:
        return "dev"
    if args.web:
        return "web"
    if args.window:
        return "window"
    if args.print_url or args.assets_only or args.levels_only or args.selftest:
        return "dev"
    return "window"


# --------------------------------------------------------------------------- 输出

def print_url_lines(mc: MissionControl, args: argparse.Namespace) -> None:
    """打印机器可解析的 URL 行（--print-url / --dev 必须；其余模式也一并打印，便于集成）。"""
    url = mc.url
    print(f"LAGRANGE_URL={url}", flush=True)
    if _autotest_env():
        sep = "&" if "?" in url else "?"
        print(f"LAGRANGE_AUTOTEST_URL={url}{sep}autotest=1", flush=True)
    print(f"[mission_control] 服务监听 {url}（模式={mc.mode}，后端={mc.backend}，"
          f"Ctrl+C 或 POST /api/quit 退出）", flush=True)
    sys.stdout.flush()


def _autotest_env() -> bool:
    for name in ("LAGRANGE_AUTOTEST", "AUTOTEST"):
        value = os.environ.get(name)
        if value and str(value).strip().lower() in _TRUTHY:
            return True
    return False


def _print_banner(mode: str) -> None:
    print(f"[mission_control] 《牧星者》v{VERSION} 启动：模式={mode}", flush=True)
    print(f"[mission_control] 项目根   {paths.app_root()}", flush=True)
    print(f"[mission_control] 存档路径 {paths.save_path()}", flush=True)


# --------------------------------------------------------------------------- 素材 / 关卡

def generate_assets(force: bool = False, *, quiet: bool = False) -> tuple[bool, dict | None]:
    """调用 W-assets 的 assets_gen.generate_all()；模块缺失/异常时返回 (False, None)。"""
    try:
        import assets_gen  # type: ignore
    except Exception as exc:  # noqa: BLE001
        if not quiet:
            print(f"[mission_control] 无法导入 assets_gen（W-assets 尚未产出？）：{exc!r}", file=sys.stderr)
        return False, None
    try:
        manifest = assets_gen.generate_all(force=force)
    except Exception as exc:  # noqa: BLE001
        if not quiet:
            traceback.print_exc()
            print(f"[mission_control] assets_gen.generate_all() 失败：{exc!r}", file=sys.stderr)
        return False, None
    return True, manifest if isinstance(manifest, dict) else {}


def generate_levels(force: bool = False, *, quiet: bool = False) -> tuple[bool, dict | None]:
    """调用 W-physics 的 levelgen.generate_levels()；模块缺失/异常时返回 (False, None)。"""
    try:
        import levelgen  # type: ignore
    except Exception as exc:  # noqa: BLE001
        if not quiet:
            print(f"[mission_control] 无法导入 levelgen（W-physics 尚未产出？）：{exc!r}", file=sys.stderr)
        return False, None
    try:
        systems = levelgen.generate_levels(force=force)
    except Exception as exc:  # noqa: BLE001
        if not quiet:
            traceback.print_exc()
            print(f"[mission_control] levelgen.generate_levels() 失败：{exc!r}", file=sys.stderr)
        return False, None
    return True, systems if isinstance(systems, dict) else {}


def _describe_manifest(manifest: dict | None) -> str:
    if not isinstance(manifest, dict):
        return "（未返回 manifest）"
    audio = manifest.get("audio") or []
    art = manifest.get("art") or []
    music = manifest.get("music") or []
    total = manifest.get("total_bytes")
    return f"audio={len(audio)} art={len(art)} music={len(music)} total_bytes={total}"


def _describe_systems(systems: dict | None) -> str:
    if not isinstance(systems, dict):
        return "（未返回 systems）"
    levels = systems.get("levels") or []
    chapters = systems.get("chapters") or []
    return f"levels={len(levels)} chapters={len(chapters)}"


def do_assets_only(args: argparse.Namespace) -> int:
    print("[mission_control] --assets-only：生成素材 …", flush=True)
    ok, manifest = generate_assets(force=bool(args.regen))
    if not ok:
        print("[mission_control] --assets-only 失败：assets_gen 不可用", file=sys.stderr)
        return 2
    print(f"[mission_control] 素材完成：{_describe_manifest(manifest)}", flush=True)
    return 0


def do_levels_only(args: argparse.Namespace) -> int:
    print("[mission_control] --levels-only：生成关卡 …", flush=True)
    ok, systems = generate_levels(force=bool(args.regen))
    if not ok:
        print("[mission_control] --levels-only 失败：levelgen 不可用", file=sys.stderr)
        return 2
    print(f"[mission_control] 关卡完成：{_describe_systems(systems)}", flush=True)
    return 0


def do_regen() -> None:
    ok_a, manifest = generate_assets(force=True, quiet=True)
    print(f"[mission_control] --regen 素材：{'OK ' + _describe_manifest(manifest) if ok_a else '失败（assets_gen 不可用）'}",
          file=sys.stderr if not ok_a else sys.stdout, flush=True)
    ok_l, systems = generate_levels(force=True, quiet=True)
    print(f"[mission_control] --regen 关卡：{'OK ' + _describe_systems(systems) if ok_l else '失败（levelgen 不可用）'}",
          file=sys.stderr if not ok_l else sys.stdout, flush=True)


# --------------------------------------------------------------------------- selftest

def do_selftest(args: argparse.Namespace, raw_argv: list[str] | None = None,
                extra_argv: list[str] | None = None) -> int:
    script = _HERE / "selftest.py"
    if not script.is_file():
        print(f"[mission_control] --selftest 失败：找不到 {script}"
              "（该文件由 W-pack 负责，可能尚未生成）", file=sys.stderr)
        return 2

    # 显式给出的 --port 才转发（selftest.py 默认 0=随机空闲端口）
    forwarded: list[str] = []
    if any(a == "--port" or a.startswith("--port=") for a in (raw_argv or [])):
        forwarded += ["--port", str(args.port)]
    # --selftest 之后无法识别的参数原样转发给 selftest.py（例如 --no-shot/--keep-open）
    forwarded += list(extra_argv or [])

    if paths.is_frozen():
        # 冻结态下 sys.executable 是 exe 本身，改为进程内执行
        import runpy
        saved_argv = sys.argv
        try:
            sys.argv = [str(script), *forwarded]
            runpy.run_path(str(script), run_name="__main__")
            return 0
        except SystemExit as exc:
            return int(exc.code) if isinstance(exc.code, int) else (0 if exc.code is None else 1)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            print(f"[mission_control] selftest 失败：{exc!r}", file=sys.stderr)
            return 1
        finally:
            sys.argv = saved_argv

    cmd = [sys.executable, str(script), *forwarded]
    print(f"[mission_control] 委托自检：{' '.join(cmd)}", flush=True)
    try:
        return int(subprocess.call(cmd, cwd=str(paths.app_root())))
    except OSError as exc:
        print(f"[mission_control] 无法启动 selftest：{exc!r}", file=sys.stderr)
        return 2


# --------------------------------------------------------------------------- 信号

def _install_sigint(mc: MissionControl) -> None:
    """Ctrl+C（Windows 上还有 Ctrl+Break）→ 优雅退出（不抛 KeyboardInterrupt，保证 stop() 能跑完）。"""
    def handler(signum, frame):  # noqa: ARG001
        print("\n[mission_control] 收到中断信号，优雅退出 …", flush=True)
        mc.request_quit()

    for name in ("SIGINT", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue
        try:
            signal.signal(sig, handler)
        except (ValueError, OSError):
            pass


# --------------------------------------------------------------------------- 无窗口模式

async def serve_headless(mc: MissionControl, args: argparse.Namespace) -> int:
    try:
        await mc.start()
    except Exception as exc:  # noqa: BLE001
        print(f"[mission_control] 启动失败：{exc!r}", file=sys.stderr)
        return 1

    print_url_lines(mc, args)
    if args.web and not args.no_browser:
        _open_browser(mc)

    _install_sigint(mc)
    try:
        if not mc.quit_flag.is_set():
            assert mc.quit_event is not None
            await mc.quit_event.wait()
    except asyncio.CancelledError:
        pass
    finally:
        await mc.stop()
    return 0


def _open_browser(mc: MissionControl) -> None:
    url = mc.url
    if _autotest_env():
        url = url + ("&" if "?" in url else "?") + "autotest=1"
    ok = False
    try:
        import window  # type: ignore
        ok = bool(window.open_browser(url))
    except Exception:  # noqa: BLE001
        ok = False
    if not ok:
        try:
            ok = webbrowser.open(url)
        except Exception:  # noqa: BLE001
            ok = False
    mc.set_backend("browser" if ok else mc.backend)
    print(f"[mission_control] 浏览器打开{'成功' if ok else '失败'}：{url}", flush=True)


# --------------------------------------------------------------------------- 窗口模式

def run_window_mode(mc: MissionControl, args: argparse.Namespace) -> int:
    """服务跑在工作线程的独立事件循环里，GUI 占主线程（pywebview 要求）。"""
    loop = asyncio.new_event_loop()
    ready = threading.Event()
    holder: dict = {}

    def boot() -> None:
        asyncio.set_event_loop(loop)
        try:
            holder["port"] = loop.run_until_complete(mc.start())
        except BaseException as exc:  # noqa: BLE001
            holder["error"] = exc
            ready.set()
            try:
                loop.close()
            except Exception:  # noqa: BLE001
                pass
            return
        ready.set()
        try:
            loop.run_forever()
        finally:
            try:
                pending = [t for t in asyncio.all_tasks(loop) if not t.done()]
                for task in pending:
                    task.cancel()
                if pending:
                    loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            except Exception:  # noqa: BLE001
                pass
            finally:
                loop.close()

    thread = threading.Thread(target=boot, name="lagrange-mc-server", daemon=True)
    thread.start()

    if not ready.wait(120):
        print("[mission_control] 服务启动超时", file=sys.stderr)
        return 1
    if "error" in holder:
        print(f"[mission_control] 服务启动失败：{holder['error']!r}", file=sys.stderr)
        return 1

    print_url_lines(mc, args)
    _install_sigint(mc)

    def on_window_closed(*_a, **_kw) -> None:
        mc.quit_flag.set()
        if mc.quit_event is not None and not loop.is_closed():
            try:
                loop.call_soon_threadsafe(mc.quit_event.set)
            except RuntimeError:
                pass

    window_ok = False
    try:
        import window  # type: ignore
        # 把「宿主收到 /api/quit」接到「销毁窗口」上：否则退出键只杀掉后端，
        # 而 open_window() 仍阻塞在 webview.start() 上，窗口会留在屏幕上变成僵尸页。
        try:
            mc.set_on_quit(window.close_window)
        except Exception as exc:  # noqa: BLE001
            print(f"[mission_control] 注册窗口关闭回调失败（忽略）：{exc!r}", file=sys.stderr)
        rc = window.open_window(mc.url, title=TITLE, width=1600, height=900,
                                on_close=on_window_closed)
        window_ok = int(rc) == 0
        if not window_ok:
            print(f"[mission_control] 窗口模式返回 {rc}，回退浏览器", file=sys.stderr)
        else:
            try:
                mc.set_backend(window.backend_name())
            except Exception:  # noqa: BLE001
                pass
    except Exception as exc:  # noqa: BLE001
        print(f"[mission_control] 无法使用 window.open_window（{exc!r}），回退浏览器", file=sys.stderr)

    if not window_ok:
        if not args.no_browser:
            _open_browser(mc)
        print("[mission_control] 已回退浏览器模式，等待退出请求（Ctrl+C 或 POST /api/quit）…", flush=True)
        mc.wait_quit()
    else:
        print("[mission_control] 窗口已关闭，优雅退出 …", flush=True)

    try:
        fut = asyncio.run_coroutine_threadsafe(mc.stop(), loop)
        fut.result(timeout=20)
    except Exception as exc:  # noqa: BLE001
        print(f"[mission_control] 关闭服务时出错：{exc!r}", file=sys.stderr)
        mc.cleanup_runtime()
    finally:
        try:
            loop.call_soon_threadsafe(loop.stop)
        except RuntimeError:
            pass
        thread.join(timeout=15)
    return 0


# --------------------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    args, extra = parser.parse_known_args(raw)
    if extra and not args.selftest:
        parser.error("unrecognized arguments: " + " ".join(extra))

    # **--dev 默认隔离存档目录**（开发 / 自动化验收专用）。
    # 起因：tools/verify_ui.py 会像真人一样点关卡、打通关，而它连的是同一个宿主；
    # 实测发生过"验收脚本替玩家把前 6 关解锁了"的事故。开发模式下把数据目录切到临时目录，
    # 玩家真实存档（%LOCALAPPDATA%\Starherd）就不会被任何自动化流程碰到。
    if getattr(args, "dev", False) and not os.environ.get("STARHERD_DATA_DIR"):
        import tempfile as _tf
        os.environ["STARHERD_DATA_DIR"] = str(Path(_tf.gettempdir()) / "starherd_dev")
        print(f"[dev] 数据目录已隔离到 {os.environ['STARHERD_DATA_DIR']}（不触碰玩家存档）", flush=True)

    if args.selftest:
        return do_selftest(args, raw, extra)

    if args.assets_only or args.levels_only:
        code = 0
        if args.assets_only:
            code = do_assets_only(args) or code
        if args.levels_only:
            code = do_levels_only(args) or code
        return code

    mode = resolve_mode(args)
    _print_banner(mode)

    if args.regen:
        do_regen()

    # 启动顺序：校验/生成素材 → 生成关卡 → 起 HTTP+WS → 打印 URL → 开窗口
    if not paths.manifest_path().is_file():
        generate_assets(force=False, quiet=True)
    if not paths.systems_path().is_file():
        generate_levels(force=False, quiet=True)

    mc = MissionControl(port=args.port, mode=mode)
    rc = 0
    try:
        if mode == "window":
            rc = run_window_mode(mc, args)
        else:
            rc = asyncio.run(serve_headless(mc, args))
    except KeyboardInterrupt:
        # 兜底：SIGINT 处理器通常已接管；此处保证仍然优雅退出（返回码 0）
        print("\n[mission_control] 中断，优雅退出", flush=True)
        mc.cleanup_runtime()
        rc = 0
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        print(f"[mission_control] 运行失败：{exc!r}", file=sys.stderr)
        mc.cleanup_runtime()
        rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
