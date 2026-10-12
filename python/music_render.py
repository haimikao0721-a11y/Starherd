"""music_render.py —— 把 ``assets/audio/music_*.json`` 谱面**离线渲染成 WAV**，供游戏内下载。

为什么需要它
------------
游戏里的音乐是 **TS 侧 WebAudio 实时合成**的（不落地成音频文件），所以"下载背景音乐"
必须先把同一份谱面渲染成波形。这里用纯标准库（``wave`` + ``math`` + ``struct``）做离线渲染：

* 与 TS 侧**共用同一份谱面 JSON**（音符时刻单位是拍，`track` ∈ pad|bass|arp|perc|lead）；
* 声部包络/滤波按 TS 合成器的设计近似（saw/sine/tri + 一极低通 + AD 包络）；
* 打击乐用 GM 音高：36 底鼓、38 军鼓、42 闭合踩镲；
* 输出 16bit 立体声 44.1kHz，峰值归一化到 -1.5 dB，尾部加淡出。

**只服务 EXE / 网页模式**：谱面渲染由宿主进程完成（``/api/music/<id>.wav``），
离线单文件版没有宿主，因此天然不提供该入口（与用户要求一致）。

用法::

    python python/music_render.py --list
    python python/music_render.py --out dist_music            # 渲染全部
    python python/music_render.py --out dist_music --only menu
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import wave
from pathlib import Path

SR = 44100
PEAK = 0.84                      # -1.5 dB
FADE_OUT = 1.6                   # 尾部淡出秒数

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ASSETS = ROOT / "assets" / "audio"

# 正式曲名（不改动谱面 JSON：避免牵动 manifest 的 sha256 与离线包）
TITLES = {
    "menu":  ("牧星者", "Shepherd of Stars"),
    "loop1": ("首次接触", "First Contact"),
    "loop2": ("碎屑带", "Debris Belt"),
    "loop3": ("双星共振", "Binary Resonance"),
    "loop4": ("深渊视界", "Abyss Horizon"),
}

# GM 打击乐音高
PERC_KICK, PERC_SNARE, PERC_HAT = 36, 38, 42

# 声部参数（近似 TS 合成器：波形 / 起音 / 释放 / 一极低通截止 / 增益 / 失谐）
VOICES: dict[str, dict[str, float | str]] = {
    "pad": {"wave": "saw", "attack": 0.9, "release": 1.4, "cutoff": 1500.0, "gain": 0.17, "detune": 0.010},
    "bass": {"wave": "sine", "attack": 0.02, "release": 0.30, "cutoff": 700.0, "gain": 0.30, "detune": 0.0},
    "arp": {"wave": "tri", "attack": 0.004, "release": 0.20, "cutoff": 3400.0, "gain": 0.15, "detune": 0.0},
    "lead": {"wave": "saw", "attack": 0.03, "release": 0.45, "cutoff": 4600.0, "gain": 0.13, "detune": 0.0},
}


def midi_hz(m: float) -> float:
    """MIDI 音高 → 频率（A4 = 440Hz）。"""
    return 440.0 * (2.0 ** ((m - 69.0) / 12.0))


def _osc(wave: str, phase: float) -> float:
    """相位 → 采样（0..1 的相位，不是弧度）。"""
    p = phase - math.floor(phase)
    if wave == "sine":
        return math.sin(2.0 * math.pi * p)
    if wave == "tri":
        return 4.0 * abs(p - 0.5) - 1.0
    # saw：带轻微低通感的锯齿（直接生成会太亮，靠调用方的一极低通压）
    return 2.0 * p - 1.0


def render_score(score: dict, sr: int = SR) -> bytes:
    """把一份谱面渲染成 16bit 立体声 WAV 字节流。"""
    bpm = float(score.get("bpm", 100))
    bpbar = int(score.get("beats_per_bar", 4))
    bars = int(score.get("bars", 16))
    beats = bars * bpbar
    spb = 60.0 / bpm                      # 每拍秒数
    total = beats * spb
    n = int(total * sr) + int(FADE_OUT * sr)
    left = [0.0] * n
    right = [0.0] * n

    for nt in score.get("notes", []):
        track = str(nt.get("track", "arp"))
        midi = float(nt.get("midi", 60))
        vel = float(nt.get("vel", 0.8))
        t0 = float(nt.get("t", 0)) * spb
        dur = max(0.05, float(nt.get("dur", 1)) * spb)
        i0 = int(t0 * sr)
        if i0 >= n:
            continue

        if track == "perc":
            _render_perc(left, right, i0, int(midi), vel, sr)
            continue

        v = VOICES.get(track, VOICES["arp"])
        freq = midi_hz(midi)
        atk = float(v["attack"])
        rel = float(v["release"])
        gain = float(v["gain"]) * vel
        cut = float(v["cutoff"])
        det = float(v["detune"])
        wave = str(v["wave"])
        dur_s = dur + rel
        m = int(dur_s * sr)
        # 一极低通系数（与截止频率对应）
        alpha = 1.0 - math.exp(-2.0 * math.pi * cut / sr)
        lp1 = lp2 = 0.0
        ph1 = ph2 = 0.0
        for i in range(m):
            j = i0 + i
            if j >= n:
                break
            t = i / sr
            # AD 包络：起音 + 保持 + 释放
            if t < atk:
                env = t / max(atk, 1e-4)
            elif t < dur:
                env = 1.0
            else:
                env = max(0.0, 1.0 - (t - dur) / max(rel, 1e-4))
            env *= env                     # 稍软一点
            s1 = _osc(wave, ph1)
            s2 = _osc(wave, ph2)
            raw = (s1 + s2) * 0.5 if det > 0 else s1
            lp1 += alpha * (raw - lp1)
            lp2 += alpha * (s2 - lp2)
            a = lp1 * gain * env
            # 轻微立体声宽度：失谐声部左右不同相
            b = (lp2 if det > 0 else lp1) * gain * env
            left[j] += a
            right[j] += b
            ph1 += freq * (1.0 + det) / sr
            ph2 += freq * (1.0 - det) / sr

    _normalize(left, right, total, sr)
    return _wav_bytes(left, right, sr)


def _render_perc(left: list[float], right: list[float], i0: int, midi: int, vel: float, sr: int) -> None:
    """打击乐：底鼓（正弦下扫）/ 军鼓（噪声+音体）/ 踩镲（高通噪声）。"""
    if midi == PERC_KICK:
        dur, gain = 0.34, 0.55
        for i in range(int(dur * sr)):
            j = i0 + i
            if j >= len(left):
                break
            t = i / sr
            f = 48.0 + 110.0 * math.exp(-t / 0.045)
            env = math.exp(-t / 0.11)
            s = math.sin(2.0 * math.pi * f * t) * env * gain * vel
            left[j] += s
            right[j] += s
        return
    if midi == PERC_SNARE:
        dur, gain = 0.22, 0.34
        rnd = _Rng(0x5eed ^ (i0 & 0xFFFF))
        hp = 0.0
        for i in range(int(dur * sr)):
            j = i0 + i
            if j >= len(left):
                break
            t = i / sr
            env = math.exp(-t / 0.075)
            noise = rnd.next() * 2.0 - 1.0
            hp += 0.55 * (noise - hp)          # 近似高通：去掉低频
            body = math.sin(2.0 * math.pi * 196.0 * t) * 0.4
            s = (hp + body) * env * gain * vel
            left[j] += s * 0.95
            right[j] += s
        return
    # hat
    dur, gain = 0.09, 0.20
    rnd = _Rng(0xC0FFEE ^ (i0 & 0xFFFF))
    hp = 0.0
    for i in range(int(dur * sr)):
        j = i0 + i
        if j >= len(left):
            break
        t = i / sr
        env = math.exp(-t / 0.028)
        noise = rnd.next() * 2.0 - 1.0
        hp += 0.85 * (noise - hp)
        s = (noise - hp) * env * gain * vel
        left[j] += s
        right[j] += s * 0.9


class _Rng:
    """小型确定性 PRNG（噪声用；不依赖 random 的全局状态）。"""

    def __init__(self, seed: int) -> None:
        self.s = (seed | 1) & 0xFFFFFFFF

    def next(self) -> float:
        self.s = (self.s * 1103515245 + 12345) & 0x7FFFFFFF
        return self.s / 0x7FFFFFFF


def _normalize(left: list[float], right: list[float], sustain: float, sr: int) -> None:
    """峰值归一化 + 尾部淡出。"""
    peak = 0.0
    for i in range(len(left)):
        v = abs(left[i])
        if v > peak:
            peak = v
        v = abs(right[i])
        if v > peak:
            peak = v
    if peak > 0:
        k = PEAK / peak
        n = len(left)
        for i in range(n):
            left[i] *= k
            right[i] *= k
    # 淡出（从 sustain 结束到末尾）
    f0 = int(sustain * sr)
    n = len(left)
    for i in range(f0, n):
        g = max(0.0, 1.0 - (i - f0) / max(1.0, (n - f0)))
        left[i] *= g
        right[i] *= g


def _wav_bytes(left: list[float], right: list[float], sr: int) -> bytes:
    import io

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = bytearray()
        for i in range(len(left)):
            a = max(-1.0, min(1.0, left[i]))
            b = max(-1.0, min(1.0, right[i]))
            frames += struct.pack("<hh", int(a * 32767), int(b * 32767))
        w.writeframes(bytes(frames))
    return buf.getvalue()


def list_scores() -> list[dict]:
    """列出可用谱面（id / 曲名 / BPM / 调式 / 时长）。"""
    out: list[dict] = []
    for p in sorted(ASSETS.glob("music_*.json")):
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        sid = p.stem.replace("music_", "")
        beats = int(j.get("bars", 16)) * int(j.get("beats_per_bar", 4))
        secs = beats * 60.0 / float(j.get("bpm", 100))
        out.append({
            "id": sid,
            "title_zh": TITLES.get(sid, (sid, sid))[0],
            "title_en": TITLES.get(sid, (sid, sid))[1],
            "bpm": j.get("bpm"),
            "key": j.get("key"),
            "mode": j.get("mode"),
            "seconds": round(secs, 1),
        })
    return out


def render_one(sid: str, out_dir: Path) -> Path:
    """渲染一首并写盘，返回文件路径。"""
    src = ASSETS / f"music_{sid}.json"
    score = json.loads(src.read_text(encoding="utf-8"))
    data = render_score(score)
    out_dir.mkdir(parents=True, exist_ok=True)
    dst = out_dir / f"Starherd_{sid}.wav"
    dst.write_bytes(data)
    return dst


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="把谱面离线渲染成 WAV（供游戏内下载 / 试听）")
    ap.add_argument("--out", type=Path, default=ROOT / "dist_music", help="输出目录")
    ap.add_argument("--only", default="", help="只渲染某一首（如 menu）")
    ap.add_argument("--list", action="store_true", help="只列出谱面")
    args = ap.parse_args(argv)

    if args.list:
        for it in list_scores():
            print(f"  {it['id']:<7} {it['title_zh']:<10} {it['bpm']} BPM  {it['key']} {it['mode']:<11} {it['seconds']}s")
        return 0

    ids = [args.only] if args.only else [it["id"] for it in list_scores()]
    for sid in ids:
        dst = render_one(sid, args.out)
        print(f"[music] {sid} -> {dst}  {dst.stat().st_size:,} B")
    return 0


if __name__ == "__main__":
    sys.exit(main())
