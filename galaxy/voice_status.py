"""Voice-status bus: one status value (idle, listening, thinking, speaking, error) for every face of the voice agent.

The server owns the sequence number. A consumer drops any event whose seq it has already seen, so seq only grows,
and it is seeded from the clock so a server restart does not start again at 1 and look stale. The contract is
mirrored by apps/web/lib/voice-status.ts; keep the two in step. Standard library only.
"""
import json
import math
import threading
import time

STATUSES = ("idle", "listening", "thinking", "speaking", "error")
HEARTBEAT_SEC = 15   # a comment line this often keeps proxies from closing an idle stream


def _level(value):
    """A level is a finite number clamped into 0..1. NaN and infinities are not levels."""
    if not math.isfinite(value):
        return 0.0
    return min(1.0, max(0.0, float(value)))


def parse_status(raw):
    """Validate an untrusted client report. Returns {"status", "level"} or None. A missing level is 0 and a
    finite one is clamped, so a slightly-off meter never drops the state change; anything else malformed is refused."""
    if not isinstance(raw, dict) or raw.get("status") not in STATUSES:
        return None
    level = raw.get("level", 0.0)
    if isinstance(level, bool) or not isinstance(level, (int, float)) or not math.isfinite(level):
        return None
    return {"status": raw["status"], "level": _level(level)}


class VoiceBus:
    """The current voice status, with a blocking wait for the next change. Thread-safe."""

    def __init__(self, start_seq=None):
        seq = int(time.time() * 1000) if start_seq is None else start_seq
        self._cond = threading.Condition()
        self._event = {"status": "idle", "level": 0.0, "seq": seq}

    def current(self):
        with self._cond:
            return dict(self._event)

    def publish(self, status, level=0.0):
        """Set the status. An event identical to the current one is coalesced (no new seq), so a steady meter
        does not flood the stream. Returns the event now current."""
        if status not in STATUSES:
            raise ValueError(f"unknown voice status: {status!r}")
        level = _level(level)
        with self._cond:
            cur = self._event
            if cur["status"] == status and cur["level"] == level:
                return dict(cur)
            self._event = {"status": status, "level": level, "seq": cur["seq"] + 1}
            self._cond.notify_all()
            return dict(self._event)

    def wait(self, after_seq, timeout):
        """Block until an event newer than `after_seq` exists, or `timeout` seconds pass. Returns it, or None."""
        with self._cond:
            self._cond.wait_for(lambda: self._event["seq"] > after_seq, timeout)
            return dict(self._event) if self._event["seq"] > after_seq else None


def format_sse(event):
    """One Server-Sent Event, in the same shape as the web app's /api/events/stream."""
    return f"id: {event['seq']}\nevent: voice\ndata: {json.dumps(event, separators=(',', ':'))}\n\n".encode("utf-8")
