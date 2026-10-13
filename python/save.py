"""save.py — 存档读写与结算合并（W-host，契约 docs/INTERFACES.md §1、DESIGN.md §5）。

冻结签名：
    default_state() -> dict
    load_state()    -> dict
    write_state(state) -> None
    merge_result(state, result, verdict) -> dict

存档位置：paths.data_root()/save.json（即 %LOCALAPPDATA%\\LagrangeCourier\\save.json）
写入方式：同目录临时文件 + fsync + os.replace（原子替换，断电不会留下半截 JSON）。
容错：文件损坏/非法 JSON → 备份为 save.corrupt-<时间戳>.json 并回退默认存档。
"""

from __future__ import annotations

import copy
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import paths  # noqa: E402

STATE_VERSION = "1.0.0"
LEVELS_PER_CHAPTER = 3
# v1.2 起是 5 章 20 关。这里若停在 4，通关第 4 章后写入的 5 会在读档时被钳回 4，第 5 章重启即锁死。
MAX_CHAPTER = 5
GRADE_ORDER = {"S": 4, "A": 3, "B": 2, "C": 1, "-": 0}
_LEVEL_ID_RE = re.compile(r"^L(\d+)-(\d+)$", re.IGNORECASE)


# --------------------------------------------------------------------------- 工具

