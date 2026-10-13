"""assets_gen.py —— 《牧星者 / STARHERD》全量程序化素材编排。

纯标准库（zlib / struct / math / array / wave / random / json / hashlib / time / pathlib），
禁止 numpy / PIL / scipy。

产出（与 docs/INTERFACES.md §4 manifest schema 一致）：
  assets/audio/*.wav            17 个音效（44.1 kHz / 16 bit / 立体声）
  assets/audio/music_*.json     5 首谱面（menu + loop1..loop4，schema 见 §5）
  assets/art/*.png              13 张贴图（8 bit RGBA）
  assets/art/app.ico            256x256 PNG-in-ICO（EXE 图标：品红引力井 + 青色轨道环）
  assets/data/manifest.json     全量 sha256 + 尺寸 + 时长 + 峰值

CLI:
  python python/assets_gen.py --force [--seed N] [--verify]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import struct
import sys
import time
import wave
import zlib
from array import array
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import music_gen                                        # noqa: E402
import png_writer                                       # noqa: E402
import wav_writer                                       # noqa: E402
from wav_writer import (                                # noqa: E402
    RATE, adsr, apply_env, biquad_bandpass, biquad_highpass,
    dc_block, exp_decay, mix, noise, one_pole_highpass, one_pole_lowpass, pan,
    reverb_schroeder, saw, sine, sine_sweep, soft_clip, write_wav,
)

__all__ = ["generate_all", "verify_manifest", "REQUIRED_AUDIO", "REQUIRED_ART",
           "REQUIRED_MUSIC", "DEFAULT_SEED"]

ROOT = _HERE.parent
ASSETS = ROOT / "assets"
AUDIO = ASSETS / "audio"
ART = ASSETS / "art"
DATA = ASSETS / "data"

DEFAULT_SEED = 20260101
MANIFEST_VERSION = "1.0"
GENERATOR = "assets_gen.py"

# docs/INTERFACES.md §4 必需素材名（缺一不可）
REQUIRED_AUDIO = [
    "ui_hover", "ui_click", "ui_back", "pulse_attract", "pulse_repel",
    "thruster_loop", "dock_success", "dock_fail", "tidal_tear", "impact_rock",
    "impact_hull", "wind_warning", "chapter_fanfare", "blackhole_rumble",
    "countdown", "ignition", "launch",
]
REQUIRED_ART = [
    "glow_soft", "glow_ring", "star_field", "nebula_loop1", "nebula_loop2",
    "nebula_loop3", "nebula_loop4", "grid_hex", "spark", "shard", "vignette",
    "lens_gradient", "ring_dock",
]
REQUIRED_MUSIC = ["loop1", "loop2", "loop3", "loop4", "menu"]
EXTRA_ART = ["app.ico"]


# =========================================================================== #
# 小工具
# =========================================================================== #
def _delay(sig, seconds: float, rate: int = RATE):
    """信号延后 seconds 秒（前面补零）。"""
    k = int(round(seconds * rate))
    return ([0.0] * k + list(sig)) if k > 0 else list(sig)


def _fit(sig, n: int):
    """截断/补零到恰好 n 个样本。"""
    if len(sig) >= n:
        return list(sig[:n])
    return list(sig) + [0.0] * (n - len(sig))


def _scale(sig, k: float):
    return [x * k for x in sig]


def _env_ar(n: int, attack: float, tau: float, rate: int = RATE):
    """线性 attack + 指数 decay 包络。"""
    n = max(1, int(n))
    a = max(1, int(attack * rate))
    k = math.exp(-1.0 / (tau * rate)) if tau > 0 else 1.0
    out = [0.0] * n
    e = 1.0
    for i in range(n):
        if i < a:
            out[i] = i / a
        else:
            out[i] = e
            e *= k
    return out


def _poly_sweep(f0: float, f1: float, dur: float, rate: int = RATE,
                duty: float = 0.5):
    """方波扫频（相位积分）。"""
    n = max(1, int(dur * rate))
    out = [0.0] * n
    ph = 0.0
    f = float(f0)
    k = (float(f1) / float(f0)) ** (1.0 / (n - 1)) if n > 1 and f0 > 0 else 1.0
    for i in range(n):
        out[i] = 1.0 if (ph % 1.0) < duty else -1.0
        ph += f / rate
        f *= k
    return out


def _smoothstep(a: float, b: float, x: float) -> float:
    if a == b:
        return 1.0 if x >= b else 0.0
    t = (x - a) / (b - a)
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    return t * t * (3.0 - 2.0 * t)


def _lerp3(a, b, t: float):
    return (a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t)


def _pack_cov(w: int, h: int, cov, color):
    """覆盖率 -> RGBA 字节串（RGB 用固定色，A = cov*255）。"""
    out = bytearray(w * h * 4)
    r, g, b = color
    for i in range(w * h):
        v = cov[i]
        if v <= 0.004:
            continue
        a = int(v * 255.0 + 0.5)
        if a > 255:
            a = 255
        if a <= 0:
            continue
        o = i * 4
        out[o] = r
        out[o + 1] = g
        out[o + 2] = b
        out[o + 3] = a
    return out


# =========================================================================== #
# 音效合成
# =========================================================================== #
def _sfx_ui_hover(seed: int):
    """短促高频"叮"，轻快不刺耳。"""
    dur = 0.09
    n = int(dur * RATE)
    body = mix(sine(1180.0, dur), sine(2360.0, dur, amp=0.20),
               sine(590.0, dur, amp=0.10))
    return pan(apply_env(body, exp_decay(n, 0.030)), -0.10)


def _sfx_ui_click(seed: int):
    """正弦 + 极短噪声瞬态，鼠标点击。"""
    dur = 0.11
    n = int(dur * RATE)
    rng = random.Random(seed ^ 0x11)
    body = mix(sine(880.0, dur), sine(1760.0, dur, amp=0.45),
               sine(2640.0, dur, amp=0.18))
    env = exp_decay(n, 0.032)
    tick = one_pole_highpass(noise(n=1400, rng=rng), 2400.0)
    tick = [tick[i] * math.exp(-i / (0.004 * RATE)) for i in range(len(tick))]
    return pan(mix(apply_env(body, env), _fit(tick, n), gains=(1.0, 0.55)), 0.0)


def _sfx_ui_back(seed: int):
    """两声下行，取消/返回。"""
    dur = 0.22
    n = int(dur * RATE)
    seg1 = apply_env(sine_sweep(760.0, 520.0, 0.10), exp_decay(int(0.10 * RATE), 0.045))
    seg2 = apply_env(sine_sweep(520.0, 300.0, 0.13), exp_decay(int(0.13 * RATE), 0.055))
    body = mix(seg1, _delay(seg2, 0.075), gains=(1.0, 0.9))
    return pan(_fit(body, n), 0.10)


def _sfx_pulse_attract(seed: int):
    """低频上行扫频 + 轻微 FM：引力井通电（吸引）。"""
    dur = 0.60
    n = int(dur * RATE)
    sweep = sine_sweep(80.0, 240.0, dur, curve="exp", fm=(7.0, 0.06))
    sub = sine_sweep(40.0, 120.0, dur, curve="exp")
    body = one_pole_lowpass(mix(sweep, sub, gains=(1.0, 0.45)), 1800.0)
    return pan(apply_env(body, _env_ar(n, 0.12, 0.22)), 0.0)


def _sfx_pulse_repel(seed: int):
    """下行扫频 + 失真相位：极性反转（斥力）。"""
    dur = 0.55
    n = int(dur * RATE)
    sweep = sine_sweep(320.0, 110.0, dur, curve="exp", fm=(11.0, 0.10))
    grit = one_pole_lowpass(_poly_sweep(150.0, 70.0, dur, duty=0.35), 1200.0)
    body = soft_clip(mix(sweep, grit, gains=(1.0, 0.35)), drive=2.4)
    return pan(apply_env(body, _env_ar(n, 0.006, 0.16)), 0.05)


def _sfx_thruster_loop(seed: int):
    """推进器：滤波噪声，首尾无缝（周期性构造 + 低步进接缝相位，不做淡入淡出）。"""
    dur = 1.20
    n = int(dur * RATE)
    rng = random.Random(seed ^ 0x7A11)
    # 周期噪声：同一段素材拼 3 份，滤波后取中间一份 → 稳态即周期信号
    base = noise(n=n * 3, rng=rng)
    rumble = biquad_bandpass(one_pole_lowpass(base, 420.0), 190.0, q=1.1)
    mid = biquad_bandpass(base, 700.0, q=0.8)
    hiss = biquad_highpass(base, 3200.0)
    body = dc_block(mix(rumble, mid, hiss, gains=(1.0, 0.75, 0.30)))
    # 在周期稳态里挑一个"接缝步进最小"的相位：循环点不会有可闻咔哒
    span = min(4000, n - 1)
    best_t0 = n
    best_step = None
    for t0 in range(n, n + span):
        step = abs(body[t0] - body[t0 + n - 1])
        if best_step is None or step < best_step:
            best_step = step
            best_t0 = t0
    seg = body[best_t0:best_t0 + n]
    # 6 个 AM 周期/圈 → 依然无缝
    am = [1.0 + 0.16 * math.sin(2.0 * math.pi * 6.0 * i / n) for i in range(n)]
    sig = [seg[i] * am[i] for i in range(n)]
    # 55 Hz 在 1.2 s 内正好 66 个整周期 → 无缝低频轰鸣
    rum = [0.22 * math.sin(2.0 * math.pi * 55.0 * i / RATE) for i in range(n)]
    return pan(soft_clip(mix(sig, rum), drive=1.3), 0.0)


def _sfx_dock_success(seed: int):
    """对接成功：加法合成钟声（非谐泛音列）+ 混响尾，明亮。"""
    dur = 2.60
    n = int(dur * RATE)
    f0 = 523.2511  # C5
    partials = ((1.00, 1.00, 2.60), (2.00, 0.52, 1.90), (2.76, 0.34, 1.40),
                (4.07, 0.22, 1.00), (5.43, 0.15, 0.80), (6.79, 0.10, 0.60),
                (8.21, 0.07, 0.45), (10.90, 0.04, 0.35))
    layers = []
    for ratio, amp, tau in partials:
        f = f0 * ratio
        if f >= RATE * 0.45:
            continue
        layers.append(apply_env(sine(f, dur, amp=amp), exp_decay(n, tau)))
    # 第二次轻击，做出"确认"的双击感
    layers.append(_delay(apply_env(sine(f0 * 3.0, 0.9, amp=0.22),
                                   exp_decay(int(0.9 * RATE), 0.30)), 0.14))
    body = mix(*layers)
    strike = apply_env(biquad_bandpass(noise(n=2000, seed=seed + 7), 4400.0, q=0.8),
                       exp_decay(2000, 0.005))
    body = mix(body, _fit(strike, n), gains=(1.0, 0.30))
    return pan(reverb_schroeder(body, room=0.72, mix=0.26, decay=1.9), 0.0)


def _sfx_dock_fail(seed: int):
    """对接失败：下扫方波 + 失真 + 闷响。"""
    dur = 0.90
    n = int(dur * RATE)
    sq = _poly_sweep(300.0, 78.0, dur, duty=0.42)
    saw_like = sine_sweep(220.0, 60.0, dur, curve="exp")
    body = soft_clip(one_pole_lowpass(mix(sq, _scale(saw_like, 0.4)), 1600.0), drive=3.2)
    sub = apply_env(sine(58.0, dur), exp_decay(n, 0.18))
    return pan(mix(apply_env(body, exp_decay(n, 0.30)), _scale(sub, 0.5),
                   gains=(1.0, 1.0)), 0.0)


def _sfx_tidal_tear(seed: int):
    """潮汐撕裂：噪声爆 + 下扫 + 颗粒化。"""
    rng = random.Random(seed ^ 0x7E41)
    dur = 1.40
    n = int(dur * RATE)
    burst = _fit(apply_env(biquad_bandpass(noise(n=int(0.18 * RATE), rng=rng), 2600.0, q=0.7),
                           exp_decay(int(0.18 * RATE), 0.045)), n)
    sweep = apply_env(sine_sweep(1700.0, 70.0, 1.0, curve="exp"),
                      exp_decay(int(1.0 * RATE), 0.35))
    sweep = mix(sweep, _scale(_poly_sweep(900.0, 55.0, 1.0, duty=0.3), 0.4))
    grains = [0.0] * n
    for _ in range(46):
        gl = int(rng.uniform(0.012, 0.030) * RATE)
        at = int(rng.uniform(0.03, 1.10) * RATE)
        if at + gl > n:
            continue
        g = biquad_bandpass(noise(n=gl, rng=rng), rng.uniform(500.0, 5200.0), q=1.6)
        a = rng.uniform(0.15, 0.5)
        for i in range(gl):
            grains[at + i] += g[i] * a
    body = mix(burst, _delay(sweep, 0.06), grains, gains=(1.0, 0.9, 0.8))
    return pan(reverb_schroeder(soft_clip(body, drive=1.6), room=0.70, mix=0.22,
                                decay=1.1), 0.0)


def _sfx_impact_rock(seed: int):
    """撞岩石：低频阻尼正弦簇 + 短噪声碎屑。"""
    dur = 0.50
    n = int(dur * RATE)
    rng = random.Random(seed ^ 0x2C13)
    thud = mix(*[apply_env(sine(f, dur, amp=a), exp_decay(n, tau)) for f, a, tau in
                 ((92.0, 1.00, 0.100), (166.0, 0.60, 0.075), (268.0, 0.35, 0.050),
                  (430.0, 0.18, 0.035))])
    crack = _fit(apply_env(one_pole_lowpass(noise(n=int(0.12 * RATE), rng=rng), 2400.0),
                           exp_decay(int(0.12 * RATE), 0.022)), n)
    body = soft_clip(mix(thud, _scale(crack, 0.8)), drive=1.3)
    return pan(body, -0.08)


def _sfx_impact_hull(seed: int):
    """撞船体：金属非谐泛音 + 高频敲击 + 短混响。"""
    dur = 0.75
    n = int(dur * RATE)
    rng = random.Random(seed ^ 0x51A7)
    metal = mix(*[apply_env(sine(f, dur, amp=a), exp_decay(n, tau)) for f, a, tau in
                  ((388.0, 1.00, 0.26), (587.0, 0.70, 0.20), (812.0, 0.50, 0.15),
                   (1174.0, 0.35, 0.11), (1642.0, 0.22, 0.08), (2310.0, 0.12, 0.05))])
    tick = _fit(apply_env(biquad_bandpass(noise(n=int(0.05 * RATE), rng=rng), 3200.0, q=0.6),
                          exp_decay(int(0.05 * RATE), 0.012)), n)
    body = soft_clip(mix(metal, _scale(tick, 0.55)), drive=1.15)
    return pan(reverb_schroeder(body, room=0.60, mix=0.18, decay=0.9), 0.08)


def _siren(dur: float, f_lo: float = 640.0, f_hi: float = 880.0):
    """双音警笛（真实报警器音色）。"""
    n = int(dur * RATE)
    out = [0.0] * n
    ph = 0.0
    for i in range(n):
        alt = 0.5 * (1.0 + math.copysign(1.0, math.sin(2.0 * math.pi * 7.0 * i / RATE)))
        f = f_lo + (f_hi - f_lo) * alt
        out[i] = math.sin(ph)
        ph += 2.0 * math.pi * f / RATE
    sq = [1.0 if v > 0.0 else -1.0 for v in out]
    tone = [0.80 * out[i] + 0.20 * sq[i] for i in range(n)]
    tone = one_pole_lowpass(tone, 3000.0)
    return apply_env(tone, adsr(n, 0.008, 0.020, 0.85, 0.030))


def _sfx_wind_warning(seed: int):
    """星风警告：三连警笛，警度比 3:5:3。"""
    unit = 0.11
    parts = []
    t = 0.0
    for span in (3, 5, 3):
        d = span * unit
        parts.append(_delay(_siren(d), t))
        t += d + unit
    body = mix(*parts)
    return pan(one_pole_lowpass(body, 6000.0), 0.0)


def _brass(freq: float, dur: float, amp: float = 1.0):
    """铜管味加法音色（带限锯齿 + 饱和 + 起振），用于号角。"""
    n = int(dur * RATE)
    harmonics = max(1, min(8, int(4000.0 / max(60.0, freq))))
    tone = saw(freq, dur, harmonics=harmonics)
    tone = one_pole_lowpass(soft_clip(tone, drive=2.2), 3200.0)
    env = adsr(n, 0.030, 0.120, 0.72, 0.28)
    env = [e * math.exp(-i / (0.90 * RATE)) for i, e in enumerate(env)]
    return [amp * x * e for x, e in zip(_fit(tone, n), env)]


def _sfx_chapter_fanfare(seed: int):
    """章节号角：大三和弦琶音 + 收束长和弦 + Schroeder 混响尾。"""
    dur = 3.40
    n = int(dur * RATE)
    layers = []
    for f, at in ((523.2511, 0.00), (659.2551, 0.13), (783.9909, 0.26),
                  (1046.5023, 0.39)):
        layers.append(_delay(_brass(f, 0.55), at))
    for f, a in ((261.6266, 0.55), (523.2511, 1.00), (659.2551, 0.80),
                 (783.9909, 0.80), (1046.5023, 0.50)):
        layers.append(_delay(_brass(f, 2.00, amp=a), 0.62))
    body = _fit(mix(*layers), n)
    return pan(reverb_schroeder(body, room=0.88, mix=0.34, decay=2.4), 0.0)


def _sfx_blackhole_rumble(seed: int):
    """黑洞低鸣：次低频 + 缓慢拍频/相位漂移 + 缓慢滤波扫动。"""
    rng = random.Random(seed ^ 0x8B0C)
    dur = 4.50
    n = int(dur * RATE)
    subs = mix(sine(27.5, dur), sine(27.94, dur), sine(41.2, dur, amp=0.55),
               sine(55.0, dur, amp=0.35))
    nz = noise(n=n, rng=rng)
    a = biquad_bandpass(nz, 90.0, q=1.4)
    b = biquad_bandpass(nz, 150.0, q=1.2)
    drift = [0.5 + 0.5 * math.sin(2.0 * math.pi * 0.07 * i / RATE) for i in range(n)]
    noise_layer = [a[i] * drift[i] + b[i] * (1.0 - drift[i]) for i in range(n)]
    air = biquad_highpass(nz, 4000.0)
    air_env = [0.10 * (0.5 + 0.5 * math.sin(2.0 * math.pi * 0.11 * i / RATE + 1.3))
               for i in range(n)]
    air = [air[i] * air_env[i] for i in range(n)]
    trem = [0.75 + 0.25 * math.sin(2.0 * math.pi * 0.055 * i / RATE) for i in range(n)]
    body = mix(subs, noise_layer, air, gains=(0.9, 1.0, 0.5))
    body = [body[i] * trem[i] for i in range(n)]
    return pan(one_pole_lowpass(body, 520.0), 0.0)


def _sfx_countdown(seed: int):
    """倒计时：四拍脉冲，最后一拍更亮更长。"""
    parts = []
    for k in range(4):
        last = (k == 3)
        f = 1400.0 if last else 900.0
        d = 0.30 if last else 0.12
        tone = apply_env(mix(sine(f, d), sine(f * 2.0, d, amp=0.30)),
                         exp_decay(int(d * RATE), (d * 0.45) if last else 0.05))
        click = _fit(apply_env(noise(n=600, seed=seed + k), exp_decay(600, 0.004)),
                     int(d * RATE))
        parts.append(_delay(mix(tone, _scale(click, 0.30)), k * 0.75))
    return pan(mix(*parts), 0.0)


def _sfx_ignition(seed: int):
    """点火：噪声上升 + 带通中心上移 + 末端闷响。"""
    rng = random.Random(seed ^ 0x1601)
    dur = 2.20
    n = int(dur * RATE)
    nz = noise(n=n, rng=rng)
    rise = [(i / n) ** 1.6 for i in range(n)]
    body = [nz[i] * rise[i] for i in range(n)]
    lo = biquad_bandpass(body, 300.0, q=0.8)
    hi = biquad_bandpass(body, 2600.0, q=0.7)
    x = [(i / n) ** 2.0 for i in range(n)]
    body = [lo[i] * (1.0 - x[i]) + hi[i] * x[i] for i in range(n)]
    sw = apply_env(sine_sweep(60.0, 900.0, dur, curve="exp"),
                   [(i / n) ** 1.2 for i in range(n)])
    body = mix(body, _scale(sw, 0.35))
    thump = _delay(apply_env(mix(sine(70.0, 0.6), sine(120.0, 0.6, amp=0.4)),
                             exp_decay(int(0.6 * RATE), 0.13)), 1.55)
    return pan(soft_clip(mix(body, _scale(thump, 0.8)), drive=1.4), 0.0)


def _sfx_launch(seed: int):
    """发射：低频冲击 + 轰鸣 + 上升噪声 + 混响。"""
    rng = random.Random(seed ^ 0x4A0C)
    dur = 3.20
    n = int(dur * RATE)
    nz = noise(n=n, rng=rng)
    rumble = one_pole_lowpass(nz, 220.0)
    rumble = [rumble[i] * (0.55 + 0.45 * min(1.0, i / (0.8 * RATE))) for i in range(n)]
    rise = [(i / n) ** 1.3 for i in range(n)]
    roar = biquad_bandpass(nz, 480.0, q=0.6)
    roar = [roar[i] * rise[i] for i in range(n)]
    hiss = biquad_highpass(nz, 3500.0)
    hiss = [hiss[i] * rise[i] * 0.5 for i in range(n)]
    sub = mix(sine(41.2, dur), sine(55.0, dur, amp=0.7), sine(82.4, dur, amp=0.4))
    kick = _delay(apply_env(mix(sine_sweep(120.0, 38.0, 0.9, curve="exp"),
                                sine(60.0, 0.9, amp=0.6)),
                            exp_decay(int(0.9 * RATE), 0.22)), 0.05)
    body = mix(sub, rumble, roar, hiss, _scale(kick, 0.9),
               gains=(0.9, 1.0, 0.8, 0.4, 1.0))
    body = soft_clip(body, drive=1.25)
    return pan(reverb_schroeder(body, room=0.60, mix=0.15, decay=1.2), 0.0)


# (名字, 构造函数, write_wav 覆盖参数)
SFX_BUILDERS = [
    ("ui_hover", _sfx_ui_hover, {}),
    ("ui_click", _sfx_ui_click, {}),
    ("ui_back", _sfx_ui_back, {}),
    ("pulse_attract", _sfx_pulse_attract, {}),
    ("pulse_repel", _sfx_pulse_repel, {}),
    # 可循环素材：不做首尾淡化 + 不在这里二次去直流（构造时已周期化）
    ("thruster_loop", _sfx_thruster_loop, {"fade_ms": 0.0, "block_dc": False}),
    ("dock_success", _sfx_dock_success, {}),
    ("dock_fail", _sfx_dock_fail, {}),
    ("tidal_tear", _sfx_tidal_tear, {}),
    ("impact_rock", _sfx_impact_rock, {}),
    ("impact_hull", _sfx_impact_hull, {}),
    ("wind_warning", _sfx_wind_warning, {}),
    ("chapter_fanfare", _sfx_chapter_fanfare, {}),
    ("blackhole_rumble", _sfx_blackhole_rumble, {}),
    ("countdown", _sfx_countdown, {}),
    ("ignition", _sfx_ignition, {}),
    ("launch", _sfx_launch, {}),
]


# =========================================================================== #
# 贴图生成（全部 8 bit RGBA，供 Canvas2D 以 lighter 叠加）
# =========================================================================== #
def _art_glow_soft(seed: int):
    """平滑径向衰减：中心 1，边缘恰为 0，无环带（保证叠加时不出现同心圆）。"""
    s = 256
    c = (s - 1) / 2.0
    cov = [0.0] * (s * s)
    edge = math.exp(-3.4)
    k = 1.0 / (1.0 - edge)
    for y in range(s):
        dy = (y - c) / (s / 2.0)
        dy2 = dy * dy
        row = y * s
        for x in range(s):
            dx = (x - c) / (s / 2.0)
            v = (math.exp(-3.4 * (dx * dx + dy2)) - edge) * k
            if v > 0.0:
                cov[row + x] = v
    return s, s, _pack_cov(s, s, cov, (255, 246, 232))


def _art_glow_ring(seed: int):
    """发光环（冲击波环 / 对接环高亮）。"""
    s = 256
    c = (s - 1) / 2.0
    cov = [0.0] * (s * s)
    for y in range(s):
        dy = (y - c) / (s / 2.0)
        row = y * s
        for x in range(s):
            dx = (x - c) / (s / 2.0)
            t = math.hypot(dx, dy)
            v = math.exp(-((t - 0.63) / 0.130) ** 2) + 0.10 * math.exp(-(t / 0.30) ** 2)
            if t > 1.0:
                v *= max(0.0, 1.0 - (t - 1.0) / 0.06)
            cov[row + x] = v if v < 1.0 else 1.0
    return s, s, _pack_cov(s, s, cov, (168, 226, 255))


def _art_star_field(seed: int):
    """星场：幂律亮度分布（大量暗星 + 少量亮星），亮星带十字光芒。"""
    s = 512
    rng = random.Random(seed ^ 0x57A2)
    cov = [0.0] * (s * s)
    cr = [0.0] * (s * s)
    cg = [0.0] * (s * s)
    cb = [0.0] * (s * s)
    for _ in range(1100):
        u = rng.random()
        b = u ** 5.0                      # 幂律：P(暗) 远大于 P(亮)
        if b < 0.03:
            continue
        x = rng.random() * s
        y = rng.random() * s
        warm = rng.random()
        col = _lerp3((255.0, 214.0, 170.0), (190.0, 220.0, 255.0), warm)
        sigma = 0.45 + 1.5 * b
        amp = min(1.0, 0.10 + 1.05 * b)
        rad = int(sigma * 3.0) + 1
        xi = int(x)
        yi = int(y)
        flare = b > 0.72                   # 最亮的少数几颗给十字光芒
        for yy in range(max(0, yi - rad), min(s, yi + rad + 1)):
            dy = yy - y
            for xx in range(max(0, xi - rad), min(s, xi + rad + 1)):
                dx = xx - x
                v = amp * math.exp(-(dx * dx + dy * dy) / (2.0 * sigma * sigma))
                if v <= 0.004:
                    continue
                if flare:
                    v = max(v, amp * 0.55 * math.exp(-abs(dy) / 0.75)
                            * math.exp(-abs(dx) / 22.0))
                    v = max(v, amp * 0.55 * math.exp(-abs(dx) / 0.75)
                            * math.exp(-abs(dy) / 22.0))
                idx = yy * s + xx
                if v > cov[idx]:
                    cov[idx] = v
                    cr[idx] = col[0]
                    cg[idx] = col[1]
                    cb[idx] = col[2]
    out = bytearray(s * s * 4)
    for i in range(s * s):
        v = cov[i]
        if v <= 0.004:
            continue
        a = int(v * 255.0 + 0.5)
        a = 255 if a > 255 else a
        o = i * 4
        out[o] = int(cr[i] + 0.5)
        out[o + 1] = int(cg[i] + 0.5)
        out[o + 2] = int(cb[i] + 0.5)
        out[o + 3] = a
    return s, s, out


def _hash01(ix: int, iy: int, seed: int) -> float:
    n = (ix * 374761393 + iy * 668265263 + seed * 362437) & 0xFFFFFFFF
    n = (n ^ (n >> 13)) & 0xFFFFFFFF
    n = (n * 1274126177) & 0xFFFFFFFF
    n = (n ^ (n >> 16)) & 0xFFFFFFFF
    return n / 4294967295.0


def _value_noise(x: float, y: float, seed: int) -> float:
    ix = math.floor(x)
    iy = math.floor(y)
    fx = x - ix
    fy = y - iy
    sx = fx * fx * (3.0 - 2.0 * fx)
    sy = fy * fy * (3.0 - 2.0 * fy)
    n00 = _hash01(ix, iy, seed)
    n10 = _hash01(ix + 1, iy, seed)
    n01 = _hash01(ix, iy + 1, seed)
    n11 = _hash01(ix + 1, iy + 1, seed)
    a = n00 + (n10 - n00) * sx
    b = n01 + (n11 - n01) * sx
    return a + (b - a) * sy


def _fbm(x: float, y: float, seed: int, octaves: int = 4,
         lacunarity: float = 2.03, gain: float = 0.5) -> float:
    total = 0.0
    norm = 0.0
    amp = 1.0
    freq = 1.0
    for o in range(octaves):
        total += amp * _value_noise(x * freq, y * freq, seed + o * 101)
        norm += amp
        amp *= gain
        freq *= lacunarity
    return total / norm if norm else 0.0


def _art_nebula(seed: int, tint_core, tint_edge, octaves: int = 5):
    """fBm 值噪声星云：4~6 倍频 + 自适应对比拉伸成丝状，径向遮罩收边。

    自适应：先统计本张噪声的 55%/99% 分位再拉伸，保证各章星云浓度一致，
    不会因为噪声相位不同而一张浓一张淡。
    """
    s = 256
    scale = 3.0
    half = s / 2.0
    vals = [0.0] * (s * s)
    mixs = [0.0] * (s * s)
    mask = [0.0] * (s * s)
    for y in range(s):
        ny = y / s * scale
        dy = (y - half + 0.5) / half
        row = y * s
        for x in range(s):
            nx = x / s * scale
            dx = (x - half + 0.5) / half
            i = row + x
            vals[i] = _fbm(nx, ny, seed, octaves=octaves)
            mixs[i] = _fbm(nx * 0.5 + 7.3, ny * 0.5 + 2.1, seed + 991, octaves=2)
            mask[i] = _smoothstep(1.02, 0.62, math.hypot(dx, dy))

    order = sorted(vals)
    lo = order[int(len(order) * 0.55)]
    hi = order[int(len(order) * 0.99)]
    if hi - lo < 1e-6:
        hi = lo + 1e-6

    out = bytearray(s * s * 4)
    for i in range(s * s):
        cov = _smoothstep(lo, hi, vals[i]) ** 1.15 * mask[i]
        if cov <= 0.004:
            continue
        if cov > 1.0:
            cov = 1.0
        col = _lerp3(tint_core, tint_edge, min(1.0, mixs[i] * 1.30))
        a = int(cov * 255.0 + 0.5)
        a = 255 if a > 255 else a
        o = i * 4
        out[o] = int(col[0] + 0.5)
        out[o + 1] = int(col[1] + 0.5)
        out[o + 2] = int(col[2] + 0.5)
        out[o + 3] = a
    return s, s, out


def _art_grid_hex(seed: int):
    """六边形网格。尺寸 384x222 使格子精确平铺（Rx=32，纵向 0.13% 拉伸换整数周期）。"""
    w, h = 384, 222
    rx = 32.0
    ry = h / (4.0 * math.sqrt(3.0))
    sqrt3 = math.sqrt(3.0)
    out = bytearray(w * h * 4)
    for y in range(h):
        py = y + 0.5
        for x in range(w):
            px = x + 0.5
            q = (2.0 / 3.0) * px / rx
            r = (-1.0 / 3.0) * px / rx + (sqrt3 / 3.0) * py / ry
            cx, cy, cz = q, -q - r, r
            ix, iy, iz = round(cx), round(cy), round(cz)
            dx, dy, dz = abs(ix - cx), abs(iy - cy), abs(iz - cz)
            if dx > dy and dx > dz:
                ix = -iy - iz
            elif dy > dz:
                iy = -ix - iz
            else:
                iz = -ix - iy
            dq, dr = q - ix, r - iz
            hd = max(abs(dq), abs(dr), abs(dq + dr))
            line = _smoothstep(0.450, 0.497, hd)
            v = 0.045 + 0.955 * line
            a = int(v * 255.0 + 0.5)
            o = (y * w + x) * 4
            out[o] = 89
            out[o + 1] = 217
            out[o + 2] = 255
            out[o + 3] = 255 if a > 255 else a
    return w, h, out


def _art_spark(seed: int):
    """火花/粒子：亮核 + 十字拖尾。"""
    s = 64
    c = (s - 1) / 2.0
    cov = [0.0] * (s * s)
    for y in range(s):
        dy = y - c
        row = y * s
        for x in range(s):
            dx = x - c
            core = math.exp(-(dx * dx + dy * dy) / (2.0 * 1.35 ** 2))
            v = core
            v += 0.50 * math.exp(-abs(dy) / 0.85) * math.exp(-abs(dx) / 13.0)
            v += 0.50 * math.exp(-abs(dx) / 0.85) * math.exp(-abs(dy) / 13.0)
            border = max(0.0, 1.0 - (max(abs(dx), abs(dy)) / c) ** 6)
            v *= border
            cov[row + x] = v if v < 1.0 else 1.0
    return s, s, _pack_cov(s, s, cov, (255, 244, 214))


def _point_in_poly(px: float, py: float, pts) -> bool:
    inside = False
    n = len(pts)
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > py) != (yj > py):
            if px < (xj - xi) * (py - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside


def _dist_to_seg(px: float, py: float, a, b) -> float:
    ax, ay = a
    bx, by = b
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L = vx * vx + vy * vy
    t = 0.0 if L <= 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L))
    dx, dy = wx - t * vx, wy - t * vy
    return math.hypot(dx, dy)


def _art_shard(seed: int):
    """碎片：锯齿多边形 + 金属高光边缘（3x3 超采样抗锯齿）。"""
    s = 64
    rng = random.Random(seed ^ 0x5A17)
    c = (s - 1) / 2.0
    nv = rng.randint(5, 6)
    base = 24.0
    pts = []
    for i in range(nv):
        ang = 2.0 * math.pi * i / nv + rng.uniform(-0.22, 0.22)
        rad = base * rng.uniform(0.55, 1.0)
        pts.append((c + rad * math.cos(ang), c + rad * math.sin(ang)))
    out = bytearray(s * s * 4)
    body_col = (128, 140, 158)
    rim_col = (232, 246, 255)
    for y in range(s):
        for x in range(s):
            hits = 0
            edge = 0.0
            for sy in range(3):
                py = y + (sy + 0.5) / 3.0
                for sx in range(3):
                    px = x + (sx + 0.5) / 3.0
                    if _point_in_poly(px, py, pts):
                        hits += 1
                        d = min(_dist_to_seg(px, py, pts[i], pts[(i + 1) % nv])
                                for i in range(nv))
                        e = math.exp(-(d / 1.6) ** 2)
                        if e > edge:
                            edge = e
            if not hits:
                continue
            cov = hits / 9.0
            col = _lerp3(body_col, rim_col, edge)
            o = (y * s + x) * 4
            out[o] = int(col[0] + 0.5)
            out[o + 1] = int(col[1] + 0.5)
            out[o + 2] = int(col[2] + 0.5)
            out[o + 3] = int(cov * 255.0 + 0.5)
    return s, s, out


def _art_vignette(seed: int):
    """暗角：中心透明，四角压暗（source-over 叠加即压暗画面）。"""
    s = 256
    c = (s - 1) / 2.0
    out = bytearray(s * s * 4)
    k = 1.0 / math.sqrt(2.0)
    for y in range(s):
        dy = (y - c) / c
        row = y * s
        for x in range(s):
            dx = (x - c) / c
            t = math.hypot(dx, dy) * k
            v = _smoothstep(0.42, 1.0, t) ** 1.25
            a = int(215.0 * v + 0.5)
            if a <= 0:
                continue
            o = (row + x) * 4
            out[o] = 5
            out[o + 1] = 7
            out[o + 2] = 15
            out[o + 3] = 255 if a > 255 else a
    return s, s, out


def _art_lens_gradient(seed: int):
    """径向渐变（供径向模糊权重 / 镜头光晕）：中心 1，圆周 0，平滑无环带。"""
    s = 256
    c = (s - 1) / 2.0
    out = bytearray(s * s * 4)
    for y in range(s):
        dy = (y - c) / (s / 2.0)
        row = y * s
        for x in range(s):
            dx = (x - c) / (s / 2.0)
            t = math.hypot(dx, dy)
            v = max(0.0, 1.0 - t) ** 1.4
            a = int(v * 255.0 + 0.5)
            if a <= 0:
                continue
            o = (row + x) * 4
            out[o] = 200
            out[o + 1] = 232
            out[o + 2] = 255
            out[o + 3] = a
    return s, s, out


def _art_ring_dock(seed: int):
    """空间站对接环：双环 + 四辐条 + 四个琥珀色对接卡爪 + 中心淡光。"""
    s = 256
    c = (s - 1) / 2.0
    R = s / 2.0
    jade = (142, 247, 208)
    amber = (255, 179, 71)
    out = bytearray(s * s * 4)
    spokes = [math.pi / 4.0 + k * math.pi / 2.0 for k in range(4)]
    clamps = [(0.86 * math.cos(k * math.pi / 2.0), 0.86 * math.sin(k * math.pi / 2.0))
              for k in range(4)]
    for y in range(s):
        dy = (y - c) / R
        row = y * s
        for x in range(s):
            dx = (x - c) / R
            r = math.hypot(dx, dy)
            if r > 1.02:
                continue
            cov = 0.0
            col = jade
            if 0.800 <= r <= 0.900:
                cov = 1.0
            if 0.550 <= r <= 0.585:
                cov = 1.0
            for a in spokes:
                proj = dx * math.cos(a) + dy * math.sin(a)
                perp = abs(-dx * math.sin(a) + dy * math.cos(a))
                if 0.570 <= proj <= 0.880 and perp < 0.022:
                    cov = 1.0
            for cx, cy in clamps:
                if abs(dx - cx) < 0.075 and abs(dy - cy) < 0.075:
                    cov = 1.0
                    col = amber
            if cov == 0.0 and r < 0.42:
                cov = 0.35 * math.exp(-(r / 0.22) ** 2)
            if cov <= 0.004:
                continue
            if r > 0.98:
                cov *= max(0.0, (1.02 - r) / 0.04)
            a8 = int(cov * 255.0 + 0.5)
            if a8 <= 0:
                continue
            o = (row + x) * 4
            out[o] = col[0]
            out[o + 1] = col[1]
            out[o + 2] = col[2]
            out[o + 3] = 255 if a8 > 255 else a8
    return s, s, out


def _art_app_icon(seed: int):
    """EXE 图标：圆形深色底盘 + 品红引力井 + 青色轨道环 + 琥珀货舱。"""
    s = 256
    c = (s - 1) / 2.0
    R = s / 2.0
    plate = (10, 15, 30)
    magenta = (255, 79, 216)
    cyan = (89, 217, 255)
    amber = (255, 179, 71)
    px_ = 0.86 * math.cos(-0.6)
    py_ = 0.34 * math.sin(-0.6)
    out = bytearray(s * s * 4)
    for y in range(s):
        dy = (y - c) / R
        row = y * s
        for x in range(s):
            dx = (x - c) / R
            r = math.hypot(dx, dy)
            a_plate = _smoothstep(0.96, 0.90, r)
            if a_plate <= 0.0:
                continue
            r0, g0, b0 = float(plate[0]), float(plate[1]), float(plate[2])
            # 品红引力井（径向渐变 + 两道同心井环）
            glow = math.exp(-(r / 0.42) ** 2)
            rings = (math.exp(-((r - 0.22) / 0.035) ** 2) * 0.80
                     + math.exp(-((r - 0.36) / 0.035) ** 2) * 0.55)
            k = min(1.0, glow * 0.85 + rings)
            r0 += magenta[0] * k
            g0 += magenta[1] * k
            b0 += magenta[2] * k
            # 青色轨道环（椭圆）
            e = math.hypot(dx / 0.86, dy / 0.34)
            orbit = math.exp(-((e - 1.0) / 0.05) ** 2)
            ko = min(1.0, orbit * 1.5)
            r0 += (cyan[0] - r0) * ko
            g0 += (cyan[1] - g0) * ko
            b0 += (cyan[2] - b0) * ko
            # 外圈冷光
            rim = math.exp(-((r - 0.905) / 0.022) ** 2)
            kr = min(1.0, rim) * 0.75
            r0 += (cyan[0] - r0) * kr
            g0 += (cyan[1] - g0) * kr
            b0 += (cyan[2] - b0) * kr
            # 轨道上的货舱点
            pod = math.exp(-(math.hypot(dx - px_, dy - py_) / 0.075) ** 2)
            kp = min(1.0, pod * 1.6)
            r0 += (amber[0] - r0) * kp
            g0 += (amber[1] - g0) * kp
            b0 += (amber[2] - b0) * kp
            o = (row + x) * 4
            out[o] = 255 if r0 > 255 else int(r0 + 0.5)
            out[o + 1] = 255 if g0 > 255 else int(g0 + 0.5)
            out[o + 2] = 255 if b0 > 255 else int(b0 + 0.5)
            out[o + 3] = int(252.0 * a_plate + 0.5)
    return s, s, out


ART_BUILDERS = [
    ("glow_soft", _art_glow_soft),
    ("glow_ring", _art_glow_ring),
    ("star_field", _art_star_field),
    ("nebula_loop1", lambda seed: _art_nebula(seed + 11, (150.0, 84.0, 255.0),
                                              (236.0, 208.0, 255.0), octaves=5)),
    ("nebula_loop2", lambda seed: _art_nebula(seed + 22, (60.0, 200.0, 255.0),
                                              (196.0, 255.0, 250.0), octaves=5)),
    ("nebula_loop3", lambda seed: _art_nebula(seed + 33, (255.0, 138.0, 48.0),
                                              (255.0, 214.0, 170.0), octaves=5)),
    ("nebula_loop4", lambda seed: _art_nebula(seed + 44, (150.0, 22.0, 44.0),
                                              (255.0, 132.0, 150.0), octaves=4)),
    ("grid_hex", _art_grid_hex),
    ("spark", _art_spark),
    ("shard", _art_shard),
    ("vignette", _art_vignette),
    ("lens_gradient", _art_lens_gradient),
    ("ring_dock", _art_ring_dock),
]


# =========================================================================== #
# 生成 / 校验
# =========================================================================== #
def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for blk in iter(lambda: f.read(1 << 20), b""):
            h.update(blk)
    return h.hexdigest()


def _measure_png(path: Path) -> dict:
    w, h, _ch, _d, _ct = png_writer.read_png_info(path)
    return {"w": w, "h": h}


def _required_missing(manifest: dict) -> list:
    have_a = {e["name"] for e in manifest.get("audio", [])}
    have_r = {e["name"] for e in manifest.get("art", [])}
    have_m = {e["name"] for e in manifest.get("music", [])}
    miss = [f"audio:{n}" for n in REQUIRED_AUDIO if n not in have_a]
    miss += [f"art:{n}" for n in REQUIRED_ART if n not in have_r]
    miss += [f"art:{n}" for n in EXTRA_ART if n not in have_r]
    miss += [f"music:{n}" for n in REQUIRED_MUSIC if n not in have_m]
    return miss


def generate_all(force: bool = False, seed: int = DEFAULT_SEED) -> dict:
    """生成全部素材并写 manifest.json，返回 manifest dict。

    ``force=False`` 且 manifest 完好（sha256 全部对得上、seed 相同）时直接返回，
    不做任何重建；manifest 缺失/损坏/seed 变化则重建（已存在且内容正确的单个文件不重复生成）。
    """
    for d in (AUDIO, ART, DATA):
        d.mkdir(parents=True, exist_ok=True)
    manifest_path = DATA / "manifest.json"

    if not force and manifest_path.exists():
        try:
            old = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            old = None
        if isinstance(old, dict):
            if old.get("seed") != int(seed):
                # seed 变了就必须重生成，否则 manifest 的 seed 与实际素材不符
                print(f"[assets] manifest seed={old.get('seed')} != 请求 seed={seed}"
                      f" → 全量重建")
                force = True
            elif not _required_missing(old):
                ok, _problems = verify_manifest()
                if ok:
                    print(f"[assets] 已存在且校验通过，跳过生成（seed={seed}）；"
                          f"如需重建加 --force")
                    return old

    t0 = time.time()
    print(f"[assets] 开始生成 seed={seed} force={force}")

    # ---------------- audio ----------------
    audio_entries = []
    for name, builder, opts in SFX_BUILDERS:
        path = AUDIO / f"{name}.wav"
        if force or not path.exists():
            left, right = builder(seed)
            write_wav(path, left, right, fade_ms=opts.get("fade_ms", 5.0),
                      block_dc=opts.get("block_dc", True))
            print(f"  wav   {name:<17s} {path.stat().st_size:>8d} B")
        m = wav_writer.measure_wav(path)
        audio_entries.append({
            "name": name,
            "file": f"audio/{path.name}",
            "bytes": path.stat().st_size,
            "seconds": m["seconds"],
            "peak": m["peak"],
            "rate": m["rate"],
            "channels": m["channels"],
            "sha256": _sha256(path),
        })

    # ---------------- art ----------------
    art_entries = []
    for name, builder in ART_BUILDERS:
        path = ART / f"{name}.png"
        if force or not path.exists():
            w, h, rgba = builder(seed)
            png_writer.write_png(path, w, h, rgba)
            print(f"  png   {name:<17s} {w}x{h} {path.stat().st_size:>8d} B")
        info = _measure_png(path)
        art_entries.append({
            "name": name,
            "file": f"art/{path.name}",
            "w": info["w"],
            "h": info["h"],
            "bytes": path.stat().st_size,
            "sha256": _sha256(path),
        })

    ico_path = ART / "app.ico"
    if force or not ico_path.exists():
        w, h, rgba = _art_app_icon(seed)
        png_writer.write_ico(ico_path, png_writer.encode_png(w, h, rgba, 4), w)
        print(f"  ico   app.ico           {w}x{h} {ico_path.stat().st_size:>8d} B")
    ico_info = _measure_png(ico_path)
    art_entries.append({
        "name": "app.ico",
        "file": f"art/{ico_path.name}",
        "w": ico_info["w"],
        "h": ico_info["h"],
        "bytes": ico_path.stat().st_size,
        "sha256": _sha256(ico_path),
    })

    # ---------------- music ----------------
    music_entries = music_gen.write_scores(AUDIO, force=force, seed=seed)
    for e in music_entries:
        print(f"  json  music_{e['name']:<11s} {e['bpm']:>4d} BPM  "
              f"{(AUDIO / ('music_' + e['name'] + '.json')).stat().st_size:>8d} B")

    # ---------------- manifest ----------------
    total = sum(e["bytes"] for e in audio_entries)
    total += sum(e["bytes"] for e in art_entries)
    total += sum((AUDIO / Path(e["file"]).name).stat().st_size for e in music_entries)

    manifest = {
        "version": MANIFEST_VERSION,
        "generator": GENERATOR,
        "seed": int(seed),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "audio": audio_entries,
        "art": art_entries,
        "music": music_entries,
        "total_bytes": total,
    }
    missing = _required_missing(manifest)
    if missing:
        raise RuntimeError(f"必需素材缺失，拒绝写出 manifest：{missing}")
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"[assets] 完成：audio {len(audio_entries)} / art {len(art_entries)} / "
          f"music {len(music_entries)}，total_bytes={total}，"
          f"耗时 {time.time() - t0:.1f}s")
    return manifest


def verify_manifest() -> tuple[bool, list[str]]:
    """校验 manifest 与磁盘实际文件是否一致，返回 ``(ok, 问题列表)``。"""
    problems: list[str] = []
    manifest_path = DATA / "manifest.json"
    if not manifest_path.exists():
        return False, [f"manifest 缺失：{manifest_path}"]

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return False, [f"manifest 无法解析：{exc}"]

    if manifest.get("version") != MANIFEST_VERSION:
        problems.append(f"version 异常：{manifest.get('version')!r}")
    missing = _required_missing(manifest)
    problems.extend(f"必需素材缺失：{m}" for m in missing)

    def _check_common(entry: dict, path: Path, label: str) -> bool:
        if not path.exists():
            problems.append(f"{label} 文件不存在：{path}")
            return False
        size = path.stat().st_size
        if entry.get("bytes") is not None and size != entry.get("bytes"):
            problems.append(f"{label} 字节数不符：manifest {entry.get('bytes')} != 磁盘 {size}")
        digest = _sha256(path)
        if digest != entry.get("sha256"):
            problems.append(f"{label} sha256 不符：{entry.get('sha256')[:12]}… != {digest[:12]}…")
        return True

    # ---- audio ----
    for entry in manifest.get("audio", []):
        name = entry.get("name", "?")
        path = ASSETS / entry.get("file", "")
        if not _check_common(entry, path, f"audio:{name}"):
            continue
        try:
            with wave.open(str(path), "rb") as w:
                frames = w.getnframes()
                rate = w.getframerate()
                channels = w.getnchannels()
                width = w.getsampwidth()
                raw = w.readframes(frames)
        except (wave.Error, OSError) as exc:
            problems.append(f"audio:{name} 无法用 wave 读取：{exc}")
            continue
        if frames <= 0:
            problems.append(f"audio:{name} nframes=0")
        if rate != 44100:
            problems.append(f"audio:{name} 采样率 {rate} != 44100")
        if channels != 2:
            problems.append(f"audio:{name} 声道数 {channels} != 2")
        if width != 2:
            problems.append(f"audio:{name} 位深 {width * 8} != 16")
        seconds = round(frames / float(rate or 1), 6)
        if abs(seconds - float(entry.get("seconds", -1))) > 1e-3:
            problems.append(f"audio:{name} 时长不符：manifest {entry.get('seconds')} != {seconds}")
        data = array("h")
        data.frombytes(raw)
        peak = (max(max(data), -min(data)) / 32768.0) if data else 0.0
        if abs(peak - float(entry.get("peak", -1))) > 1e-3:
            problems.append(f"audio:{name} 峰值不符：manifest {entry.get('peak')} != {peak:.6f}")
        if peak > 0.9501:
            problems.append(f"audio:{name} 峰值 {peak:.4f} 超过 0.95")
        if data:
            dc = sum(data) / float(len(data)) / 32768.0
            if abs(dc) > 0.001:
                problems.append(f"audio:{name} 直流偏移过大 {dc:.5f}")
        if entry.get("rate") != rate or entry.get("channels") != channels:
            problems.append(f"audio:{name} manifest 的 rate/channels 与实际不符")

    # ---- art ----
    for entry in manifest.get("art", []):
        name = entry.get("name", "?")
        path = ASSETS / entry.get("file", "")
        if not _check_common(entry, path, f"art:{name}"):
            continue
        try:
            w, h, ch, depth, ctype = png_writer.read_png_info(path)
        except (AssertionError, OSError, struct.error) as exc:
            problems.append(f"art:{name} PNG/ICO 头部非法：{exc}")
            continue
        if (w, h) != (entry.get("w"), entry.get("h")):
            problems.append(f"art:{name} 尺寸不符：manifest {entry.get('w')}x{entry.get('h')} != {w}x{h}")
        if depth != 8 or ch != 4:
            problems.append(f"art:{name} 非 8bit RGBA：depth={depth} channels={ch}")
        try:
            raw = _decode_png_pixels(path) if name != "app.ico" else _decode_ico_pixels(path)
        except (AssertionError, OSError, ValueError, struct.error) as exc:
            problems.append(f"art:{name} 像素解码失败：{exc}")
            continue
        if len(raw) != w * h * 4:
            problems.append(f"art:{name} 解码字节数 {len(raw)} != {w * h * 4}")

    # ---- music ----
    modes = set()
    for entry in manifest.get("music", []):
        name = entry.get("name", "?")
        path = ASSETS / entry.get("file", "")
        if not _check_common(entry, path, f"music:{name}"):
            continue
        try:
            score = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            problems.append(f"music:{name} 无法解析：{exc}")
            continue
        problems.extend(music_gen.verify_score(score))
        for key in ("bpm", "bars", "beats_per_bar", "key", "mode"):
            if score.get(key) != entry.get(key):
                problems.append(f"music:{name} manifest 的 {key} 与文件不符")
        modes.add(score.get("mode"))
    if len(modes) < 4:
        problems.append(f"音乐调式区分度不足：仅 {sorted(modes)}")

    total = sum(e.get("bytes", 0) for e in manifest.get("audio", []))
    total += sum(e.get("bytes", 0) for e in manifest.get("art", []))
    total += sum((ASSETS / e.get("file", "")).stat().st_size
                 for e in manifest.get("music", [])
                 if (ASSETS / e.get("file", "")).exists())
    if total != manifest.get("total_bytes"):
        problems.append(f"total_bytes 不符：manifest {manifest.get('total_bytes')} != 实算 {total}")

    return (len(problems) == 0), problems


def _decode_png_pixels(data, label: str = "png") -> bytes:
    """独立解一遍 PNG（IHDR/IDAT/filter type 0），确认像素真的能解出来。"""
    blob = data if isinstance(data, (bytes, bytearray)) else Path(data).read_bytes()
    assert blob[:8] == png_writer.PNG_SIGNATURE, f"{label} PNG 签名错误"
    pos = 8
    w = h = None
    idat = bytearray()
    while pos < len(blob):
        (length,) = struct.unpack_from(">I", blob, pos)
        tag = blob[pos + 4:pos + 8]
        body = blob[pos + 8:pos + 8 + length]
        if tag == b"IHDR":
            w, h, depth, ctype, comp, filt, inter = struct.unpack(">IIBBBBB", body)
            assert depth == 8 and ctype == 6 and inter == 0, "只支持 8bit RGBA 非隔行"
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            break
        pos += 12 + length
    raw = zlib.decompress(bytes(idat))
    stride = w * 4
    assert len(raw) == (stride + 1) * h, "解压后扫描线长度不符"
    out = bytearray(stride * h)
    for y in range(h):
        o = y * (stride + 1)
        assert raw[o] == 0, f"第 {y} 行 filter type != 0"
        out[y * stride:(y + 1) * stride] = raw[o + 1:o + 1 + stride]
    return bytes(out)


def _decode_ico_pixels(path: Path) -> bytes:
    blob = Path(path).read_bytes()
    assert blob[:4] == b"\x00\x00\x01\x00", "ICO 头非法"
    assert struct.unpack_from("<H", blob, 4)[0] >= 1, "ICO 无图像"
    length, offset = struct.unpack_from("<II", blob, 14)
    assert offset + length <= len(blob), "ICO 资源越界"
    assert blob[offset:offset + 8] == png_writer.PNG_SIGNATURE, "ICO 内嵌不是 PNG"
    return _decode_png_pixels(blob[offset:offset + length], "app.ico")


def _report() -> None:
    """打印 assets 目录统计：文件数、总字节、最大 5 个文件。"""
    files = [p for p in ASSETS.rglob("*") if p.is_file()]
    total = sum(p.stat().st_size for p in files)
    print(f"[assets] 文件数 {len(files)}，总字节 {total}（{total / 1048576:.2f} MiB）")
    for p in sorted(files, key=lambda q: -q.stat().st_size)[:5]:
        print(f"  TOP  {p.relative_to(ASSETS)}  {p.stat().st_size} B")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="《牧星者》程序化素材生成（纯标准库）")
    ap.add_argument("--force", action="store_true", help="强制重建全部素材")
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED, help="随机种子")
    ap.add_argument("--verify", action="store_true", help="只校验 manifest 与文件一致性")
    args = ap.parse_args(argv)

    if args.verify and not args.force:
        ok, problems = verify_manifest()
        for p in problems:
            print(f"  [FAIL] {p}")
        print(f"[assets] verify: {'OK' if ok else 'FAIL'}"
              f"（{len(problems)} 处不一致）")
        _report()
        return 0 if ok else 1

    try:
        generate_all(force=args.force, seed=args.seed)
    except RuntimeError as exc:
        print(f"[assets] 生成失败：{exc}")
        return 1

    ok, problems = verify_manifest()
    for p in problems:
        print(f"  [FAIL] {p}")
    print(f"[assets] verify: {'OK' if ok else 'FAIL'}（{len(problems)} 处不一致）")
    _report()
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
