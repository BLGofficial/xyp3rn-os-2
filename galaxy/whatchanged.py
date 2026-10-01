"""'What changed today?': a spoken summary of git commits, edited notes, runs and approvals, with the
touched stars lit up. No phone, no accounts."""
import re
import shutil
import subprocess
import time

import desk
import server

RULES = """You are Jarvis, a dry British butler, briefing your employer at his desk on what changed.
Three or four plain spoken sentences, most important first: what moved in the work, what finished or
failed, and anything waiting on him. No lists, no markdown, no file paths read aloud. If little changed,
say so in one sentence."""
ASK = re.compile(r"\bwhat(?:'?s|\s+has|\s+have)?\s+(?:changed|new|happened|moved)\b|\bcatch\s+me\s+up\b", re.I)


def _git(*args):
    git = shutil.which("git")
    if not git:
        return ""
    p = subprocess.run([git, *args], cwd=server.notes_dir(), capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=30)
    return p.stdout if p.returncode == 0 else ""


def compose(text=""):
    days = 7 if re.search(r"\bweek\b", text, re.I) else 1
    log = _git("log", f"--since={days} days ago", "--name-only", "--pretty=format:@@%h %s")
    commits = [l[2:] for l in log.splitlines() if l.startswith("@@")]
    files = {l.strip() for l in log.splitlines() if l.strip() and not l.startswith("@@")}
    files |= {l[3:].strip().strip('"') for l in _git("status", "--porcelain").splitlines() if len(l) > 3}
    since = time.time() - days * 86400
    ran = [r for r in desk.read("runs") if (r.get("ended") or 0) > since and r["status"] in ("done", "failed")]
    waiting = desk.read("approvals")
    paths = {n["path"]: n["id"] for n in server.load_index()["notes"]}
    touched = [paths[f] for f in sorted(files) if f in paths]
    facts = (f"Window: last {'week' if days == 7 else '24 hours'}.\n"
             f"Commits ({len(commits)}): " + "; ".join(commits[:15]) + "\n"
             f"Notes edited ({len(touched)}): " + ", ".join(f for f in sorted(files) if f in paths)[:1500] + "\n"
             f"Other files changed: {len([f for f in files if f not in paths])}\n"
             f"Runs: " + "; ".join(f"{r['kind']} '{r['text'][:60]}' {r['status']}: {r.get('headline') or ''}"[:200] for r in ran[-8:]) + "\n"
             f"Approvals waiting: {len(waiting)}")
    answer = server.ask_text(facts, RULES, "chat")
    return {"answer": answer, "nodes": touched[:24], "route": "what changed"}
