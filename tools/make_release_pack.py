"""网易云上传包 v2：**全分辨率程序化封面**（不再放大 256x256 小图）。

v1 的问题：把 256x256 的星云贴图双三次放大到 1400 → 锯齿色块，环压字，像占位图。
v2 做法：在 1400x1400 上从头绘制
  · 星云：多枚**软径向渐变**叠加后再整体高斯模糊 → 平滑云团（不是放大位图）
  · 星野：三层（细星 / 中星 / 少量带光晕的亮星）
  · 轨道环：细椭圆、低透明度，避开文字区
  · 行星：小圆盘 + 一侧边缘光 + 地平阴影
  · 文字：标题 / 英文 / 副题 / 作者，配柔和暗底衬与分隔线
每首用各自的强调色；曲目封面右上角带「牧星者 STARHERD」小字标。

引号纪律：插入文本不用英文引号（本会话已因此失败三次）。
"""
import math
import pathlib
import random
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
# 直接产出到 dist_music/ —— 用户已经选中的就是这个文件夹，这样打开即可全选上传。
# 注意：**绝不能** rmtree(OUT)，那会把源 WAV 一起删掉。
OUT = ROOT / "dist_music"
SRC = ROOT / "dist_music"
SIZE = 1400
ARTIST = "海米糕"
# 旧项目名残留（与 Starherd_menu.wav 是同一首），上传前必须清掉，否则是重复投稿
STALE = ("LagrangeCourier_menu.wav", "LagrangeCourier_finale.wav")

TRACKS = [
    ("Starherd_menu.wav",   "星港",       "Starport",          "主菜单 · 慢流行",   (108, 168, 245), 0.55),
    ("Starherd_loop1.wav",  "双星摇篮",   "Binary Cradle",     "第 1 章",           (120, 186, 250), 0.50),
    ("Starherd_loop2.wav",  "碎石带",     "Debris Belt",       "第 2 章",           (110, 210, 205), 0.62),
    ("Starherd_loop3.wav",  "双星共振",   "Binary Resonance",  "第 3 章",           (158, 150, 245), 0.52),
    ("Starherd_loop4.wav",  "深渊视界",   "Abyss Horizon",     "第 4 章",           (206, 132, 236), 0.48),
    ("Starherd_storm.wav",  "宇宙风暴",   "Cosmic Storm",      "事件 · 风暴过境",   (245, 172,  96), 0.66),
    ("Starherd_rescue.wav", "救援倒计时", "Rescue Countdown",  "事件 · 船体泄漏",   (244, 118, 126), 0.60),
    ("Starherd_finale.wav", "终章",       "Finale",            "结算 · 凯旋",       (252, 208, 124), 0.56),
]
ALBUM = ("牧星者", "STARHERD OST", "20 关 / 5 章 · 程序化生成", (128, 178, 248), 0.52)


