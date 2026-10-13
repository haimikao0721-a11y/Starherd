"""music_gen.py —— 生成 `assets/audio/music_*.json` 谱面（严格按 INTERFACES §5 schema）。

《牧星者 / STARHERD》W-assets 程序化素材管线。

5 首：``menu`` + ``loop1..loop4``（对应 4 章）。Python 只产出**谱面 JSON**，
TS 侧 WebAudio 合成器实时演奏；每音符带 ``intensity`` 阈值，随游戏强度叠加声部。

固定约定（与渲染/音频侧对齐）
--------------------------
* ``t`` / ``dur`` 单位 = **拍**（不是秒），``t`` 从循环头起算。
* ``track`` ∈ ``pad|bass|arp|perc|lead``。
* ``perc`` 轨用 GM 打击乐音高：36 = 底鼓、38 = 军鼓、42 = 闭合踩镲。
* 每首 16 小节 × 4 拍 = 64 拍 ≥ 32 拍；和声每 2 小节一变 → 8 次和弦变化 ≥ 4。
* 调式各不相同：aeolian / dorian / lydian / phrygian / mixolydian。
* BPM 全部落在 84..118。所有随机性走 ``random.Random(seed)``。
"""

from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path

__all__ = [
    "MODES", "TRACKS", "PIECES", "DEFAULT_SEED",
    "build_score", "build_all_scores", "write_scores", "verify_score",
]

DEFAULT_SEED = 20260101
BEATS_PER_BAR = 4
TRACKS = ("pad", "bass", "arp", "perc", "lead")

# GM 打击乐音高
PERC_KICK = 36
PERC_SNARE = 38
PERC_HAT = 42

MODES = {
    "ionian": [0, 2, 4, 5, 7, 9, 11],
    "dorian": [0, 2, 3, 5, 7, 9, 10],
    "phrygian": [0, 1, 3, 5, 7, 8, 10],
    "lydian": [0, 2, 4, 6, 7, 9, 11],
    "mixolydian": [0, 2, 4, 5, 7, 9, 10],
    "aeolian": [0, 2, 3, 5, 7, 8, 10],
    "locrian": [0, 1, 3, 5, 6, 8, 10],
    # 扩展方案第 5 项新增两种色彩调式
    "hijaz": [0, 1, 4, 5, 7, 8, 10],        # 增二度 → 异域/紧张，用于宇宙风暴
    "whole": [0, 2, 4, 6, 8, 10],           # 全音阶 → 失重/释然，用于终章
}

# 主音音高（八度 3 区，pad 和声围绕它铺开）
KEY_ROOT_MIDI = {"C": 48, "D": 50, "E": 52, "F": 53, "G": 55, "A": 57, "B": 59}

# 各声部进入阈值（写进每个音符的 intensity 字段）
LV_PAD = 0.10
LV_PAD_SUB = 0.50
LV_BASS = 0.30
LV_KICK = 0.30
LV_HAT = 0.40
LV_SNARE = 0.50
LV_ARP = 0.60
LV_LEAD = 0.75

# 段落（16 小节）：intro → build → main → outro
SECTIONS_LOOP = [(0, "intro", 0.20), (4, "build", 0.45), (8, "main", 0.80),
                 (14, "outro", 0.35)]
SECTIONS_MENU = [(0, "intro", 0.25), (4, "main", 0.55), (12, "outro", 0.30)]

