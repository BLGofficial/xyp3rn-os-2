"""Reminders and the morning briefing (Prompt 15). They live in desk_state.json, so a restart never
loses one. A reminder is marked fired BEFORE it acts, so one that came due while the server was down
fires as soon as it is back, and never twice."""
import json
import threading
import time
from datetime import datetime

import desk

TICK_S = 10


def ingest_inbox():
    """Reminders set by tool turns (desk_mcp.py) arrive as lines in an append-only inbox."""
    if not desk.INBOX.exists():
        return
    taken = desk.INBOX.with_suffix(".taking")
    try:
        desk.INBOX.replace(taken)
    except OSError:
        return
    rows = []
    for line in taken.read_text(encoding="utf-8").splitlines():
        try:
            rows.append(json.loads(line))
        except ValueError:
            pass
    with desk.edit() as s:
        for r in rows:   # one bad row is skipped, never the whole batch
            try:
                due = float(r["due"])
            except (KeyError, TypeError, ValueError):
                print("scheduler: skipped a malformed reminder", str(r)[:120])
                continue
            channel = r.get("channel") if r.get("channel") in ("desk", "call", "telegram") else "desk"
            s["reminders"].append({"id": desk.new_id("rem"), "text": str(r.get("text", ""))[:300],
                                   "due": due, "channel": channel, "fired": False})
    taken.unlink(missing_ok=True)


def fire(rem):
    import phone, pocket
    text = f"A reminder, sir: {rem['text']}."
    try:
        if rem["channel"] == "call":
            phone.call_me(text, rem["text"], purpose="reminder")
            return
        if rem["channel"] == "telegram" and pocket.paired():
            pocket.send(text)
            return
    except Exception as e:
        text += f" (I couldn't {'ring' if rem['channel'] == 'call' else 'text'} you: {e})"
    desk.raise_card(text, speak=True, push=True, source="reminder", kind="reminder")


def tick():
    ingest_inbox()
    now = time.time()
    due = []
    with desk.edit() as s:
        for r in s["reminders"]:
            if not r.get("fired") and r["due"] <= now:
                r["fired"] = True
                due.append(r)
        s["reminders"] = [r for r in s["reminders"] if not r.get("fired") or now - r["due"] < 86400][-200:]
        b = s["briefing"]
        today = datetime.now().date().isoformat()
        briefing_due = b and b.get("last_date") != today and datetime.now().strftime("%H:%M") >= b["time"]
        if briefing_due:
            b["last_date"] = today
    for r in due:
        threading.Thread(target=fire, args=(r,), daemon=True).start()
    if briefing_due:
        import phone
        threading.Thread(target=phone.briefing_call, daemon=True).start()


APPROVALS_EVERY = 120
_last = {"approvals": 0}


def loop():
    import approvals, playbooks
    while True:
        try:
            tick()
            playbooks.due()
        except Exception as e:
            print("scheduler:", e)
        if time.time() - _last["approvals"] > APPROVALS_EVERY:
            _last["approvals"] = time.time()
            try:
                approvals.refresh()
            except Exception as e:   # the OS database may be down; the desk keeps working
                print("approvals:", str(e)[:200])
        time.sleep(TICK_S)


def start():
    threading.Thread(target=loop, daemon=True).start()
