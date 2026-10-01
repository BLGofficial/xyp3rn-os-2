#!/usr/bin/env python3
"""Preflight: every LIVE chain, end to end, against the running server. No mocks.

    python preflight.py          (start python server.py first)

Prints a tick or a cross per check and one summary line. Exits non-zero on any failure.
"Done" means this passed.
"""
import http.client
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import server

HERE = Path(__file__).resolve().parent
HOST, PORT = server.HOST, server.PORT
ORIGIN = f"http://{HOST}:{PORT}"
# A real 64x40 JPEG, generated once and pasted here so preflight stays standard library only.
PROBE_JPEG = (
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/"
    "2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAoAEADASIAAhEBAxEB/8QAHwAA"
    "AQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRol"
    "JicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW"
    "19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdh"
    "cRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJma"
    "oqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDyqiivdavGYz6ty+7e9+o6NH2t9bWPCqK9"
    "1org/tj+5+P/AADo+pf3vwPCqK91oo/tj+5+P/AD6l/e/A8Kor3WvGdd/wCRg1H/AK+pf/QzXbg8d9Zk1y2t5/8AAMK1D2STvcoV7Lr/APyLmp/9ekv/AKAa8ar3"
    "WuTN3Z036/obYNXUkczrr3TfaPtMMMf/ABKLzb5cpfP+r65UYrpqKK8OUrpK2x3JWbYUUUVBQV4zrv8AyMGo/wDX1L/6Ga9mrxnXf+Rg1H/r6l/9DNe1lHxy9Dix"
    "nwooVf8A7d1j/oK3v/gQ/wDjRRXvyjGW6PPTa2D+3dY/6Ct7/wCBD/40f27rH/QVvf8AwIf/ABooqfZQ/lQc0u4f27rH/QVvf/Ah/wDGj+3dY/6Ct7/4EP8A40UU"
    "eyh/Kg5pdw/t3WP+gre/+BD/AONUpJHlkaSR2d3JZmY5JJ6kmiiqUIx2QNt7n//Z")
PROBE = "remember that the preflight probe codeword is zanzibar kite"
ROUTING = [  # (sentence, expected route): every row must pass
    ("I'm leaving, only call me if anything urgent comes up", "standing order"),
    ("I'm going into a meeting, call me only for emergencies", "standing order"),
    ("don't call me unless it's urgent", "standing order"),
    ("Only bug me if it's on fire", "standing order"),
    ("ok heading to bed, call me if anything urgent happens", "standing order"),
    ("call me", "call me now"),
    ("Jarvis, call me now", "call me now"),
    ("give me a call", "call me now"),
    ("call the dentist", "call a business"),
    ("ring Acme Plumbing please", "call a business"),
    ("I have a call at 3", "nothing"),
    ("I'm on a call for an hour", "nothing"),
    ("call me when it's done", "nothing"),
    ("don't call me", "nothing"),
    ("call me later", "nothing"),
    ("what did we decide about the research orchestrator?", "nothing"),
]

COMMANDS = [  # (sentence, desk command): never reaches the brain
    ("call me when it's done", "when done"),
    ("Jarvis, stage an urgent call in two minutes", "stage"),
    ("Georgia State an urgent call in ten seconds", "stage"),
    ("call me with the briefing every morning at 8", "briefing daily"),
    ("call me with the briefing now", "briefing now"),
    ("stop the morning calls", "briefing stop"),
    ("in twenty minutes give me a reminder call about the invoice", "reminder"),
    ("text me instead", "text instead"),
    ("Jarvis, pocket code", "pocket code"),
    ("do it", "confirm"),
    ("never mind", "cancel"),
    ("research the best suno prompting method", "research"),
    ("run workflow retrieve and summarize the handoffs", "os run"),
    ("agent find what blocks prompt 03 in the handoffs", "agent run"),
    ("open studio", "open area"),
    ("Jarvis, go to the creative vault", "open area"),
    ("show the core domain", "domain"),
    ("write a song about leaving Sofia at night", "song"),
    ("stop that run", "stop run"),
    ("also check the plans folder", "follow up"),
    ("what changed today?", "what changed"),
    ("run my monday review playbook", "playbook"),
    ("approve it", "approval"),
    ("remember that the finish window is 900 ms", None),
    ("what does the research orchestrator do?", None),
]