def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _num(value, default: float = 0.0) -> float:
    try:
        if isinstance(value, bool):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _int(value, default: int = 0) -> int:
    try:
        if isinstance(value, bool):
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def _merge_dict(base: dict, extra: dict) -> dict:
    """把 extra 合并进 base（嵌套 dict 递归合并，extra 的未知键保留）。"""
    out = copy.deepcopy(base)
    if not isinstance(extra, dict):
        return out
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge_dict(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def default_settings() -> dict:
    return {
        "master": 0.8,
        "music": 0.7,
        "sfx": 0.9,
        "muted": False,
        "quality": "auto",          # auto|high|medium|low
        "vsync": True,
        "show_hints": True,
        "time_scale": 1.6,
        "fullscreen": False,
        "window": {"width": 1600, "height": 900},
    }


def level_coords(level_id: str) -> tuple[int, int] | None:
    """'L1-1' -> (章节 1, 关序 1)；无法解析返回 None。"""
    if not isinstance(level_id, str):
        return None
    m = _LEVEL_ID_RE.match(level_id.strip())
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


# --------------------------------------------------------------------------- 状态

def default_state() -> dict:
    """全新存档（首次运行 / 损坏回退）。"""
    return {
        "version": STATE_VERSION,
        "settings": default_settings(),
        "unlocked_chapters": 1,
        "best_scores": {},           # level_id -> {"score","grade","time","fuel"}
        "totals": {"played": 0, "delivered": 0, "lost": 0, "playtime": 0.0},
        "last_level": None,
        "last_result": None,
        "updated_at": "",
    }


def _normalize(data) -> dict:
    """把任意来源的 dict 规整成完整合法的 state（缺键补默认，非法值纠正）。"""
    state = default_state()
    if not isinstance(data, dict):
        return state

    if isinstance(data.get("version"), str) and data["version"]:
        state["version"] = data["version"]

    if isinstance(data.get("settings"), dict):
        state["settings"] = _merge_dict(default_settings(), data["settings"])
    else:
        state["settings"] = default_settings()
    state["settings"]["vsync"] = bool(state["settings"].get("vsync", True))
    state["settings"]["muted"] = bool(state["settings"].get("muted", False))

    state["unlocked_chapters"] = max(1, min(MAX_CHAPTER, _int(data.get("unlocked_chapters"), 1)))

    best: dict[str, dict] = {}
    raw_best = data.get("best_scores")
    if isinstance(raw_best, dict):
        for level_id, entry in raw_best.items():
            if not isinstance(entry, dict):
                continue
            grade = entry.get("grade")
            item = {
                "score": _int(entry.get("score"), 0),
                "grade": str(grade) if isinstance(grade, str) and grade else "-",
                "time": round(_num(entry.get("time"), 0.0), 3),
                "fuel": round(_num(entry.get("fuel"), 0.0), 5),
            }
            # 客户端靠 won===true 才算通关。丢掉这个字段的话，重启后成绩会被整笔删掉，章内后续关卡重新上锁。
            if entry.get("won") is True:
                item["won"] = True
            best[str(level_id)] = item
    state["best_scores"] = best
    for level_id in best:
        coords = level_coords(level_id)
        if not coords:
            continue
        # 旧包把第 5 章钳成 4，但成绩键还在。读到 L5-* 时把章节数补回，避免已经打到的章被永久锁死。
        state["unlocked_chapters"] = max(state["unlocked_chapters"], min(MAX_CHAPTER, coords[0]))

    raw_totals = data.get("totals")
    if isinstance(raw_totals, dict):
        state["totals"] = {
            "played": max(0, _int(raw_totals.get("played"), 0)),
            "delivered": max(0, _int(raw_totals.get("delivered"), 0)),
            "lost": max(0, _int(raw_totals.get("lost"), 0)),
            "playtime": round(max(0.0, _num(raw_totals.get("playtime"), 0.0)), 3),
        }

    state["last_level"] = data.get("last_level") if isinstance(data.get("last_level"), str) else None
    if isinstance(data.get("last_result"), dict):
        lr = data["last_result"]
        state["last_result"] = {
            "level_id": str(lr.get("level_id") or ""),
            "success": bool(lr.get("success")),
            "score": _int(lr.get("score"), 0),
            "grade": str(lr.get("grade") or "-"),
            "time": round(_num(lr.get("time"), 0.0), 3),
            "fuel": round(_num(lr.get("fuel"), 0.0), 5),
            "at": str(lr.get("at") or ""),
        }
    state["updated_at"] = str(data.get("updated_at") or "")

    # 向前/向后兼容：保留未知顶层键（例如后续版本新增字段或 TS 侧扩展）
    for key, value in data.items():
        if key not in state:
            state[key] = copy.deepcopy(value)
    return state


def _backup_corrupt(path: Path, reason: str) -> Path | None:
    """备份损坏的存档，返回备份路径（失败返回 None）。"""
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    backup = path.with_name(f"{path.stem}.corrupt-{stamp}{path.suffix}")
    try:
        os.replace(path, backup)
        print(f"[save] 存档损坏（{reason}），已备份为 {backup.name} 并回退默认存档", file=sys.stderr)
        return backup
    except OSError as exc:
        print(f"[save] 存档损坏（{reason}），备份失败：{exc!r}", file=sys.stderr)
        try:
            path.unlink()
        except OSError:
            pass
        return None


def load_state() -> dict:
    """读取存档；不存在 → 默认值；损坏 → 备份坏文件 + 默认值（永不抛异常）。"""
    path = paths.save_path()
    try:
        if not path.is_file():
            return default_state()
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"[save] 无法读取存档 {path}：{exc!r}，使用默认存档", file=sys.stderr)
        return default_state()

    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("顶层不是 JSON 对象")
    except (ValueError, TypeError) as exc:
        _backup_corrupt(path, repr(exc))
        return default_state()

    return _normalize(data)


def write_state(state: dict) -> None:
    """原子写入存档：同目录临时文件 → fsync → os.replace。"""
    path = paths.save_path()
    payload = _normalize(state)
    payload["updated_at"] = _now_iso()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass

    tmp_fd, tmp_name = tempfile.mkstemp(prefix=".save-", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=False)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


# --------------------------------------------------------------------------- 结算

def _fidelity_score_bonus(verdict: dict | None) -> int:
    """宿主判级奖励（契约 verdict.score_bonus）：S=+40，A=+20，其余 0。"""
    if not isinstance(verdict, dict):
        return 0
    bonus = verdict.get("score_bonus")
    if bonus is not None:
        return _int(bonus, 0)
    return {"S": 40, "A": 20}.get(str(verdict.get("grade") or "").upper(), 0)


