"""bench_settings.py —— 设置界面功能实测 + 性能基准对比（改前/改后）。

用途：验证玩家反馈的三项性能设置真的生效，并给出可复现的对比数据。
无头环境（--disable-gpu）的绝对帧率低于真机，但**相对差异**有效，用于判断优化是否有效。

用法::

    python tools/bench_settings.py            # 实测控件 + 四组配置基准
    python tools/bench_settings.py --quick    # 只跑控件实测
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
URL = "http://127.0.0.1:8801/"

# 每组配置：(名称, 在页面里执行的设置动作)
CONFIGS = [
    ("默认（自动分辨率 / 120Hz / 不限帧率）", "() => {}"),
    ("帧率上限 30", "() => { document.querySelector('select[data-set=\"fpsCap\"]').value='30';"
                    " document.querySelector('select[data-set=\"fpsCap\"]').dispatchEvent(new Event('change',{bubbles:true})); }"),
    ("物理步长 60Hz", "() => { const s=document.querySelector('select[data-set=\"physics60\"]');"
                      " s.value='1'; s.dispatchEvent(new Event('change',{bubbles:true})); }"),
    ("手动分辨率 50%", "() => { const s=document.querySelector('select[data-set=\"renderScaleAuto\"]');"
                       " s.value='fixed'; s.dispatchEvent(new Event('change',{bubbles:true}));"
                       " const r=document.querySelector('input[data-set=\"renderScale\"]');"
                       " r.value='0.5'; r.dispatchEvent(new Event('input',{bubbles:true}));"
                       " r.dispatchEvent(new Event('change',{bubbles:true})); }"),
]


def sample(page, seconds: float) -> dict:
    """采样若干秒的帧时，返回统计。"""
    raw = page.evaluate(
        """async (sec) => {
            const out = [];
            const t0 = performance.now();
            while (performance.now() - t0 < sec * 1000) {
                await new Promise(r => requestAnimationFrame(r));
                const d = window.__LC_DEBUG;
                if (d && d.frameMs > 0) out.push(d.frameMs);
            }
            return out;
        }""", seconds)
    if not raw:
        return {"n": 0, "p50": 0, "p95": 0, "fps": 0}
    raw.sort()
    p50 = statistics.median(raw)
    p95 = raw[min(len(raw) - 1, int(len(raw) * 0.95))]
    return {"n": len(raw), "p50": p50, "p95": p95, "fps": 1000.0 / p50 if p50 > 0 else 0}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="设置界面实测与性能基准")
    ap.add_argument("--quick", action="store_true", help="只做控件功能实测")
    ap.add_argument("--seconds", type=float, default=5.0, help="每组采样秒数")
    args = ap.parse_args(argv)

    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True, args=["--disable-gpu"])
        page = browser.new_context(viewport={"width": 1280, "height": 800}).new_page()
        errs: list[str] = []
        page.on("pageerror", lambda e: errs.append(str(e)[:160]))
        page.goto(URL, wait_until="load", timeout=90000)
        page.wait_for_function("window.__LC_DEBUG", timeout=90000)
        page.evaluate("localStorage.setItem('lc_tut_seen','1'); localStorage.setItem('lc_guide_seen','1')")
        page.reload(wait_until="load")
        page.wait_for_function("window.__LC_DEBUG", timeout=90000)
        page.wait_for_timeout(1500)

        # ---- 1. 设置界面控件实测 ----
        print("=" * 66)
        print("  设置界面控件实测")
        print("=" * 66)
        page.evaluate("() => window.__LC_GAME.setScreen('menu')")
        page.wait_for_timeout(400)
        page.evaluate("() => { const g = window.__LC_GAME; g.menu.show('settings'); }")
        page.wait_for_timeout(600)
        found = page.evaluate(
            """() => {
                const q = (s) => !!document.querySelector(s);
                return {
                    fpsCap: q('select[data-set="fpsCap"]'),
                    renderScale: q('input[data-set="renderScale"]'),
                    renderScaleAuto: q('select[data-set="renderScaleAuto"]'),
                    physics60: q('select[data-set="physics60"]'),
                };
            }""")
        for k, v in found.items():
            print(f"  {'✓' if v else '✗'} {k}")
        page.screenshot(path=str(ROOT / "docs" / "screenshots" / "settings_perf.png"))

        # 逐项验证真的生效
        page.select_option('select[data-set="fpsCap"]', "60")
        page.wait_for_timeout(300)
        cap = page.evaluate("() => window.__LC_GAME.loop.minFrameMs")
        print(f"  帧率上限 60 → loop.minFrameMs = {cap:.3f} ms  {'✓' if abs(cap - 16.67) < 0.1 else '✗'}")

        page.select_option('select[data-set="renderScaleAuto"]', "fixed")
        page.wait_for_timeout(200)
        page.eval_on_selector('input[data-set="renderScale"]',
                              "el => { el.value = '0.5'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }")
        page.wait_for_timeout(500)
        rs = page.evaluate("() => window.__LC_GAME.renderer.renderScale")
        auto = page.evaluate("() => window.__LC_GAME.renderer.renderScaleAuto")
        print(f"  手动分辨率 50% → renderScale = {rs:.2f}, auto = {auto}  {'✓' if abs(rs - 0.5) < 0.02 and not auto else '✗'}")

        page.select_option('select[data-set="physics60"]', "1")
        page.wait_for_timeout(300)
        dt = page.evaluate("() => window.__LC_GAME.loop.fixedDt")
        print(f"  物理步长 60Hz → fixedDt = {dt:.6f} TU  {'✓' if dt > 0.0045 else '✗'}")

        # 恢复默认
        page.select_option('select[data-set="fpsCap"]', "0")
        page.select_option('select[data-set="renderScaleAuto"]', "auto")
        page.select_option('select[data-set="physics60"]', "0")
        page.wait_for_timeout(400)

        if args.quick:
            browser.close()
            return 0

        # ---- 2. 性能基准（进游戏、开 AI、逐组采样）----
        print()
        print("=" * 66)
        print("  性能基准（无头 --disable-gpu，绝对值低于真机，看相对差异）")
        print("=" * 66)
        results = []
        for name, action in CONFIGS:
            page.evaluate("() => { const g = window.__LC_GAME; g.autotest = false; g.attract = true;"
                          " g.loadWorld(0); g.setScreen('play'); }")
            page.wait_for_timeout(1200)
            page.evaluate("() => window.__LC_GAME.menu.show('settings')")   # 保留设置页以便操作控件
            page.wait_for_timeout(300)
            page.evaluate(action)
            page.wait_for_timeout(800)
            page.evaluate("() => window.__LC_GAME.setScreen('play')")
            page.wait_for_timeout(600)
            st = sample(page, args.seconds)
            results.append((name, st))
            print(f"  {name:<34} p50 {st['p50']:6.2f} ms  p95 {st['p95']:6.2f} ms  "
                  f"≈{st['fps']:5.1f} fps  (n={st['n']})")
        print()
        base = results[0][1]["p50"]
        print(f"  基准对照（第一行 = 默认配置，p50 {base:.2f} ms）：")
        for name, st in results[1:]:
            d = (st["p50"] - base) / base * 100
            print(f"    {name:<34} p50 变化 {d:+6.1f}%")
        if errs:
            print("  ⚠ 页面 JS 报错:", errs[:2])
        print(f"  截图: docs/screenshots/settings_perf.png")
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
