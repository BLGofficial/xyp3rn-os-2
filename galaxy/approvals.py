"""OS approvals on the desk: the Promotion Gate's pending queue (pnpm gate queue / gate decide).

The queue is polled into desk_state.json; each new item raises one card. A decision is one button
press (or "approve it" when exactly one item is waiting): the confirmation covers that item only.
"""
import json
import re
import shutil
import subprocess
from pathlib import Path

import desk
import runs
import server

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
VOICE = re.compile(r"^\W*(?:jarvis\W+)?(approve|reject)\s+(?:it|that|this|the\s+approval)\W*$", re.I)


def _gate(*args, timeout=120):
    root = server.notes_dir()
    cli = root / "knowledge" / "promotion-gate" / "cli.ts"
    node = shutil.which("node")
    if not cli.exists() or not node:
        raise RuntimeError("The Promotion Gate CLI (knowledge/promotion-gate/cli.ts) was not found.")
    proc = subprocess.run([node, str(cli), *args], cwd=root, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=timeout, env=runs.os_env())
    if proc.returncode:
        raise RuntimeError((proc.stderr or proc.stdout).strip()[-300:] or f"gate exited {proc.returncode}")
    return json.loads(proc.stdout)


def label(item):
    reasons = item.get("gate_reasons")
    reason = "; ".join(str(x) for x in reasons[:2]) if isinstance(reasons, list) else str(reasons or "")
    what = item.get("target_slug") or item.get("item_type", "item").replace("_", " ")
    return f"{what}" + (f": {reason}" if reason and reason != "None" else "")


def refresh():
    items = _gate("queue")
    with desk.edit() as s:
        known = {a["approval_id"] for a in s["approvals"]}
        s["approvals"] = items
    for a in items:
        if a["approval_id"] not in known:
            desk.raise_card(f"An approval is waiting, sir: {label(a)}.", speak=True, push=True, source="gate", kind="approval")


def decide(approval_id, decision, reason="Decided at the Jarvis desk."):
    if decision not in ("approve", "reject") or not UUID.match(str(approval_id)):
        raise server.BrainError(400, "Approve or reject one real approval id.")
    out = _gate("decide", approval_id, decision, "owner", reason[:300])
    try:
        refresh()
    except Exception:
        pass
    return {"answer": f"{'Approved' if decision == 'approve' else 'Rejected'}, sir.", "nodes": [], "route": "approval",
            "result": out}


def voice(text):
    m = VOICE.match(text)
    if not m:
        return None
    waiting = desk.read("approvals")
    if len(waiting) != 1:
        return {"answer": ("Nothing is waiting for approval, sir." if not waiting else
                           f"{len(waiting)} approvals are waiting, sir. Use the buttons so I decide the right one."),
                "nodes": [], "route": "approval"}
    return decide(waiting[0]["approval_id"], m.group(1).lower())