PIECES = [
    dict(
        name="loop1", title_zh="双星摇篮", key="A", mode="aeolian", bpm=96,
        bars=16, prog=[0, 5, 2, 6], bars_per_chord=2, sections=SECTIONS_LOOP,
        pad_center=58, bass_pattern=[(0, 0.0, 1.5), (4, 2.0, 1.5), (0, 3.5, 0.5)],
        kick=[(0.0, 0.92), (2.0, 0.74)], snare=[(1.0, 0.62), (3.0, 0.70)],
        hat_step=0.5, hat_vel=0.30, hat_accent=0.44,
        perc_from_bar=4, hat_from_bar=6,
        arp=[(0, 1, 0.5), (2, 1, 0.5), (4, 1, 0.5), (2, 1, 0.5),
             (4, 1, 0.5), (6, 1, 0.5), (4, 1, 0.5), (2, 1, 0.5)],
        arp_from_bar=8, arp_to_bar=14,
        lead=[(4, 1, 0.0, 1.0), (5, 1, 1.0, 1.0), (4, 1, 2.0, 2.0),
              (2, 1, 4.0, 1.0), (4, 1, 5.0, 1.0), (0, 1, 6.0, 2.0)],
        lead_repeat=2, lead_from_bar=8, lead_to_bar=14,
    ),
    dict(
        name="loop2", title_zh="碎石带", key="D", mode="dorian", bpm=110,
        bars=16, prog=[0, 3, 5, 6], bars_per_chord=2, sections=SECTIONS_LOOP,
        pad_center=57, bass_pattern=[(0, 0.0, 1.0), (0, 1.5, 0.5), (4, 2.0, 1.0),
                                     (6, 3.5, 0.5)],
        kick=[(0.0, 0.95), (1.5, 0.60), (2.5, 0.72)],
        snare=[(1.0, 0.66), (3.0, 0.74)],
        hat_step=0.5, hat_vel=0.28, hat_accent=0.42,
        perc_from_bar=4, hat_from_bar=5,
        arp=[(0, 1, 0.25), (2, 1, 0.25), (4, 1, 0.25), (6, 1, 0.25),
             (4, 1, 0.25), (2, 1, 0.25), (4, 1, 0.25), (6, 1, 0.25)],
        arp_from_bar=8, arp_to_bar=14,
        lead=[(0, 1, 0.0, 0.5), (1, 1, 0.5, 0.5), (2, 1, 1.0, 1.0),
              (4, 1, 2.0, 2.0), (2, 1, 4.0, 1.0), (0, 1, 5.0, 0.5),
              (2, 1, 6.0, 2.0)],
        lead_repeat=2, lead_from_bar=8, lead_to_bar=14,
    ),
    dict(
        name="loop3", title_zh="双星共振", key="G", mode="lydian", bpm=116,
        bars=16, prog=[0, 1, 4, 5], bars_per_chord=2, sections=SECTIONS_LOOP,
        pad_center=59, bass_pattern=[(0, 0.0, 1.0), (4, 1.0, 0.5), (0, 2.0, 1.0),
                                     (2, 3.0, 0.5), (4, 3.5, 0.5)],
        kick=[(0.0, 0.95), (1.0, 0.68), (2.0, 0.90), (3.0, 0.68)],
        snare=[(1.0, 0.70), (3.0, 0.76)],
        hat_step=0.25, hat_vel=0.24, hat_accent=0.40,
        perc_from_bar=4, hat_from_bar=6,
        arp=[(0, 1, 0.25), (4, 1, 0.25), (2, 1, 0.25), (6, 1, 0.25)],
        arp_from_bar=8, arp_to_bar=14,
        lead=[(3, 1, 0.0, 1.0), (4, 1, 1.0, 1.0), (6, 1, 2.0, 2.0),
              (4, 1, 4.0, 1.0), (2, 1, 5.0, 1.0), (4, 1, 6.0, 2.0)],
        lead_repeat=2, lead_from_bar=8, lead_to_bar=14,
    ),
    dict(
        name="loop4", title_zh="深渊视界", key="E", mode="phrygian", bpm=92,
        bars=16, prog=[0, 1, 6, 5], bars_per_chord=2, sections=SECTIONS_LOOP,
        pad_center=55, bass_pattern=[(0, 0.0, 2.0), (4, 2.0, 2.0)],
        kick=[(0.0, 1.00), (2.5, 0.70)], snare=[(2.0, 0.82)],
        hat_step=1.0, hat_vel=0.26, hat_accent=0.36,
        perc_from_bar=4, hat_from_bar=7,
        arp=[(0, 1, 0.5), (2, 1, 0.5), (4, 1, 0.5), (None, 1, 0.5),
             (2, 1, 0.5), (4, 1, 0.5), (6, 1, 0.5), (None, 1, 0.5)],
        arp_from_bar=8, arp_to_bar=14,
        lead=[(0, 1, 0.0, 2.0), (1, 1, 2.0, 2.0), (0, 1, 4.0, 1.0),
              (6, 0, 5.0, 3.0)],
        lead_repeat=2, lead_from_bar=8, lead_to_bar=14,
    ),
    dict(
        name="menu", title_zh="主菜单", key="C", mode="mixolydian", bpm=84,
        bars=16, prog=[0, 6, 3, 4], bars_per_chord=2, sections=SECTIONS_MENU,
        pad_center=57, bass_pattern=[(0, 0.0, 2.5), (4, 2.5, 1.5)],
        kick=[(0.0, 0.58), (2.0, 0.42)], snare=[],
        hat_step=1.0, hat_vel=0.20, hat_accent=0.28,
        perc_from_bar=2, hat_from_bar=4,
        arp=[(4, 1, 0.5), (2, 1, 0.5), (0, 1, 0.5), (2, 1, 0.5)],
        arp_from_bar=4, arp_to_bar=12,
        lead=[(2, 1, 0.0, 1.0), (4, 1, 1.0, 1.0), (6, 1, 2.0, 2.0),
              (4, 1, 4.0, 1.0), (2, 1, 5.0, 1.0), (0, 1, 6.0, 2.0)],
        lead_repeat=1, lead_from_bar=4, lead_to_bar=12,
        lead_level=0.50, arp_level=0.50,
    ),
    # ---- 扩展方案第 5 项：事件与终章 ----------
    # 注：原本打算用全音阶（whole-tone）写终章，但本项目的谱面 schema 要求
    # scale 为 7 音（verify_score 会判定 6 音非法），因此改用 ionian（大调）——
    # 对「终章」的释然感其实更贴切。
    dict(
        name="storm", title_zh="宇宙风暴", key="G", mode="hijaz", bpm=118,
        bars=16, prog=[0, 1, 4, 5], bars_per_chord=2,
        sections=[(0, "warning", 0.25), (4, "storm", 1.00), (12, "aftermath", 0.40)],
        pad_center=59, bass_pattern=[(0, 0.0, 0.5), (0, 0.5, 0.5), (4, 1.0, 1.0),
                                     (2, 2.0, 0.5), (0, 2.5, 0.5), (4, 3.0, 1.0)],
        kick=[(0.0, 1.00), (1.0, 0.78), (2.0, 0.95), (3.0, 0.78)],
        snare=[(1.0, 0.80), (3.0, 0.86)],
        hat_step=0.25, hat_vel=0.26, hat_accent=0.46,
        perc_from_bar=2, hat_from_bar=2,
        arp=[(0, 1, 0.25), (2, 1, 0.25), (4, 1, 0.25), (6, 1, 0.25),
             (4, 1, 0.25), (2, 1, 0.25), (1, 1, 0.25), (0, 1, 0.25)],
        arp_from_bar=4, arp_to_bar=16,
        lead=[(4, 1, 0.0, 1.0), (5, 1, 1.0, 1.0), (4, 1, 2.0, 2.0),
              (2, 1, 4.0, 1.0), (4, 1, 5.0, 0.5), (1, 1, 5.5, 0.5),
              (0, 1, 6.0, 2.0)],
        lead_repeat=2, lead_from_bar=4, lead_to_bar=16,
    ),
    dict(
        name="rescue", title_zh="救援倒计时", key="A", mode="locrian", bpm=104,
        bars=16, prog=[0, 1, 0, 6], bars_per_chord=2,
        sections=[(0, "alert", 0.35), (3, "countdown", 0.95), (12, "resolve", 0.45)],
        pad_center=57, bass_pattern=[(0, 0.0, 1.0), (0, 1.0, 1.0), (0, 2.0, 1.0),
                                     (4, 3.0, 1.0)],
        kick=[(0.0, 0.72), (2.0, 0.62)],
        snare=[(3.0, 0.55)],
        hat_step=0.5, hat_vel=0.30, hat_accent=0.48,     # 稳定的滴答 → 倒计时感
        perc_from_bar=2, hat_from_bar=1,
        arp=[(0, 1, 0.5), (2, 1, 0.5), (4, 1, 0.5), (2, 1, 0.5)],
        arp_from_bar=3, arp_to_bar=16,
        lead=[(0, 1, 0.0, 1.5), (1, 1, 2.0, 0.5), (0, 1, 3.0, 1.0),
              (6, 1, 5.0, 1.0)],
        lead_repeat=3, lead_from_bar=3, lead_to_bar=16,
    ),
    dict(
        name="finale", title_zh="终章", key="D", mode="ionian", bpm=84,
        bars=16, prog=[0, 2, 4, 1], bars_per_chord=2,
        sections=[(0, "drift", 0.20), (6, "bloom", 0.70), (12, "rest", 0.25)],
        pad_center=62, bass_pattern=[(0, 0.0, 3.0), (4, 3.0, 1.0)],
        kick=[], snare=[],                                # 终章不用打击乐
        hat_step=1.0, hat_vel=0.14, hat_accent=0.20,
        perc_from_bar=16, hat_from_bar=8,
        arp=[(0, 1, 1.0), (2, 1, 1.0), (4, 1, 1.0), (2, 1, 1.0)],
        arp_from_bar=6, arp_to_bar=16,
        lead=[(4, 1, 0.0, 2.0), (2, 1, 2.0, 2.0), (0, 1, 4.0, 4.0)],
        lead_repeat=2, lead_from_bar=6, lead_to_bar=16,
        lead_level=0.45, arp_level=0.45,
    ),
]

