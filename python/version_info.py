"""version_info.py —— 生成 PyInstaller 的 --version-file（Windows 文件属性）。

让 EXE 的「属性 → 详细信息」里能看到制作者、仓库与**联系邮箱**——
扩展方案第 7 项的最后一块（界面里的联系方式早已铺开，这里是文件层面的）。

用法：python python/version_info.py            # 打印生成文件的路径
"""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
import host  # noqa: E402  （取 VERSION，保持单一来源）

VERSION = host.VERSION
AUTHOR = "海米糕 / MiKaoHai"
EMAIL = "haimikao0721@gmail.com"
REPO = "https://github.com/haimikao0721-a11y/Starherd"
OUT = ROOT / "build" / "version_info.txt"


def parts(v: str) -> tuple[int, int, int, int]:
    nums = [int(x) for x in v.split(".")[:3]]
    while len(nums) < 3:
        nums.append(0)
    return (nums[0], nums[1], nums[2], 0)


def generate() -> pathlib.Path:
    a, b, c, d = parts(VERSION)
    text = f"""# UTF-8 — 由 python/version_info.py 自动生成，请勿手改
VSVersionInfo(
  ffi=FixedFileInfo(
    filevers=({a}, {b}, {c}, {d}),
    prodvers=({a}, {b}, {c}, {d}),
    mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)
  ),
  kids=[
    StringFileInfo([
      StringTable('080404B0', [
        StringStruct('CompanyName', '{AUTHOR}'),
        StringStruct('FileDescription', '牧星者 / STARHERD —— 引力井太空摆渡'),
        StringStruct('FileVersion', '{VERSION}'),
        StringStruct('InternalName', 'Starherd'),
        StringStruct('LegalCopyright', 'MIT License'),
        StringStruct('OriginalFilename', 'Starherd.exe'),
        StringStruct('ProductName', '牧星者 / STARHERD'),
        StringStruct('ProductVersion', '{VERSION}'),
        StringStruct('Comments', '反馈邮箱 {EMAIL} · 仓库 {REPO} —— 发现问题或想加关卡都欢迎写信'),
      ])
    ]),
    VarFileInfo([VarStruct('Translation', [0x0804, 1200])])
  ]
)
"""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8")
    return OUT


if __name__ == "__main__":
    p = generate()
    print(p)
