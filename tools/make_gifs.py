"""make_gifs.py —— 录制游戏画面并合成 GIF（用于 GitHub 仓库主页演示）。

为什么这样做
------------
* **真实画面**：不手绘、不摆拍，逐帧截取正在运行的游戏；
* **不用手动操作**：游戏自带 AI（`attract` 模式），让它自己玩，录出来就是真实玩法；
* **速度正确**：`autotest=true` 会把时间流速乘 8（那是给无头回归用的），
  所以录制时用 **`attract=true` + `autotest=false`** → AI 接管但**实时速度**。

产出（默认写到 ``docs/demo/``）：

    gameplay.gif   核心玩法：引力井把货舱拽出原轨道、甩进空间站对接环
    multibody.gif  多体系统：拉格朗日稳定岛（双星 + L4/L5）
    blackhole.gif  黑洞 + 恒星双星：潮汐撕裂安全线附近的作业

用法::

    python tools/make_gifs.py                 # 录全部
    python tools/make_gifs.py --only gameplay # 只录一个
    python tools/make_gifs.py --fps 12 --seconds 6 --width 900
"""

from __future__ import annotations

import argparse
import io
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "docs" / "demo"
URL = "http://127.0.0.1:8801/"

# 录制清单：level 从 1 起（与关卡编号一致）
CLIPS = [
    {"name": "gameplay", "level": 1, "skip": 6.0, "caption": "引力井搬运货舱入坞"},
    {"name": "multibody", "level": 9, "skip": 8.0, "caption": "双星 + L4/L5 稳定岛"},
    {"name": "blackhole", "level": 10, "skip": 8.0, "caption": "黑洞 + 恒星双星"},
]


def log(msg: str) -> None:
    print(f"[gif] {msg}", flush=True)


def compose(frames: list[bytes], out: Path, fps: int, width: int, colors: int = 64) -> int:
    """把 PNG 帧合成为优化过的 GIF，返回字节数。"""
    from PIL import Image

    imgs = []
    for raw in frames:
        im = Image.open(io.BytesIO(raw)).convert("RGB")
        if im.width != width:
            im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
        # 深空画面用 128 色足够，且体积能压到 1/3 左右
        imgs.append(im.convert("P", palette=Image.ADAPTIVE, colors=colors))
    if not imgs:
        raise SystemExit("没有可合成的帧")
    out.parent.mkdir(parents=True, exist_ok=True)
    imgs[0].save(
        out, save_all=True, append_images=imgs[1:],
        duration=int(1000 / fps), loop=0, optimize=True,
        # disposal=1（不擦除）让 Pillow 只写"变化的矩形"，深空画面大部分静止 → 体积能降一个量级；
        # disposal=2 是每帧全量存，实测 6 秒 900px 就要 16MB（GitHub 首页不可接受）。
        disposal=1,
    )
    return out.stat().st_size


def record(only: str, fps: int, seconds: float, width: int, colors: int, viewport: tuple[int, int]) -> int:
    from playwright.sync_api import sync_playwright

    clips = [c for c in CLIPS if not only or c["name"] == only]
    if not clips:
        raise SystemExit(f"没有匹配的片段：{only}")

    total = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True,
                                    args=["--disable-gpu", "--hide-scrollbars"])
        page = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)[:160]))
        page.goto(URL, wait_until="load", timeout=90000)
        page.wait_for_function("window.__LC_DEBUG", timeout=90000)
        # 跳过首次引导，避免弹窗挡住画面
        page.evaluate("localStorage.setItem('lc_tut_seen','1'); localStorage.setItem('lc_guide_seen','1')")
        page.reload(wait_until="load")
        page.wait_for_function("window.__LC_DEBUG", timeout=90000)
        page.wait_for_timeout(1500)

        for clip in clips:
            lv = int(clip["level"]) - 1
            # attract=true → AI 接管；autotest 保持 false → 实时速度
            page.evaluate(
                """(lv) => {
                    const g = window.__LC_GAME;
                    g.autotest = false;
                    g.attract = true;
                    g.loadWorld(lv);
                    g.setScreen('play');
                }""", lv)
            page.wait_for_timeout(int(clip["skip"] * 1000))
            n = max(2, int(fps * seconds))
            frames: list[bytes] = []
            interval = 1.0 / fps
            t0 = time.perf_counter()
            for i in range(n):
                frames.append(page.screenshot(type="png"))
                target = t0 + (i + 1) * interval
                dt = target - time.perf_counter()
                if dt > 0:
                    page.wait_for_timeout(int(dt * 1000))
            out = OUT_DIR / f"{clip['name']}.gif"
            size = compose(frames, out, fps, width, colors)
            total += size
            log(f"{clip['name']:<10} {len(frames)} 帧 → {out.relative_to(ROOT)}  "
                f"{size/1048576:.2f} MB   （{clip['caption']}）")
            # 顺手存一张静态首帧（GitHub 社交预览/README 头图常用）
            (OUT_DIR / f"{clip['name']}.png").write_bytes(frames[len(frames) // 2])
        if errors:
            log(f"⚠ 页面有 JS 报错：{errors[:2]}")
        browser.close()
    return total


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="录制《牧星者》演示 GIF")
    ap.add_argument("--only", default="", help="只录某个片段（gameplay/multibody/blackhole）")
    ap.add_argument("--fps", type=int, default=8, help="帧率（默认 8）")
    ap.add_argument("--seconds", type=float, default=4.0, help="时长秒数（默认 4）")
    ap.add_argument("--width", type=int, default=640, help="输出宽度像素（默认 640）")
    ap.add_argument("--colors", type=int, default=48, help="调色板颜色数（默认 48，越小越小）")
    ap.add_argument("--viewport", default="1280x760", help="浏览器视口 WxH")
    args = ap.parse_args(argv)
    vw, vh = (int(x) for x in args.viewport.lower().split("x"))
    log(f"开始录制：fps={args.fps} 时长={args.seconds}s 宽度={args.width} 视口={vw}x{vh}")
    total = record(args.only, args.fps, args.seconds, args.width, args.colors, (vw, vh))
    log(f"合计 {total/1048576:.2f} MB，输出目录 {OUT_DIR.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