def merge_result(state: dict, result: dict, verdict: dict | None) -> dict:
    """把一次关卡结算并入存档，返回**新的** state（不修改入参）。

    * best_scores[level_id]：分数取历史最高；time/fuel 取成功局里的最小值；
      grade 跟随最高分那一局（若新局分数不高于旧纪录则保留旧评级）。
    * unlocked_chapters：通关章节最后一关（关序 ≥ 3）后解锁下一章，上限 5。
    * totals：played+1、delivered/lost 累加、playtime 累加本局用时。
    """
    current = _normalize(state)
    if not isinstance(result, dict):
        return current

    level_id = result.get("level_id")
    if not isinstance(level_id, str) or not level_id:
        level_id = current.get("last_level") or ""

    grade = "-"
    if isinstance(verdict, dict) and verdict.get("grade"):
        grade = str(verdict["grade"]).upper()
    fidelity = _num(verdict.get("fidelity"), 0.0) if isinstance(verdict, dict) else 0.0

    success = bool(result.get("success"))
    elapsed = max(0.0, _num(result.get("time"), 0.0))
    fuel = max(0.0, _num(result.get("fuel_used"), 0.0))
    pods_total = max(0, _int(result.get("pods_total"), 0))
    pods_delivered = max(0, _int(result.get("pods_delivered"), 0))
    pods_lost = max(0, _int(result.get("pods_lost"), max(0, pods_total - pods_delivered)))
    score = max(0, _int(result.get("score"), 0)) + _fidelity_score_bonus(verdict)

    # ---- 最佳分 ----
    if level_id:
        prev = current["best_scores"].get(level_id)
        fresh = {
            "score": score,
            "grade": grade,
            "time": round(elapsed, 3),
            "fuel": round(fuel, 5),
        }
        if success or (isinstance(prev, dict) and prev.get("won") is True):
            fresh["won"] = True
        if prev is None or score > _int(prev.get("score"), 0):
            current["best_scores"][level_id] = fresh
        elif success:
            # 未破纪录，但成功局的最佳用时/燃料仍可取更优值
            entry = dict(prev)
            entry["won"] = True
            if elapsed > 0:
                entry["time"] = round(min(_num(entry.get("time"), elapsed) or elapsed, elapsed), 3)
            if fuel > 0:
                entry["fuel"] = round(min(_num(entry.get("fuel"), fuel) or fuel, fuel), 5)
            current["best_scores"][level_id] = entry

    # ---- 章节解锁 ----
    coords = level_coords(level_id)
    if coords:
        chapter, index = coords
        if 1 <= chapter <= MAX_CHAPTER:
            current["unlocked_chapters"] = max(current["unlocked_chapters"], chapter)
        if success and index >= LEVELS_PER_CHAPTER:
            current["unlocked_chapters"] = min(MAX_CHAPTER, max(current["unlocked_chapters"], chapter + 1))
    elif success and isinstance(result.get("chapter_complete"), bool) and result["chapter_complete"]:
        chapter = _int(result.get("chapter"), current["unlocked_chapters"])
        current["unlocked_chapters"] = min(MAX_CHAPTER, max(current["unlocked_chapters"], chapter + 1))

    # ---- 累计统计 ----
    totals = current["totals"]
    totals["played"] = _int(totals.get("played"), 0) + 1
    totals["delivered"] = _int(totals.get("delivered"), 0) + pods_delivered
    totals["lost"] = _int(totals.get("lost"), 0) + pods_lost
    totals["playtime"] = round(_num(totals.get("playtime"), 0.0) + elapsed, 3)

    current["last_level"] = level_id or current.get("last_level")
    current["last_result"] = {
        "level_id": level_id,
        "success": success,
        "score": score,
        "grade": grade,
        "time": round(elapsed, 3),
        "fuel": round(fuel, 5),
        "fidelity": round(fidelity, 4),
        "at": _now_iso(),
    }
    current["updated_at"] = _now_iso()
    return current


__all__ = [
    "STATE_VERSION",
    "LEVELS_PER_CHAPTER",
    "MAX_CHAPTER",
    "GRADE_ORDER",
    "default_settings",
    "default_state",
    "load_state",
    "write_state",
    "merge_result",
    "level_coords",
]
