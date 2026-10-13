import json
from collections import Counter

d = json.load(open(r"c:\Users\a\Desktop\LagrangeCourier\assets\data\systems.json", encoding="utf-8"))
print("chapters", len(d["chapters"]), "levels", len(d["levels"]))
for lv in d["levels"]:
    pods = lv.get("pods", [])
    bodies = lv.get("bodies", [])
    kinds = ",".join(sorted({b["kind"] for b in bodies}))
    classes = ",".join(sorted({p.get("class", "standard") for p in pods}))
    ev = len(lv.get("events") or [])
    obj = len(lv.get("objectives") or [])
    haz = len(lv.get("hazards") or [])
    neb = len(lv.get("nebulae") or [])
    label = lv.get("difficulty_label") or ""
    print(
        f"{lv['id']:6} ch{lv['chapter']} d{lv['difficulty']:2} {label:8} "
        f"pods={len(pods)} bodies={len(bodies)} ev={ev} obj={obj} haz={haz} neb={neb} "
        f"cls={classes} kinds={kinds} | {lv['name_zh']}"
    )
print("--- hints ---")
for lv in d["levels"]:
    print(lv["id"], lv.get("hint_zh", "")[:80])
print("--- events kinds ---")
c = Counter()
for lv in d["levels"]:
    for e in lv.get("events") or []:
        c[e["kind"]] += 1
print(c)
