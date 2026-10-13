"""核对 assets/data/manifest.json 里每个条目的 sha256/字节数与实际文件是否一致。

背景：已发布的 v1.2.0 EXE 报 assets_ok=false，但 /api/levels、/api/music、
新曲 WAV 下载全部正常。所以要么是某个体积/哈希对不上（诊断项 stale），
要么真有文件缺失。这里逐个算清楚，避免猜。
"""
import hashlib
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
man = json.loads((ROOT / "assets" / "data" / "manifest.json").read_text(encoding="utf-8"))
print("manifest 顶层键:", list(man.keys()))
print("generated_at:", man.get("generated_at"), " total_bytes:", man.get("total_bytes"))

for section in ("audio", "art", "music"):
    items = man.get(section) or []
    bad_hash, bad_size, missing, ok = [], [], [], 0
    total = 0
    for e in items:
        rel = e.get("file")
        if not rel:
            continue
        p = ROOT / "assets" / rel
        if not p.is_file():
            missing.append(rel)
            continue
        raw = p.read_bytes()
        total += len(raw)
        if e.get("bytes") is not None and e["bytes"] != len(raw):
            bad_size.append((rel, e["bytes"], len(raw)))
        if e.get("sha256"):
            h = hashlib.sha256(raw).hexdigest()
            if h != e["sha256"]:
                bad_hash.append((rel, e["sha256"][:12], h[:12]))
        else:
            ok += 1
    print(f"\n[{section}] 条目 {len(items)} 个，实际合计 {total:,} 字节")
    print(f"  缺失文件 {len(missing)}: {missing[:6]}")
    print(f"  字节数不符 {len(bad_size)}: {[(a, b, c) for a, b, c in bad_size[:6]]}")
    print(f"  哈希不符 {len(bad_hash)}: {[(a, b, c) for a, b, c in bad_hash[:6]]}")
    if not missing and not bad_size and not bad_hash:
        print("  ✓ 该段全部一致")

# total_bytes 是否等于三段合计（manifest 的口径：audio+art+music）
allsum = 0
for section in ("audio", "art", "music"):
    for e in (man.get(section) or []):
        rel = e.get("file")
        if rel:
            p = ROOT / "assets" / rel
            if p.is_file():
                allsum += p.stat().st_size
print(f"\ntotal_bytes 字段 {man.get('total_bytes'):,} vs 实际合计 {allsum:,} "
      f"→ {'一致 ✓' if man.get('total_bytes') == allsum else '不一致 ✗'}")
