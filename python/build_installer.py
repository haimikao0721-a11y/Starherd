"""build_installer.py —— 把 `python/installer.py` 打成自带 GUI 的安装程序 EXE。

产物：``dist_exe/Starherd_安装程序.exe``（内嵌 ``Starherd.exe`` 作为 payload，约 50MB）。

为什么自己打而不是用 Inno Setup / NSIS
--------------------------------------
目标机器与构建机都没有安装器工具链；这个安装程序用**纯标准库 + tkinter**写成，
由 PyInstaller 打成单文件 EXE，于是"安装程序本身也不需要任何环境"。

用法::

    python python/build_installer.py            # 打包 + 静默自检（装到临时目录再卸载）
    python python/build_installer.py --no-smoke
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DIST_EXE = ROOT / "dist_exe"
GAME_EXE = DIST_EXE / "Starherd.exe"
ENTRY = HERE / "installer.py"
OUT_NAME = "Starherd_安装程序"


def log(msg: str) -> None:
    print(f"[installer] {msg}", flush=True)


def build() -> Path:
    if not GAME_EXE.is_file():
        raise SystemExit(f"缺少游戏本体：{GAME_EXE}（先运行 python python/build_exe.py）")
    work = ROOT / "build" / "installer"
    if work.exists():
        shutil.rmtree(work, ignore_errors=True)
    # 复用 build_exe.py 的 PyInstaller 驱动：本机 site-packages 里有一份废弃的 pathlib backport，
    # PyInstaller 的前置检查会因此直接 SystemExit 拒绝运行（而 import pathlib 实际走标准库）。
    # 驱动对"废弃 backport"检查做**定向豁免**，避免去动共享环境。见 build_exe.py 源码注释。
    sys.path.insert(0, str(HERE))
    from build_exe import ensure_pyi_driver  # noqa: PLC0415
    driver = ensure_pyi_driver()
    cmd = [
        sys.executable, str(driver),
        "--noconfirm", "--clean", "--onefile", "--windowed",
        "--name", OUT_NAME,
        "--distpath", str(DIST_EXE),
        "--workpath", str(work),
        "--specpath", str(ROOT / "build"),
        # payload：游戏本体打进安装程序内部（运行时从 sys._MEIPASS 取）
        "--add-data", f"{GAME_EXE}{';' if sys.platform == 'win32' else ':'}.",
        # tkinter 需要显式带上（onefile 下 PyInstaller 一般能自动收集，这里兜底）
        "--hidden-import", "tkinter",
        "--hidden-import", "tkinter.filedialog",
        "--hidden-import", "tkinter.messagebox",
        "--hidden-import", "tkinter.ttk",
        str(ENTRY),
    ]
    log("PyInstaller 打包 → " + OUT_NAME + ".exe")
    r = subprocess.run(cmd, cwd=str(ROOT))
    if r.returncode != 0:
        raise SystemExit(f"PyInstaller 失败（退出码 {r.returncode}）")
    out = DIST_EXE / f"{OUT_NAME}.exe"
    if not out.is_file():
        raise SystemExit(f"未生成产物：{out}")
    log(f"产物 {out}  {out.stat().st_size:,} B ({out.stat().st_size/1048576:.2f} MB)")
    return out


def smoke(exe: Path) -> bool:
    """静默安装 → 校验文件/快捷方式/注册表 → 卸载 → 校验清理，全程无 GUI。"""
    tmp = Path(tempfile.mkdtemp(prefix="lc_inst_"))
    target = tmp / "Starherd"
    log(f"静默安装到 {target}")
    r = subprocess.run([str(exe), "--silent", f"--dir={target}", "--desktop=1",
                        "--menu=1", "--run=0"], capture_output=True, text=True)
    print(r.stdout.strip())
    if r.returncode != 0:
        log(f"✗ 安装失败（退出码 {r.returncode}）")
        return False
    ok = True
    checks = [
        ("游戏本体", (target / "Starherd.exe").is_file()),
        ("使用说明", (target / "使用说明.txt").is_file()),
        ("卸载入口", (target / "卸载 Starherd.bat").is_file()),
    ]
    for name, passed in checks:
        log(f"  {'✓' if passed else '✗'} {name}")
        ok = ok and passed
    # 桌面 / 开始菜单快捷方式
    desk = Path.home() / "Desktop" / "Starherd.lnk"
    menu = (Path.home() / "AppData" / "Roaming" / "Microsoft" / "Windows"
            / "Start Menu" / "Programs" / "Starherd.lnk")
    for name, lnk in (("桌面快捷方式", desk), ("开始菜单项", menu)):
        exists = lnk.is_file()
        tgt = ""
        if exists:
            tgt = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 f"(New-Object -ComObject WScript.Shell).CreateShortcut('{lnk}').TargetPath"],
                capture_output=True, text=True).stdout.strip()
        good = exists and tgt.lower().endswith("starherd.exe")
        log(f"  {'✓' if good else '✗'} {name} → {tgt or '(缺失)'}")
        ok = ok and good
    # 卸载
    log("静默卸载")
    r = subprocess.run([str(exe), "--uninstall", "--silent", f"--dir={target}"],
                       capture_output=True, text=True)
    print(r.stdout.strip())
    gone = not (target / "Starherd.exe").exists()
    lnk_gone = not desk.exists() and not menu.exists()
    log(f"  {'✓' if gone else '✗'} 程序文件已删除")
    log(f"  {'✓' if lnk_gone else '✗'} 快捷方式已删除")
    ok = ok and gone and lnk_gone
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.rmtree(target, ignore_errors=True)
    return ok


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="打包《牧星者》安装程序")
    ap.add_argument("--no-smoke", action="store_true", help="跳过静默安装自检")
    args = ap.parse_args(argv)
    print("=" * 58)
    print("  STARHERD ／ 安装程序打包 (build_installer.py)")
    print("=" * 58)
    exe = build()
    if not args.no_smoke:
        print("-" * 58)
        ok = smoke(exe)
        print("-" * 58)
        log(f"静默自检：{'PASS' if ok else 'FAIL'}")
        return 0 if ok else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
