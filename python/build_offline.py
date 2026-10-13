#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
单文件离线版打包：把前端 + 12 关数据 + 全部素材内联成一个 HTML。

为什么需要它：EXE 虽然自带 Python（不需要装环境），但仍需要机器上有 WebView2/Edge/Chrome；
网页版又需要先在本机跑 Python 宿主、且别的机器连不上。这个产物把两者都绕开——
**复制任何一个 .html 文件过去，双击就能玩，不需要装任何东西、也不需要宿主**。

用法：
    python python/build_offline.py                 # 生成 dist_offline/Starherd_离线单文件版.html
    python python/build_offline.py --out X.html
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))

WEB = ROOT / "web"
DIST = ROOT / "dist"
ASSETS = ROOT / "assets"
OUT_DIR = ROOT / "dist_offline"

MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".wav": "audio/wav", ".json": "application/json", ".ico": "image/x-icon",
}


def data_url(path: Path) -> str:
    mime = MIME.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def inline_manifest(manifest: dict) -> dict:
    """把 manifest 里每个条目的 file 换成 data URL（AssetStore 直接用 assetBase + file 取）"""
    out = json.loads(json.dumps(manifest))  # 深拷贝
    for group in ("audio", "art", "music"):
        for e in out.get(group, []):
            rel = str(e.get("file", ""))
            p = ASSETS / rel
            if p.exists():
                e["file"] = data_url(p)
                e["inlined"] = True
            else:
                print(f"  [WARN] 素材缺失，跳过内联：{rel}")
    return out


def build(out_path: Path) -> dict:
    index = (WEB / "index.html").read_text(encoding="utf-8")
    css = (WEB / "styles.css").read_text(encoding="utf-8")
    app = (DIST / "app.js").read_text(encoding="utf-8")
    levels = json.loads((ASSETS / "data" / "systems.json").read_text(encoding="utf-8"))
    manifest = json.loads((ASSETS / "data" / "manifest.json").read_text(encoding="utf-8"))

    print("[offline] 内联素材…")
    manifest = inline_manifest(manifest)
    music_index = [
        {"name": m.get("name"), "file": m.get("file"), "bpm": m.get("bpm"),
         "bars": m.get("bars"), "beats_per_bar": m.get("beats_per_bar"),
         "key": m.get("key"), "mode": m.get("mode")}
        for m in manifest.get("music", [])
    ]

    welcome = {
        "t": "welcome",
        "version": "1.1.0-offline",
        "mode": "offline",
        "backend": "static",
        "server_time": time.time(),
        "port": 0,
        "config": {
            "time_scale": levels.get("constants", {}).get("time_scale", 1.6),
            "phys_hz": 120,
            "epsilon": levels.get("constants", {}).get("epsilon", 0.02),
            "isp": levels.get("constants", {}).get("isp", 320.0),
            "g0": levels.get("constants", {}).get("g0", 9.80665),
            "autotest": False,
            "vsync": True,
            "max_substeps": 8,
        },
        "levels": levels,
        "manifest": manifest,
        "music_index": music_index,
        "save": None,
        "asset_base": "",
    }

    # 取出 index.html 的 body 内容（保留 #boot / #game / #ui-root 与内联的 LCShell 脚本）
    body = index
    m = re.search(r"<body[^>]*>(.*?)</body>", index, re.S | re.I)
    if m:
        body = m.group(1)
    # 去掉对外部资源/脚本的引用（我们全部内联）
    body = re.sub(r'<script[^>]*src=["\'][^"\']*app\.js[^"\']*["\'][^>]*>\s*</script>', "", body, flags=re.I)
    body = re.sub(r"<link[^>]*styles\.css[^>]*>", "", body, flags=re.I)

    js_safe = app.replace("</script", "<\\/script")
    payload = json.dumps(welcome, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>牧星者 / STARHERD（离线单文件版）</title>
<style>
{css}
</style>
</head>
<body>
{body}
<script id="lc-offline-payload">
/* 离线单文件版：任务控制中心的 welcome 报文（关卡 + 素材 + 配乐索引）全部内联在这里。
   因此本文件不需要宿主、不需要联网、不需要安装任何运行环境，双击即可游玩。 */
window.__LC_OFFLINE__ = {payload};
</script>
<script type="module">
{js_safe}
</script>
</body>
</html>
"""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, encoding="utf-8")
    size = out_path.stat().st_size
    print(f"[offline] 已生成 {out_path}")
    print(f"[offline] 大小 {size:,} 字节 ({size / 1048576:.2f} MB)  关卡 {len(levels.get('levels', []))}  素材 {sum(len(manifest.get(g, [])) for g in ('audio', 'art', 'music'))}")
    return {"path": str(out_path), "bytes": size}


def main() -> int:
    ap = argparse.ArgumentParser(description="牧星者 · 单文件离线版打包")
    ap.add_argument("--out", default="", help="输出路径（默认 dist_offline/Starherd_离线单文件版.html）")
    ap.add_argument("--name", default="Starherd_离线单文件版.html")
    args = ap.parse_args()
    out = Path(args.out) if args.out else (OUT_DIR / args.name)
    if not (DIST / "app.js").exists():
        print("[offline] 找不到 dist/app.js，请先执行：node tools/build.mjs", file=sys.stderr)
        return 2
    build(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
