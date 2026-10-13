"""installer.py —— 《牧星者 / STARHERD》安装程序（自带 GUI + 静默模式，纯标准库）。

为什么自产
----------
目标机器上**不装任何环境**：不能用 Inno Setup / NSIS（本机也没有），所以这个安装程序
自己就是 PyInstaller 打出来的单文件 EXE，内嵌游戏本体 `Starherd.exe` 作为 payload。

功能
----
* **选择安装目录**（默认 ``%LOCALAPPDATA%\\Programs\\Starherd``，全程无需管理员权限）；
* **创建桌面快捷方式** / **创建开始菜单项**（可选，`.lnk` 用 PowerShell 的 WScript.Shell 生成）；
* 可选**安装后立即运行**；
* 写入 HKCU 的"应用和功能"登记（卸载入口）+ 安装目录内 ``卸载 Starherd.bat``；
* **静默模式**（用于自动化验证）::

      Starherd_安装程序.exe --silent --dir=D:\\Games\\Starherd --desktop=1 --menu=1 --run=0
      Starherd_安装程序.exe --uninstall --silent --dir=D:\\Games\\Starherd

设计取舍
--------
* 只写 **HKCU**（当前用户）→ 不需要 UAC，装到用户目录也不触发 SmartScreen 的"管理员"分支；
* 快捷方式不依赖 pywin32（目标机没有）→ 走 PowerShell COM（Windows 全版本自带）；
* 卸载用批处理延迟自删（bat 无法删除正在运行的自身，用 ``start /b`` 分离后删）。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

APP_NAME = "Starherd"
APP_TITLE = "牧星者 / STARHERD"
GAME_EXE = "Starherd.exe"
UNINST_KEY = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Starherd"
VERSION = "1.2.2"

# 是否由 PyInstaller 打包运行
FROZEN = bool(getattr(sys, "frozen", False))


def payload_path() -> Path:
    """内嵌的游戏本体路径（打包后在 sys._MEIPASS；源码运行时在本目录）。"""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    for cand in (base / GAME_EXE, Path(__file__).resolve().parent / GAME_EXE,
                 Path(__file__).resolve().parent.parent / "dist_exe" / GAME_EXE):
        if cand.is_file():
            return cand
    return base / GAME_EXE


def default_dir() -> Path:
    """默认安装目录：%LOCALAPPDATA%\\Programs\\Starherd（用户级，无需管理员）。"""
    la = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(la) / "Programs" / APP_NAME


def desktop_dir() -> Path:
    return Path(os.environ.get("USERPROFILE", str(Path.home()))) / "Desktop"


def start_menu_dir() -> Path:
    appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs"


def _run_hidden(args: list[str]) -> tuple[bool, str]:
    """跑子进程且不弹黑框（create_no_window）。"""
    try:
        flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
        p = subprocess.run(args, capture_output=True, text=True, timeout=60,
                           creationflags=flags)
        return p.returncode == 0, (p.stdout or "") + (p.stderr or "")
    except Exception as exc:  # noqa: BLE001
        return False, repr(exc)


def make_shortcut(lnk: Path, target: Path, workdir: Path, desc: str) -> bool:
    """用 PowerShell 的 WScript.Shell 生成 .lnk（不依赖 pywin32）。"""
    lnk.parent.mkdir(parents=True, exist_ok=True)
    icon = target
    ps = (
        "$ws = New-Object -ComObject WScript.Shell; "
        f"$s = $ws.CreateShortcut('{lnk}'); "
        f"$s.TargetPath = '{target}'; "
        f"$s.WorkingDirectory = '{workdir}'; "
        f"$s.IconLocation = '{icon},0'; "
        f"$s.Description = '{desc}'; "
        "$s.Save()"
    )
    ok, _ = _run_hidden(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps])
    return ok and lnk.exists()


def write_uninstaller(install_dir: Path, *, desktop: bool, menu: bool) -> Path:
    """在安装目录生成卸载批处理（延迟自删）。"""
    bat = install_dir / f"卸载 {APP_NAME}.bat"
    lnks = []
    if desktop:
        lnks.append(desktop_dir() / f"{APP_NAME}.lnk")
    if menu:
        lnks.append(start_menu_dir() / f"{APP_NAME}.lnk")
    lines = [
        "@echo off",
        "chcp 65001 >nul",
        f"title 卸载 {APP_TITLE}",
        "echo.",
        f"echo   正在卸载 {APP_TITLE} ...",
        "echo.",
        "reg delete \"HKCU\\" + UNINST_KEY + "\" /f >nul 2>nul",
    ]
    for lnk in lnks:
        lines.append(f'del /f /q "{lnk}" >nul 2>nul')
    lines += [
        "echo   已删除快捷方式与注册表登记。",
        "echo   正在删除程序文件 ...",
        # bat 无法删除自身：分离出一个延迟命令，等本进程退出后再删目录
        f'start "" /b cmd /c "ping 127.0.0.1 -n 2 >nul & rmdir /s /q \\"{install_dir}\\""',
        "exit /b 0",
        "",
    ]
    bat.write_text("\r\n".join(lines), encoding="utf-8")
    return bat


def register_uninstall(install_dir: Path, uninstall_bat: Path) -> bool:
    """写入 HKCU 的"应用和功能"登记（无需管理员权限）。"""
    try:
        import winreg  # type: ignore
    except Exception:  # noqa: BLE001
        return False
    try:
        key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, UNINST_KEY)
        vals = {
            "DisplayName": APP_TITLE,
            "DisplayVersion": VERSION,
            "Publisher": "STARHERD",
            "InstallLocation": str(install_dir),
            "DisplayIcon": str(install_dir / GAME_EXE),
            "UninstallString": f'"{uninstall_bat}"',
            "NoModify": 1,
            "NoRepair": 1,
        }
        for k, v in vals.items():
            winreg.SetValueEx(key, k, 0, winreg.REG_SZ if isinstance(v, str) else winreg.REG_DWORD, v)
        winreg.CloseKey(key)
        return True
    except Exception:  # noqa: BLE001
        return False


def remove_registry() -> None:
    try:
        import winreg  # type: ignore
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, UNINST_KEY)
    except Exception:  # noqa: BLE001
        pass


def do_install(install_dir: Path, *, desktop: bool, menu: bool, run_after: bool,
               log=print) -> int:
    """执行安装。返回进程退出码。"""
    src = payload_path()
    if not src.is_file():
        log(f"[错误] 找不到内嵌的游戏本体：{src}")
        return 2
    try:
        install_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        log(f"[错误] 无法创建安装目录 {install_dir}：{exc}")
        return 3
    dst = install_dir / GAME_EXE
    log(f"  复制 {src.name} → {dst}")
    try:
        shutil.copy2(src, dst)
    except OSError as exc:
        log(f"[错误] 复制失败：{exc}")
        return 4
    # 说明文件（分发时对方最需要知道的两件事）
    (install_dir / "使用说明.txt").write_text(
        f"{APP_TITLE}\r\n"
        "=" * 40 + "\r\n\r\n"
        "双击 Starherd.exe 即可开始游戏。\r\n\r\n"
        "首次运行若弹出「Windows 已保护你的电脑 / 未知发布者」：\r\n"
        "  点「更多信息」→「仍要运行」即可（程序未做数字签名，属正常现象）。\r\n\r\n"
        "不需要安装 Python 或任何运行环境；存档位于：\r\n"
        "  %LOCALAPPDATA%\\Starherd\\save.json\r\n\r\n"
        "卸载：运行本目录下的「卸载 Starherd.bat」，或从\r\n"
        "「设置 → 应用 → 已安装的应用」中卸载。\r\n\r\n"
        "----------------------------------------\r\n"
        "制作者：海米糕\r\n"
        "  仓库：https://github.com/haimikao0721-a11y/Starherd\r\n"
        "  主页：https://github.com/haimikao0721-a11y\r\n"
        "  邮箱：haimikao0721@gmail.com（反馈 bug / 建议关卡都欢迎）\r\n"
        "觉得好玩就在仓库页面点个 Star ⭐ —— 这是对独立开发者最实在的鼓励。\r\n"
        "（游戏内也能找到同样内容：主菜单 → 关于本作）\r\n",
        encoding="utf-8")
    bat = write_uninstaller(install_dir, desktop=desktop, menu=menu)
    log(f"  生成卸载入口：{bat.name}")
    if register_uninstall(install_dir, bat):
        log("  已登记到「应用和功能」（HKCU，无需管理员）")
    if desktop:
        lnk = desktop_dir() / f"{APP_NAME}.lnk"
        ok = make_shortcut(lnk, dst, install_dir, APP_TITLE)
        log(f"  桌面快捷方式：{'✓ ' + str(lnk) if ok else '✗ 创建失败'}")
    if menu:
        lnk = start_menu_dir() / f"{APP_NAME}.lnk"
        ok = make_shortcut(lnk, dst, install_dir, APP_TITLE)
        log(f"  开始菜单项：{'✓ ' + str(lnk) if ok else '✗ 创建失败'}")
    log(f"  安装完成 → {install_dir}")
    if run_after:
        log("  正在启动游戏 ...")
        try:
            flags = 0x00000008 if os.name == "nt" else 0  # DETACHED_PROCESS
            subprocess.Popen([str(dst)], cwd=str(install_dir), creationflags=flags)
        except Exception as exc:  # noqa: BLE001
            log(f"  [警告] 启动失败：{exc!r}")
    return 0


def do_uninstall(install_dir: Path, *, log=print) -> int:
    """静默卸载（删快捷方式 / 注册表 / 目录）。"""
    remove_registry()
    for lnk in (desktop_dir() / f"{APP_NAME}.lnk", start_menu_dir() / f"{APP_NAME}.lnk"):
        try:
            if lnk.exists():
                lnk.unlink()
                log(f"  已删除 {lnk}")
        except OSError:
            pass
    if install_dir.is_dir():
        # 正在运行的 exe 删不掉：先尽量删，剩下的交给系统（或提示用户）
        failed = []
        for p in sorted(install_dir.rglob("*"), reverse=True):
            try:
                if p.is_file():
                    p.unlink()
                elif p.is_dir():
                    p.rmdir()
            except OSError:
                failed.append(p)
        try:
            install_dir.rmdir()
        except OSError:
            failed.append(install_dir)
        log(f"  已清理 {install_dir}" + (f"（{len(failed)} 项被占用，稍后可手动删除）" if failed else ""))
    return 0


# ------------------------------------------------------------------ GUI

def run_gui() -> int:
    """tkinter 安装界面（目标机无需任何 Python 环境，已打包进 EXE）。"""
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    root = tk.Tk()
    root.title(f"{APP_TITLE} 安装程序")
    root.geometry("560x300")
    root.resizable(False, False)
    try:
        root.iconbitmap(default="")
    except Exception:  # noqa: BLE001
        pass

    frm = ttk.Frame(root, padding=16)
    frm.pack(fill="both", expand=True)

    ttk.Label(frm, text=APP_TITLE, font=("Microsoft YaHei UI", 14, "bold")).pack(anchor="w")
    ttk.Label(frm, text=f"版本 {VERSION}　·　安装到你所选择的目录，无需管理员权限",
              foreground="#666").pack(anchor="w", pady=(2, 12))

    ttk.Label(frm, text="安装目录：").pack(anchor="w")
    row = ttk.Frame(frm)
    row.pack(fill="x", pady=(4, 10))
    var_dir = tk.StringVar(value=str(default_dir()))
    ent = ttk.Entry(row, textvariable=var_dir)
    ent.pack(side="left", fill="x", expand=True)

    def browse() -> None:
        d = filedialog.askdirectory(title="选择安装目录", initialdir=str(Path(var_dir.get()).parent))
        if d:
            var_dir.set(str(Path(d) / APP_NAME) if Path(d).name.lower() != APP_NAME.lower() else d)

    ttk.Button(row, text="浏览…", command=browse, width=10).pack(side="left", padx=(8, 0))

    var_desk = tk.BooleanVar(value=True)
    var_menu = tk.BooleanVar(value=True)
    var_run = tk.BooleanVar(value=True)
    ttk.Checkbutton(frm, text="创建桌面快捷方式", variable=var_desk).pack(anchor="w")
    ttk.Checkbutton(frm, text="创建开始菜单项", variable=var_menu).pack(anchor="w")
    ttk.Checkbutton(frm, text="安装完成后立即运行", variable=var_run).pack(anchor="w")

    status = ttk.Label(frm, text="", foreground="#0a7")
    status.pack(anchor="w", pady=(8, 0))
    btns = ttk.Frame(frm)
    btns.pack(side="bottom", fill="x", pady=(10, 0))

    def on_install() -> None:
        btn_install.state(["disabled"])
        root.update_idletasks()
        msgs: list[str] = []
        code = do_install(Path(var_dir.get()), desktop=var_desk.get(), menu=var_menu.get(),
                          run_after=False, log=msgs.append)
        status.config(text="\n".join(m.strip() for m in msgs[-3:]) or "完成")
        if code == 0:
            if var_run.get():
                try:
                    flags = 0x00000008 if os.name == "nt" else 0
                    subprocess.Popen([str(Path(var_dir.get()) / GAME_EXE)],
                                     cwd=var_dir.get(), creationflags=flags)
                except Exception:  # noqa: BLE001
                    pass
            messagebox.showinfo("安装完成", f"已安装到：\n{var_dir.get()}\n\n"
                                            + ("桌面快捷方式已创建。\n" if var_desk.get() else "")
                                            + ("开始菜单项已创建。\n" if var_menu.get() else "")
                                            + "\n首次运行若提示「Windows 已保护你的电脑」，"
                                              "点「更多信息 → 仍要运行」即可。")
            root.destroy()
        else:
            btn_install.state(["!disabled"])
            messagebox.showerror("安装失败", "\n".join(msgs) or "未知错误")

    btn_install = ttk.Button(btns, text="安装", command=on_install)
    btn_install.pack(side="right")
    ttk.Button(btns, text="取消", command=root.destroy).pack(side="right", padx=(0, 8))
    root.mainloop()
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=f"{APP_TITLE} 安装程序")
    ap.add_argument("--silent", action="store_true", help="静默安装（无界面，用于自动化验证）")
    ap.add_argument("--dir", default="", help="安装目录（默认 %%LOCALAPPDATA%%\\Programs\\Starherd）")
    ap.add_argument("--desktop", type=int, default=1, help="1=创建桌面快捷方式")
    ap.add_argument("--menu", type=int, default=1, help="1=创建开始菜单项")
    ap.add_argument("--run", type=int, default=0, help="1=安装后立即运行")
    ap.add_argument("--uninstall", action="store_true", help="静默卸载")
    ap.add_argument("--payload", default="", help="指定游戏本体路径（默认用内嵌 payload）")
    args = ap.parse_args(argv)

    target = Path(args.dir) if args.dir else default_dir()
    if args.payload:
        globals()["payload_path"] = lambda: Path(args.payload)  # type: ignore[assignment]

    if args.uninstall:
        return do_uninstall(target)
    if args.silent:
        return do_install(target, desktop=bool(args.desktop), menu=bool(args.menu),
                          run_after=bool(args.run))
    return run_gui()


if __name__ == "__main__":
    sys.exit(main())
