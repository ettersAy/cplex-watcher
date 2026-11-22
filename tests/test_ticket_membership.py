import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import register_watch
import telegram_reminders
import ticket_membership as tm
import watcher
from notification_preferences import recipient_key

MOVIE = {"url": "https://www.cineplex.com/movie/paper-tiger", "name": "Paper Tiger"}
GEORGE = {"url": "https://www.cineplex.com/movie/george-michael-the-faith-tour", "name": "George Michael"}
NOW = 1_800_000_000_000


class TicketMembershipTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.settings = patch.dict(os.environ, {
            "TELEGRAM_PREFERENCES_KEY": "synthetic-key",
            "TELEGRAM_RECIPIENTS": "201,-202",
            "TELEGRAM_GEORGE_MICHAEL_ALERT_CHAT_IDS": "101,102",
        }, clear=True)
        self.settings.start()
        self.addCleanup(self.settings.stop)
        self.friend, self.second, self.owner = map(recipient_key, ("101", "102", "201"))
        self.write("movies.json", [{**MOVIE, "subscribers": [self.friend, self.second]}, GEORGE])
        self.write("state.json", {"lastTicketCheckSlot": 12, "movies": {}})
        self.write("sales-started.json", [])

    def write(self, name, data):
        (self.root / name).write_text(json.dumps(data))

    def read(self, name):
        return json.loads((self.root / name).read_text())

    def settle(self, key, slug="paper-tiger", nonce="a" * 22, **kwargs):
        return tm.unfollow(self.root, key, slug, nonce, NOW + 1000, now=NOW, **kwargs)

    def current_recipients(self, index=0):
        row = self.read("movies.json")[index]
        return watcher.sale_alert_chat_ids(row["url"], "201", "101,102", row.get("subscribers", []), row.get("unfollowers", []))

    def test_friend_stop_keep_owner_and_second_friend(self):
        result = self.settle(self.friend)
        self.assertEqual(result, {"status": "unfollowed", "name": "Paper Tiger", "slug": "paper-tiger", "friend": True})
        self.assertEqual(self.current_recipients(), ["201", "102"])
        self.assertEqual(self.read("state.json")["lastTicketCheckSlot"], 12)
        self.assertEqual(self.current_recipients(1), ["201", "101", "102"])

    def test_scope_replay_noop_and_restart(self):
        self.settle(self.friend)
        self.assertEqual(self.settle(self.friend, nonce="b" * 22)["status"], "unchanged")
        request = {"status": "watching", "movie": MOVIE}
        register_watch.save_registration(self.root, request, self.friend)
        self.assertTrue(request["friend_started"])
        self.assertEqual(self.settle(self.friend)["status"], "duplicate")
        self.assertIn("101", self.current_recipients())
        request = {"status": "watching", "movie": MOVIE}
        register_watch.save_registration(self.root, request, self.friend)
        self.assertNotIn("friend_started", request)
        self.assertEqual(request["status"], "already_watching")

    def test_keep_consumes_offer_and_stop_too_only_changes_approver(self):
        self.settle(self.friend)
        self.assertEqual(self.settle(self.owner, nonce="b" * 22, keep=True)["status"], "kept")
        self.assertEqual(self.settle(self.owner, nonce="b" * 22)["status"], "duplicate")
        self.assertEqual(self.current_recipients(), ["201", "102"])
        self.assertFalse(self.settle(self.owner, nonce="c" * 22)["friend"])
        self.assertEqual(self.current_recipients(), ["102"])
        with self.assertRaisesRegex(ValueError, "owner"):
            self.settle(self.second, nonce="d" * 22, keep=True)

    def test_joining_existing_ticket_does_not_repeat_scan_row_or_clear_preferences(self):
        movies = [MOVIE]
        self.write("movies.json", movies)
        self.write("notification-preferences.json", {"recipients": {
            self.friend: {"stoppedAll": True}, self.owner: {"stoppedWatches": ["ticket:paper-tiger"]}}})
        old_prefs = self.read("notification-preferences.json")
        friend_join = {"status": "watching", "movie": MOVIE}
        register_watch.save_registration(self.root, friend_join, self.friend)
        self.assertTrue(friend_join["already_tracked"])
        self.assertTrue(friend_join["membership_added"])
        self.assertTrue(friend_join["friend_started"])
        owner_repeat = {"status": "watching", "movie": MOVIE}
        register_watch.save_registration(self.root, owner_repeat, self.owner)
        self.assertEqual(owner_repeat["status"], "already_watching")
        self.assertNotIn("membership_added", owner_repeat)
        self.assertNotIn("friend_started", owner_repeat)
        self.settle(self.owner, nonce="r" * 22)
        owner_rejoins = {"status": "watching", "movie": MOVIE}
        register_watch.save_registration(self.root, owner_rejoins, self.owner)
        self.assertTrue(owner_rejoins["membership_added"])
        self.assertNotIn("friend_started", owner_rejoins)
        self.assertEqual(self.current_recipients(), ["201", "101"])
        self.assertEqual(len(self.read("movies.json")), 1)
        self.assertEqual(self.read("notification-preferences.json"), old_prefs)

    def test_rejoining_dormant_ticket_does_not_restore_previous_others(self):
        self.write("movies.json", [{**MOVIE, "subscribers": [self.friend], "unfollowers": [self.friend, self.owner, recipient_key("-202")]}])
        rejoin = {"status": "watching", "movie": MOVIE}
        register_watch.save_registration(self.root, rejoin, self.friend)
        self.assertTrue(rejoin["was_dormant"])
        self.assertTrue(rejoin["membership_added"])
        self.assertTrue(rejoin["friend_started"])
        self.assertEqual(self.current_recipients(), ["101"])
        self.assertEqual(len(self.read("movies.json")), 1)

    def test_cancel_consumes_personal_confirmation_without_unfollowing(self):
        self.assertEqual(self.settle(self.friend, cancel=True)["status"], "cancelled")
        self.assertEqual(self.settle(self.friend)["status"], "duplicate")
        self.assertIn("101", self.current_recipients())
        pref = {}
        nonce = "p" * 22
        self.assertIn("Cancelled", telegram_reminders.confirmed_pause(pref, [], "all", nonce, NOW + 1000, NOW, cancel=True))
        self.assertIsNone(telegram_reminders.confirmed_pause(pref, [], "all", nonce, NOW + 1000, NOW))
        self.assertNotIn("stoppedAll", pref)

    def test_expired_and_unrecognized_do_not_write(self):
        before = self.read("state.json")
        self.assertEqual(tm.unfollow(self.root, self.friend, "paper-tiger", "a" * 22, NOW, now=NOW)["status"], "expired")
        with self.assertRaises(ValueError):
            self.settle(recipient_key("999"))
        self.assertEqual(self.read("state.json"), before)

    def test_implicit_george_membership_is_removed_and_preserved_on_rearm(self):
        slug = "george-michael-the-faith-tour"
        self.settle(self.friend, slug)
        self.assertEqual(self.current_recipients(1), ["201", "102"])
        row = self.read("movies.json")[1]
        movies, sold, state = [], [row], {"movies": {}}
        self.assertTrue(watcher.rearm_montreal_watch(movies, sold, state))
        self.assertEqual(movies[0]["unfollowers"], [self.friend])

    def test_only_private_owner_gets_notice_and_offer_only_if_following(self):
        response = self.settle(self.friend)
        sender = Mock()
        tm.notify_friend_change(self.root, response, "masked", sender)
        sender.assert_called_once()
        self.assertEqual(sender.call_args.args[1], "201")
        self.assertIn("Reply Stop too", sender.call_args.args[2])
        self.assertNotIn(self.friend, sender.call_args.args[2])
        self.assertNotIn("101", sender.call_args.args[2].split("Confirmation code:")[0])
        self.settle(self.owner, nonce="b" * 22)
        sender.reset_mock()
        tm.notify_friend_change(self.root, response, "masked", sender)
        self.assertNotIn("Reply Stop too", sender.call_args.args[2])
        sender.reset_mock()
        tm.notify_friend_change(self.root, {"status": "duplicate"}, "masked", sender)
        sender.assert_not_called()
        sender.side_effect = OSError("private text")
        with patch("sys.stderr", new=io.StringIO()) as log:
            tm.notify_friend_change(self.root, response, "masked", sender)
        self.assertIn("OSError", log.getvalue())
        self.assertNotIn("private text", log.getvalue())

    def test_ambiguous_admin_destination_never_fans_out(self):
        sender = Mock()
        with patch.dict(os.environ, {"TELEGRAM_RECIPIENTS": "201,202"}), patch("sys.stderr", new=io.StringIO()) as log:
            tm.notify_friend_change(self.root, {"status": "watching", "friend_started": True, "movie": MOVIE}, "masked", sender)
        sender.assert_not_called()
        self.assertIn("no unique private admin destination", log.getvalue())
        self.assertNotIn("201", log.getvalue())

    def test_pause_preferences_replay_does_not_reapply_after_resume(self):
        pref = {"remindersEnabled": False}
        nonce = "x" * 22
        reply = telegram_reminders.confirmed_pause(pref, [], "all", nonce, NOW + 1000, NOW)
        self.assertIn("stay on your list", reply)
        telegram_reminders.update_preference(pref, [], "start", "all")
        self.assertIsNone(telegram_reminders.confirmed_pause(pref, [], "all", nonce, NOW + 1000, NOW))
        self.assertFalse(pref["stoppedAll"])
        self.assertFalse(pref["remindersEnabled"])
