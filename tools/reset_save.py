"""reset_save.py —— 查看/修复存档里的解锁进度（默认只做演练，不改文件）。

背景：早期自动化验收脚本会以"真人路径"驱动真实 UI（点关卡 → 简报 → 开始 → 游玩），
而它连的是同一个宿主，于是**替玩家解锁了关卡**。该问题已修（`--dev` 现在会把数据目录
隔离到临时目录），但已经被写脏的存档需要还原一次。

用法::

    python tools/reset_save.py                      # 只看现状（不改）
    python tools/reset_save.py --chapter 1          # 还原到"只解锁第 1 章"
    python tools/reset_save.py --clear-scores L2-1 L2-2
    python tools/reset_save.py --chapter 1 --yes    # 真正写入（先自动备份）
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path


def save_path() -> Path:
    override = os.environ.get("STARHERD_DATA_DIR", "").strip()
    root = Path(override) if override else Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Starherd"
    return root / "save.json"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="查看/修复《牧星者》存档")
    ap.add_argument("--chapter", type=int, default=0, help="把解锁章节设为该值（1~4）")
    ap.add_argument("--clear-scores", nargs="*", default=[], help="删除这些关卡的成绩记录")
    ap.add_argument("--yes", action="store_true", help="真正写入（默认只演练）")
    args = ap.parse_args(argv)

    p = save_path()
    if not p.is_file():
        print(f"找不到存档：{p}")
        return 1
    d = json.loads(p.read_text(encoding="utf-8"))
    print(f"存档：{p}")
    print(f"  解锁章节    : {d.get('unlocked_chapters')}（1 章 = 前 3 关，2 章 = 前 6 关 …）")
    print(f"  有成绩的关卡: {sorted(d.get('best_scores', {}).keys())}")
    print(f"  统计        : {d.get('totals')}")

    changed = False
    if args.chapter:
        d["unlocked_chapters"] = max(1, min(4, args.chapter))
        changed = True
        print(f"  → 解锁章节将设为 {d['unlocked_chapters']}")
    for lv in args.clear_scores:
        if lv in d.get("best_scores", {}):
            del d["best_scores"][lv]
            changed = True
            print(f"  → 将删除成绩记录 {lv}")
        else:
            print(f"  （{lv} 本来就没有成绩记录）")

    if not changed:
        print("\n没有要改的内容。用 --chapter N 或 --clear-scores L2-1 指定改动。")
        return 0
    if not args.yes:
        print("\n演练模式：没有写入任何内容。加 --yes 才会真正修改（会自动备份）。")
        return 0

    bak = p.with_suffix(f".json.bak-{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(p, bak)
    p.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n已写入。备份：{bak.name}")
    print(f"  解锁章节    : {d.get('unlocked_chapters')}")
    print(f"  有成绩的关卡: {sorted(d.get('best_scores', {}).keys())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
