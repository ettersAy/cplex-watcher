import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from ticket_check import SLOT_SECONDS, run


class TicketCheckTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.state = Path(directory.name) / "state.json"
        self.state.write_text('{"movies": {}, "existing": true}')
        self.scan = Mock()

    def check(self, request, slot=123, scan=None):
        run(request, slot * SLOT_SECONDS + 10, self.state, scan or self.scan)

    def test_same_slot_runs_once_across_primary_and_fallback(self):
        for first, second in (("ticket-check-123", "fallback"), ("fallback", "ticket-check-123")):
            with self.subTest(first=first):
                self.state.write_text('{"movies": {}}')
                self.scan.reset_mock()
                self.check(first)
                self.check(second)
                self.check(first)
                self.scan.assert_called_once()

    def test_next_slot_checks_and_preserves_updated_alert_state(self):
        self.check("ticket-check-123")

        def update():
            self.state.write_text('{"movies": {"a": {"alerted": true}}, "existing": true}')

        self.check("ticket-check-124", 124, update)
        self.check("fallback", 123)
        self.assertEqual(json.loads(self.state.read_text()), {
            "movies": {"a": {"alerted": True}}, "existing": True, "lastTicketCheckSlot": 124,
        })

    def test_skip_expired_and_future_slots(self):
        for request in ("ticket-check-122", "ticket-check-124"):
            self.check(request)
        self.scan.assert_not_called()

    def test_reject_invalid_request_ids(self):
        for request in ("watch", "ticket-check-", "ticket-check-٠١", "ticket-check-12345678901"):
            with self.subTest(request=request), self.assertRaisesRegex(ValueError, "Invalid"):
                self.check(request)
        self.scan.assert_not_called()

    def test_scan_exception_does_not_complete_slot(self):
        self.scan.side_effect = [RuntimeError("scan failed"), None]
        with self.assertRaisesRegex(RuntimeError, "scan failed"):
            self.check("ticket-check-123")
        self.assertNotIn("lastTicketCheckSlot", json.loads(self.state.read_text()))
        self.check("ticket-check-123")
        self.assertEqual(self.scan.call_count, 2)

    def test_manual_watch_keeps_immediate_scan_and_does_not_mark_timer(self):
        self.check(None)
        self.scan.assert_called_once()
        self.assertNotIn("lastTicketCheckSlot", json.loads(self.state.read_text()))


if __name__ == "__main__":
    unittest.main()
