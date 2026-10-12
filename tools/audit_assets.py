#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
素材质检（独立于生成器，用于客观验收 assets/ 下的音频与贴图是否"真的是能用的素材"）。
用法: python tools/audit_assets.py [--json]
检查项：
  WAV  : 可解码、采样率、声道、时长、峰值、RMS、直流偏移、首尾淡入淡出、是否有实际内容（非静音）
  PNG  : 可解码、尺寸、通道、非空像素占比、alpha 覆盖率
  JSON : 音乐谱结构合法性（t/dur/midi/track/intensity）、按 BPM 的秒长、轨道分布、和弦变化
  MANIFEST: 文件存在性 + 字节数 + sha256 一致性
退出码 0 = 全部通过。
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import struct
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
FAILS: list[str] = []
WARNS: list[str] = []


def sha256_of(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def audit_wav(p: Path) -> dict:
    info: dict = {"file": p.name}
    with wave.open(str(p), "rb") as w:
        ch, sw, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    info.update(channels=ch, width=sw, rate=rate, frames=n, seconds=round(n / rate, 3))
    if sw != 2:
        FAILS.append(f"{p.name}: 采样位深 {sw * 8}bit（要求 16bit）")
    if ch != 2:
        WARNS.append(f"{p.name}: 声道数 {ch}（期望立体声）")
    samples = struct.unpack("<%dh" % (len(raw) // 2), raw)
    if not samples:
        FAILS.append(f"{p.name}: 无采样数据")
        return info
    peak = max(abs(s) for s in samples)
    rms = math.sqrt(sum(s * s for s in samples) / len(samples))
    dc = sum(samples) / len(samples)
    info.update(peak=peak, peak_db=round(20 * math.log10(max(peak, 1) / 32768), 2),
                rms=round(rms, 1), rms_db=round(20 * math.log10(max(rms, 1) / 32768), 2),
                dc=round(dc, 2))
    if peak < 1000:
        FAILS.append(f"{p.name}: 峰值仅 {peak}（近似静音）")
    if peak > 32767:
        FAILS.append(f"{p.name}: 采样溢出")
    if abs(dc) > 400:
        FAILS.append(f"{p.name}: 直流偏移过大 {dc:.1f}")
    if rms < 40:
        WARNS.append(f"{p.name}: RMS 偏低 {rms:.1f}（内容过弱）")
    head = max(abs(s) for s in samples[: max(1, rate // 200)]) if len(samples) > 64 else 0
    tail = max(abs(s) for s in samples[-max(1, rate // 200):]) if len(samples) > 64 else 0
    info.update(head_peak=head, tail_peak=tail)
    if p.name != "thruster_loop.wav":
        if head > peak * 0.5:
            WARNS.append(f"{p.name}: 起始无淡入（可能有爆音），head={head}")
        if tail > peak * 0.5:
            WARNS.append(f"{p.name}: 结尾无淡出（可能有爆音），tail={tail}")
    return info


def audit_png(p: Path) -> dict:
    info: dict = {"file": p.name}
    try:
        from PIL import Image
    except Exception:  # noqa: BLE001
        WARNS.append("未安装 PIL，跳过 PNG 深度检查")
        return info
    with Image.open(p) as im:
        im = im.convert("RGBA")
        w, h = im.size
        px = im.load()
        nonzero = 0
        alpha_sum = 0
        step = max(1, w // 64)
        cnt = 0
        for y in range(0, h, step):
            for x in range(0, w, step):
                r, g, b, a = px[x, y]
                cnt += 1
                alpha_sum += a
                if a > 4 and (r + g + b) > 8:
                    nonzero += 1
        info.update(w=w, h=h, coverage=round(nonzero / max(1, cnt), 4),
                    alpha_mean=round(alpha_sum / max(1, cnt), 1))
    if info.get("coverage", 0) < 0.005:
        FAILS.append(f"{p.name}: 可见像素占比 {info.get('coverage')}（近似全透明/全黑）")
    return info


def audit_music(p: Path) -> dict:
    data = json.loads(p.read_text(encoding="utf-8"))
    info: dict = {"file": p.name, "name": data.get("name"), "bpm": data.get("bpm")}
    need = ("bpm", "bars", "beats_per_bar", "key", "mode", "scale", "notes")
    for k in need:
        if k not in data:
            FAILS.append(f"{p.name}: 缺少字段 {k}")
    notes = data.get("notes", [])
    if len(notes) < 40:
        FAILS.append(f"{p.name}: 音符数仅 {len(notes)}，配乐过于单薄")
    tracks: dict[str, int] = {}
    maxbeat = 0.0
    chords = set()
    for i, nt in enumerate(notes):
        for k in ("t", "dur", "midi", "track", "intensity"):
            if k not in nt:
                FAILS.append(f"{p.name}: 第 {i} 个音符缺字段 {k}")
                break
        else:
            if nt["t"] < 0 or nt["dur"] <= 0:
                FAILS.append(f"{p.name}: 第 {i} 个音符时间非法 t={nt['t']} dur={nt['dur']}")
            if not (24 <= nt["midi"] <= 108):
                FAILS.append(f"{p.name}: 第 {i} 个音符 midi={nt['midi']} 越界")
            if nt["track"] not in ("pad", "bass", "arp", "perc", "lead"):
                FAILS.append(f"{p.name}: 第 {i} 个音符 track={nt['track']} 非法")
            if not (0 <= nt["intensity"] <= 1):
                FAILS.append(f"{p.name}: 第 {i} 个音符 intensity 越界")
            tracks[nt["track"]] = tracks.get(nt["track"], 0) + 1
            maxbeat = max(maxbeat, nt["t"] + nt["dur"])
            if nt["track"] == "pad":
                chords.add(nt["midi"] % 12)
    bpb = data.get("beats_per_bar", 4)
    bars = data.get("bars", 16)
    if maxbeat < bars * bpb * 0.9:
        WARNS.append(f"{p.name}: 谱面长度 {maxbeat:.1f} 拍 < 标称 {bars * bpb} 拍")
    info.update(notes=len(notes), tracks=tracks, beats=round(maxbeat, 1),
                seconds=round(maxbeat * 60 / max(1, data.get("bpm", 90)), 1),
                chord_pitch_classes=len(chords))
    if len(chords) < 3:
        FAILS.append(f"{p.name}: pad 只用了 {len(chords)} 个音高类，和弦变化不足")
    return info


def main() -> int:
    report: dict = {"audio": [], "art": [], "music": [], "manifest": {}}
    audio_dir, art_dir = ASSETS / "audio", ASSETS / "art"
    for p in sorted(audio_dir.glob("*.wav")):
        try:
            report["audio"].append(audit_wav(p))
        except Exception as e:  # noqa: BLE001
            FAILS.append(f"{p.name}: 解码失败 {e}")
    for p in sorted(art_dir.glob("*.png")):
        try:
            report["art"].append(audit_png(p))
        except Exception as e:  # noqa: BLE001
            FAILS.append(f"{p.name}: 解码失败 {e}")
    for p in sorted(audio_dir.glob("music_*.json")):
        try:
            report["music"].append(audit_music(p))
        except Exception as e:  # noqa: BLE001
            FAILS.append(f"{p.name}: 解析失败 {e}")

    mf = ASSETS / "data" / "manifest.json"
    if mf.exists():
        man = json.loads(mf.read_text(encoding="utf-8"))
        total_bad = 0
        for group in ("audio", "art", "music"):
            for e in man.get(group, []):
                fp = ASSETS / e["file"]
                if not fp.exists():
                    FAILS.append(f"manifest: 缺文件 {e['file']}")
                    total_bad += 1
                    continue
                size = fp.stat().st_size
                if size != e.get("bytes"):
                    FAILS.append(f"manifest: {e['file']} 字节数不符 {size} != {e.get('bytes')}")
                    total_bad += 1
                got = sha256_of(fp)
                if got != e.get("sha256"):
                    FAILS.append(f"manifest: {e['file']} sha256 不符")
                    total_bad += 1
        report["manifest"] = {
            "entries": sum(len(man.get(g, [])) for g in ("audio", "art", "music")),
            "total_bytes": man.get("total_bytes"), "mismatch": total_bad,
        }
    else:
        FAILS.append("缺少 assets/data/manifest.json")

    if "--json" in sys.argv:
        print(json.dumps(report, ensure_ascii=False, indent=1))
    else:
        print(f"WAV {len(report['audio'])} 个：")
        for a in report["audio"]:
            print(f"  {a['file']:<24} {a.get('seconds'):>6}s  peak={a.get('peak_db')}dB  rms={a.get('rms_db')}dB  dc={a.get('dc')}")
        print(f"PNG {len(report['art'])} 个：")
        for a in report["art"]:
            print(f"  {a['file']:<24} {a.get('w')}x{a.get('h')}  coverage={a.get('coverage')}  alphā={a.get('alpha_mean')}")
        print(f"音乐 {len(report['music'])} 首：")
        for a in report["music"]:
            print(f"  {a['file']:<24} bpm={a.get('bpm')} notes={a.get('notes')} beats={a.get('beats')} ≈{a.get('seconds')}s tracks={a.get('tracks')}")
        print(f"manifest: {report['manifest']}")
    print()
    for w in WARNS:
        print(f"  [WARN] {w}")
    for f in FAILS:
        print(f"  [FAIL] {f}")
    print(f"\n结论: {'PASS' if not FAILS else 'FAIL'}  （FAIL={len(FAILS)} WARN={len(WARNS)}）")
    return 0 if not FAILS else 1


if __name__ == "__main__":
    sys.exit(main())