results = {"pass": 0, "fail": 0, "warn": 0}


def post_hook(token, tool, payload):
    """As the phone provider would: through the tunnel, so with a foreign Host and no Origin."""
    conn = http.client.HTTPConnection(HOST, PORT, timeout=240)
    try:
        conn.request("POST", f"/hook/{token}/{tool}", body=json.dumps(payload).encode(),
                     headers={"Host": "x.trycloudflare.com", "Content-Type": "application/json"})
        res = conn.getresponse()
        return res.status, json.loads(res.read() or b"{}")
    finally:
        conn.close()


def mark(kind, name, detail=""):
    results[kind] += 1
    icon = {"pass": "✔", "fail": "✘", "warn": "!"}[kind]
    print(f"  {icon} {name}" + (f"  ({detail})" if detail else ""))


def check(ok, name, detail=""):
    mark("pass" if ok else "fail", name, detail)
    return ok


def request(method, path, body=None, headers=None, timeout=240):
    h = {"Host": f"{HOST}:{PORT}"}
    if body is not None:
        h.update({"Content-Type": "application/json", "Origin": ORIGIN})
    h.update(headers or {})
    conn = http.client.HTTPConnection(HOST, PORT, timeout=timeout)
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    try:
        conn.request(method, path, body=data, headers=h)
        res = conn.getresponse()
        return res.status, dict(res.getheaders()), res.read()
    finally:
        conn.close()


def post(path, payload):
    status, _, raw = request("POST", path, payload)
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, {}


