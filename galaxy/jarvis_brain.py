"""Voice and phone triggers that the TypeScript JarvisCore owns, dispatched to it from here.

    "Run monday review"   ->   node core/src/cli/jarvis-entry.ts "<text>" --json   ->   {"answer": ...}

JarvisCore is reached by running its CLI as a child process (argv list, no shell), not over HTTP: the web app sits
behind the owner's session cookie, so a Python call to it would need a second way in, and a command spoken or typed
here must never be able to open one. Prompt completions stay on `server.ask_text` (the `claude -p` subscription bridge).
"""
import json
import os
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ENTRY = REPO / "core" / "src" / "cli" / "jarvis-entry.ts"
ENV_FILE = REPO / "apps" / "web" / ".env.local"
MONDAY = re.compile(r"\brun\b[^.?!]*\bmonday review\b(?!\s+playbook)", re.I)
TIMEOUT_S = 120


def _database_url():
    """The same XYP_DATABASE_URL the web app uses (it points at the project's Postgres), or None for the CLI default."""
    try:
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            if line.startswith("XYP_DATABASE_URL="):
                return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return None


def dispatch(text):
    """Hand one sentence to JarvisCore and return a Galaxy answer. Never raises: a failure is spoken, not hidden."""
    env = dict(os.environ)
    url = _database_url()
    if url and "XYP_DATABASE_URL" not in env:
        env["XYP_DATABASE_URL"] = url
    try:
        proc = subprocess.run(["node", str(ENTRY), text, "--json"], cwd=REPO, env=env, capture_output=True,
                              text=True, timeout=TIMEOUT_S)
        result = json.loads(proc.stdout.strip().splitlines()[-1])
        answer = result["summary"]
    except Exception:
        answer = "Jarvis Core did not answer, sir. The sweep was not run."
    return {"answer": answer, "nodes": [], "route": "jarvis core"}
