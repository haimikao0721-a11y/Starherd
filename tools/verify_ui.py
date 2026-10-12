#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
UI / 运行时验收（Playwright + 真实浏览器内核）

覆盖三件事（对应交付要求里的"能否运行、流畅度"与"视觉"）：
  1. shot    : 预热推进模拟后渲染一帧 → 截图（用于人工/自动视觉检查）
  2. bench   : 固定墙钟时间内统计 fps 与帧耗时（无头=软件渲染的下限，--headed=真实 GPU）
  3. autotest: 游戏自带的 ?autotest=1 全流程自检（物理推进/渲染/对接），读回 /api/selftest

用法:
  python tools/verify_ui.py                 # 全部跑，默认连 http://127.0.0.1:8801
  python tools/verify_ui.py --base URL --only shot --headed
退出码 0 = 全部通过。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "docs" / "screenshots"
SHOTS.mkdir(parents=True, exist_ok=True)

RESULTS: list[tuple[str, bool, str]] = []
CONSOLE_ERRORS: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  {detail}" if detail else ""))
    return ok


def http_json(url: str, timeout: float = 10.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def attach_console(page) -> None:
    def on_console(msg):
        if msg.type == "error":
            CONSOLE_ERRORS.append(f"console.error: {msg.text}")
    def on_pageerror(err):
        CONSOLE_ERRORS.append(f"pageerror: {err}")
    page.on("console", on_console)
    page.on("pageerror", on_pageerror)


def dismiss_overlays(page) -> None:
    """收起会挡住菜单按钮的新手覆盖层。

    首次进入游戏会自动弹「操作演示」，此时主菜单按钮不在当前界面上，
    直接点 start-levels / quit 会一直等到超时。
    """
    for _ in range(3):
        if page.query_selector("#lc-tut-canvas") is None:
            return
        back = page.query_selector('#ui-root button[data-act="back"]')
        if not back:
            return
        back.click()
        page.wait_for_timeout(500)


def run(args) -> int:
    from playwright.sync_api import sync_playwright

    base = args.base.rstrip("/")
    only = set(args.only.split(",")) if args.only else {"menu", "shot", "bench", "autotest", "quit", "tutorial", "control"}

    print(f"[verify_ui] base={base} headed={args.headed}")
    health = http_json(f"{base}/api/health")
    check("宿主健康检查", bool(health.get("ok")), f"port={health.get('port')} backend={health.get('backend')} assets_ok={health.get('assets_ok')}")
    levels = http_json(f"{base}/api/levels")
    check("关卡数据可用", len(levels.get("levels", [])) >= 1, f"关卡数={len(levels.get('levels', []))}")
    manifest = http_json(f"{base}/api/manifest")
    n_assets = len(manifest.get("audio", [])) + len(manifest.get("art", [])) + len(manifest.get("music", []))
    check("素材清单", n_assets >= 30, f"audio={len(manifest.get('audio', []))} art={len(manifest.get('art', []))} music={len(manifest.get('music', []))}")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            channel=args.channel, headless=not args.headed,
            # 注意①：**不要**加 --autoplay-policy=no-user-gesture-required。
            # 真实用户打开页面时没有音频手势，AudioContext.resume() 会一直 pending；
            # 之前正是这个参数把"启动卡死在装载素材 100%"的 bug 掩盖了（见 src/audio/audio.ts 的超时赛跑）。
            args=["--disable-gpu" if not args.headed else "--enable-gpu-rasterization"],
        )
        ctx = browser.new_context(viewport={"width": args.w, "height": args.h}, device_scale_factor=1)
        page = ctx.new_page()
        attach_console(page)

        # ---------------- menu ----------------
        if "menu" in only:
            print("[verify_ui] 0/4 完整用户路径：主菜单 → 关卡列表 → 简报 → 开始 → 游玩")
            page.goto(f"{base}/", wait_until="load", timeout=60000)
            try:
                page.wait_for_selector("#ui-root .lc-overlay", timeout=30000)
                dismiss_overlays(page)  # 首次进入会自动弹操作演示，先收起再验证主菜单
                txt = page.inner_text("#ui-root")
                nav = page.inner_text("#ui-root .lc-overlay") if page.query_selector("#ui-root .lc-overlay") else txt
                check("主菜单渲染", "牧星者" in nav or "LAGRANGE" in nav.upper(), nav.replace("\n", " / ")[:100])
                page.wait_for_function("window.__LC_DEBUG && window.__LC_DEBUG.screen === 'menu'", timeout=30000)
                t1 = page.evaluate("window.__LC_DEBUG.simTime")
                page.wait_for_timeout(2500)
                t2 = page.evaluate("window.__LC_DEBUG.simTime")
                check("演示模式(ATTRACT)在跑", t2 > t1, f"simTime {t1:.2f} → {t2:.2f} TU（菜单背景是真实模拟）")
                page.screenshot(path=str(SHOTS / "menu.png"))

                # 主菜单 → 关卡列表
                page.click('#ui-root button[data-act="start-levels"]')
                page.wait_for_timeout(900)
                t = page.inner_text("#ui-root")
                check("进入关卡列表", "章节" in t or "CH" in t.upper() or "锁" in t, t.replace("\n", " / ")[:100])
                page.screenshot(path=str(SHOTS / "levels.png"))

                # 关卡列表 → 简报（点第一张未锁定的关卡卡）
                cards = page.query_selector_all('#ui-root button[data-act="level"]')
                clickable = [c for c in cards if c.is_enabled()]
                if not clickable:
                    check("关卡卡可点", False, f"共 {len(cards)} 张卡，全部锁定")
                else:
                    clickable[0].click()
                    page.wait_for_timeout(900)
                    t = page.inner_text("#ui-root")
                    check("进入任务简报", ("简报" in t or "目标" in t or "Δv" in t or "时限" in t), t.replace("\n", " / ")[:110])
                    page.screenshot(path=str(SHOTS / "briefing.png"))

                    # 简报 → 开始 → 真正进入游玩
                    start = page.query_selector('#ui-root button[data-act="start"]')
                    if start is None:
                        check("简报开始按钮", False, "未找到 data-act=start")
                    else:
                        start.click()
                        page.wait_for_timeout(1500)
                        scr = page.evaluate("window.__LC_DEBUG.screen")
                        st = page.evaluate("window.__LC_DEBUG")
                        check("进入游玩(PLAY)", scr == "play", f"screen={scr} level 物体={st.get('bodies')} 模拟时间={st.get('simTime')}")
                        page.wait_for_timeout(2000)
                        st2 = page.evaluate("window.__LC_DEBUG")
                        check("游玩中物理在推进", st2.get("simTime", 0) > st.get("simTime", 0), f"{st.get('simTime')} → {st2.get('simTime')} TU")
                        page.screenshot(path=str(SHOTS / "play.png"))
            except Exception as e:  # noqa: BLE001
                page.screenshot(path=str(SHOTS / "menu_failed.png"))
                check("用户路径", False, f"{type(e).__name__}: {e}")

        # ---------------- shot ----------------
        if "shot" in only:
            print("[verify_ui] 1/3 截图（预热模拟 + 渲染一帧）")
            page.goto(f"{base}/?shot=1&tu={args.tu}&level={args.level}", wait_until="load", timeout=60000)
            try:
                page.wait_for_function("document.title.startsWith('SHOT')", timeout=args.shot_timeout * 1000)
                title = page.title()
                out = SHOTS / "gameplay.png"
                page.screenshot(path=str(out))
                check("游戏画面截图", out.stat().st_size > 60_000, f"{out.name} {out.stat().st_size} 字节 | {title}")
            except Exception as e:  # noqa: BLE001
                page.screenshot(path=str(SHOTS / "gameplay_failed.png"))
                check("游戏画面截图", False, f"{type(e).__name__}: {e}")

        # ---------------- bench ----------------
        if "bench" in only:
            print(f"[verify_ui] 2/3 性能基准（{args.sec}s，{'真实 GPU' if args.headed else '无头软件渲染'}）")
            page.goto(f"{base}/?bench=1&sec={args.sec}&level={args.level}", wait_until="load", timeout=60000)
            try:
                page.wait_for_function("document.title.startsWith('BENCH')", timeout=(args.sec + 90) * 1000)
                title = page.title()
                parts = dict(kv.split("=") for kv in title.split()[1:])
                fps = float(parts.get("fps", "0"))
                p95 = float(parts.get("p95", "999ms").rstrip("ms"))
                limit = 45.0 if args.headed else 24.0
                check("帧率达标", fps >= limit, f"fps={fps:.1f} p50={parts.get('p50')} p95={parts.get('p95')}（阈值 {limit}）")
                check("帧耗时 p95", p95 <= (22.0 if args.headed else 45.0), f"p95={p95:.2f}ms")
                page.screenshot(path=str(SHOTS / ("bench_headed.png" if args.headed else "bench_headless.png")))
            except Exception as e:  # noqa: BLE001
                check("帧率达标", False, f"{type(e).__name__}: {e}")

        # ---------------- autotest ----------------
        if "autotest" in only:
            print("[verify_ui] 3/3 全流程自检（?autotest=1）")
            page.goto(f"{base}/?autotest=1&level={args.level}", wait_until="load", timeout=60000)
            try:
                page.wait_for_function("document.title.startsWith('AUTOTEST')", timeout=args.autotest_timeout * 1000)
                title = page.title()
                report = http_json(f"{base}/api/selftest")
                checks = report.get("checks", [])
                hard = [c for c in checks if not c.get("soft")]
                soft = [c for c in checks if c.get("soft")]
                for c in hard:
                    check(f"自检:{c['name']}", bool(c.get("ok")), str(c.get("detail", ""))[:110])
                for c in soft:
                    print(f"  {'PASS' if c.get('ok') else 'SOFT'}  自检:{c['name']}  {str(c.get('detail',''))[:110]}")
                w = report.get("world", {})
                check("自检总判定", bool(report.get("ok")), f"标题={title} 模拟时间={w.get('time')} 步数={w.get('steps')} 送达={w.get('delivered')} 状态={w.get('status')}")
                page.screenshot(path=str(SHOTS / "autotest.png"))
            except Exception as e:  # noqa: BLE001
                check("自检总判定", False, f"{type(e).__name__}: {e}")

        browser.close()

    # ---------------- quit（自起一个独立宿主，避免影响其它检查）----------------
    if "quit" in only:
        print("[verify_ui] 4/4 退出链路：点「退出」后宿主必须真的退出，且界面要有明确反馈")
        import subprocess
        port = args.quit_port
        host = subprocess.Popen(
            [sys.executable, str(ROOT / "python" / "mission_control.py"), "--dev", "--port", str(port), "--no-browser"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=str(ROOT),
        )
        try:
            ready = False
            for _ in range(40):
                try:
                    http_json(f"http://127.0.0.1:{port}/api/health", timeout=2)
                    ready = True
                    break
                except Exception:  # noqa: BLE001
                    time.sleep(0.7)
            check("退出测试宿主就绪", ready, f"port={port}")
            if ready:
                with sync_playwright() as pw2:
                    br = pw2.chromium.launch(channel=args.channel, headless=True)
                    pg = br.new_context(viewport={"width": 1600, "height": 900}).new_page()
                    pg.goto(f"http://127.0.0.1:{port}/", wait_until="load", timeout=60000)
                    pg.wait_for_function("window.__LC_DEBUG && window.__LC_DEBUG.screen", timeout=60000)
                    dismiss_overlays(pg)
                    btn = pg.query_selector('#ui-root button[data-act="quit"]')
                    check("主菜单有退出按钮", btn is not None, "button[data-act=quit]")
                    if btn:
                        btn.click()
                        pg.wait_for_timeout(2500)
                        overlay = pg.query_selector("#lc-exit")
                        txt = overlay.inner_text().replace("\n", " | ")[:90] if overlay else ""
                        check("退出有可见反馈", bool(overlay) and "退出" in txt, txt or "无 #lc-exit 覆盖层")
                    br.close()
                gone = False
                for _ in range(12):
                    if host.poll() is not None:
                        gone = True
                        break
                    time.sleep(1)
                check("宿主已退出", gone, f"returncode={host.poll()}")
        finally:
            try:
                if host.poll() is None:
                    host.kill()
            except Exception:  # noqa: BLE001
                pass

    # ---------------- tutorial（操作演示 + 教学关分步引导）----------------
    if "tutorial" in only:
        print("[verify_ui] 5/5 新手引导：首次进入自动弹演示、5 幕可翻且动画在动、教学关引导按动作推进")
        with sync_playwright() as pw3:
            br = pw3.chromium.launch(channel=args.channel, headless=True, args=["--disable-gpu"])
            ctx = br.new_context(viewport={"width": 1600, "height": 900})  # 全新上下文 = 无 localStorage
            pg = ctx.new_page()
            pg.on("pageerror", lambda e: CONSOLE_ERRORS.append(f"pageerror: {e}"))
            pg.goto(f"{base}/?tutest=1", wait_until="load", timeout=60000)
            pg.wait_for_function("window.__LC_DEBUG", timeout=60000)
            pg.wait_for_timeout(1500)
            cv = pg.query_selector("#lc-tut-canvas")
            check("首次进入自动弹操作演示", cv is not None, "#lc-tut-canvas")
            if cv:
                check("演示有分幕导航", pg.query_selector('#ui-root button[data-act="tut-next"]') is not None, "tut-next")
                titles = []
                for _ in range(5):
                    t = pg.query_selector(".lc-tut-title")
                    titles.append(t.inner_text() if t else "?")
                    nxt = pg.query_selector('#ui-root button[data-act="tut-next"]')
                    if nxt:
                        nxt.click()
                        pg.wait_for_timeout(450)
                check("5 幕内容齐全", len(set(titles)) == 5, " / ".join(titles))
                import hashlib
                h1 = hashlib.md5(pg.locator("#lc-tut-canvas").screenshot()).hexdigest()
                pg.wait_for_timeout(700)
                h2 = hashlib.md5(pg.locator("#lc-tut-canvas").screenshot()).hexdigest()
                check("演示动画在播放", h1 != h2, "canvas 连续两帧不同")
                done = pg.query_selector('#ui-root button[data-act="tut-done"]')
                check("有完成按钮", done is not None, "tut-done")
                if done:
                    done.click()
                    pg.wait_for_timeout(700)
                    check("看完后记录状态", pg.evaluate("localStorage.getItem('lc_tut_seen')") == "1", "lc_tut_seen=1")
                # 教学关引导
                pg.click('#ui-root button[data-act="start-levels"]')
                pg.wait_for_timeout(700)
                lv = [c for c in pg.query_selector_all('#ui-root button[data-act="level"]') if c.is_enabled()]
                if lv:
                    lv[0].click()
                    pg.wait_for_timeout(700)
                    st = pg.query_selector('#ui-root button[data-act="start"]')
                    if st:
                        st.click()
                        pg.wait_for_timeout(1600)
                        g = pg.query_selector("#lc-guide")
                        first = g.inner_text().replace("\n", " ")[:40] if g else ""
                        check("教学关出现分步引导", bool(g) and "①" in first, first or "无 #lc-guide")
                        for i in range(4):
                            pg.mouse.move(700 + i * 45, 430 + i * 18)
                            pg.wait_for_timeout(160)
                        g2 = pg.query_selector("#lc-guide")
                        t2 = g2.inner_text().replace("\n", " ")[:40] if g2 else ""
                        check("引导随动作推进", "②" in t2, t2 or "无")
            br.close()

    # ---------------- control（人类输入路径：鼠标必须真的能控制引力井）----------------
    if "control" in only:
        print("[verify_ui] 6/6 输入链路：鼠标 → 引力井目标（这条路径曾整条失效，且不被任何测试覆盖）")
        with sync_playwright() as pw4:
            br = pw4.chromium.launch(channel=args.channel, headless=True, args=["--disable-gpu"])
            pg = br.new_context(viewport={"width": 1600, "height": 900}).new_page()
            pg.on("pageerror", lambda e: CONSOLE_ERRORS.append(f"pageerror: {e}"))
            pg.goto(f"{base}/", wait_until="load", timeout=60000)
            pg.wait_for_function("window.__LC_DEBUG", timeout=60000)
            pg.wait_for_timeout(1200)
            dismiss_overlays(pg)
            pg.click('#ui-root button[data-act="start-levels"]')
            pg.wait_for_timeout(700)
            lv = [c for c in pg.query_selector_all('#ui-root button[data-act="level"]') if c.is_enabled()]
            if lv:
                lv[0].click()
                pg.wait_for_timeout(700)
                st = pg.query_selector('#ui-root button[data-act="start"]')
                if st:
                    st.click()
                    pg.wait_for_timeout(1600)
                    hits = 0
                    total = 0
                    for (mx, my) in [(1100, 300), (400, 650), (1200, 700), (600, 200)]:
                        pg.mouse.move(mx, my)
                        pg.mouse.down()
                        pg.wait_for_timeout(600)
                        d = pg.evaluate("""() => { const g = window.__LC_GAME, w = g.world, s = g.input.snapshot;
                            return { raw: [s.wx, s.wy], target: [w.well.tx, w.well.ty] }; }""")
                        pg.mouse.up()
                        total += 1
                        if abs(d["raw"][0] - d["target"][0]) < 0.05 and abs(d["raw"][1] - d["target"][1]) < 0.05:
                            hits += 1
                    check("鼠标世界坐标非零且目标跟随", hits == total, f"{hits}/{total} 个位置的目标 == 鼠标世界坐标")
                    # 光球层硬边界：把井强行塞进恒星，再按住往外拖，必须能脱身
                    pg.evaluate("""() => { const g = window.__LC_GAME, w = g.world, s = w.primaries.find(p => p.kind === 'star');
                        w.well.x = s.x + 0.02; w.well.y = s.y; w.well.vx = -4; w.well.vy = 0; }""")
                    pg.wait_for_timeout(1200)
                    d1 = pg.evaluate("window.__LC_DEBUG")
                    check("恒星不可进入（光球层硬边界）", d1["well"]["r"] >= d1["well"]["keep"] - 1e-6,
                          f"r={d1['well']['r']:.3f} ≥ keep={d1['well']['keep']:.3f}")
                    pg.mouse.move(1250, 300)
                    pg.mouse.down()
                    for i in range(7):
                        pg.mouse.move(1250 + i * 40, 300 - i * 15)
                        pg.wait_for_timeout(380)
                    pg.mouse.up()
                    d2 = pg.evaluate("window.__LC_DEBUG")
                    check("任何局面都能把井拖回来（无死局）", d2["well"]["r"] > d2["well"]["keep"] + 0.1,
                          f"r={d2['well']['r']:.3f} > keep+0.1")
            br.close()

    check("无 JS 报错", len(CONSOLE_ERRORS) == 0, " | ".join(CONSOLE_ERRORS[:3]) if CONSOLE_ERRORS else "干净")
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n[verify_ui] 结论：{'PASS' if not failed else 'FAIL'}  （{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过）")
    for n, ok, d in RESULTS:
        if not ok:
            print(f"   ✘ {n}  {d}")
    return 0 if not failed else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="牧星者 · UI/运行时验收")
    ap.add_argument("--base", default="http://127.0.0.1:8801")
    ap.add_argument("--only", default="", help="menu,shot,bench,autotest,quit 的逗号子集")
    ap.add_argument("--quit-port", type=int, default=8790, help="退出链路检查专用的宿主端口")
    ap.add_argument("--headed", action="store_true", help="真实窗口 + 真实 GPU（性能数字才有意义）")
    ap.add_argument("--channel", default="msedge", help="playwright 浏览器通道")
    ap.add_argument("--w", type=int, default=1600)
    ap.add_argument("--h", type=int, default=900)
    ap.add_argument("--sec", type=int, default=14, help="基准时长（秒）")
    ap.add_argument("--tu", type=float, default=26, help="截图前的模拟预热时长（TU）")
    ap.add_argument("--level", type=int, default=1)
    ap.add_argument("--shot-timeout", type=int, default=180)
    ap.add_argument("--autotest-timeout", type=int, default=180)
    args = ap.parse_args()
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
