"""paths.py — 《牧星者》路径解析（W-host，契约 docs/INTERFACES.md §1）。

冻结签名：
    app_root()   -> Path   开发态=项目根；frozen 态=sys._MEIPASS
    data_root()  -> Path   可写目录 %LOCALAPPDATA%\\LagrangeCourier（自动创建）
    assets_dir() -> Path   app_root()/assets
    web_dir()    -> Path   app_root()/web
    dist_dir()   -> Path   app_root()/dist
    is_frozen()  -> bool

本模块只做路径推导，不产生副作用（data_root() 会创建目录，这是契约要求）。
"""

from __future__ import annotations

import os
import sys
import logging
import shutil
import tempfile
from pathlib import Path

APP_NAME = "Starherd"
VERSION = "1.0.0"

SAVE_NAME = "save.json"
RUNTIME_NAME = "runtime.json"
SELFTEST_NAME = "selftest.json"
MANIFEST_NAME = "manifest.json"
SYSTEMS_NAME = "systems.json"


def is_frozen() -> bool:
    """是否运行在 PyInstaller 冻结态。"""
    return hasattr(sys, "_MEIPASS") or bool(getattr(sys, "frozen", False))


def app_root() -> Path:
    """开发态=项目根目录；frozen 态=解包目录 sys._MEIPASS。"""
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return Path(meipass)
    # paths.py 位于 <root>/python/paths.py
    return Path(__file__).resolve().parent.parent


def _local_appdata() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
    if base:
        return Path(base)
    home = Path.home()
    if os.name == "nt":
        return home / "AppData" / "Local"
    return home / ".local" / "share"


def data_root() -> Path:
    """可写目录：%LOCALAPPDATA%\\Starherd（不存在则自动创建）。

    若该位置不可写（罕见：只读环境变量指向了只读卷），回退到系统临时目录下的同名目录，
    以保证宿主永远能拿到一个可写目录，而不是直接崩溃。
    """
    target = _local_appdata() / APP_NAME
    try:
        target.mkdir(parents=True, exist_ok=True)
        _migrate_legacy_save(target)
        return target
    except OSError:
        fallback = Path(tempfile.gettempdir()) / APP_NAME
        try:
            fallback.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        return fallback


# 旧应用名（改名前的目录）：从《拉格朗日信使 / LAGRANGE COURIER》改为《牧星者 / STARHERD》时，
# 自动把老存档搬过来一次，保证玩家的章节解锁与最佳分不丢。只在新目录里没有存档时执行。
_LEGACY_NAMES = ("LagrangeCourier",)


def _migrate_legacy_save(new_root: Path) -> None:
    """把旧应用名目录里的存档复制到新目录（幂等；失败静默，不影响启动）。"""
    try:
        if (new_root / "save.json").exists():
            return
        for old_name in _LEGACY_NAMES:
            old = new_root.parent / old_name
            if old == new_root or not old.is_dir():
                continue
            src = old / "save.json"
            if not src.exists():
                continue
            shutil.copy2(src, new_root / "save.json")
            LOG = logging.getLogger("paths")
            LOG.info("已从旧名目录迁移存档：%s -> %s", src, new_root / "save.json")
            return
    except Exception:  # noqa: BLE001
        pass


def assets_dir() -> Path:
    return app_root() / "assets"


def web_dir() -> Path:
    return app_root() / "web"


def dist_dir() -> Path:
    return app_root() / "dist"


# ---- 便捷派生路径（附加工具函数，不属于冻结签名子集，但与之兼容） ----

def assets_data_dir() -> Path:
    return assets_dir() / "data"


def manifest_path() -> Path:
    return assets_data_dir() / MANIFEST_NAME


def systems_path() -> Path:
    return assets_data_dir() / SYSTEMS_NAME


def save_path() -> Path:
    return data_root() / SAVE_NAME


def runtime_path() -> Path:
    return data_root() / RUNTIME_NAME


def selftest_path() -> Path:
    return data_root() / SELFTEST_NAME


def python_dir() -> Path:
    """python/ 目录（模块同目录），供 sys.path 补全。"""
    return Path(__file__).resolve().parent


__all__ = [
    "APP_NAME",
    "VERSION",
    "SAVE_NAME",
    "RUNTIME_NAME",
    "SELFTEST_NAME",
    "MANIFEST_NAME",
    "SYSTEMS_NAME",
    "is_frozen",
    "app_root",
    "data_root",
    "assets_dir",
    "web_dir",
    "dist_dir",
    "assets_data_dir",
    "manifest_path",
    "systems_path",
    "save_path",
    "runtime_path",
    "selftest_path",
    "python_dir",
]
