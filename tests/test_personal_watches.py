"""Supplementary, no-network regressions for friends' personal ticket watches."""
import json
import os
import tempfile
import textwrap
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock, patch

import register_watch
import telegram_reminders
import watcher
from notification_preferences import configured_recipients, recipient_key, save_preferences


ROOT = Path(__file__).resolve().parents[1]
MOVIE = {"url": "https://www.cineplex.com/movie/paper-tiger", "name": "Paper Tiger"}
OTHER = {"url": "https://www.cineplex.com/movie/the-odyssey", "name": "The Odyssey"}


class PersonalWatchesTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        environment = patch.dict(os.environ, {
            "TELEGRAM_PREFERENCES_KEY": "test-secret", "TELEGRAM_BOT_TOKEN": "test-token",
            "TELEGRAM_RECIPIENTS": "owner-id",
            "TELEGRAM_GEORGE_MICHAEL_ALERT_CHAT_IDS": "friend-id,second-friend-id",
        }, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.owner = recipient_key("owner-id")
        self.friend = recipient_key("friend-id")
        self.second = recipient_key("second-friend-id")
        self.write("movies.json", [OTHER])
        self.write("sales-started.json", [])
        self.write("state.json", {"movies": {}})
        self.write("seat-watches.json", {"watches": {}})
        save_preferences(self.root, {self.owner: {}, self.friend: {}, self.second: {}})

    def write(self, name, value):
        (self.root / name).write_text(json.dumps(value))

    def read(self, name):
        return json.loads((self.root / name).read_text())

    def register(self, key=None, status="watching"):
        result = {"status": status, "movie": MOVIE}
        register_watch.save_registration(self.root, result, self.friend if key is None else key)
        return result

    def test_friend_adds_one_shared_watch_and_owner_receives_it(self):
        self.assertEqual(self.register()["status"], "watching")
        movies = self.read("movies.json")
        self.assertEqual(movies[0], OTHER)
        self.assertEqual(movies[1]["subscribers"], [self.friend])
        self.assertEqual(watcher.sale_alert_chat_ids(MOVIE["url"], "owner-id", "friend-id,second-friend-id", movies[1]["subscribers"]), ["owner-id", "friend-id"])
        raw = (self.root / "movies.json").read_text()
        self.assertNotIn("friend-id", raw)
        self.assertNotIn("test-secret", raw)

    def test_existing_shared_watch_can_be_new_to_each_friend(self):
        self.write("movies.json", [MOVIE, OTHER])
        self.assertEqual(self.register()["status"], "watching")
        self.assertEqual(self.register()["status"], "already_watching")
        self.assertEqual(self.register(self.second)["status"], "watching")
        movies = self.read("movies.json")
        self.assertEqual(len(movies), 2)
        self.assertEqual(movies[0]["subscribers"], [self.friend, self.second])

    def test_owner_and_web_additions_do_not_subscribe_friends(self):
        self.register(self.owner)
        self.register("")
        movie = self.read("movies.json")[1]
        self.assertNotIn("subscribers", movie)
        self.assertEqual(watcher.sale_alert_chat_ids(MOVIE["url"], "owner-id", "friend-id"), ["owner-id"])

    def test_unknown_recipient_cannot_modify_shared_watches(self):
        with self.assertRaisesRegex(ValueError, "not configured"):
            self.register(recipient_key("stranger-id"))
        self.assertEqual(self.read("movies.json"), [OTHER])
        self.assertEqual(self.read("sales-started.json"), [])

    def test_initialization_revokes_removed_accounts_and_keeps_current_preferences(self):
        save_preferences(self.root, {self.friend: {"stoppedAll": True}, recipient_key("removed-id"): {}})
        with patch("sys.argv", ["telegram_reminders.py", "initialize", "--root", str(self.root)]):
            telegram_reminders.main()
        saved = self.read("notification-preferences.json")["recipients"]
        self.assertEqual(set(saved), {self.owner, self.friend, self.second})
        self.assertEqual(saved[self.friend], {"stoppedAll": True})

    def test_on_sale_movie_is_added_to_personal_history_only(self):
        self.register(status="already_on_sale")
        self.register(status="already_on_sale")
        self.assertEqual(self.read("movies.json"), [OTHER])
        sales = self.read("sales-started.json")
        self.assertEqual(len(sales), 1)
        self.assertEqual(sales[0]["subscribers"], [self.friend])

    def test_sale_sends_to_owner_and_subscriber_and_preserves_history(self):
        self.register()
        # Another friend can register after sales begin, before the checker archives it.
        self.write("sales-started.json", [{**MOVIE, "subscribers": [self.second]}])
        with patch.multiple(watcher, ROOT=self.root, MOVIES_FILE=self.root / "movies.json",
                            SALES_STARTED_FILE=self.root / "sales-started.json", STATE_FILE=self.root / "state.json"), \
                patch.object(watcher, "get_movie", side_effect=lambda url: {"url": url, "name": "Movie", "hasShowtimes": url == MOVIE["url"]}), \
                patch.object(watcher, "send_telegram") as send:
            watcher.main()
        self.assertEqual(send.call_args.args[1], "owner-id,friend-id")
        self.assertEqual(self.read("movies.json"), [OTHER])
        self.assertEqual(self.read("sales-started.json")[0]["subscribers"], [self.second, self.friend])

    def test_reminders_and_stop_remain_personal(self):
        self.register()
        default, special, recipients = configured_recipients()
        now = datetime(2026, 11, 21, 12, tzinfo=telegram_reminders.MONTREAL)
        watches = telegram_reminders.active_watches(self.root, default, special, now)
        preferences = {key: {} for key in recipients}
        send = Mock()
        telegram_reminders.send_reminders(preferences, recipients, watches, "test-token", now, send)
        messages = {call.args[1]: call.args[2] for call in send.call_args_list}
        self.assertIn("Paper Tiger", messages["owner-id"])
        self.assertIn("The Odyssey", messages["owner-id"])
        self.assertIn("Paper Tiger", messages["friend-id"])
        self.assertNotIn("The Odyssey", messages["friend-id"])
        self.assertNotIn("second-friend-id", messages)
        personal = [watch for watch in watches if "friend-id" in watch["recipients"]]
        telegram_reminders.update_preference(preferences[self.friend], personal, "stop", "Paper Tiger")
        self.assertEqual(preferences[self.owner].get("stoppedWatches", []), [])
        self.assertEqual(watcher.notification_chat_ids(["owner-id", "friend-id"], "ticket:paper-tiger", preferences), ["owner-id"])
        self.assertEqual(len(self.read("movies.json")), 2)

    def test_actual_workflow_reply_requires_saved_state_and_reports_paused_alerts(self):
        workflow = (ROOT / ".github/workflows/check-tickets.yml").read_text()
        self.assertLess(workflow.index("- name: Save alert state"), workflow.index("- name: Send registration result"))
        step = workflow.split("- name: Send registration result to Telegram", 1)[1].split("- name: Send removal result", 1)[0]
        source = textwrap.dedent(step.split("python - <<'PY'\n", 1)[1].rsplit("          PY", 1)[0])
        self.write("registration.json", {"status": "watching", "movie": MOVIE})
        save_preferences(self.root, {self.friend: {"stoppedAll": True}})
        old_cwd = Path.cwd()
        try:
            os.chdir(self.root)
            with patch.dict(os.environ, {"RECIPIENT_KEY": self.friend, "REGISTRATION_SAVED": "true"}), patch.object(watcher, "send_telegram") as send:
                exec(compile(source, "check-tickets.yml reply", "exec"), {})
                self.assertEqual(send.call_args.args[1], "friend-id")
                self.assertIn("Started watching Paper Tiger", send.call_args.args[2])
                self.assertIn("alerts are paused", send.call_args.args[2])
                self.assertIn("/start all", send.call_args.args[2])
                os.environ["REGISTRATION_SAVED"] = "false"
                exec(compile(source, "check-tickets.yml reply", "exec"), {})
                self.assertIn("could not save", send.call_args.args[2])
                self.assertNotIn("Started watching", send.call_args.args[2])
        finally:
            os.chdir(old_cwd)


if __name__ == "__main__":
    unittest.main()
