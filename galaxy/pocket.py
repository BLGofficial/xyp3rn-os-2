"""The pocket (Prompt 11): a Telegram bot, long-polled, so no tunnel is needed. Standard library only.

Pairing: a code minted at the desk from a cryptographic source, alive ten minutes, the WHOLE message,
single use, dead after five wrong guesses. A paired chat is you; everyone else gets one polite refusal
and nothing more. Strangers never get free transcription. Every push records its card id, so the same
card can never reach your phone twice.
"""
import hmac
import json
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import desk
import server

CODE_TTL = 600
MAX_GUESSES = 5
REFUSAL = "Good day. This is a private line, I'm afraid. I'm unable to help."
_code = {"value": None, "expires": 0, "guesses": 0}
_deferred = []


class PocketError(Exception):
    pass


def cfg():
    return server.config()


def token():
    t = (cfg().get("telegram") or {}).get("bot_token")
    return t if t and "PUT-" not in t else None


def openai_key():
    k = (cfg().get("speech") or {}).get("openai_api_key")
    return k if k and "PUT-" not in k else None


def paired():
    return bool(desk.read("telegram").get("chat_id"))


def tg(method, params=None, files=None, timeout=60):
    url = f"https://api.telegram.org/bot{token()}/{method}"
    if files:
        body, ctype = multipart(params or {}, files)
        req = urllib.request.Request(url, data=body, headers={"Content-Type": ctype})
    else:
        req = urllib.request.Request(url, data=json.dumps(params or {}).encode(),
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise PocketError(f"Telegram {e.code}: {e.read()[:200].decode(errors='replace')}")
    if not out.get("ok"):
        raise PocketError(f"Telegram: {out.get('description')}")
    return out["result"]


def multipart(fields, files):
    boundary = uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    for k, (name, data, ctype) in files.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{name}"\r\n'
                     f"Content-Type: {ctype}\r\n\r\n".encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def mint_code():
    if not token():
        raise PocketError("The pocket isn't set up, sir: create a bot with @BotFather and put its token "
                          "in config.json under telegram.bot_token.")
    value = "".join(secrets.choice("0123456789") for _ in range(8))
    _code.update(value=value, expires=time.time() + CODE_TTL, guesses=0)
    return value


def _try_pair(chat_id, text):
    if not _code["value"] or _code["expires"] < time.time():
        return False
    if hmac.compare_digest(text.strip().encode(), _code["value"].encode()):   # the WHOLE message, nothing else
        _code.update(value=None, expires=0)
        with desk.edit() as s:
            s["telegram"]["chat_id"] = chat_id
        send("Paired, sir. This chat is now the desk's pocket.")
        return True
    _code["guesses"] += 1
    if _code["guesses"] >= MAX_GUESSES:
        _code.update(value=None, expires=0)   # dies after five wrong guesses
    return False


# ── Speech: OpenAI for both directions; with no key, text only ────────────────────────
def openai(path, data, ctype):
    req = urllib.request.Request("https://api.openai.com/v1/" + path, data=data,
                                 headers={"Authorization": f"Bearer {openai_key()}", "Content-Type": ctype})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read()


def transcribe(audio):
    body, ctype = multipart({"model": "gpt-4o-mini-transcribe"}, {"file": ("voice.ogg", audio, "audio/ogg")})
    return json.loads(openai("audio/transcriptions", body, ctype))["text"]


def voice_note(text):
    """An OGG/Opus voice note of the same line, or None without a speech key."""
    if not openai_key():
        return None
    try:
        return openai("audio/speech", json.dumps({"model": "gpt-4o-mini-tts", "voice": "fable", "input": text[:3000],
                                                  "response_format": "opus"}).encode(), "application/json")
    except Exception as e:
        print("voice note failed:", e)
        return None


def send(text, card_id=None):
    """A TEXT plus a VOICE NOTE of the same short line. A card id is recorded first: never twice."""
    chat_id = desk.read("telegram").get("chat_id")
    if not token() or not chat_id:
        return False
    if card_id:
        with desk.edit() as s:
            if card_id in s["pushed"]:
                return False
            s["pushed"] = (s["pushed"] + [card_id])[-500:]
    tg("sendMessage", {"chat_id": chat_id, "text": text})
    audio = voice_note(text)
    if audio:
        tg("sendVoice", {"chat_id": chat_id}, files={"voice": ("jarvis.ogg", audio, "audio/ogg")})
    return True


def on_card(card):
    """High-priority cards and post-call confirmations push to the phone; desk reminders push only
    when the desk is closed. Nothing pushes during a staged call: one Jarvis talking at a time."""
    from phone import _staged_quiet
    eligible = card["push"] and (card["priority"] == "high" or card["kind"] in ("confirmation", "message")
                                 or (card["kind"] == "reminder" and server.desk_closed()))
    if not eligible:
        return
    if _staged_quiet.is_set():
        _deferred.append(card)
        return
    send(card["text"], card["id"])


def flush_deferred():
    while _deferred:
        card = _deferred.pop(0)
        try:
            send(card["text"], card["id"])
        except Exception as e:
            print("deferred push failed:", e)


def handle(update):
    msg = update.get("message") or {}
    chat_id = (msg.get("chat") or {}).get("id")
    if not chat_id:
        return
    with desk.edit() as s:
        tgs = s["telegram"]
        mine = tgs.get("chat_id") == chat_id
        refused = chat_id in tgs.setdefault("refused", [])
    if not mine:
        if "text" in msg and _try_pair(chat_id, msg["text"]):
            return
        if not refused:   # one polite refusal, then silence
            with desk.edit() as s:
                s["telegram"]["refused"] = (s["telegram"]["refused"] + [chat_id])[-200:]
            tg("sendMessage", {"chat_id": chat_id, "text": REFUSAL})
        return
    text = msg.get("text")
    if not text and msg.get("voice"):
        if not openai_key():
            send("I can't hear voice notes yet, sir: add speech.openai_api_key to config.json.")
            return
        f = tg("getFile", {"file_id": msg["voice"]["file_id"]})
        with urllib.request.urlopen(f"https://api.telegram.org/file/bot{token()}/{f['file_path']}", timeout=60) as r:
            text = transcribe(r.read())
    if not text:
        return
    try:
        answer = server.handle_text(text[:2000])["answer"]
    except Exception as e:
        answer = f"I'm afraid that failed, sir: {getattr(e, 'message', e)}"
    send(answer)


def loop():
    while True:
        if not token():
            time.sleep(30)
            continue
        try:
            offset = desk.read("telegram").get("offset", 0)
            updates = tg("getUpdates", {"offset": offset, "timeout": 50, "allowed_updates": ["message"]}, timeout=70)
            for u in updates:
                with desk.edit() as s:
                    s["telegram"]["offset"] = u["update_id"] + 1   # record first: a crash never replays it
                try:
                    handle(u)
                except Exception as e:
                    print("telegram message failed:", e)
        except Exception as e:
            print("telegram poll:", e)
            time.sleep(10)


def start():
    threading.Thread(target=loop, daemon=True).start()
