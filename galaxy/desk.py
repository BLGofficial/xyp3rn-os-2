"""The desk's memory: cards, runs, calls, reminders, pairing. One JSON state file, owner-only.

Everything that must survive a restart lives here. Writes are atomic and re-locked to 600.
"""
import json
import os
import re
import secrets
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE = HERE / "desk_state.json"
INBOX = HERE / "reminders-inbox.jsonl"   # tool subprocesses append here; the scheduler ingests it
_lock = threading.RLock()
_state = None
DEFAULTS = {"cards": [], "runs": [], "calls": [], "reminders": [], "briefing": None,
            "pushed": [], "telegram": {}, "hotline": {}, "urgent_line": None, "last_urgent_call": 0,
            "approvals": [], "playbook_last": {}}


def lock_down(path):
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _load():
    global _state
    if _state is None:
        try:
            _state = json.loads(STATE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            _state = {}
        for k, v in DEFAULTS.items():
            _state.setdefault(k, json.loads(json.dumps(v)))
    return _state


def _save():
    tmp = STATE.with_name(STATE.name + f".{secrets.token_hex(4)}.tmp")
    tmp.write_text(json.dumps(_state, ensure_ascii=False, indent=1), encoding="utf-8")
    lock_down(tmp)
    os.replace(tmp, STATE)
    lock_down(STATE)


@contextmanager
def edit():
    """with desk.edit() as s: ... (saved on exit)"""
    with _lock:
        s = _load()
        yield s
        _save()


def read(key):
    with _lock:
        return json.loads(json.dumps(_load()[key]))


def new_id(prefix):
    return f"{prefix}_{int(time.time())}_{secrets.token_hex(3)}"


# ── Cards ───────────────────────────────────────────────────────────────────────────
listeners = []   # fn(card) called after a card is raised: Telegram push, urgent line


def raise_card(text, priority="normal", speak=True, source="desk", push=True, kind="info"):
    """A desk card. speak: the desk reads it aloud once. push: may go to the phone (once)."""
    card = {"id": new_id("card"), "text": text, "priority": priority, "speak": speak,
            "source": source, "kind": kind, "push": push, "created": time.time(), "seen": False}
    with edit() as s:
        s["cards"] = (s["cards"] + [card])[-200:]
    for fn in listeners:
        try:
            fn(card)
        except Exception as e:  # a broken pusher never loses the card
            print("card listener failed:", e)
    return card


def mark_seen(card_id):
    with edit() as s:
        for c in s["cards"]:
            if c["id"] == card_id:
                c["seen"] = True


# ── Time words ──────────────────────────────────────────────────────────────────────
NUMBERS = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve "
                                       "thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split())}
NUMBERS.update(twenty=20, thirty=30, forty=40, fifty=50, sixty=60, ninety=90, a=1, an=1, couple=2, few=3)
UNIT = {"second": 1, "sec": 1, "minute": 60, "min": 60, "hour": 3600}


def number(words):
    words = words.lower().replace("-", " ").split()
    if not words:
        return None
    if all(w.isdigit() for w in words):
        return int("".join(words))
    total = 0
    for w in words:
        if w not in NUMBERS:
            return None
        total += NUMBERS[w]
    return total


def parse_delay(text):
    """'in twenty minutes', 'in 10 seconds', 'in half an hour' -> seconds, or None."""
    t = text.lower()
    if re.search(r"\bin\s+half\s+an\s+hour\b", t):
        return 1800
    m = re.search(r"\bin\s+(?:a\s+)?((?:[a-z]+|\d+)(?:[\s-](?:[a-z]+|\d+))?)\s+(seconds?|secs?|minutes?|mins?|hours?)\b", t)
    if not m:
        return None
    n = number(m.group(1))
    unit = UNIT[re.sub(r"s$", "", m.group(2))]
    return None if n is None else n * unit


def parse_clock(text, now=None):
    """'at 3pm', 'at 10:30', 'at noon' -> the next datetime at that clock time, or None."""
    now = now or datetime.now()
    t = text.lower()
    if re.search(r"\bat\s+noon\b", t):
        h, mnt = 12, 0
    elif re.search(r"\bat\s+midnight\b", t):
        h, mnt = 0, 0
    else:
        m = re.search(r"\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d:])", t)
        if not m:
            return None
        h, mnt, ap = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or "").replace(".", "")
        if h > 23 or mnt > 59:
            return None
        if ap == "pm" and h < 12:
            h += 12
        elif ap == "am" and h == 12:
            h = 0
        elif not ap and h <= 12:   # bare hour: the next time that clock reads it
            candidates = [now.replace(hour=hh % 24, minute=mnt, second=0, microsecond=0) for hh in (h, h + 12)]
            future = sorted(c if c > now else c + timedelta(days=1) for c in candidates)
            return future[0]
    at = now.replace(hour=h, minute=mnt, second=0, microsecond=0)
    return at if at > now else at + timedelta(days=1)


def parse_when(text, now=None):
    now = now or datetime.now()
    delay = parse_delay(text)
    if delay is not None:
        return now + timedelta(seconds=delay)
    return parse_clock(text, now)
