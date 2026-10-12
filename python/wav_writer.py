"""wav_writer.py —— 44.1 kHz / 16 bit / 立体声 PCM WAV 写出 + 一套纯标准库 DSP 工具。

《牧星者 / STARHERD》W-assets 程序化素材管线。

只用标准库：``math`` / ``random`` / ``struct`` / ``array`` / ``wave`` / ``pathlib``。
本文件不依赖（也禁止依赖）numpy / scipy / PIL。

约定
----
* 单声道信号 = ``list[float]``，取值视作 [-1, 1]（未归一化时可比 1 大）。
* 立体声 = ``(left, right)`` 两个等长 ``list[float]``；``pan()`` 负责单声道→立体声。
* 所有随机性都走 ``random.Random(seed)`` 实例，禁止裸 ``random.*``。
* ``write_wav()`` 落盘前依次：直流阻断 → 峰值归一到 0.95（左右同系数，保持声像）
  → 首尾 5 ms 淡入淡出（防爆音）。可循环素材（推进器）传 ``fade_ms=0``，
  改用周期性构造保证首尾无缝。
"""

from __future__ import annotations

import math
import random
import struct
import wave
from array import array
from pathlib import Path

__all__ = [
    "RATE", "CHANNELS", "SAMPLE_WIDTH", "PEAK_LIMIT", "FADE_MS",
    "sine", "sine_sweep", "saw", "square", "noise", "adsr", "exp_decay",
    "one_pole_lowpass", "one_pole_highpass", "biquad_lowpass", "biquad_highpass",
    "biquad_bandpass", "soft_clip", "normalize", "normalize_pair", "mix",
    "reverb_schroeder", "dc_block", "remove_mean", "pan", "apply_env", "fade",
    "fade_env",
    "peak_abs", "measure_wav", "write_wav",
]

RATE = 44100
CHANNELS = 2
SAMPLE_WIDTH = 2          # 16 bit
PEAK_LIMIT = 0.95
FADE_MS = 5.0
TWO_PI = 2.0 * math.pi


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def _n_samples(dur: float, rate: int = RATE) -> int:
    return max(1, int(round(float(dur) * rate)))


def _rng(rng=None, seed: int = 0) -> random.Random:
    if isinstance(rng, random.Random):
        return rng
    return random.Random(int(seed) if rng is None else int(rng))


def peak_abs(sig) -> float:
    return max(max(map(abs, sig), default=0.0), 0.0)


def apply_env(sig, env):
    """逐样本相乘（长度取二者较短）。"""
    n = min(len(sig), len(env))
    return [sig[i] * env[i] for i in range(n)]


def fade(sig, fade_in_s: float = 0.0, fade_out_s: float = 0.0, rate: int = RATE):
    """线性淡入淡出（秒）。首尾淡入淡出用于消除爆音。"""
    env = fade_env(len(sig), fade_in_s, fade_out_s, rate)
    return [x * e for x, e in zip(sig, env)]


def mix(*sigs, gains=None, n: int | None = None):
    """多路信号相加（按需补零对齐到最长）。"""
    sigs = [s for s in sigs if s is not None]
    if not sigs:
        return []
    if gains is None:
        gains = [1.0] * len(sigs)
    if n is None:
        n = max(len(s) for s in sigs)
    out = [0.0] * n
    for sig, g in zip(sigs, gains):
        if g == 0.0:
            continue
        for i, x in enumerate(sig):
            out[i] += g * x
    return out


def normalize(sig, peak: float = PEAK_LIMIT):
    m = peak_abs(sig)
    if m <= 0.0:
        return list(sig)
    k = float(peak) / m
    return [x * k for x in sig]


def normalize_pair(left, right, peak: float = PEAK_LIMIT):
    """左右同系数归一化，保持声像与相对电平。"""
    m = max(peak_abs(left), peak_abs(right))
    if m <= 0.0:
        return list(left), list(right)
    k = float(peak) / m
    return [x * k for x in left], [x * k for x in right]


def dc_block(sig, r: float = 0.9995):
    """一极高通，去直流偏移（截止约 3.5 Hz @44.1k）。"""
    out = [0.0] * len(sig)
    x1 = 0.0
    y1 = 0.0
    for i, x in enumerate(sig):
        y = x - x1 + r * y1
        out[i] = y
        x1 = x
        y1 = y
    return out


def fade_env(n: int, fade_in_s: float = 0.0, fade_out_s: float = 0.0,
             rate: int = RATE):
    """首尾线性淡入淡出包络（0 → 1 → 0），长度 n。"""
    n = max(1, int(n))
    env = [1.0] * n
    a = min(n, max(0, int(round(fade_in_s * rate))))
    b = min(n - a, max(0, int(round(fade_out_s * rate))))
    for i in range(a):
        env[i] = i / a
    for i in range(b):
        env[n - 1 - i] = i / b
    return env


