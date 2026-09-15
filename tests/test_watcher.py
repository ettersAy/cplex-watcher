import unittest

from watcher import sale_alert_chat_ids


GEORGE_MICHAEL_URL = "https://www.cineplex.com/movie/george-michael-the-faith-tour"
OTHER_MOVIE_URL = "https://www.cineplex.com/movie/the-odyssey"


class SaleAlertChatIdsTest(unittest.TestCase):
    def test_george_michael_adds_its_private_recipient(self):
        self.assertEqual(
            sale_alert_chat_ids(GEORGE_MICHAEL_URL, "owner-id", "friend-id"),
            ["owner-id", "friend-id"],
        )

    def test_other_movies_do_not_add_george_michael_recipient(self):
        self.assertEqual(
            sale_alert_chat_ids(OTHER_MOVIE_URL, "owner-id", "friend-id"),
            ["owner-id"],
        )

    def test_duplicate_recipient_is_sent_once(self):
        self.assertEqual(
            sale_alert_chat_ids(GEORGE_MICHAEL_URL, "owner-id,friend-id", "friend-id"),
            ["owner-id", "friend-id"],
        )


if __name__ == "__main__":
    unittest.main()
