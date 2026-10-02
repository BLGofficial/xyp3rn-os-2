"""The Google line (Prompt 10): OAuth with PKCE, then direct REST. Standard library only.

DRAFTS ONLY: there is no send function in this project and there never will be.
"""
import base64
import hashlib
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from email.message import EmailMessage
from pathlib import Path

import desk

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.json"
TOKEN = HERE / "google_token.json"
REDIRECT = "http://localhost:4700/oauth/callback"
SCOPES = ["https://www.googleapis.com/auth/calendar.events",
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose"]
_pending = {}       # state -> (verifier, expires)
_access = {"token": None, "expires": 0}


class GoogleError(Exception):
    pass


def client():
    g = json.loads(CONFIG.read_text(encoding="utf-8")).get("google") or {}
    if not g.get("client_id") or not g.get("client_secret") or "PUT-" in g.get("client_id", ""):
        raise GoogleError("Google is not set up: add google.client_id and google.client_secret to config.json.")
    return g


def connected():
    return TOKEN.exists()


def auth_url():
    g = client()
    verifier = secrets.token_urlsafe(64)
    state = secrets.token_urlsafe(24)
    _pending.clear()   # one consent in flight at a time
    _pending[state] = (verifier, time.time() + 600)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": g["client_id"], "redirect_uri": REDIRECT, "response_type": "code",
        "scope": " ".join(SCOPES), "state": state, "code_challenge": challenge,
        "code_challenge_method": "S256", "access_type": "offline", "prompt": "consent"})


def finish(state, code):
    """The callback: the state must be one we minted, unexpired, used once."""
    entry = None
    for s in list(_pending):
        if secrets.compare_digest(s, state or ""):
            entry = _pending.pop(s)
    if not entry or entry[1] < time.time():
        raise GoogleError("That sign-in link expired or was not ours. Press Connect Google again.")
    g = client()
    tok = _post_form("https://oauth2.googleapis.com/token", {
        "code": code, "client_id": g["client_id"], "client_secret": g["client_secret"],
        "redirect_uri": REDIRECT, "grant_type": "authorization_code", "code_verifier": entry[0]})
    if "refresh_token" not in tok:
        raise GoogleError("Google returned no refresh token. Remove the app's access in your Google account and connect again.")
    TOKEN.write_text(json.dumps({"refresh_token": tok["refresh_token"]}), encoding="utf-8")
    desk.lock_down(TOKEN)
    _access.update(token=tok.get("access_token"), expires=time.time() + int(tok.get("expires_in", 0)) - 60)


def _post_form(url, fields):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(fields).encode(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise GoogleError(f"Google token error {e.code}: {e.read()[:200].decode(errors='replace')}")


def access_token():
    if _access["token"] and _access["expires"] > time.time():
        return _access["token"]
    if not TOKEN.exists():
        raise GoogleError("Google is not connected. Press Connect Google on the desk.")
    g = client()
    tok = _post_form("https://oauth2.googleapis.com/token", {
        "client_id": g["client_id"], "client_secret": g["client_secret"],
        "refresh_token": json.loads(TOKEN.read_text(encoding="utf-8"))["refresh_token"], "grant_type": "refresh_token"})
    _access.update(token=tok["access_token"], expires=time.time() + int(tok.get("expires_in", 3600)) - 60)
    return _access["token"]


def api(method, url, body=None, params=None):
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {access_token()}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raise GoogleError(f"Google API {e.code}: {e.read()[:300].decode(errors='replace')}")


GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me"
CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events"


def _headers(msg):
    h = {x["name"].lower(): x["value"] for x in msg.get("payload", {}).get("headers", [])}
    return {"id": msg["id"], "from": h.get("from", ""), "subject": h.get("subject", ""),
            "date": h.get("date", ""), "snippet": msg.get("snippet", "")}


def gmail_search(query, max_results=8):
    ids = api("GET", f"{GMAIL}/messages", params={"q": query, "maxResults": max(1, min(int(max_results), 20))})
    out = []
    for m in ids.get("messages", []):
        msg = api("GET", f"{GMAIL}/messages/{m['id']}", params={"format": "metadata",
                  "metadataHeaders": ["From", "Subject", "Date"]})
        out.append(_headers(msg))
    return out


def gmail_unread(max_results=8):
    return gmail_search("is:unread in:inbox category:primary", max_results)


def _text_of(part):
    if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
        return base64.urlsafe_b64decode(part["body"]["data"] + "==").decode("utf-8", "replace")
    for p in part.get("parts", []) or []:
        t = _text_of(p)
        if t:
            return t
    return ""


def gmail_read(message_id):
    msg = api("GET", f"{GMAIL}/messages/{urllib.parse.quote(message_id)}", params={"format": "full"})
    return {**_headers(msg), "body": _text_of(msg.get("payload", {}))[:6000]}


def gmail_draft(to, subject, body):
    m = EmailMessage()
    m["To"], m["Subject"] = to, subject
    m.set_content(body)
    raw = base64.urlsafe_b64encode(m.as_bytes()).decode()
    d = api("POST", f"{GMAIL}/drafts", {"message": {"raw": raw}})
    return {"draft_id": d["id"], "link": "https://mail.google.com/mail/#drafts", "receipt": f"draft {d['id']} saved"}


def gcal_events(start=None, end=None):
    """start/end: ISO dates or datetimes. Default: today."""
    tz = datetime.now().astimezone().tzinfo
    s = datetime.fromisoformat(start) if start else datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    e = datetime.fromisoformat(end) if end else s + timedelta(days=1)
    s, e = (x if x.tzinfo else x.replace(tzinfo=tz) for x in (s, e))
    if e <= s:
        e = s + timedelta(days=1)
    items = api("GET", CAL, params={"timeMin": s.isoformat(), "timeMax": e.isoformat(), "singleEvents": "true",
                                   "orderBy": "startTime", "maxResults": 50}).get("items", [])
    return [{"id": i["id"], "summary": i.get("summary", "(no title)"),
             "start": i["start"].get("dateTime", i["start"].get("date")),
             "end": i["end"].get("dateTime", i["end"].get("date")), "location": i.get("location", "")} for i in items]


def _when(value):
    dt = datetime.fromisoformat(value)
    if not dt.tzinfo:
        dt = dt.replace(tzinfo=datetime.now().astimezone().tzinfo)
    return {"dateTime": dt.isoformat()}


def gcal_add(summary, start, end=None, description=""):
    end = end or (datetime.fromisoformat(start) + timedelta(hours=1)).isoformat()
    ev = api("POST", CAL, {"summary": summary, "description": description, "start": _when(start), "end": _when(end)})
    return {"event_id": ev["id"], "link": ev.get("htmlLink"), "receipt": f"event {ev['id']} created"}


def gcal_move(event_id, start, end=None):
    end = end or (datetime.fromisoformat(start) + timedelta(hours=1)).isoformat()
    ev = api("PATCH", f"{CAL}/{urllib.parse.quote(event_id)}", {"start": _when(start), "end": _when(end)})
    return {"event_id": ev["id"], "link": ev.get("htmlLink"), "receipt": f"event {ev['id']} moved"}