def main():
    print("Live chains")
    try:
        status, _, page = request("GET", "/")
    except OSError as e:
        check(False, "Server is up and serving the viewer", f"{e}; start python server.py")
        return summary()
    check(status == 200 and b"<title>" in page, "Server is up and serving the viewer", f"HTTP {status}")

    status, _, js = request("GET", "/graph-data.js")
    graph = json.loads(js[js.index(b"{"):js.rindex(b"}") + 1]) if status == 200 else {"nodes": []}
    nodes = graph["nodes"]
    check(len(nodes) > 0 and all(n["id"] == i for i, n in enumerate(nodes)),
          "Graph data loads, ids equal their index", f"{len(nodes)} nodes, {len(graph.get('links', []))} links")

    for name in ("index.html", "graph-data.js"):
        _, _, served = request("GET", "/" + name)
        check(served == (HERE / "viewer" / name).read_bytes(), f"Served {name} matches the file on disk")

    cfg = server.config()
    model = cfg.get("model")
    check(model in server.KNOWN_MODELS, "Config model is a known id", model)
    exe = shutil.which(cfg.get("claude_bin", "claude"))
    if check(bool(exe), "Claude Code CLI is installed", exe or "not on PATH"):
        env = {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}
        proc = subprocess.run([exe, "-p", "--model", model, "--output-format", "json", "--tools", "", *server.CLI_ISOLATION], input="Reply with OK.", capture_output=True,
                              text=True, encoding="utf-8", timeout=180, env=env)
        try:
            out = json.loads(proc.stdout)
        except ValueError:
            out = {"is_error": True, "result": (proc.stderr or "no output").strip()[:200]}
        if not check(not out.get("is_error"), f"Login reaches the config model by id: {model}", out.get("result", "")[:160] if out.get("is_error") else ""):
            fb = cfg.get("fallback_model")
            mark("warn", f"Chat will fall back to {fb}" if fb else "No fallback_model set")

    title = max(nodes, key=lambda n: len(n["label"]))["label"] if nodes else "notes"
    status, data = post("/chat", {"question": f"What is {title} about?"})
    check(status == 200 and isinstance(data.get("answer"), str) and data["answer"]
          and isinstance(data.get("nodes"), list), "/chat answers a real question with a nodes array",
          f"HTTP {status}, nodes {data.get('nodes')}, {data.get('model')}" if status == 200 else data.get("answer", "")[:160])

    status, data = post("/remember", {"text": PROBE})
    node = data.get("node")
    node_id = node["id"] if isinstance(node, dict) else node
    path = None
    if status == 200 and node_id is not None:
        brain = json.loads((HERE / "notes.json").read_text(encoding="utf-8"))
        path = server.notes_dir() / brain[node_id]["path"]
    check(status == 200 and path is not None and path.is_file(), "/remember writes a real file",
          f"{path}" + (" (reused today's probe)" if data.get("existing") else "") if path else data.get("answer", ""))
    status, data = post("/chat", {"question": "What is the preflight probe codeword?"})
    found = status == 200 and (node_id in data.get("nodes", []) or "zanzibar" in data.get("answer", "").lower())
    check(found, "The captured note is retrievable by /chat immediately", data.get("answer", "")[:120])

    status, data = post("/see", {"question": "What do you see?", "image": PROBE_JPEG, "media_type": "image/jpeg"})
    blind = re.search(r"corrupt|never reached|did not arrive|didn't arrive|no image|can'?t see (?:it|the|any)", data.get("answer", ""), re.I)
    check(status == 200 and data.get("answer") and not blind, "/see answers a real JPEG", data.get("answer", "")[:120])

    post("/chat", {"reset": True})   # the probe questions never leak into your own thread

    status, data = post("/model", {"name": "switch to opus 6"})
    check(status == 200 and data.get("refused"), "Brain swap refuses an unknown model", data.get("answer", "")[:100])

    print("Routing (Prompt 12)")
    width = max(len(s) for s, _ in ROUTING)
    bad = 0
    for sentence, expected in ROUTING:
        got = server.route(sentence)
        bad += got != expected
        print(f"    {'PASS' if got == expected else 'FAIL'}  {sentence:<{width}}  {got}")
    check(not bad, f"Routing table, {len(ROUTING)} sentences", f"{bad} wrong" if bad else "")
    bad = sum(server.classify(s) != e for s, e in COMMANDS)
    for s, e in COMMANDS:
        if server.classify(s) != e:
            print(f"    FAIL  {s}  -> {server.classify(s)} (want {e})")
    check(not bad, f"Desk command table, {len(COMMANDS)} sentences", f"{bad} wrong" if bad else "")

    print("Runs, tools and Part Two")
    status, data = post("/tool_chat", {"question": "Use notes_search to find the research orchestrator note. Reply with its title only."})
    check(status == 200 and "orchestrator" in data.get("answer", "").lower(), "Tool loop through the desk MCP server",
          data.get("answer", "")[:100])
    status, data = post("/run", {"kind": "agent", "text": "preflight probe, never started"})
    pending = data.get("pending")
    status2, data2 = post("/run/cancel", {"id": pending})
    check(status == 200 and pending and status2 == 200 and "Cancelled" in data2.get("answer", ""),
          "A run waits for confirmation and can be cancelled")
    status, _, audio = request("POST", "/speak", {"text": "Preflight."})
    if status == 503:
        mark("warn", "Kokoro voice not running on port 8880: the desk falls back to the browser's voice")
    else:
        check(status == 200 and (audio[:3] == b"ID3" or audio[:1] == bytes([255])), "Kokoro speaks (POST /speak returns MP3)", f"{len(audio)} bytes")
    import playbooks, whatchanged
    check(bool(playbooks.load()), "Playbooks load", ", ".join(pb["name"] for pb in playbooks.load()))
    status, data = post("/chat", {"question": "what changed today?"})
    check(status == 200 and data.get("route") == "what changed" and data.get("answer"), "What changed briefing",
          f"{len(data.get('nodes', []))} stars lit: " + data.get("answer", "")[:80])
    import phone, pocket, google
    if phone.configured():
        for path in ("/call", "/stage", "/briefing"):
            status, data = post(path, {"dry": True})
            check(status == 200 and data.get("dry") is not False, f"{path} dry run", data.get("answer", "")[:80])
    else:
        mark("warn", "Phone line not configured: telephony in config.json, then python setup_phone.py")
    if not shutil.which("cloudflared"):
        mark("warn", "cloudflared not installed: the inbound hotline needs it (winget install Cloudflare.cloudflared)")
    if not google.connected():
        mark("warn", "Google not connected: google.client_id/secret in config.json, then Connect Google")
    if not pocket.token():
        mark("warn", "Telegram not configured: telegram.bot_token in config.json")
    elif not pocket.paired():
        mark("warn", "Telegram configured but not paired: say \"pocket code\" at the desk")
    pocket._code.update(value="12345678", expires=9e18, guesses=0)
    for guess in ("1", "2", "3", "4", "5"):
        pocket._try_pair(-1, guess)
    check(pocket._code["value"] is None, "A pairing code dies after five wrong guesses")

    token = json.loads((HERE / "desk_state.json").read_text(encoding="utf-8"))["hotline"].get("token") if (HERE / "desk_state.json").exists() else None
    status, _, _ = request("POST", "/hook/not-the-token/verify_code", {"args": {"code": "1"}}, headers={"Host": "x.trycloudflare.com"})
    check(status == 404, "A hotline tool with the wrong token is refused", f"HTTP {status}")
    if token:
        caller = {"call_id": "preflight-" + os.urandom(4).hex(), "from_number": "preflight-" + os.urandom(4).hex()}
        hook = lambda tool, args: post_hook(token, tool, {"call": caller, "args": args})
        _, d = hook("fetch_brain", {"question": "what is on my calendar?"})
        check("Not verified" in d.get("result", ""), "fetch_brain refuses an unverified call")
        last = {}
        for _ in range(3):
            _, last = hook("verify_code", {"code": "0"})
        _, after = hook("verify_code", {"code": "0"})
        check(last.get("locked") and after.get("locked"), "Three wrong hotline codes lock the caller out")
    else:
        mark("warn", "No hotline token yet (created on first server start)")

    print("Security (Prompt 18)")
    for p in ("/config.json", "/../config.json", "/%2e%2e/config.json", "/..%2fconfig.json", "/notes.json", "/index.html.bak"):
        status, _, body = request("GET", p)
        if not check(status != 200 and b"model" not in body, f"Not served: {p}", f"HTTP {status}"):
            print("    !!! config or a private file is reachable from the browser !!!")
    status, _, _ = request("GET", "/", headers={"Host": "evil.example:4700"})
    check(status == 403, "A foreign Host is refused (DNS rebinding)", f"HTTP {status}")
    status, _, _ = request("GET", "/graph-data.js", headers={"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "script"})
    check(status == 403, "A cross-site script load of the graph is refused", f"HTTP {status}")
    status, _, _ = request("GET", "/", headers={"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"})
    check(status == 200, "A cross-site link may still navigate to the app", f"HTTP {status}")
    status, _, _ = request("POST", "/chat", {"question": "hi"}, headers={"Origin": "https://evil.example"})
    check(status == 403, "A foreign-Origin POST is refused", f"HTTP {status}")
    status, _, _ = request("POST", "/chat", {"question": "hi"}, headers={"Origin": ""})
    check(status == 403, "A POST without an Origin is refused", f"HTTP {status}")
    status, _, _ = request("POST", "/chat", {"question": "x" * 20000})
    check(status == 413, "An oversized body is refused", f"HTTP {status}")
    _, headers, _ = request("GET", "/")
    h = {k.lower(): v for k, v in headers.items()}
    check(h.get("x-content-type-options") == "nosniff" and h.get("cross-origin-resource-policy") == "same-origin"
          and h.get("referrer-policy") == "no-referrer" and h.get("x-frame-options") == "DENY",
          "nosniff, same-origin resource policy, no-referrer, no framing")
    gitignore = (HERE / ".gitignore").read_text(encoding="utf-8") if (HERE / ".gitignore").exists() else ""
    check("config.json*" in gitignore.split(), ".gitignore covers config.json*")
    for secret in [p for p in (HERE / "config.json", HERE / "desk_state.json", HERE / "google_token.json") if p.exists()]:
        if os.name == "nt":
            mark("warn", f"{secret.name}: Windows has no 600 mode; it relies on your user profile's ACL")
        else:
            check(stat.S_IMODE(secret.stat().st_mode) & 0o077 == 0, f"{secret.name} is 600",
                  oct(stat.S_IMODE(secret.stat().st_mode)))
    backups = [p.name for p in HERE.glob("config.json?*")]
    check(not backups, "No config backups beside the project", ", ".join(backups))
    return summary()


def summary():
    print(f"\n{results['pass']} pass, {results['fail']} fail, {results['warn']} warn")
    return 1 if results["fail"] else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
