"""difficulty_probe.py —— 用内置 AI 探针给关卡定难度档位（客观、可复现）。

档位定义（用户标准：难，但要有通关可能性，不是极限）
--------------------------------------------------
* **普通**：AI 一次跑就通关，且用时 ≤ par_time 的 1.2 倍
* **困难**：AI 通关但很勉强（用时或燃料接近上限），**或** AI 没通关但**已经打得很近**
          （最近对接距离很小 —— 说明解法存在、只差操作）
* **挑战**：AI 没通关且离成功很远（有构造性可行性证明，但需要玩家自己发明解法）

为什么不用"跑 N 次统计成功率"
------------------------------
那需要把每关重复跑 3 遍（约 10 分钟），而现有单次结果已经携带足够信号：
**是否通关 / 用时占比 / 最近对接距离**。这里据此分档，并把原始证据一并写进
``assets/data/difficulty.json``，任何人可复核。

用法::

    python tools/difficulty_probe.py            # 跑探针 → 写档位（写进 systems.json + difficulty.json）
    python tools/difficulty_probe.py --dry      # 只报告，不写文件
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SYSTEMS = ROOT / "assets" / "data" / "systems.json"
OUT = ROOT / "assets" / "data" / "difficulty.json"

# 判定阈值
NEAR_RU = 2.2        # 未通关但最近距离小于该值 → 视为"已经很接近"（困难）
TIME_SLACK = 1.2     # 通关但用时超过 par_time 的该倍数 → 视为勉强（困难）
FUEL_SLACK = 0.92    # 通关但耗油超过预算的该比例 → 视为勉强（困难）


def run_probe(seconds: int = 150) -> str:
    """跑一次全量回归，返回其标准输出。"""
    mjs = ROOT / "tools" / "simtest.mjs"
    if not mjs.is_file():
        raise SystemExit("缺少 tools/simtest.mjs —— 先运行：npx esbuild tools/simtest.ts "
                         "--bundle --format=esm --platform=node --outfile=tools/simtest.mjs")
    p = subprocess.run([("node"), str(mjs), str(SYSTEMS), str(seconds)],
                       cwd=str(ROOT), capture_output=True, text=True)
    return (p.stdout or "") + (p.stderr or "")


def parse(out: str) -> dict[str, dict]:
    """解析回归输出里的每关一行。"""
    rows: dict[str, dict] = {}
    for line in out.splitlines():
        m = re.match(r"^(L\d+-\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+([\d.]+)\s+", line)
        if not m:
            continue
        lid, status, t, delivered, lost, _pad, closest, fuel = m.groups()
        rows[lid] = {
            "status": status,
            "success": status == "成功",
            "time": float(t),
            "delivered": int(delivered),
            "lost": int(lost),
            "closest": float("nan") if closest == "-" else float(closest),
            "fuelUsed": float(fuel),
        }
    return rows


def classify(row: dict, par_time: float, fuel_cap: float) -> tuple[str, str]:
    """返回 (档位, 理由)。"""
    if row["success"]:
        slow = par_time > 0 and row["time"] > par_time * TIME_SLACK
        thirsty = fuel_cap > 0 and row["fuelUsed"] > fuel_cap * FUEL_SLACK
        if slow or thirsty:
            why = "通关但" + ("用时接近上限" if slow else "燃料接近耗尽")
            return "困难", why
        return "普通", "AI 一次通关"
    close = row["closest"] == row["closest"] and row["closest"] < NEAR_RU  # NaN 安全
    if close:
        return "困难", f"AI 未通关但最近已到 {row['closest']:.2f} RU（解法存在，只差操作）"
    return "挑战", "AI 未通关且距离较远（有构造性可行性证明，需自行发明解法）"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="AI 探针定难度档位")
    ap.add_argument("--seconds", type=int, default=150, help="每关模拟时限（秒，默认 150）")
    ap.add_argument("--dry", action="store_true", help="只报告，不写文件")
    args = ap.parse_args(argv)

    print("=" * 70)
    print("  难度探针（内置 AI 实跑 → 客观分档）")
    print("=" * 70)
    out = run_probe(args.seconds)
    rows = parse(out)
    if not rows:
        print("解析不到任何关卡结果，原始输出尾部：")
        print("\n".join(out.splitlines()[-8:]))
        return 1

    doc = json.loads(SYSTEMS.read_text(encoding="utf-8"))
    levels = {lv["id"]: lv for lv in doc["levels"]}
    report: dict[str, dict] = {}
    counts = {"普通": 0, "困难": 0, "挑战": 0}

    for lid, row in sorted(rows.items()):
        lv = levels.get(lid, {})
        par_time = float(lv.get("par_time", 0) or 0)
        fuel_cap = (40 + 6 * float(lv.get("difficulty", 1))) * float(lv.get("fuel_scale", 1) or 1)
        grade, why = classify(row, par_time, fuel_cap)
        counts[grade] += 1
        report[lid] = {"grade": grade, "why": why, **row, "parTime": par_time, "fuelCap": fuel_cap}
        print(f"  {lid:<6} {grade:<4} 用时 {row['time']:6.2f} TU  耗油 {row['fuelUsed']:6.1f}/{fuel_cap:.0f}"
              f"  最近 {'-' if row['closest'] != row['closest'] else format(row['closest'], '.2f')} RU   {why}")

    print()
    print(f"  合计：普通 {counts['普通']} · 困难 {counts['困难']} · 挑战 {counts['挑战']}")

    if args.dry:
        return 0

    # 口径局限必须随数据一起写出去，否则分档会被误读
    caveat = ("探针内置的自动驾驶没有多段目标（objectives）逻辑：它只会朝'当前泊位'飞，"
              "泊位切换后不会重新规划。因此所有多段关卡（L5-1/L5-3/L5-6/L5-8/L5-9 等）"
              "都会被判为'挑战'——这反映的是 AI 的能力边界，不等同于人类难度。"
              "真正的人类难度需要'会切航段的 AI'或人工试玩来定。")
    OUT.write_text(json.dumps({"scale": {"普通": "AI 一次通关", "困难": "勉强通关或已很接近",
                                         "挑战": "AI 未通关（有可行性证明，需自行发明解法）"},
                               "caveat": caveat,
                               "counts": counts, "levels": report},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    for lid, r in report.items():
        if lid in levels:
            levels[lid]["difficulty_label"] = r["grade"]
    SYSTEMS.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  已写入 {OUT.relative_to(ROOT)} 与 {SYSTEMS.relative_to(ROOT)} 的 difficulty_label 字段")
    return 0


if __name__ == "__main__":
    sys.exit(main())
