"""启动画面 GIF：像素头图，字偶尔闪，星星闪光，货舱和引力井偶尔动一下。"""
from PIL import Image, ImageDraw

W, H = 640, 320
BG = (5, 7, 15)
MAGENTA = (255, 79, 216)
MAGENTA_DIM = (120, 28, 96)
CYAN = (89, 217, 255)
CYAN_DIM = (28, 78, 96)
POD = (255, 179, 71)
STATION = (142, 247, 208)
STAR = (255, 233, 168)
STAR2 = (255, 157, 60)
SHADOW = (92, 16, 78)
DIM_ORBIT = (36, 88, 120)
FRAMES = 16
STEP = 7

GLYPH = {
    "S": ("0111110", "1100000", "1100000", "0111110", "0000011", "0000011", "0111110"),
    "T": ("1111111", "0001000", "0001000", "0001000", "0001000", "0001000", "0001000"),
    "A": ("0011100", "0100010", "1000001", "1111111", "1000001", "1000001", "1000001"),
    "R": ("1111100", "1000010", "1000010", "1111100", "1001000", "1000100", "1000010"),
    "H": ("1000001", "1000001", "1000001", "1111111", "1000001", "1000001", "1000001"),
    "E": ("1111111", "1000000", "1000000", "1111110", "1000000", "1000000", "1111111"),
    "D": ("1111110", "1000001", "1000001", "1000001", "1000001", "1000001", "1111110"),
}
TITLE = "STARHERD"
HAN = {
    "牧": (
        "................", "...#.....#......", "...#....#.#.....", "...#...#...#....",
        ".#####.#....#...", "...#..#.........", "...#.#..........", ".######.........",
        "...#...#........", "...#...#.#......", "...#....#.#.....", "...#.....#.#....",
        "...#......#.....", "...##...........", "................", "................",
    ),
    "星": (
        "................", "....#######.....", "....#.....#.....", "....#.....#.....",
        "....#######.....", "....#.....#.....", "....#.....#.....", "....#######.....",
        ".......#........", "......#.#.......", "....#######.....", ".......#........",
        "...#########....", ".......#........", "..###########...", "................",
    ),
    "者": (
        "................", ".....####.......", "....#....#......", "..########......",
        "......#.........", "....#####.......", "...#.....#......", "...#.....#......",
        "...#######......", "....#...#.......", "...#.....#......", "..#.......#.....",
        ".#.........#....", "###########.....", "....#####.......", "....#####.......",
    ),
}
# x, y, size, phase, period, color. period 帧里灭一帧。
STARS = (
    (24, 18, 2, 0, 5, STAR), (48, 44, 1, 1, 4, CYAN), (90, 20, 1, 2, 6, STAR),
    (300, 14, 1, 3, 5, CYAN), (380, 24, 2, 1, 7, STAR), (580, 24, 2, 0, 4, STAR),
    (612, 60, 1, 2, 5, CYAN), (544, 18, 1, 4, 6, STAR), (20, 110, 1, 1, 5, STAR),
    (615, 130, 1, 3, 4, CYAN), (32, 300, 1, 2, 6, STAR), (600, 295, 2, 0, 5, STAR),
    (460, 36, 1, 5, 8, CYAN), (200, 28, 1, 4, 3, STAR),
)


def block(px, x, y, n, color):
    for dy in range(n):
        yy = y + dy
        if not 0 <= yy < H:
            continue
        for dx in range(n):
            xx = x + dx
            if 0 <= xx < W:
                px[xx, yy] = color


def blit_rows(px, rows, ox, oy, cell, color):
    for r, bits in enumerate(rows):
        for c, bit in enumerate(bits):
            if bit in ("1", "#"):
                block(px, ox + c * cell, oy + r * cell, cell, color)


def fill_disk(draw, cx, cy, r, color, cell=4):
    r2 = r * r
    for y in range(cy - r, cy + r + 1, cell):
        for x in range(cx - r, cx + r + 1, cell):
            if (x + cell / 2 - cx) ** 2 + (y + cell / 2 - cy) ** 2 <= r2:
                draw.rectangle([x, y, x + cell - 1, y + cell - 1], fill=color)


def ring(draw, cx, cy, r, thick, color, cell=4):
    outer, inner = r * r, max(0, r - thick) ** 2
    for y in range(cy - r, cy + r + 1, cell):
        for x in range(cx - r, cx + r + 1, cell):
            d = (x + cell / 2 - cx) ** 2 + (y + cell / 2 - cy) ** 2
            if inner <= d <= outer:
                draw.rectangle([x, y, x + cell - 1, y + cell - 1], fill=color)


