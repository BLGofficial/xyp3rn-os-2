"""Playbooks: saved multi-step routines in playbooks/*.json, started by voice or on a schedule.

"Run my Monday review" proposes the playbook with every step listed; one "do it" covers exactly those
steps. A scheduled playbook is only ever PROPOSED at its time (a card asks you); it never runs unseen.

    {"name": "Monday review", "aliases": ["monday review"], "schedule": {"days": ["mon"], "time": "09:00"},
     "steps": [{"kind": "whatchanged"}, {"kind": "agent", "text": "..."}, {"kind": "os", "text": "...", "domain": "RESEARCH_INTELLIGENCE"}]}
"""
import json
import re
from datetime import datetime
from pathlib import Path

import desk
import runs
import server

DIR = Path(__file__).resolve().parent / "playbooks"
KINDS = {"whatchanged", "agent", "os"}
ASK = re.compile(r"^\W*(?:jarvis\W+)?(?:run|start|do)\s+(?:my\s+|the\s+)?(.+?)\s+playbook\b|\b(?:list|which|what)\s+(?:my\s+)?playbooks\b", re.I)
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def load():
    out = []
    for f in sorted(DIR.glob("*.json")):
        try:
            pb = json.loads(f.read_text(encoding="utf-8"))
        except ValueError as e:
            print(f"playbook {f.name} is not valid JSON: {e}")
            continue
        if pb.get("name") and all(st.get("kind") in KINDS for st in pb.get("steps", [])):
            out.append(pb)
        else:
            print(f"playbook {f.name} skipped: needs a name and steps of kind {sorted(KINDS)}")
    return out


def find(name):
    name = name.lower().strip()
    for pb in load():
        if name in [pb["name"].lower(), *(a.lower() for a in pb.get("aliases", []))]:
            return pb
    return None


def voice(text):
    m = ASK.search(text)
    if not m:
        return None
    if not m.group(1):
        names = [pb["name"] for pb in load()]
        return {"answer": ("Your playbooks, sir: " + ", ".join(names) + ".") if names else
                "No playbooks yet, sir. They live in galaxy/playbooks.", "nodes": [], "route": "playbook"}
    pb = find(m.group(1))
    if not pb:
        return {"answer": f"I have no playbook called {m.group(1)}, sir.", "nodes": [], "route": "playbook"}
    return propose(pb)


def propose(pb):
    steps = [{**st, "label": st.get("label") or ("What changed" if st["kind"] == "whatchanged" else st.get("text", "")[:60])}
             for st in pb["steps"]]
    return runs.propose("playbook", pb["name"], steps=steps)


def execute(run_id):
    run = next(r for r in desk.read("runs") if r["id"] == run_id)
    lines, ok = [], True
    for i, st in enumerate(run["steps"]):
        if runs.stopped(run_id):
            return
        runs.progress(run_id, f"Step {i + 1}: {st['label']}")
        try:
            if st["kind"] == "whatchanged":
                import whatchanged
                headline = whatchanged.compose(st.get("text", ""))["answer"]
            elif st["kind"] == "agent":
                _, headline, _ = runs._run_agent({"id": run_id, "text": st["text"]})
            else:
                step_ok, headline, _ = runs._run_os({"id": run_id, "text": st["text"], "domain": st.get("domain")})
                ok &= step_ok
        except runs.Stopped:
            return
        except Exception as e:
            ok, headline = False, f"failed: {e}"
        lines.append(f"{i + 1}. {st['label']}: {headline}")
    try:
        summary = server.ask_text("\n".join(lines), "Summarize these playbook results as two plain spoken sentences, "
                                  "outcome first, in the voice of a dry British butler.", "extract")
    except Exception:
        summary = f"The {run['text']} playbook has finished, sir."
    runs.finish(run_id, ok, summary, f"Playbook {run['text']}", "\n\n".join(lines))


def due():
    """Scheduler hook: propose any playbook whose time has come today (once per day)."""
    now = datetime.now()
    today, day = now.date().isoformat(), DAYS[now.weekday()]
    for pb in load():
        sch = pb.get("schedule") or {}
        try:   # "9:00" and "09:00" are the same time
            h, m = (int(x) for x in str(sch.get("time", "")).split(":"))
        except ValueError:
            continue
        if day not in sch.get("days", DAYS) or (now.hour, now.minute) < (h, m):
            continue
        with desk.edit() as s:
            last = s.setdefault("playbook_last", {})
            if last.get(pb["name"]) == today:
                continue
            if any(r["status"] == "pending" for r in s["runs"]):
                continue   # never replace your own unconfirmed proposal; try again next tick
            last[pb["name"]] = today
        propose(pb)
        desk.raise_card(f"Your {pb['name']} playbook is due, sir. Say do it, or cancel.", speak=True, push=True,
                        source="playbook", kind="reminder")
