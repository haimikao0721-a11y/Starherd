#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""shot_field.py —— 引力井「吸引 / 排斥」渲染对比截图（渲染层可读性修复的证据）

用法:
  python tools/shot_field.py                 # 连 http://127.0.0.1:8801
  python tools/shot_field.py --base URL --channel msedge

产出（1600x900，device_scale_factor=1）:
  docs/screenshots/field_attract.png       第 1 关（loop1 调色板）吸引
  docs/screenshots/field_repel.png         第 1 关（loop1 调色板）排斥
  docs/screenshots/field_attract_loop3.png 第 3 章 L3-1（loop3 调色板，well/orbit 几乎同色）吸引
  docs/screenshots/field_repel_loop3.png   第 3 章 L3-1（loop3 调色板）排斥

第 1 关用 ?shot=1&tu=6&level=3&field=attract|repel（URL 调试入口，见 src/game/game.ts）。
第 3 章用同一入口起页，再用页面内的私有入口把世界切到 L3-1 并重新强制极性后重绘一帧
（?shot=1 的关卡参数只对 ?autotest=1 生效，这里不改源码，只在测试侧驱动）。

退出码 0 = 全部截图产出成功。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "docs" / "screenshots"
SHOTS.mkdir(parents=True, exist_ok=True)

# 切到第 3 章第 1 关（index 7 → L3-1 → palette loop3），预热后强制极性并重绘静帧。
# 取景：把井移到货舱（没有存活货舱就用镜头中心）旁边，90 帧静帧期间相机会平滑对焦到井，
# 保证两种状态拍到的是同一机位、同一井体尺寸，只有模式提示不同。
FORCE_LOOP3 = """
(mode) => {
  const g = window.__LC_GAME;
  g.startLevelAt(7);
  g.warmupAndStill(2);          // 短预热：保留关卡初始氛围
  const w = g.worldRef;
  let px = null, py = null;
  for (const p of w.pods) if (p.alive && !p.delivered) { px = p.x; py = p.y; break; }
  const cx = (px === null ? g.renderer.camX : px) + 0.28;
  const cy = (py === null ? g.renderer.camY : py) + 0.18;
  w.well.x = w.well.px = w.well.tx = w.well.ltx = cx;
  w.well.y = w.well.py = w.well.ty = w.well.lty = cy;
  w.well.vx = w.well.vy = w.well.tvx = w.well.tvy = 0;
  w.well.mass = w.well.targetMass = 0.06;
  w.well.engaged = true;
  w.well.repel = mode === 'repel';
  g.warmupAndStill(0);          // 不再推进模拟，只按强制后的状态重绘静帧（相机在此对焦）
  return {
    level: w.level.id, chapter: w.level.chapter, palette: g.palette.id,
    mode: w.well.repel ? 'repel' : 'attract', engaged: w.well.engaged, mass: w.well.mass,
    camZoom: Number(g.view.camera.zoom.toFixed(2)), podAlive: px !== null,
  };
}
"""


def main() -> int:
    ap = argparse.ArgumentParser(description="牧星者 · 引力井模式对比截图")
    ap.add_argument("--base", default="http://127.0.0.1:8801")
    ap.add_argument("--channel", default="msedge")
    ap.add_argument("--w", type=int, default=1600)
    ap.add_argument("--h", type=int, default=900)
    ap.add_argument("--tu", type=float, default=6.0, help="截图前的模拟预热时长（TU）")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    from playwright.sync_api import sync_playwright

    errors: list[str] = []
    results: list[tuple[str, int, str]] = []
    ok = True
    with sync_playwright() as pw:
        br = pw.chromium.launch(channel=args.channel, headless=True, args=["--disable-gpu"])
        ctx = br.new_context(viewport={"width": args.w, "height": args.h}, device_scale_factor=1)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: errors.append(f"console.error: {m.text}") if m.type == "error" else None)

        # ---- 第 1 关（loop1）：URL 调试入口 ?field= ----
        for mode in ("attract", "repel"):
            out = SHOTS / f"field_{mode}.png"
            page.goto(f"{base}/?shot=1&tu={args.tu:g}&level=3&field={mode}", wait_until="load", timeout=60000)
            page.wait_for_function("document.title.startsWith('SHOT')", timeout=180000)
            page.wait_for_timeout(600)   # 等最后一帧合成完
            page.screenshot(path=str(out))
            dbg = page.evaluate("window.__LC_DEBUG") or {}
            info = f"level1 palette=loop1 screen={dbg.get('screen')} status={dbg.get('status')}"
            results.append((out.name, out.stat().st_size, info))
            ok = ok and out.stat().st_size > 60_000

        # ---- 第 3 章 L3-1（loop3，well/orbit 几乎同色）----
        for mode in ("attract", "repel"):
            out = SHOTS / f"field_{mode}_loop3.png"
            page.goto(f"{base}/?shot=1&tu={args.tu:g}&field={mode}", wait_until="load", timeout=60000)
            page.wait_for_function("document.title.startsWith('SHOT')", timeout=180000)
            info_d = page.evaluate(FORCE_LOOP3, mode)
            page.wait_for_timeout(600)
            page.screenshot(path=str(out))
            results.append((out.name, out.stat().st_size, str(info_d)))
            ok = ok and out.stat().st_size > 60_000
        br.close()

    for name, size, info in results:
        print(f"  {'PASS' if size > 60_000 else 'FAIL'}  {name}  {size} 字节  {info}")
    print(f"[shot_field] JS 报错: {'无' if not errors else ' | '.join(errors[:3])}")
    return 0 if ok and not errors else 1


if __name__ == "__main__":
    sys.exit(main())