def dots(draw, pts, color, cell=4):
    seen = set()
    for x, y in pts:
        key = (round(x / cell) * cell, round(y / cell) * cell)
        if key in seen:
            continue
        seen.add(key)
        draw.rectangle([key[0], key[1], key[0] + cell - 1, key[1] + cell - 1], fill=color)


def arc(p0, p1, p2, n=22):
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append((
            u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
            u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
        ))
    return out


PATH = arc((125, 250), (320, 214), (520, 254), 22)


def frame(i: int) -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    cell = 4
    flare = i in (3, 11)

    for n, (x, y, s, phase, period, col) in enumerate(STARS):
        on = (i + phase) % period != 0
        if not on and not (flare and n == 0):
            continue
        size = s * 2 if (flare and n in (0, 5)) else s
        draw.rectangle([x, y, x + size - 1, y + size - 1], fill=STAR if flare and n in (0, 5) else col)

    sun_r = 24 if i % 8 != 5 else 26
    fill_disk(draw, 75, 59, sun_r, STAR2, cell)
    fill_disk(draw, 75, 59, 13, STAR, cell)
    ring(draw, 75, 59, 40, 3, DIM_ORBIT, cell)
    if i % 5 != 2:
        fill_disk(draw, 107, 84, 7, (127, 212, 255), cell)
    fill_disk(draw, 564, 54, 11, (180, 196, 220), cell)
    ring(draw, 564, 54, 24, 3, (70, 60, 110), cell)

    # 轨道常在。货舱大部分时间停在中段，每圈滑出去再回来。
    slide = (0, 0, 0, 0, 1, 2, 3, 4, 3, 2, 1, 0, 0, 0, 0, 0)[i]
    dock_i = 11 + slide
    dots(draw, PATH, DIM_ORBIT, cell)
    well_r = 40 if i not in (6, 7) else 44
    ring(draw, 115, 254, well_r, 5, MAGENTA, cell)
    ring(draw, 115, 254, 24, 4, (255, 140, 220), cell)
    core = (255, 220, 245) if i % 4 != 1 else (255, 79, 216)
    fill_disk(draw, 115, 254, 8, core, cell)

    ring(draw, 526, 256, 35, 7, STATION, cell)
    ring(draw, 526, 256, 20, 3, (40, 90, 80), cell)

    px, py = PATH[min(dock_i, len(PATH) - 1)]
    px = int(round(px / cell) * cell) - 16
    py = int(round(py / cell) * cell) - 14
    img_px = img.load()
    blit_rows(img_px, (
        "00111100", "01111110", "11111111", "11100111",
        "11111111", "01111110", "00111100",
    ), px, py, cell, POD)
    if i % 6 != 4:
        blit_rows(img_px, (
            "00111100", "01111110", "11111111", "11100111", "11111111", "01111110",
        ), 504, 238, 3, (255, 196, 120))

    en_dim = i in (5, 13)
    zh_dim = i in (2, 10)
    han_cell = 3
    han_gap = 14
    han_w = 16 * han_cell
    han_total = han_w * 3 + han_gap * 2
    tw = (7 * len(TITLE) + 1 * (len(TITLE) - 1)) * STEP
    tx = (W - tw) // 2
    han_x = (W - han_total) // 2
    han_y = 62
    ty = han_y + 16 * han_cell + 8
    zh = CYAN_DIM if zh_dim else CYAN
    en = MAGENTA_DIM if en_dim else MAGENTA
    for k, ch in enumerate("牧星者"):
        ox = han_x + k * (han_w + han_gap)
        if not zh_dim:
            blit_rows(img_px, HAN[ch], ox + 1, han_y + 1, han_cell, (8, 40, 64))
        blit_rows(img_px, HAN[ch], ox, han_y, han_cell, zh)
    x = tx
    for ch in TITLE:
        if not en_dim:
            blit_rows(img_px, GLYPH[ch], x + STEP // 2, ty + STEP // 2, STEP, SHADOW)
        blit_rows(img_px, GLYPH[ch], x, ty, STEP, en)
        x += (7 + 1) * STEP
    return img


def main() -> None:
    frames = [frame(i) for i in range(FRAMES)]
    base = frames[0].quantize(colors=48, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    pal = [base] + [f.quantize(palette=base, dither=Image.Dither.NONE) for f in frames[1:]]
    out = r"C:\Users\a\Desktop\LagrangeCourier\assets\art\boot.gif"
    pal[0].save(out, save_all=True, append_images=pal[1:], duration=310, loop=0, optimize=True, disposal=2)
    print(out, frames[0].size, "frames", len(pal))


if __name__ == "__main__":
    main()
