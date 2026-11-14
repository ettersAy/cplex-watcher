import io
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError

import telegram_reminders as reminders
import seat_watcher
from notification_preferences import load_preferences, notification_chat_ids, recipient_key, save_preferences


class RemindersTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        environment = patch.dict(os.environ, {
            "TELEGRAM_PREFERENCES_KEY": "test-secret", "TELEGRAM_BOT_TOKEN": "test-token",
            "TELEGRAM_CHAT_IDS": "owner-id", "TELEGRAM_GEORGE_MICHAEL_ALERT_CHAT_IDS": "friend-id,owner-id",
        }, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.now = datetime(2026, 11, 14, 12, tzinfo=reminders.MONTREAL)
        self.owner, self.friend = recipient_key("owner-id"), recipient_key("friend-id")
        self.preferences = {self.owner: {}, self.friend: {}}
        self.movies = [
            {"url": "https://www.cineplex.com/movie/george-michael-the-faith-tour", "name": "George Michael: The Faith Tour"},
            {"url": "https://www.cineplex.com/movie/the-odyssey", "name": "The Odyssey"},
        ]
        seat = {"enabled": True, "name": "Dune & Friends", "theatreId": "9406", "theatreName": "Scotia",
                "showtimes": {"123": {"enabled": True, "startsAt": "2099-12-14T18:00:00"}}}
        self.seats = {"dune": seat, "disabled": {**seat, "enabled": False},
                      "completed": {**seat, "showtimes": {"124": {"enabled": False}}},
                      "past": {**seat, "showtimes": {"125": {"enabled": True, "showStartDateTimeUtc": "2026-01-01T18:00:00Z"}}}}
        (self.root / "movies.json").write_text(json.dumps(self.movies))
        (self.root / "seat-watches.json").write_text(json.dumps({"watches": self.seats}))
        save_preferences(self.root, self.preferences)
        default, special, self.recipients = reminders.configured_recipients()
        self.watches = reminders.active_watches(self.root, default, special, self.now)
        self.send = Mock()

    def deliver(self, now=None):
        return reminders.send_reminders(self.preferences, self.recipients, self.watches, "test-token", now or self.now, send=self.send)

    def test_only_active_watches_and_correct_recipient_scopes(self):
        self.assertEqual(len(self.watches), 3)
        self.assertEqual(self.deliver(), 0)
        self.assertEqual(self.send.call_count, 2)
        owner, friend = self.send.call_args_list
        self.assertIn("Dune &amp; Friends", owner.args[2])
        self.assertIn("The Odyssey", owner.args[2])
        self.assertIn("ticket sales in Montréal", friend.args[2])
        self.assertNotIn("Dune", friend.args[2])
        self.assertNotIn("Odyssey", friend.args[2])
        self.assertIn("/stop reminder", friend.args[2])

    def test_once_per_week_and_next_saturday(self):
        self.deliver()
        self.deliver(self.now + timedelta(days=1))
        self.assertEqual(self.send.call_count, 2)
        self.deliver(self.now + timedelta(days=7))
        self.assertEqual(self.send.call_count, 4)

    def test_failed_recipient_does_not_block_others_and_is_retried(self):
        failure = HTTPError("https://telegram.test", 403, "Forbidden", {}, io.BytesIO())
        self.addCleanup(failure.close)
        self.send.side_effect = [failure, None]
        with patch("sys.stderr", new=io.StringIO()) as errors:
            self.assertEqual(self.deliver(), 1)
        self.assertIn("403", errors.getvalue())
        self.assertNotIn("lastReminderWeek", self.preferences[self.owner])
        self.assertIn("lastReminderWeek", self.preferences[self.friend])
        self.send.reset_mock(side_effect=True)
        self.assertEqual(self.deliver(), 0)
        self.assertEqual(self.send.call_args.args[1], "owner-id")
        self.assertEqual(self.send.call_count, 1)

    def test_stop_reminder_keeps_alerts_and_start_restores_reminders(self):
        preference = self.preferences[self.owner]
        reminders.update_preference(preference, self.watches, "stop", "reminder")
        self.deliver()
        self.assertEqual(self.send.call_count, 1)
        self.assertEqual(notification_chat_ids(["owner-id"], "seat:dune", self.preferences), ["owner-id"])
        reminders.update_preference(preference, self.watches, "start", "reminder")
        self.deliver()
        self.assertEqual(self.send.call_count, 2)

    def test_connection_reset_does_not_block_other_recipients(self):
        self.send.side_effect = [ConnectionResetError("Connection reset"), None]
        with patch("sys.stderr", new=io.StringIO()):
            self.assertEqual(self.deliver(), 1)
        self.assertEqual(self.send.call_count, 2)
        self.assertNotIn("lastReminderWeek", self.preferences[self.owner])
        self.assertIn("lastReminderWeek", self.preferences[self.friend])

    def test_stop_one_is_personal_and_stop_all_disables_alerts_and_reminders(self):
        preference = self.preferences[self.owner]
        reminders.update_preference(preference, self.watches, "stop", "George Michael")
        self.assertEqual(notification_chat_ids(["owner-id", "friend-id"], self.watches[0]["key"], self.preferences), ["friend-id"])
        reminders.update_preference(preference, self.watches, "stop", "all")
        self.assertEqual(notification_chat_ids(["owner-id"], "seat:dune", self.preferences), [])
        self.deliver()
        self.assertEqual(self.send.call_count, 1)
        reminders.update_preference(preference, self.watches, "start", "all")
        self.assertEqual(notification_chat_ids(["owner-id"], self.watches[0]["key"], self.preferences), ["owner-id"])

    def test_no_watch_means_no_reminder(self):
        self.watches = []
        self.deliver()
        self.send.assert_not_called()

    def test_long_list_keeps_every_watch_and_fits_telegram_messages(self):
        watches = [{"name": f"Movie {index}: " + "A & B " * 15, "detail": "ticket sales"} for index in range(100)]
        messages = list(reminders.weekly_messages(watches))
        self.assertGreater(len(messages), 1)
        self.assertTrue(all(len(message) <= 3900 for message in messages))
        self.assertEqual(sum(message.count("• ") for message in messages), 100)
        self.assertTrue(all("/stop reminder" in message for message in messages))

    def test_runner_saves_successful_delivery_even_when_another_fails(self):
        failure = HTTPError("https://telegram.test", 403, "Forbidden", {}, io.BytesIO())
        self.addCleanup(failure.close)
        with patch("sys.argv", ["telegram_reminders.py", "remind", "--root", str(self.root)]), patch("watcher.request_json") as telegram, patch("sys.stderr", new=io.StringIO()):
            telegram.side_effect = [failure, {"ok": True}]
            with self.assertRaises(SystemExit):
                reminders.main()
            saved = load_preferences(self.root)
            self.assertNotIn("lastReminderWeek", saved[self.owner])
            self.assertIn("lastReminderWeek", saved[self.friend])
            telegram.reset_mock(side_effect=True)
            reminders.main()
            self.assertEqual(telegram.call_count, 1)
            self.assertEqual(telegram.call_args.args[1]["chat_id"], "owner-id")

    def test_unknown_or_ambiguous_watch_changes_nothing(self):
        preference = self.preferences[self.owner]
        self.assertIn("No active watch", reminders.update_preference(preference, self.watches, "stop", "Missing"))
        self.assertIn("Several watches", reminders.update_preference(preference, self.watches, "stop", "The"))
        self.assertEqual(preference, {})
        reminders.update_preference(preference, self.watches, "stop", "seat:dune")
        self.assertEqual(preference["stoppedWatches"], ["seat:dune"])

    def test_command_persists_before_success_reply_without_private_ids(self):
        with patch.dict(os.environ, {"RECIPIENT_KEY": self.friend, "PREFERENCE_QUERY": "reminder"}), patch.object(reminders, "send_telegram") as send:
            with patch("sys.argv", ["telegram_reminders.py", "stop", "--root", str(self.root)]):
                reminders.main()
            send.assert_not_called()
            self.assertFalse(load_preferences(self.root)[self.friend]["remindersEnabled"])
            raw = (self.root / "notification-preferences.json").read_text()
            self.assertNotIn("friend-id", raw)
            self.assertNotIn("test-secret", raw)
            with patch.dict(os.environ, {"PREFERENCE_SAVED": "true"}), patch("sys.argv", ["telegram_reminders.py", "reply", "--root", str(self.root)]):
                reminders.main()
            self.assertIn("Weekly reminders are off", send.call_args.args[2])
            with patch.dict(os.environ, {"PREFERENCE_SAVED": "false"}), patch("sys.argv", ["telegram_reminders.py", "reply", "--root", str(self.root)]):
                reminders.main()
            self.assertIn("could not save", send.call_args.args[2])

    def test_unconfigured_account_cannot_change_preferences(self):
        with patch.dict(os.environ, {"RECIPIENT_KEY": recipient_key("stranger")}), patch("sys.argv", ["telegram_reminders.py", "stop", "--root", str(self.root)]):
            with self.assertRaisesRegex(ValueError, "not configured"):
                reminders.main()
        self.assertEqual(load_preferences(self.root), self.preferences)

    def test_missing_secret_and_invalid_state_are_errors(self):
        with patch.dict(os.environ, {"TELEGRAM_PREFERENCES_KEY": ""}):
            with self.assertRaisesRegex(ValueError, "not configured"):
                recipient_key("owner-id")
        (self.root / "notification-preferences.json").write_text('{"recipients": []}')
        with self.assertRaises(ValueError):
            load_preferences(self.root)

    def test_seat_scan_uses_personal_recipient_filter(self):
        save_preferences(self.root, {self.owner: {"stoppedWatches": ["seat:dune"]}})
        def scan(_root, **kwargs):
            kwargs["notify_watch"]("dune", "Muted seat alert")
            kwargs["notify_watch"]("other", "Another seat alert")
            return {}
        with patch("sys.argv", ["seat_watcher.py", "scan", "--notify", "--root", str(self.root)]), patch.object(seat_watcher, "scan_all", side_effect=scan), patch("watcher.request_json") as telegram, patch("sys.stdout", new=io.StringIO()):
            seat_watcher.main()
        self.assertEqual(telegram.call_count, 1)
        self.assertEqual(telegram.call_args.args[1]["text"], "Another seat alert")

    def test_missing_secret_does_not_scan_or_consume_seat_alerts(self):
        with patch.dict(os.environ, {"TELEGRAM_PREFERENCES_KEY": ""}), patch("sys.argv", ["seat_watcher.py", "scan", "--notify", "--root", str(self.root)]), patch.object(seat_watcher, "scan_all") as scan:
            with self.assertRaisesRegex(ValueError, "not configured"):
                seat_watcher.main()
        scan.assert_not_called()

    def test_noon_uses_montreal_summer_and_winter_offsets(self):
        for month, utc_hour in [(7, 16), (11, 17)]:
            local = datetime(2026, month, 14, 12, tzinfo=reminders.MONTREAL)
            self.assertEqual(local.astimezone(timezone.utc).hour, utc_hour)


if __name__ == "__main__":
    unittest.main()