def remove_mean(sig, window=None):
    """减去（加权）算术均值，保证落盘后均值约 0（真·无直流偏移）。

    ``window`` 给定时按窗口加权扣除：窗口为 0 的样本（淡化端点）保持不动，
    因此首尾仍然精确为 0。对周期素材是常数平移，不破坏首尾无缝。
    """
    n = len(sig)
    if n == 0:
        return []
    m = math.fsum(sig) / n
    if window is None:
        return [x - m for x in sig]
    return [sig[i] - m * window[i] for i in range(n)]


def pan(mono, p: float = 0.0, width: float = 1.0):
    """等功率声像：``p`` ∈ [-1(左), 1(右)]，中心处两声道增益均为 1.0。

    返回 ``(left, right)``。
    """
    p = max(-1.0, min(1.0, float(p)))
    th = (p + 1.0) * math.pi / 4.0
    k = math.sqrt(2.0) * float(width)
    gl = math.cos(th) * k
    gr = math.sin(th) * k
    return [x * gl for x in mono], [x * gr for x in mono]


# --------------------------------------------------------------------------- #
# 振荡器 / 噪声
# --------------------------------------------------------------------------- #
def sine(freq: float, dur: float, rate: int = RATE, phase: float = 0.0,
         amp: float = 1.0):
    n = _n_samples(dur, rate)
    w = TWO_PI * float(freq) / rate
    return [amp * math.sin(w * i + phase) for i in range(n)]


def sine_sweep(f0: float, f1: float, dur: float, rate: int = RATE,
               curve: str = "exp", phase: float = 0.0, amp: float = 1.0,
               fm=None):
    """相位积分扫频正弦。``curve`` = "exp"(指数，音乐化) / "lin"。

    ``fm`` = (调制频率 Hz, 深度比例) 做颤音/FM 味。
    """
    n = _n_samples(dur, rate)
    out = [0.0] * n
    ph = float(phase)
    expo = None
    if curve == "exp" and f0 > 0.0 and f1 > 0.0 and n > 1:
        expo = (float(f1) / float(f0)) ** (1.0 / (n - 1))
    f = float(f0)
    for i in range(n):
        if expo is not None:
            fi = f
            f *= expo
        else:
            u = i / (n - 1) if n > 1 else 0.0
            fi = f0 + (f1 - f0) * u
        if fm is not None:
            fi *= 1.0 + fm[1] * math.sin(TWO_PI * fm[0] * i / rate)
        out[i] = amp * math.sin(ph)
        ph += TWO_PI * fi / rate
    return out


def saw(freq: float, dur: float, rate: int = RATE, amp: float = 1.0,
        phase: float = 0.0, harmonics: int | None = None):
    """锯齿波。``harmonics`` 给定时用加法合成（带限，无混叠），否则朴素锯齿。"""
    n = _n_samples(dur, rate)
    if harmonics:
        out = [0.0] * n
        for h in range(1, int(harmonics) + 1):
            f = float(freq) * h
            if f >= rate * 0.45:
                break
            a = amp * (2.0 / math.pi) / h
            w = TWO_PI * f / rate
            for i in range(n):
                out[i] += a * math.sin(w * i)
        return out
    w = float(freq) / rate
    return [amp * (2.0 * ((w * i + phase) % 1.0) - 1.0) for i in range(n)]


def square(freq: float, dur: float, rate: int = RATE, amp: float = 1.0,
           duty: float = 0.5, phase: float = 0.0):
    n = _n_samples(dur, rate)
    w = float(freq) / rate
    return [amp if ((w * i + phase) % 1.0) < duty else -amp for i in range(n)]


def noise(dur: float = 0.0, seed: int = 0, rate: int = RATE, amp: float = 1.0,
          rng=None, n: int | None = None):
    """白噪（均匀分布），确定性。``n`` 给定时以样本数为准。"""
    if n is None:
        n = _n_samples(dur, rate)
    r = _rng(rng, seed)
    return [amp * r.uniform(-1.0, 1.0) for _ in range(n)]


