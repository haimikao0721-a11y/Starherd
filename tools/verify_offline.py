#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
离线单文件版验收：直接双击 .html（file:// 协议）也要能完整游玩。

这是"零环境"承诺的验证：不需要 Python 宿主、不需要联网、不需要安装任何运行时。
用法: python tools/verify_offline.py [--file 路径] [--headed]
退出码 0 = 通过。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT = ROOT / "dist_offline" / "Starherd_离线单文件版.html"
SHOTS = ROOT / "docs" / "screenshots"
SHOTS.mkdir(parents=True, exist_ok=True)

RESULTS: list[tuple[str, bool, str]] = []
ERRORS: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  {detail}" if detail else ""))
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description="牧星者 · 离线单文件版验收")
    ap.add_argument("--file", default=str(DEFAULT))
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--channel", default="msedge")
    args = ap.parse_args()

    f = Path(args.file)
    if not f.exists():
        print(f"找不到离线文件：{f}\n请先运行 python python/build_offline.py", file=sys.stderr)
        return 2
    url = f.as_uri()
    print(f"[verify_offline] {f.name}  {f.stat().st_size:,} 字节\n[verify_offline] {url}")

    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        b = pw.chromium.launch(channel=args.channel, headless=not args.headed)
        page = b.new_context(viewport={"width": 1600, "height": 900}).new_page()
        page.on("pageerror", lambda e: ERRORS.append(f"pageerror: {e}"))
        page.on("console", lambda m: ERRORS.append(f"console.error: {m.text[:160]}") if m.type == "error" else None)

        page.goto(url, wait_until="load", timeout=90000)
        try:
            page.wait_for_function("window.__LC_DEBUG && window.__LC_DEBUG.screen", timeout=90000)
        except Exception as e:  # noqa: BLE001
            page.screenshot(path=str(SHOTS / "offline_failed.png"))
            check("离线启动到主菜单", False, f"{type(e).__name__}: {e}")
            b.close()
            return 1

        dbg = page.evaluate("window.__LC_DEBUG")
        check("离线启动到主菜单", dbg.get("screen") == "menu", f"screen={dbg.get('screen')} bodies={dbg.get('bodies')}")

        info = page.evaluate("""() => {
          const g = window.__LC_GAME;
          return {
            assets: g && g.assets ? [g.assets.loadedCount, g.assets.totalCount] : null,
            assetErrors: g && g.assets ? g.assets.errors.slice(0,4) : [],
            levels: g && g.doc ? g.doc.levels.length : 0,
            audioReady: !!(g && g.audio && g.audio.ready),
            musicLoaded: !!(g && g.assets && g.assets.music && (g.assets.music('loop1') || g.assets.music('menu'))),
          };
        }""")
        a = info.get("assets") or [0, 0]
        check("素材内联加载", a[0] == a[1] and a[0] >= 30, f"{a[0]}/{a[1]}，失败 {len(info.get('assetErrors') or [])}：{(info.get('assetErrors') or ['无'])[0][:60]}")
        check("关卡数据内联", (info.get("levels") or 0) >= 12, f"{info.get('levels')} 关")
        check("配乐内联可用", bool(info.get("musicLoaded")), f"audioReady={info.get('audioReady')}")
        page.screenshot(path=str(SHOTS / "offline_menu.png"))

        # 首次进入会自动弹操作演示（离线版也生效）→ 先确认它出现，再返回菜单
        tut = page.query_selector("#lc-tut-canvas")
        check("离线版也自动弹操作演示", tut is not None, "#lc-tut-canvas")
        if tut:
            back = page.query_selector('#ui-root button[data-act="back"]')
            if back:
                back.click()
                page.wait_for_timeout(600)

        # 走真实路径进游戏
        page.click('#ui-root button[data-act="start-levels"]')
        page.wait_for_timeout(700)
        cards = [c for c in page.query_selector_all('#ui-root button[data-act="level"]') if c.is_enabled()]
        check("关卡列表可用", len(cards) > 0, f"可选 {len(cards)} 关")
        if cards:
            cards[0].click()
            page.wait_for_timeout(700)
            start = page.query_selector('#ui-root button[data-act="start"]')
            if start:
                start.click()
                page.wait_for_timeout(1600)
                t1 = page.evaluate("window.__LC_DEBUG.simTime")
                page.wait_for_timeout(2500)
                d2 = page.evaluate("window.__LC_DEBUG")
                check("进入游玩且物理推进", d2.get("screen") == "play" and d2.get("simTime", 0) > t1,
                      f"screen={d2.get('screen')} simTime {t1:.2f} → {d2.get('simTime'):.2f} TU  ΔE/E={d2.get('energyDrift'):.2e}")
                page.screenshot(path=str(SHOTS / "offline_play.png"))
            else:
                check("进入游玩且物理推进", False, "简报页没有 data-act=start 按钮")

        check("无 JS 报错", not ERRORS, " | ".join(ERRORS[:2]) if ERRORS else "干净")
        b.close()

    bad = [r for r in RESULTS if not r[1]]
    print(f"\n[verify_offline] 结论：{'PASS' if not bad else 'FAIL'}  （{len(RESULTS) - len(bad)}/{len(RESULTS)} 通过）")
    for n, ok, d in RESULTS:
        if not ok:
            print(f"   ✘ {n}  {d}")
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