# --------------------------------------------------------------------------- #
# 乐理工具
# --------------------------------------------------------------------------- #
def _mix_seed(seed: int, name: str) -> int:
    """把 (seed, name) 混成一个稳定的 int 种子（不用 str hash，跨进程确定）。"""
    h = 2166136261
    for ch in f"{int(seed)}:{name}".encode("utf-8"):
        h = ((h ^ ch) * 16777619) & 0xFFFFFFFF
    return h


def _midi(root_midi: int, scale, degree: int, octave: int = 0) -> int:
    """音阶级数（可越界，自动跨八度）→ MIDI 音高。"""
    d = int(degree)
    n = len(scale)          # 调式音数（全音阶为 6，不能写死 7）
    return int(root_midi) + 12 * (d // n + int(octave)) + scale[d % n]


def _voice(prev, root_midi: int, scale, degree: int, center: float = 57.0):
    """三和弦长音的声部连接：在候选八度位移里挑"离上一和弦最近、离中心最近"的。"""
    base = [_midi(root_midi, scale, degree + k) for k in (0, 2, 4)]
    best = None
    best_cost = None
    for shift in (-24, -12, 0, 12, 24):
        cand = [p + shift for p in base]
        if min(cand) < 36 or max(cand) > 84:
            continue
        cost = 0.40 * abs(sum(cand) / 3.0 - center)
        if prev:
            cost += sum(min(abs(c - q) for q in prev) for c in cand) / 3.0
        if best_cost is None or cost < best_cost:
            best_cost = cost
            best = cand
    return best if best is not None else base


def _section_at(bar: int, sections):
    cur = sections[0]
    for s in sections:
        if bar >= s[0]:
            cur = s
    return cur


class _Notes:
    """音符收集器（保证 t/dur/midi/vel/track/intensity 六字段齐全）。"""

    def __init__(self, rng: random.Random):
        self.items: list[dict] = []
        self.rng = rng

    def add(self, t: float, dur: float, midi: int, vel: float, track: str,
            intensity: float, jitter: float = 0.04):
        if track not in TRACKS:
            raise ValueError(f"非法 track {track!r}")
        v = vel + (self.rng.uniform(-jitter, jitter) if jitter else 0.0)
        v = max(0.05, min(1.0, v))
        self.items.append({
            "t": round(float(t), 4),
            "dur": round(float(dur), 4),
            "midi": int(midi),
            "vel": round(v, 3),
            "track": track,
            "intensity": round(float(intensity), 3),
        })


# --------------------------------------------------------------------------- #
# 谱面构建
# --------------------------------------------------------------------------- #
def build_score(piece: dict, seed: int = DEFAULT_SEED) -> dict:
    """把一首曲子的配方展开成 INTERFACES §5 谱面 dict。"""
    name = piece["name"]
    key = piece["key"]
    mode = piece["mode"]
    scale = MODES[mode]
    root = KEY_ROOT_MIDI[key]
    bpm = int(piece["bpm"])
    bars = int(piece["bars"])
    bpb = BEATS_PER_BAR
    total_beats = bars * bpb
    bpc = int(piece.get("bars_per_chord", 2))
    prog = list(piece["prog"])
    sections = [(int(b), n, float(i)) for b, n, i in piece["sections"]]

    rng = random.Random(_mix_seed(seed, name))
    notes = _Notes(rng)

    # ---------------- pad（三和弦长音，每和弦 8 拍）+ 低八度根音 ---------------- #
    chords = []
    prev = None
    bar = 0
    ci = 0
    while bar < bars:
        deg = prog[ci % len(prog)]
        voicing = _voice(prev, root, scale, deg, center=piece.get("pad_center", 57))
        prev = voicing
        chords.append((bar, deg, voicing))
        bar += bpc
        ci += 1

    for start_bar, deg, voicing in chords:
        t = start_bar * bpb
        dur = min(bpc * bpb, total_beats - t)
        if dur <= 0:
            continue
        for p in voicing:
            notes.add(t, dur, p, 0.66, "pad", LV_PAD, jitter=0.02)
        # 主歌段加一层低八度根音，垫厚度（不低于 C2，避免糊成一团）
        if start_bar >= 8:
            sub = voicing[0] - 12
            while sub < 38:
                sub += 12
            notes.add(t, dur, sub, 0.52, "pad", LV_PAD_SUB, jitter=0.0)

    # ---------------- bass（根音 + 五度） ---------------- #
    bass_root = root - 12
    for b in range(bars):
        if b < 2:
            continue
        t_bar = b * bpb
        deg = prog[(b // bpc) % len(prog)]
        for off, beat, dur in piece["bass_pattern"]:
            midi = _midi(bass_root, scale, deg + off)
            while midi > bass_root + 12:   # 五度不越出一个八度，避免低音跑到中音区
                midi -= 12
            while midi < bass_root - 1:
                midi += 12
            notes.add(t_bar + beat, dur, midi, 0.88, "bass", LV_BASS, jitter=0.03)

    # ---------------- perc（底鼓 / 军鼓 / 踩镲） ---------------- #
    for b in range(bars):
        if b < piece.get("perc_from_bar", 4):
            continue
        t_bar = b * bpb
        for beat, vel in piece["kick"]:
            notes.add(t_bar + beat, 0.25, PERC_KICK, vel, "perc", LV_KICK,
                      jitter=0.03)
        for beat, vel in piece["snare"]:
            notes.add(t_bar + beat, 0.25, PERC_SNARE, vel, "perc", LV_SNARE,
                      jitter=0.03)
    hat_step = float(piece.get("hat_step", 0.5))
    hat_from = int(piece.get("hat_from_bar", 6))
    step = 0.0
    while step < total_beats:
        b = int(step // bpb)
        if b >= hat_from:
            pos = step % bpb
            on_beat = abs(pos - round(pos)) < 1e-9
            vel = piece.get("hat_accent", 0.42) if on_beat else piece.get("hat_vel", 0.3)
            open_hat = (abs(pos - (bpb - hat_step)) < 1e-9 and hat_step >= 0.5)
            dur = hat_step * (1.6 if open_hat else 0.8)
            dur = min(dur, total_beats - step)
            if dur <= 1e-9:
                break
            notes.add(step, dur, PERC_HAT, vel * (0.85 if open_hat else 1.0),
                      "perc", LV_HAT, jitter=0.04)
        step = round(step + hat_step, 6)

    # ---------------- arp（音阶琶音，只在 main） ---------------- #
    arp = piece.get("arp") or []
    arp_from = int(piece.get("arp_from_bar", 8))
    arp_to = int(piece.get("arp_to_bar", 14))
    arp_level = float(piece.get("arp_level", LV_ARP))
    if arp:
        t = arp_from * bpb
        end = min(arp_to * bpb, total_beats)
        i = 0
        while t < end - 1e-9:
            off, octv, dur = arp[i % len(arp)]
            bar_now = int(t // bpb)
            deg = prog[(bar_now // bpc) % len(prog)]
            if off is not None and t + dur <= end + 1e-9:
                notes.add(t, dur, _midi(root, scale, deg + off, octv), 0.62,
                          "arp", arp_level, jitter=0.05)
            t = round(t + dur, 6)
            i += 1

    # ---------------- lead（主题动机，只在 main，重复 lead_repeat 次） ---------------- #
    motif = piece.get("lead") or []
    lead_from = int(piece.get("lead_from_bar", 8))
    lead_to = int(piece.get("lead_to_bar", 14))
    lead_level = float(piece.get("lead_level", LV_LEAD))
    span = 8.0
    for rep in range(int(piece.get("lead_repeat", 2))):
        base = lead_from * bpb + rep * span
        for off, octv, beat, dur in motif:
            t = base + beat
            if t + dur > min(lead_to * bpb, total_beats) + 1e-9:
                continue
            bar_now = int(t // bpb)
            deg = prog[(bar_now // bpc) % len(prog)]
            notes.add(t, dur, _midi(root, scale, deg + off, octv), 0.80,
                      "lead", lead_level, jitter=0.04)

    items = sorted(notes.items, key=lambda n: (n["t"], n["track"], n["midi"]))
    return {
        "name": name,
        "bpm": bpm,
        "bars": bars,
        "beats_per_bar": bpb,
        "key": key,
        "mode": mode,
        "scale": list(scale),
        "sections": [{"start_bar": b, "name": n, "intensity": i}
                     for b, n, i in sections],
        "notes": items,
    }


def build_all_scores(seed: int = DEFAULT_SEED) -> list[dict]:
    """按 manifest 声明顺序返回全部谱面：loop1..loop4, menu, storm, rescue, finale。"""
    # 顺序表必须与 PIECES 同步：新增曲目要加进来，否则谱面永远不会被构建
    # （扩展方案第 5 项：storm / rescue / finale）
    order = ["loop1", "loop2", "loop3", "loop4", "menu", "storm", "rescue", "finale"]
    by_name = {p["name"]: p for p in PIECES}
    return [build_score(by_name[n], seed) for n in order]


def score_text(score: dict) -> str:
    return json.dumps(score, indent=2, ensure_ascii=False) + "\n"


def write_scores(audio_dir, force: bool = False, seed: int = DEFAULT_SEED) -> list[dict]:
    """写 ``music_<name>.json``，返回 manifest 的 music 段（含 sha256）。"""
    audio_dir = Path(audio_dir)
    audio_dir.mkdir(parents=True, exist_ok=True)
    entries = []
    for score in build_all_scores(seed):
        path = audio_dir / f"music_{score['name']}.json"
        text = score_text(score)
        if force or not path.exists() or path.read_text(encoding="utf-8") != text:
            path.write_text(text, encoding="utf-8")
        raw = path.read_bytes()
        entries.append({
            "name": score["name"],
            "file": f"audio/{path.name}",
            "bpm": score["bpm"],
            "bars": score["bars"],
            "beats_per_bar": score["beats_per_bar"],
            "key": score["key"],
            "mode": score["mode"],
            "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
        })
    return entries


# --------------------------------------------------------------------------- #
# 校验
# --------------------------------------------------------------------------- #
def verify_score(score: dict) -> list[str]:
    """谱面自检，返回问题列表（空 = 合法）。"""
    bad: list[str] = []
    name = score.get("name", "?")
    bpm = score.get("bpm")
    bars = score.get("bars")
    bpb = score.get("beats_per_bar")
    if not isinstance(bpm, int) or not (84 <= bpm <= 118):
        bad.append(f"{name}: bpm {bpm} 越界（要求 84..118）")
    if not isinstance(bars, int) or bars < 8:
        bad.append(f"{name}: bars {bars} 过少")
    if bpb != 4:
        bad.append(f"{name}: beats_per_bar 应为 4")
    if score.get("mode") not in MODES:
        bad.append(f"{name}: 未知调式 {score.get('mode')!r}")
    scale = score.get("scale")
    if not isinstance(scale, list) or len(scale) != 7 or scale[0] != 0:
        bad.append(f"{name}: scale 非法 {scale!r}")
    elif score.get("mode") in MODES and scale != MODES[score["mode"]]:
        bad.append(f"{name}: scale 与 mode 不匹配")
    if score.get("key") not in KEY_ROOT_MIDI:
        bad.append(f"{name}: 未知调 {score.get('key')!r}")

    beats = (bars or 0) * (bpb or 0)
    if beats < 32:
        bad.append(f"{name}: 总长 {beats} 拍 < 32")

    secs = score.get("sections") or []
    if not secs:
        bad.append(f"{name}: 缺 sections")
    for s in secs:
        if not (0 <= s.get("start_bar", -1) < (bars or 0)):
            bad.append(f"{name}: section start_bar 越界 {s}")
        if not (0.0 <= float(s.get("intensity", -1)) <= 1.0):
            bad.append(f"{name}: section intensity 越界 {s}")

    notes = score.get("notes") or []
    if not notes:
        bad.append(f"{name}: 无音符")
    pad_groups = set()
    for i, n in enumerate(notes):
        tr = n.get("track")
        if tr not in TRACKS:
            bad.append(f"{name}: 音符 {i} 非法 track {tr!r}")
        for k in ("t", "dur", "midi", "vel", "intensity"):
            if k not in n:
                bad.append(f"{name}: 音符 {i} 缺字段 {k}")
        try:
            t = float(n.get("t", -1))
            dur = float(n.get("dur", 0))
            inten = float(n.get("intensity", -1))
            vel = float(n.get("vel", -1))
        except (TypeError, ValueError):
            bad.append(f"{name}: 音符 {i} 字段类型错误")
            continue
        if t < 0 or dur <= 0:
            bad.append(f"{name}: 音符 {i} 时值非法 t={t} dur={dur}")
        if beats and t + dur > beats + 1e-6:
            bad.append(f"{name}: 音符 {i} 超出循环长度 ({t}+{dur} > {beats})")
        if not (0.0 <= inten <= 1.0):
            bad.append(f"{name}: 音符 {i} intensity {inten} 越界")
        if not (0.0 < vel <= 1.0):
            bad.append(f"{name}: 音符 {i} vel {vel} 越界")
        if not (21 <= int(n.get("midi", 0)) <= 108):
            bad.append(f"{name}: 音符 {i} midi {n.get('midi')} 越界")
        if tr == "pad":
            pad_groups.add(round(t, 3))
    if len(pad_groups) < 4:
        bad.append(f"{name}: 和弦变化 {len(pad_groups)} 次 < 4")

    present = {n.get("track") for n in notes}
    for need in ("pad", "bass", "perc"):
        if need not in present:
            bad.append(f"{name}: 缺 {need} 声部")
    return bad
