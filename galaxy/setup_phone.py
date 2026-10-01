#!/usr/bin/env python3
"""One setup command for the phone line (Prompts 09 and 16).

    python setup_phone.py --dry     preview, change nothing
    python setup_phone.py           create what is missing, write ids into config.json atomically

Idempotent: an agent whose id is already in config.json and still exists is never created twice.
Creates the outbound agent (Jarvis rings you) and the inbound hotline agent, and points your Retell
number's inbound calls at the hotline. The hotline's tools are added by the server once its tunnel
is up, because their address changes with every tunnel.
"""
import json
import os
import secrets
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import desk   # noqa: E402
import phone  # noqa: E402

CONFIG = HERE / "config.json"
DEFAULT_VOICE = "11labs-Adrian"


def main():
    dry = "--dry" in sys.argv
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    t = cfg.get("telephony") or {}
    if not t.get("api_key") or "PUT-" in t["api_key"]:
        print("No Retell key yet: create one at https://dashboard.retellai.com (API Keys), then put it in "
              "config.json under telephony.api_key, with your Retell number as telephony.from and your cell as telephony.callback.")
        return 0
    for k in ("from", "callback"):
        if not t.get(k) or not str(t[k]).startswith("+"):
            print(f"telephony.{k} must be an E.164 number like +15551234567.")
            return 1
    voice = t.get("voice_id") or DEFAULT_VOICE
    plan, updates = [], {}

    def exists(path):
        try:
            phone.retell("GET", path, key=t["api_key"])
            return True
        except phone.PhoneError:
            return False

    for side, prompt, begin, tools in (
            ("outbound", phone.OUTBOUND.format(headline="(set per call)", notes="(set per call)"), phone.GREETING,
             [{"type": "end_call", "name": "end_call", "description": "End the call right after the sign-off."}]),
            ("inbound", phone.INBOUND, "Jarvis here. May I have your access code?",
             [{"type": "end_call", "name": "end_call", "description": "End the call after the sign-off."}])):
        agent_key = "agent_id" if side == "outbound" else "inbound_agent_id"
        llm_key = "llm_id" if side == "outbound" else "inbound_llm_id"
        if t.get(agent_key) and exists(f"/get-agent/{t[agent_key]}"):
            plan.append(f"keep {side} agent {t[agent_key]}")
            continue
        plan.append(f"create {side} LLM + agent (voice {voice})")
        if dry:
            continue
        llm = phone.retell("POST", "/create-retell-llm", {"general_prompt": prompt, "begin_message": begin,
                                                          "general_tools": tools}, key=t["api_key"])
        agent = phone.retell("POST", "/create-agent", {"agent_name": f"Jarvis {side}", "voice_id": voice,
                                                       "response_engine": {"type": "retell-llm", "llm_id": llm["llm_id"]}},
                             key=t["api_key"])
        updates.update({llm_key: llm["llm_id"], agent_key: agent["agent_id"]})
    if not t.get("hotline_code"):
        plan.append("mint a 6-digit hotline code (shown once, below)")
        if not dry:
            updates["hotline_code"] = "".join(secrets.choice("0123456789") for _ in range(6))
    inbound = updates.get("inbound_agent_id") or t.get("inbound_agent_id")
    plan.append(f"point {t['from']} inbound calls at the hotline agent")
    if not dry and inbound:
        phone.retell("PATCH", f"/update-phone-number/{t['from']}", {"inbound_agent_id": inbound}, key=t["api_key"])

    print(("DRY RUN, nothing changed:\n  - " if dry else "Done:\n  - ") + "\n  - ".join(plan))
    if updates:
        cfg["telephony"] = {**t, **updates}
        tmp = CONFIG.with_name(f".config.{secrets.token_hex(4)}.tmp")
        tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
        desk.lock_down(tmp)
        os.replace(tmp, CONFIG)
        desk.lock_down(CONFIG)
        print("config.json updated with the new ids.")
        if "hotline_code" in updates:
            print(f"Your hotline code: {updates['hotline_code']}  (it lives only in config.json; the agent never sees it)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
