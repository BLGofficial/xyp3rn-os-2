"""Voice-status contract, server side (approach C). Mirrors apps/web/lib/voice-status.ts: five states, a level in
0..1, and a seq that only grows. Stdlib only, like the server. Run from this folder:

    python -m unittest test_voice_status -v

The HTTP tests start the real Handler on an ephemeral port and send the Host and Origin the server expects
(it checks the headers, not the socket), so nothing here needs port 4700. The brain (`chat`) is replaced by a stub:
no `claude -p` runs.
"""
import http.client
import json
import sys
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import voice_status as vs  # noqa: E402


class ParseStatus(unittest.TestCase):
    def test_the_five_states_match_the_typescript_contract(self):
        self.assertEqual(vs.STATUSES, ("idle", "listening", "thinking", "speaking", "error"))

    def test_accepts_a_status_with_or_without_a_level(self):
        self.assertEqual(vs.parse_status({"status": "listening", "level": 0.4}), {"status": "listening", "level": 0.4})
        self.assertEqual(vs.parse_status({"status": "idle"}), {"status": "idle", "level": 0.0})

    def test_clamps_a_finite_level_instead_of_dropping_the_event(self):
        self.assertEqual(vs.parse_status({"status": "speaking", "level": 3})["level"], 1.0)
        self.assertEqual(vs.parse_status({"status": "speaking", "level": -1})["level"], 0.0)

    def test_refuses_anything_malformed(self):
        for bad in (None, "listening", [], {"status": "dancing"}, {"status": 3}, {},
                    {"status": "idle", "level": "loud"}, {"status": "idle", "level": float("nan")},
                    {"status": "idle", "level": float("inf")},
                    {"status": "idle", "level": True}):  # bool is an int in Python; it is not a level
            self.assertIsNone(vs.parse_status(bad), bad)


class Bus(unittest.TestCase):
    def test_starts_idle_and_seq_only_grows(self):
        bus = vs.VoiceBus(start_seq=10)
        self.assertEqual(bus.current(), {"status": "idle", "level": 0.0, "seq": 10})
        a = bus.publish("listening", 0.2)
        b = bus.publish("thinking")
        self.assertEqual(a, {"status": "listening", "level": 0.2, "seq": 11})
        self.assertEqual(b, {"status": "thinking", "level": 0.0, "seq": 12})
        self.assertEqual(bus.current(), b)

    def test_an_identical_event_is_coalesced_not_re_sent(self):
        bus = vs.VoiceBus(start_seq=1)
        first = bus.publish("speaking", 0.5)
        again = bus.publish("speaking", 0.5)
        self.assertEqual(again, first)
        self.assertEqual(bus.publish("speaking", 0.6)["seq"], first["seq"] + 1)

    def test_publish_clamps_and_refuses_unknown_status(self):
        bus = vs.VoiceBus(start_seq=1)
        self.assertEqual(bus.publish("listening", 9)["level"], 1.0)
        with self.assertRaises(ValueError):
            bus.publish("dancing")

    def test_default_seq_survives_a_server_restart(self):
        # A consumer drops seq <= the last it saw, so a fresh bus must not restart at 1.
        seq = vs.VoiceBus().current()["seq"]
        self.assertIsInstance(seq, int)
        self.assertGreaterEqual(seq, 1_700_000_000_000)
        self.assertLess(seq, 2 ** 53)

    def test_wait_returns_at_once_when_already_ahead(self):
        bus = vs.VoiceBus(start_seq=5)
        bus.publish("listening")
        self.assertEqual(bus.wait(5, 0.01)["status"], "listening")

    def test_wait_times_out_with_none(self):
        bus = vs.VoiceBus(start_seq=5)
        t0 = time.monotonic()
        self.assertIsNone(bus.wait(5, 0.05))
        self.assertLess(time.monotonic() - t0, 1.0)

    def test_wait_wakes_on_a_publish_from_another_thread(self):
        bus = vs.VoiceBus(start_seq=5)
        threading.Timer(0.05, lambda: bus.publish("thinking")).start()
        got = bus.wait(5, 2.0)
        self.assertEqual(got["status"], "thinking")


class Sse(unittest.TestCase):
    def test_wire_format_matches_the_hud_events_route(self):
        event = {"status": "listening", "level": 0.5, "seq": 5}
        self.assertEqual(vs.format_sse(event), b'id: 5\nevent: voice\ndata: {"status":"listening","level":0.5,"seq":5}\n\n')