# --------------------------------------------------------------------------- #
# 包络
# --------------------------------------------------------------------------- #
def adsr(n: int, attack: float, decay: float, sustain: float, release: float,
         rate: int = RATE):
    """线性 ADSR，时间单位秒；总长不足时按比例压缩各段。"""
    n = max(1, int(n))
    a = max(0, int(attack * rate))
    d = max(0, int(decay * rate))
    r = max(0, int(release * rate))
    if a + d + r > n:
        tot = a + d + r
        k = n / tot
        a = int(a * k)
        d = int(d * k)
        r = max(0, n - a - d)
    s = max(0, n - a - d - r)
    sustain = max(0.0, min(1.0, float(sustain)))
    env = []
    if a:
        env.extend(i / a for i in range(a))
    if d:
        env.extend(1.0 + (sustain - 1.0) * (i / d) for i in range(d))
    env.extend([sustain] * s)
    if r:
        env.extend(sustain * (1.0 - i / r) for i in range(r))
    if len(env) < n:
        env.extend([0.0] * (n - len(env)))
    return env[:n]


def exp_decay(n: int, tau: float, rate: int = RATE, floor: float = 0.0):
    """指数衰减包络 e^{-t/tau}（tau 秒，0 表示不衰减）。"""
    n = max(1, int(n))
    if tau <= 0.0:
        return [1.0] * n
    k = math.exp(-1.0 / (tau * rate))
    out = [0.0] * n
    e = 1.0
    for i in range(n):
        out[i] = floor + (1.0 - floor) * e
        e *= k
    return out


# --------------------------------------------------------------------------- #
# 滤波器
# --------------------------------------------------------------------------- #
def one_pole_lowpass(sig, cutoff: float, rate: int = RATE):
    a = 1.0 - math.exp(-TWO_PI * float(cutoff) / rate)
    out = [0.0] * len(sig)
    y = 0.0
    for i, x in enumerate(sig):
        y += a * (x - y)
        out[i] = y
    return out


def one_pole_highpass(sig, cutoff: float, rate: int = RATE):
    lp = one_pole_lowpass(sig, cutoff, rate)
    return [x - y for x, y in zip(sig, lp)]


def _biquad(sig, b0, b1, b2, a0, a1, a2):
    b0 /= a0
    b1 /= a0
    b2 /= a0
    a1 /= a0
    a2 /= a0
    x1 = x2 = y1 = y2 = 0.0
    out = [0.0] * len(sig)
    for i, x in enumerate(sig):
        y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        out[i] = y
        x2 = x1
        x1 = x
        y2 = y1
        y1 = y
    return out


def biquad_bandpass(sig, f0: float, q: float = 1.0, rate: int = RATE,
                    gain_db: float = 0.0):
    """RBJ 常数峰值增益带通（Q 越大越窄）。"""
    w0 = TWO_PI * float(f0) / rate
    cw = math.cos(w0)
    sw = math.sin(w0)
    alpha = sw / (2.0 * max(1e-6, float(q)))
    out = _biquad(sig, alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * cw, 1.0 - alpha)
    if gain_db:
        g = 10.0 ** (gain_db / 20.0)
        out = [x * g for x in out]
    return out


def biquad_lowpass(sig, f0: float, q: float = 0.7071, rate: int = RATE):
    w0 = TWO_PI * float(f0) / rate
    cw = math.cos(w0)
    sw = math.sin(w0)
    alpha = sw / (2.0 * max(1e-6, float(q)))
    b1 = 1.0 - cw
    b0 = b1 / 2.0
    b2 = b0
    return _biquad(sig, b0, b1, b2, 1.0 + alpha, -2.0 * cw, 1.0 - alpha)


def biquad_highpass(sig, f0: float, q: float = 0.7071, rate: int = RATE):
    w0 = TWO_PI * float(f0) / rate
    cw = math.cos(w0)
    sw = math.sin(w0)
    alpha = sw / (2.0 * max(1e-6, float(q)))
    b0 = (1.0 + cw) / 2.0
    b1 = -(1.0 + cw)
    b2 = b0
    return _biquad(sig, b0, b1, b2, 1.0 + alpha, -2.0 * cw, 1.0 - alpha)


def soft_clip(sig, drive: float = 1.0, ceiling: float = 0.98):
    """tanh 饱和，``drive`` 越大越脏；峰值被压到 ``ceiling`` 以内。"""
    drive = max(1e-6, float(drive))
    t = math.tanh(drive)
    return [ceiling * math.tanh(drive * x) / t for x in sig]


# --------------------------------------------------------------------------- #
# 混响
# --------------------------------------------------------------------------- #
_COMB_MS = (29.7, 37.1, 41.1, 43.7)
_ALLPASS_MS = (5.0, 1.7)