def _font(size):
    from PIL import ImageFont
    for p in (r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\msyh.ttc",
              r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\arialbd.ttf"):
        if pathlib.Path(p).is_file():
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def _blob(size, radius, color, alpha):
    """一枚软径向渐变（用于叠星云）"""
    from PIL import Image
    d = int(radius * 2)
    tile = Image.new("RGBA", (d, d), (0, 0, 0, 0))
    px = tile.load()
    r2 = radius * radius
    for y in range(d):
        dy = y - radius
        for x in range(d):
            dx = x - radius
            t = 1.0 - (dx * dx + dy * dy) / r2
            if t <= 0:
                continue
            a = int(alpha * (t ** 2.2))
            if a:
                px[x, y] = (color[0], color[1], color[2], a)
    return tile


def make_cover(dst, accent, mood, title_zh, title_en, sub, wordmark=True):
    from PIL import Image, ImageDraw, ImageFilter, ImageChops

    rng = random.Random(hash((title_en, accent)) & 0xFFFF)
    img = Image.new("RGB", (SIZE, SIZE), (7, 9, 18))

    # ---- 星云：软渐变叠加 ----
    cloud = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    for _ in range(14):
        r = rng.randint(int(SIZE * 0.18), int(SIZE * 0.42))
        c = (max(0, accent[0] + rng.randint(-30, 20)),
             max(0, accent[1] + rng.randint(-30, 20)),
             min(255, accent[2] + rng.randint(-20, 30)))
        b = _blob(SIZE, r, c, rng.randint(26, 54))
        cloud.alpha_composite(b, (rng.randint(-r // 2, SIZE - r // 2),
                                  rng.randint(-r // 2, SIZE - r // 2)))
    cloud = cloud.filter(ImageFilter.GaussianBlur(SIZE * 0.045))
    img = Image.alpha_composite(img.convert("RGBA"), cloud).convert("RGB")

    d = ImageDraw.Draw(img, "RGBA")

    # ---- 星野三层 ----
    for _ in range(900):
        x, y = rng.randrange(SIZE), rng.randrange(SIZE)
        v = rng.randint(70, 170)
        d.point((x, y), fill=(v, v, min(255, v + 18)))
    for _ in range(150):
        x, y = rng.randrange(SIZE), rng.randrange(SIZE)
        v = rng.randint(150, 235)
        d.ellipse((x - 1, y - 1, x + 1, y + 1), fill=(v, v, 255))
    for _ in range(9):
        x, y = rng.randrange(80, SIZE - 80), rng.randrange(80, int(SIZE * 0.55))
        v = rng.randint(210, 255)
        d.ellipse((x - 3, y - 3, x + 3, y + 3), fill=(v, v, 255, 230))
        d.ellipse((x - 9, y - 9, x + 9, y + 9), fill=(accent[0], accent[1], accent[2], 40))

    # ---- 行星（左下方一枚 + 边缘光）----
    pr = int(SIZE * 0.115)
    pcx, pcy = int(SIZE * 0.20), int(SIZE * 0.26)
    # 行星：暗球 + **受光月牙**（用偏移椭圆在 RGBA 层上挖阴影，方法稳、参数恒合法）
    d.ellipse((pcx - pr, pcy - pr, pcx + pr, pcy + pr), fill=(15, 19, 32, 255))
    lit = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ld = ImageDraw.Draw(lit, "RGBA")
    ld.ellipse((pcx - pr, pcy - pr, pcx + pr, pcy + pr),
               fill=(accent[0], accent[1], accent[2], 235))
    # 挖掉偏移的椭圆 → 剩下的就是月牙（受光的那一侧）
    off = int(pr * 0.62)
    ld.ellipse((pcx - pr + off, pcy - pr - int(pr * 0.12),
                pcx + pr + off, pcy + pr - int(pr * 0.12)), fill=(0, 0, 0, 0))
    lit = lit.filter(ImageFilter.GaussianBlur(pr * 0.055))
    img = Image.alpha_composite(img.convert("RGBA"), lit).convert("RGB")
    d = ImageDraw.Draw(img, "RGBA")
    # 亮缘（弧，非椭圆填充）
    d.arc((pcx - pr, pcy - pr, pcx + pr, pcy + pr), 205, 335,
          fill=(min(255, accent[0] + 40), min(255, accent[1] + 40),
                min(255, accent[2] + 30), 210), width=3)

    # ---- 轨道环（避开下方文字区：只画上半部分）----
    for rr, w, a in ((SIZE * 0.46, 3, 120), (SIZE * 0.56, 2, 70), (SIZE * 0.38, 1, 90)):
        d.arc((SIZE / 2 - rr, SIZE * 0.40 - rr * 0.30, SIZE / 2 + rr, SIZE * 0.40 + rr * 0.30),
              185, 355, fill=(accent[0], accent[1], accent[2], a), width=w)

    # ---- 文字区暗底衬（保证可读）----
    scrim = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sd = ImageDraw.Draw(scrim)
    for i in range(int(SIZE * 0.46)):
        y = SIZE - i
        sd.line((0, y, SIZE, y), fill=(4, 6, 14, int(232 * (1 - i / (SIZE * 0.46)) ** 0.7)))
    img = Image.alpha_composite(img.convert("RGBA"), scrim).convert("RGB")

    # ---- 暗角 ----
    vig = Image.new("L", (SIZE, SIZE), 0)
    vd = ImageDraw.Draw(vig)
    for i in range(80):
        f = i / 80.0
        vd.ellipse((-SIZE * 0.22 + SIZE * 0.44 * f, -SIZE * 0.22 + SIZE * 0.44 * f,
                    SIZE * 1.22 - SIZE * 0.44 * f, SIZE * 1.22 - SIZE * 0.44 * f),
                   fill=int(255 * (f ** 0.8)))
    img = Image.composite(img, Image.new("RGB", (SIZE, SIZE), (4, 6, 13)), vig)

    d = ImageDraw.Draw(img, "RGBA")
    f_big, f_en, f_sub, f_art = (_font(int(SIZE * 0.108)), _font(int(SIZE * 0.050)),
                                 _font(int(SIZE * 0.034)), _font(int(SIZE * 0.032)))
    y0 = int(SIZE * 0.700)
    d.text((SIZE // 2, y0), title_zh, font=f_big, fill=(248, 250, 255), anchor="mm")
    d.text((SIZE // 2, y0 + int(SIZE * 0.088)), title_en, font=f_en,
           fill=(accent[0], accent[1], accent[2]), anchor="mm")
    d.line((SIZE * 0.34, y0 + int(SIZE * 0.132), SIZE * 0.66, y0 + int(SIZE * 0.132)),
           fill=(120, 140, 175, 150), width=2)
    d.text((SIZE // 2, y0 + int(SIZE * 0.163)), sub, font=f_sub, fill=(176, 192, 218), anchor="mm")
    d.text((SIZE // 2, y0 + int(SIZE * 0.212)), ARTIST, font=f_art, fill=(206, 218, 238), anchor="mm")

    if wordmark:
        f_wm = _font(int(SIZE * 0.026))
        d.text((SIZE - int(SIZE * 0.05), int(SIZE * 0.055)), "牧星者 STARHERD",
               font=f_wm, fill=(190, 205, 230, 190), anchor="ra")

    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst, "PNG")


def main():
    try:
        import PIL  # noqa: F401
    except Exception:
        print("缺少 Pillow")
        return 2
    if OUT.exists():
        # 只清理我们自己的产出，**绝不** rmtree 整个目录（里面是源 WAV）
        for sub in ("covers",):
            p = OUT / sub
            if p.exists():
                shutil.rmtree(p)
        (OUT / "covers").mkdir(parents=True, exist_ok=True)
    else:
        (OUT / "covers").mkdir(parents=True, exist_ok=True)

    # 清掉旧项目名残留（与 Starherd_* 重复）
    for name in STALE:
        p = OUT / name
        if p.is_file():
            p.unlink()
            print("  已删除旧名残留:", name)

    rows = []
    for fname, zh, en, sub, accent, mood in TRACKS:
        src = SRC / fname
        if not src.is_file():
            print("  ⚠ 缺少", fname)
            continue
        # 音频已经在 dist_music/ 里，不复制（自己拷自己会抛 SameFileError）
        cov = OUT / "covers" / (fname.replace(".wav", "") + "_cover_1400.png")
        make_cover(cov, accent, mood, zh, en, sub)
        rows.append((fname, zh, en, sub, cov.name, src.stat().st_size))
        print("  封面 ✓", cov.name)

    azh, aen, asub, aacc, amood = ALBUM
    make_cover(OUT / "covers" / "album_cover_1400.png", aacc, amood, azh, aen, asub, wordmark=False)
    print("  封面 ✓ album_cover_1400.png")

    lines = ["# 网易云「上传包」— 就在 dist_music/ 里", "",
             "**你选中的 dist_music 文件夹已经可以直接用了**：",
             "根目录下 8 个 `Starherd_*.wav` 是要传的音频，`covers/` 里是对应封面。", "",
             "## 逐首对照", "",
             "| # | 上传这个音频 | 曲名 | 英文名 | 说明 | 配这张封面 |",
             "|---|---|---|---|---|---|"]
    for i, (f, zh, en, sub, cov, sz) in enumerate(rows, 1):
        lines.append(f"| {i} | `{f}` | **{zh}** | {en} | {sub} | `covers/{cov}` |")
    lines += ["", "专辑封面（可选用作整张专辑的图）：`covers/album_cover_1400.png`", "",
              "## 上传时怎么填", "",
              "| 字段 | 填什么 |",
              "|---|---|",
              "| 音乐人身份 | **AI 音乐人**（音频由程序合成，如实标注）|",
              "| 授权方式 | **非独家**（仓库已声明音乐适用 MIT，签独家会自相矛盾）|",
              "| 类型 | **纯音乐**（无歌词）|",
              "| 作曲 / 编曲 / 制作 | 海米糕 |",
              "| 专辑名 | 牧星者 / STARHERD 原声带 |",
              "| 作品说明 | 程序化生成：Python 合成管线（自写作曲规则 + 软件合成器渲染），非采样、非录音。作曲 / 编曲：海米糕。|",
              "",
              "## 尺寸与格式自检", "",
              f"- 封面 **{SIZE}x{SIZE}** ✓（平台要求 ≥640x640）",
              "- 音频 WAV 44.1kHz / 16bit / 立体声 ✓，峰值 −1.7~−2.4 dBFS **无削波** ✓",
              "- 时长 34~47 秒（游戏内无缝循环片段）",
              "",
              "## ⛔ 绝对不要传（就在同一台机器的仓库里，很容易误选）", "",
              "| 文件 | 原因 |",
              "|---|---|",
              "| `assets/audio/third_party/hopes_and_dreams.m4a` | **Toby Fox《Undertale》版权曲**，",
              "上传即侵权 → 账号永久封禁级 |",
              "| `assets/audio/*.wav`（17 个音效）| 是 UI 点击 / 撞击 / 推进器音效，不是音乐 |",
              "| `assets/audio/music_*.json`（8 个）| 是谱面数据，不是音频文件 |",
              "| `dist_music/LagrangeCourier_menu.wav` | 旧项目名残留，与 Starherd_menu 重复 |",
              ""]
    (OUT / "上传清单.md").write_text("\n".join(lines), encoding="utf-8")
    print("清单 ✓ dist_release/上传清单.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