class Http(unittest.TestCase):
    HOST = "127.0.0.1:4700"
    ORIGIN = "http://127.0.0.1:4700"

    def setUp(self):
        import server
        self.server_mod = server
        self.bus = vs.VoiceBus(start_seq=100)
        patches = [mock.patch.object(server, "voice", self.bus), mock.patch.object(vs, "HEARTBEAT_SEC", 0.1)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def post(self, path, body, origin=ORIGIN):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Host": self.HOST, "Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        conn.request("POST", path, body=json.dumps(body), headers=headers)
        resp = conn.getresponse()
        data = json.loads(resp.read() or b"{}")
        conn.close()
        return resp.status, data

    def open_stream(self, origin=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Host": self.HOST}
        if origin:
            headers["Origin"] = origin
        conn.request("GET", "/voice/stream", headers=headers)
        self.addCleanup(conn.close)
        return conn.getresponse()

    @staticmethod
    def read_until(resp, needle, limit=40):
        seen = []
        for _ in range(limit):
            line = resp.fp.readline().decode()
            seen.append(line)
            if needle in line:
                return seen
        raise AssertionError(f"never saw {needle!r}: {seen}")

    def test_client_can_report_a_status_and_a_new_stream_starts_from_it(self):
        status, body = self.post("/voice/status", {"status": "listening", "level": 0.4})
        self.assertEqual((status, body["seq"]), (200, 101))
        resp = self.open_stream()
        self.assertEqual(resp.status, 200)
        self.assertIn("text/event-stream", resp.getheader("Content-Type"))
        lines = self.read_until(resp, "data:")
        self.assertIn("retry: 5000\n", lines)
        self.assertEqual(json.loads(lines[-1][len("data: "):]), {"status": "listening", "level": 0.4, "seq": 101})

    def test_a_connected_stream_receives_later_events_and_heartbeats(self):
        resp = self.open_stream()
        self.read_until(resp, "data:")                       # the current state first
        self.read_until(resp, ": heartbeat")                 # HEARTBEAT_SEC patched to 0.1
        self.bus.publish("speaking", 0.7)
        lines = self.read_until(resp, '"speaking"')
        self.assertEqual(json.loads(lines[-1][len("data: "):])["seq"], 101)

    def test_bad_status_is_a_400_and_publishes_nothing(self):
        status, _ = self.post("/voice/status", {"status": "dancing"})
        self.assertEqual(status, 400)
        self.assertEqual(self.bus.current()["seq"], 100)

    def test_foreign_or_missing_origin_is_refused_like_every_other_route(self):
        self.assertEqual(self.post("/voice/status", {"status": "idle"}, origin="http://evil.example")[0], 403)
        self.assertEqual(self.post("/voice/status", {"status": "idle"}, origin=None)[0], 403)
        self.assertEqual(self.open_stream(origin="http://127.0.0.1:3100").status, 403)  # the web app goes through a proxy, never direct

    def test_chat_is_thinking_while_it_runs_then_idle(self):
        seen = {}

        def brain(text):
            seen["during"] = self.bus.current()["status"]
            return {"answer": "ok", "nodes": []}

        with mock.patch.object(self.server_mod, "chat", brain):
            status, body = self.post("/chat", {"question": "hello"})
        self.assertEqual((status, body["answer"]), (200, "ok"))
        self.assertEqual(seen["during"], "thinking")
        self.assertEqual(self.bus.current()["status"], "idle")

    def test_a_failed_chat_ends_in_error(self):
        def brain(text):
            raise self.server_mod.BrainError(502, "claude -p returned nothing.")

        with mock.patch.object(self.server_mod, "chat", brain):
            status, _ = self.post("/chat", {"question": "hello"})
        self.assertEqual(status, 502)
        self.assertEqual(self.bus.current()["status"], "error")

    def test_a_refused_chat_is_not_an_error_state(self):
        def brain(text):
            raise self.server_mod.BrainError(400, "Say something first.")

        with mock.patch.object(self.server_mod, "chat", brain):
            status, _ = self.post("/chat", {"question": "hello"})
        self.assertEqual(status, 400)
        self.assertEqual(self.bus.current()["status"], "idle")

    def test_a_chat_reset_is_not_thinking(self):
        self.post("/chat", {"reset": True})
        self.assertEqual(self.bus.current()["seq"], 100)


if __name__ == "__main__":
    unittest.main()