def reverb_schroeder(sig, room: float = 0.78, mix: float = 0.3,
                     decay: float = 1.8, rate: int = RATE, damp: float = 0.35,
                     tail: float | None = None):
    """Schroeder 混响：4 并联梳状滤波 + 2 级串联全通，带高频阻尼。"""
    n = len(sig)
    if n == 0:
        return []
    if tail is None:
        tail = int(rate * min(2.5, max(0.4, float(decay))) * 0.45)
    total = n + max(0, int(tail))
    dry = list(sig) + [0.0] * (total - n)
    wet = [0.0] * total
    scale = 0.6 + 0.7 * float(room)
    for ms in _COMB_MS:
        d = max(1, int(rate * ms / 1000.0 * scale))
        g = min(0.98, math.exp(-3.0 * math.log(10.0) * d / (float(decay) * rate)))
        line = [0.0] * d
        idx = 0
        lp = 0.0
        for i in range(total):
            y = line[idx]
            lp = y * (1.0 - damp) + lp * damp
            line[idx] = dry[i] + lp * g
            wet[i] += y * 0.25
            idx += 1
            if idx == d:
                idx = 0
    for ms in _ALLPASS_MS:
        d = max(1, int(rate * ms / 1000.0))
        g = 0.5
        line = [0.0] * d
        idx = 0
        for i in range(total):
            x = wet[i]
            y = line[idx]
            wet[i] = y - x
            line[idx] = x + y * g
            idx += 1
            if idx == d:
                idx = 0
    mix = max(0.0, min(1.0, float(mix)))
    return [(1.0 - mix) * dry[i] + mix * wet[i] for i in range(total)]


# --------------------------------------------------------------------------- #
# 落盘 / 回读
# --------------------------------------------------------------------------- #
def _to_s16(x: float) -> int:
    v = int(round(x * 32767.0))
    if v > 32767:
        return 32767
    if v < -32768:
        return -32768
    return v


def write_wav(path, left, right=None, rate: int = RATE, fade_ms: float = FADE_MS,
              peak: float = PEAK_LIMIT, block_dc: bool = True) -> dict:
    """写 44.1 kHz / 16 bit / 立体声 PCM WAV。

    处理链：对齐长度 → 去直流（一阶高通 + 均值归零）→ 峰值归一（左右同系数）
    → 首尾淡化 → int16 交织 → wave 落盘。
    返回 ``{"bytes","seconds","frames","rate","channels","peak"}``（peak 为落盘后实测值）。
    """
    left = list(left)
    right = list(left) if right is None else list(right)
    n = max(len(left), len(right))
    assert n > 0, "空信号无法写出"
    if len(left) < n:
        left = left + [0.0] * (n - len(left))
    if len(right) < n:
        right = right + [0.0] * (n - len(right))
    if block_dc:
        left = dc_block(left)
        right = dc_block(right)
    env = None
    if fade_ms and fade_ms > 0:
        s = fade_ms / 1000.0
        env = fade_env(n, s, s, rate)
        left = [x * e for x, e in zip(left, env)]
        right = [x * e for x, e in zip(right, env)]
    # 均值归零：有淡化时按淡化曲线加权，端点（包络 0 处）保持精确 0
    left = remove_mean(left, env)
    right = remove_mean(right, env)
    left, right = normalize_pair(left, right, peak)

    inter = array("h", bytes(4 * n))
    for i in range(n):
        inter[2 * i] = _to_s16(left[i])
        inter[2 * i + 1] = _to_s16(right[i])

    p = Path(path)
    if p.parent and not p.parent.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(p), "wb") as w:
        w.setnchannels(CHANNELS)
        w.setsampwidth(SAMPLE_WIDTH)
        w.setframerate(int(rate))
        w.writeframes(inter.tobytes())

    meta = measure_wav(p)
    meta["bytes"] = p.stat().st_size
    return meta


def measure_wav(path) -> dict:
    """用 ``wave`` 回读 WAV，返回实测 (rate, channels, frames, seconds, peak)。"""
    p = Path(path)
    with wave.open(str(p), "rb") as w:
        channels = w.getnchannels()
        width = w.getsampwidth()
        rate = w.getframerate()
        frames = w.getnframes()
        raw = w.readframes(frames)
    data = array("h")
    data.frombytes(raw)
    peak = 0.0
    if data:
        peak = max(max(data), -min(data)) / 32768.0
    return {
        "rate": rate,
        "channels": channels,
        "sampwidth": width,
        "frames": frames,
        "seconds": round(frames / float(rate or 1), 6),
        "peak": round(peak, 6),
    }


def pcm_preview(path, start_s: float = 0.0, count: int = 8, rate: int = RATE):
    """调试用：取一小段样本值（验证工具，不参与生成）。"""
    p = Path(path)
    with wave.open(str(p), "rb") as w:
        off = int(start_s * w.getframerate()) * w.getnchannels()
        w.setpos(min(off, max(0, w.getnframes() - 1)))
        raw = w.readframes(count)
    return list(struct.unpack("<%dh" % (len(raw) // 2), raw))
