"""png_writer.py —— 纯标准库 PNG 编码器 + Vista+ PNG-in-ICO 写出。

《牧星者 / STARHERD》W-assets 程序化素材管线。

只用标准库：``struct`` / ``zlib`` / ``pathlib``。
本文件不依赖（也禁止依赖）PIL / numpy / scipy。

PNG 规格：8 bit / 通道，filter type 0（None），非隔行，zlib(deflate) 压缩。
写入前断言像素字节数 == width*height*channels，长度不符直接 AssertionError，
避免生成"看着像图、实际解码失败"的坏文件。
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

__all__ = [
    "PNG_SIGNATURE",
    "encode_png",
    "write_png",
    "write_png_rgba",
    "write_png_rgb",
    "write_ico",
    "png_info",
    "read_png_info",
]

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

_COLOR_TYPE = {3: 2, 4: 6}  # 3 通道 -> Truecolor(2)，4 通道 -> Truecolor+Alpha(6)


def _chunk(tag: bytes, data: bytes) -> bytes:
    """一个 PNG chunk：length + type + data + crc32(type+data)。"""
    crc = zlib.crc32(tag + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)


def encode_png(width: int, height: int, pixels, channels: int = 4,
               compress_level: int = 9) -> bytes:
    """把裸像素编码成完整 PNG 字节串（不落盘）。

    ``pixels`` 为行优先、每像素 ``channels`` 字节的 bytes/bytearray/memoryview。
    """
    width = int(width)
    height = int(height)
    channels = int(channels)
    assert width > 0 and height > 0, f"非法尺寸 {width}x{height}"
    assert channels in _COLOR_TYPE, f"只支持 3/4 通道，收到 {channels}"

    stride = width * channels
    expected = stride * height
    n = len(pixels)
    assert n == expected, (
        f"像素字节数不符：期望 {expected}（{width}x{height}x{channels}），实得 {n}"
    )

    # 每行前置 1 字节 filter type 0
    raw = bytearray((stride + 1) * height)
    mv = memoryview(raw)
    if isinstance(pixels, (bytes, bytearray, memoryview)):
        for y in range(height):
            o = y * (stride + 1)
            mv[o] = 0
            mv[o + 1:o + 1 + stride] = pixels[y * stride:(y + 1) * stride]
    else:  # 可迭代的 int 序列
        src = bytes(bytearray(pixels))
        for y in range(height):
            o = y * (stride + 1)
            mv[o] = 0
            mv[o + 1:o + 1 + stride] = src[y * stride:(y + 1) * stride]
    del mv

    ihdr = struct.pack(">IIBBBBB", width, height, 8, _COLOR_TYPE[channels], 0, 0, 0)
    idat = zlib.compress(bytes(raw), int(compress_level))
    return b"".join((
        PNG_SIGNATURE,
        _chunk(b"IHDR", ihdr),
        _chunk(b"IDAT", idat),
        _chunk(b"IEND", b""),
    ))


def write_png(path, width: int, height: int, rgba) -> int:
    """写 8 位 RGBA PNG，返回写入字节数。"""
    data = encode_png(width, height, rgba, 4)
    p = Path(path)
    if p.parent and not p.parent.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return len(data)


def write_png_rgba(path, width: int, height: int, rgba) -> int:
    """``write_png`` 的显式别名。"""
    return write_png(path, width, height, rgba)


def write_png_rgb(path, width: int, height: int, rgb) -> int:
    """写 8 位 RGB（无 alpha）PNG，返回写入字节数。"""
    data = encode_png(width, height, rgb, 3)
    p = Path(path)
    if p.parent and not p.parent.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return len(data)


def write_ico(path, png_bytes: bytes, size: int) -> int:
    """写单张 PNG 内嵌的 ICO（Vista+ 合法），返回容器字节数。

    ICO 目录项宽/高为 0 表示 256。``png_bytes`` 必须是尺寸等于 ``size`` 的 PNG。
    """
    size = int(size)
    assert 1 <= size <= 256, f"ICO 尺寸需在 1..256，收到 {size}"
    assert isinstance(png_bytes, (bytes, bytearray)), "png_bytes 必须是 bytes"
    png_bytes = bytes(png_bytes)
    assert png_bytes.startswith(PNG_SIGNATURE), "内嵌数据不是 PNG"
    w, h, _channels, _depth, _ctype = png_info(png_bytes)
    assert (w, h) == (size, size), f"内嵌 PNG 尺寸 {w}x{h} != ICO 声明 {size}x{size}"

    header = struct.pack("<HHH", 0, 1, 1)        # reserved, type=1(icon), count=1
    entry = struct.pack(
        "<BBBBHHII",
        size % 256,      # 宽（256 记 0）
        size % 256,      # 高（256 记 0）
        0,               # 调色板色数
        0,               # reserved
        1,               # color planes
        32,              # bits per pixel
        len(png_bytes),  # 资源字节数
        6 + 16,          # 资源偏移：ICONDIR(6) + ICONDIRENTRY(16)
    )
    blob = header + entry + png_bytes
    p = Path(path)
    if p.parent and not p.parent.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(blob)
    return len(blob)


def png_info(data: bytes):
    """从 PNG/ICO 字节串解析 (w, h, channels, bitdepth, color_type)。"""
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("png_info 需要 bytes")
    b = bytes(data)
    if b[:4] == b"\x00\x00\x01\x00":  # ICO
        assert len(b) >= 22, "ICO 头部不完整"
        count = struct.unpack_from("<H", b, 4)[0]
        assert count >= 1, "ICO 内无图像"
        length, offset = struct.unpack_from("<II", b, 6 + 8)  # bytesInRes, imageOffset
        assert offset + length <= len(b), "ICO 资源越界"
        w = b[6] or 256
        h = b[7] or 256
        iw, ih, _c, _d, _ct = png_info(b[offset:offset + length])
        assert (iw, ih) == (w, h), "ICO 目录尺寸与内嵌 PNG 不一致"
        return iw, ih, 4, 8, 6
    assert b.startswith(PNG_SIGNATURE), "不是 PNG/ICO 数据"
    length, tag = struct.unpack_from(">I4s", b, 8)
    assert tag == b"IHDR", "首个 chunk 不是 IHDR"
    w, h, depth, ctype = struct.unpack_from(">IIBB", b, 16)
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    return w, h, channels, depth, ctype


def read_png_info(path):
    """读磁盘上的 PNG/ICO，返回 (w, h, channels, bitdepth, color_type)。"""
    return png_info(Path(path).read_bytes())
