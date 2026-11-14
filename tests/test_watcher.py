import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError

import register_watch
import seat_watcher
import watcher
from notification_preferences import recipient_key, save_preferences
from watcher import sale_alert_chat_ids


GEORGE_MICHAEL_URL = "https://www.cineplex.com/movie/george-michael-the-faith-tour"
OTHER_MOVIE_URL = "https://www.cineplex.com/movie/the-odyssey"
FILM_ID = 61943
SESSION = {
    "vistaSessionId": 12345,
    "showStartDateTime": "2026-12-09T19:00:00",
    "isShowtimeEnabledOnline": True,
    "isSoldOut": False,
    "isInThePast": False,
}


def theatre(city="Montréal", theatre_id=9406):
    return {"theatreId": theatre_id, "theatreName": f"Cinema {city}", "location": {"city": city}}


def theatre_list(*theatres, group="otherTheatres"):
    result = {"favouriteTheatres": [], "nearbyTheatres": [], "otherTheatres": []}
    result[group] = list(theatres)
    return result


def showtimes(session=None, film_id=FILM_ID, theatre_id=9406):
    return [{"theatreId": theatre_id, "dates": [{"movies": [{
        "id": film_id, "experiences": [{"sessions": [session or dict(SESSION)]}],
    }]}]}]


def response(body, status=200):
    result = MagicMock()
    result.__enter__.return_value = result
    result.status = status
    result.read.return_value = body.encode()
    return result


def movie_result(url=GEORGE_MICHAEL_URL, on_sale=False):
    result = {"url": url, "name": "George Michael: The Faith Tour", "hasShowtimes": on_sale}
    if watcher.movie_slug(url) == watcher.GEORGE_MICHAEL_FAITH_TOUR_SLUG:
        result.update({"city": "Montréal", "nationalHasShowtimes": True, "showtime": None})
        if on_sale:
            result["showtime"] = {
                "theatreId": 9406, "theatreName": "Cinéma Banque Scotia Montréal",
                "showtimeId": SESSION["vistaSessionId"], "startsAt": SESSION["showStartDateTime"],
            }
    return result


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


class MontrealAvailabilityTest(unittest.TestCase):
    @patch("watcher.request_theatrical_json")
    def test_other_cities_do_not_trigger_or_request_dates(self, request):
        outside = theatre("Toronto", 7400)
        outside["theatreName"] = "Montreal named cinema in Toronto"
        request.return_value = theatre_list(outside, theatre("Laval", 9408))
        self.assertIsNone(watcher.find_city_showtime(FILM_ID, "Montréal"))
        self.assertEqual(request.call_count, 1)

    def test_city_match_accepts_accents_in_each_theatre_group(self):
        for group in ("favouriteTheatres", "nearbyTheatres", "otherTheatres"):
            with self.subTest(group=group), patch("watcher.request_theatrical_json") as request:
                request.side_effect = [theatre_list(theatre("Montreal"), group=group), ["2026-12-09T00:00:00"], showtimes()]
                result = watcher.find_city_showtime(FILM_ID, "Montréal")
                self.assertEqual(result["theatreId"], 9406)
                self.assertEqual(result["showtimeId"], SESSION["vistaSessionId"])
                self.assertEqual(request.call_args.args[1], {
                    "language": "en", "filmId": FILM_ID, "locationId": 9406, "date": "12/9/2026",
                })

    @patch("watcher.request_theatrical_json")
    def test_no_bookable_dates_does_not_request_showtimes(self, request):
        request.side_effect = [theatre_list(theatre()), []]
        self.assertIsNone(watcher.find_city_showtime(FILM_ID, "Montreal"))
        self.assertEqual(request.call_count, 2)

    def test_disabled_sold_out_past_and_missing_id_sessions_do_not_alert(self):
        for field, value in [("isShowtimeEnabledOnline", False), ("isSoldOut", True),
                             ("isInThePast", True), ("vistaSessionId", "")]:
            with self.subTest(field=field), patch("watcher.request_theatrical_json") as request:
                request.side_effect = [theatre_list(theatre()), ["2026-12-09T00:00:00"], showtimes({**SESSION, field: value})]
                self.assertIsNone(watcher.find_city_showtime(FILM_ID, "Montréal"))

    def test_unrelated_movie_or_theatre_is_not_accepted(self):
        for payload in (showtimes(film_id=99999), showtimes(theatre_id=7400)):
            with self.subTest(payload=payload), patch("watcher.request_theatrical_json") as request:
                request.side_effect = [theatre_list(theatre()), ["2026-12-09T00:00:00"], payload]
                self.assertIsNone(watcher.find_city_showtime(FILM_ID, "Montréal"))

    @patch("watcher.request_theatrical_json")
    def test_checks_later_dates_until_a_bookable_session_exists(self, request):
        request.side_effect = [theatre_list(theatre()), ["2026-12-09T00:00:00", "2026-12-11T00:00:00"], [], showtimes()]
        self.assertIsNotNone(watcher.find_city_showtime(FILM_ID, "Montréal"))
        self.assertEqual(request.call_args.args[1]["date"], "12/11/2026")

    @patch("watcher.request_theatrical_json")
    def test_malformed_data_is_a_check_error(self, request):
        request.return_value = {"unexpected": []}
        with self.assertRaisesRegex(ValueError, "unexpected format"):
            watcher.find_city_showtime(FILM_ID, "Montréal")

    @patch("watcher.request_theatrical_json")
    def test_network_failure_is_not_reported_as_no_tickets(self, request):
        request.side_effect = URLError("API unavailable")
        with self.assertRaises(URLError):
            watcher.find_city_showtime(FILM_ID, "Montréal")

    @patch("watcher.find_city_showtime", return_value=None)
    @patch("watcher.urlopen")
    def test_movie_page_national_flag_does_not_override_montreal(self, open_url, city_check):
        details = {"id": FILM_ID, "title": "George Michael: The Faith Tour", "hasShowtimes": True}
        open_url.return_value = response(f'<script id="__NEXT_DATA__">{json.dumps(details)}</script>')
        movie = watcher.get_movie(GEORGE_MICHAEL_URL + "?ic=cpx_search_grid&openTM=true")
        self.assertFalse(movie["hasShowtimes"])
        self.assertTrue(movie["nationalHasShowtimes"])
        self.assertEqual(movie["city"], "Montréal")
        city_check.assert_called_once_with(FILM_ID, "Montréal")

    @patch("watcher.find_city_showtime")
    @patch("watcher.urlopen")
    def test_other_movies_keep_the_existing_national_check(self, open_url, city_check):
        details = {"title": "The Odyssey", "hasShowtimes": True}
        open_url.return_value = response(f'<script id="__NEXT_DATA__">{json.dumps(details)}</script>')
        self.assertTrue(watcher.get_movie(OTHER_MOVIE_URL)["hasShowtimes"])
        city_check.assert_not_called()

    @patch("register_watch.get_movie", return_value=movie_result())
    @patch("register_watch.urlopen")
    def test_registration_accepts_watch_while_only_national_sales_exist(self, open_url, get_movie):
        open_url.return_value = response(f"<urlset><url><loc>{GEORGE_MICHAEL_URL}</loc></url></urlset>")
        self.assertEqual(register_watch.find_movie("George Michael: The Faith Tour")["status"], "watching")


class TheatricalResponseTest(unittest.TestCase):
    @patch("seat_watcher._discover_public_subscription_key")
    @patch("seat_watcher.request_json", return_value={})
    def test_normal_api_check_does_not_download_website_bundles(self, request, discover):
        seat_watcher.request_theatrical_json("theatres", {"language": "en", "filmId": FILM_ID})
        request.assert_called_once()
        discover.assert_not_called()

    @patch("seat_watcher._subscription_key_discovery_attempted", False)
    @patch("seat_watcher._discovered_subscription_key", "old-public-key")
    @patch("seat_watcher._discover_public_subscription_key", return_value="new-public-key")
    @patch("seat_watcher.request_json")
    def test_rejected_public_key_is_refreshed_once(self, request, discover):
        error = HTTPError("https://example.test", 401, "Unauthorized", {}, io.BytesIO())
        self.addCleanup(error.close)
        request.side_effect = [error, {}]
        self.assertEqual(seat_watcher.request_theatrical_json("theatres"), {})
        discover.assert_called_once()
        self.assertEqual(request.call_args.args[1]["Ocp-Apim-Subscription-Key"], "new-public-key")

    @patch("seat_watcher._subscription_key_discovery_attempted", False)
    @patch("seat_watcher._discover_public_subscription_key", return_value=None)
    @patch("seat_watcher.request_json")
    def test_unsuccessful_key_refresh_preserves_the_api_error(self, request, discover):
        error = HTTPError("https://example.test", 403, "Forbidden", {}, io.BytesIO())
        self.addCleanup(error.close)
        request.side_effect = error
        with self.assertRaises(HTTPError) as raised:
            seat_watcher.request_theatrical_json("theatres")
        self.assertIs(raised.exception, error)
        request.assert_called_once()

    @patch("seat_watcher.urlopen")
    def test_empty_showtime_response_is_an_empty_list(self, open_url):
        open_url.return_value = response("", status=204)
        self.assertEqual(seat_watcher.request_json("https://example.test/showtimes", response_type=list), [])

    @patch("seat_watcher.urlopen")
    def test_seat_metadata_still_requires_an_object(self, open_url):
        open_url.return_value = response("[]")
        with self.assertRaisesRegex(ValueError, "JSON object"):
            seat_watcher.request_json("https://example.test/seat-layout")

    @patch("seat_watcher.urlopen")
    def test_dates_require_an_array(self, open_url):
        open_url.return_value = response('{"error": "invalid request"}')
        with self.assertRaisesRegex(ValueError, "JSON array"):
            seat_watcher.request_json("https://example.test/dates", response_type=list)


class WatchLifecycleTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        patches = [
            patch.multiple(watcher, ROOT=self.root, MOVIES_FILE=self.root / "movies.json", STATE_FILE=self.root / "state.json", SALES_STARTED_FILE=self.root / "sales-started.json"),
            patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "test-token", "TELEGRAM_CHAT_IDS": "owner-id", "TELEGRAM_GEORGE_MICHAEL_ALERT_CHAT_IDS": "friend-id", "TELEGRAM_PREFERENCES_KEY": "test-secret"}, clear=True),
            patch("watcher.get_movie"), patch("watcher.send_telegram"),
            patch("sys.stdout", new=io.StringIO()), patch("sys.stderr", new=io.StringIO()),
        ]
        mocks = []
        for item in patches:
            mocks.append(item.start())
            self.addCleanup(item.stop)
        self.get_movie, self.send = mocks[2:4]
        self.get_movie.side_effect = lambda url: movie_result(url)
        save_preferences(self.root, {})

    def test_personal_stop_excludes_only_that_recipient_from_sale_alert(self):
        self.seed([{"url": GEORGE_MICHAEL_URL}])
        save_preferences(self.root, {recipient_key("friend-id"): {"stoppedWatches": [f"ticket:{watcher.GEORGE_MICHAEL_FAITH_TOUR_SLUG}"]}})
        self.get_movie.side_effect = lambda url: movie_result(url, on_sale=True)
        watcher.main()
        self.assertEqual(self.send.call_args.args[1], "owner-id")

    def test_everyone_opted_out_archives_the_sale_without_sending(self):
        self.seed([{"url": GEORGE_MICHAEL_URL}])
        save_preferences(self.root, {recipient_key(chat): {"stoppedAll": True} for chat in ("owner-id", "friend-id")})
        self.get_movie.side_effect = lambda url: movie_result(url, on_sale=True)
        watcher.main()
        self.send.assert_not_called()
        self.assertEqual(self.read("movies.json"), [])
        self.assertEqual(len(self.read("sales-started.json")), 1)

    def seed(self, movies, sales=None, state=None):
        for name, data in [("movies.json", movies), ("sales-started.json", sales or []), ("state.json", state or {"movies": {}})]:
            (self.root / name).write_text(json.dumps(data))

    def read(self, name):
        return json.loads((self.root / name).read_text())

    def test_old_national_alert_is_rearmed_then_alerts_once_for_montreal(self):
        key = watcher.GEORGE_MICHAEL_FAITH_TOUR_SLUG
        archived = {"url": GEORGE_MICHAEL_URL, "name": "George Michael: The Faith Tour", "salesStartedAt": "2026-11-11"}
        other_archive = {"url": OTHER_MOVIE_URL, "name": "The Odyssey", "salesStartedAt": "2026-11-01"}
        other_state = {"hasShowtimes": True, "alerted": True}
        self.seed([], [archived, other_archive], {"movies": {key: {"hasShowtimes": True, "alerted": True}, "the-odyssey": dict(other_state)}})
        watcher.main()
        self.send.assert_not_called()
        self.assertEqual([movie["url"] for movie in self.read("movies.json")], [GEORGE_MICHAEL_URL])
        self.assertEqual(self.read("sales-started.json"), [other_archive])
        saved = self.read("state.json")["movies"]
        self.assertFalse(saved[key]["hasShowtimes"])
        self.assertFalse(saved[key].get("alerted", False))
        self.assertEqual(saved["the-odyssey"], other_state)

        self.get_movie.side_effect = lambda url: movie_result(url, on_sale=True)
        watcher.main()
        self.send.assert_called_once()
        self.assertEqual(self.send.call_args.args[1], "owner-id,friend-id")
        self.assertIn("in Montréal", self.send.call_args.args[2])
        self.assertIn("Cinéma Banque Scotia Montréal", self.send.call_args.args[2])
        self.assertEqual(self.read("movies.json"), [])
        self.assertTrue(self.read("state.json")["movies"][key]["alerted"])
        watcher.main()
        self.send.assert_called_once()
        self.assertEqual(len(self.read("sales-started.json")), 2)

    def test_rearm_does_not_duplicate_an_active_watch(self):
        movie = {"url": GEORGE_MICHAEL_URL, "name": "George Michael"}
        self.seed([movie], [movie])
        watcher.main()
        self.assertEqual(self.read("movies.json"), [movie])
        self.assertEqual(self.read("sales-started.json"), [])

    def test_removed_watch_is_not_recreated(self):
        self.seed([])
        watcher.main()
        self.get_movie.assert_not_called()
        self.assertEqual(self.read("movies.json"), [])

    def test_api_failure_keeps_watch_and_continues_other_movies(self):
        movies = [{"url": GEORGE_MICHAEL_URL}, {"url": OTHER_MOVIE_URL}]
        self.seed(movies)
        self.get_movie.side_effect = [URLError("Cineplex unavailable"), movie_result(OTHER_MOVIE_URL)]
        watcher.main()
        self.assertEqual(self.read("movies.json"), movies)
        saved = self.read("state.json")["movies"]
        self.assertEqual(saved[watcher.GEORGE_MICHAEL_FAITH_TOUR_SLUG]["lastCheckStatus"], "failed")
        self.assertIn("Cineplex unavailable", saved[watcher.GEORGE_MICHAEL_FAITH_TOUR_SLUG]["lastError"])
        self.assertEqual(saved["the-odyssey"]["lastCheckStatus"], "success")
        self.send.assert_not_called()

    def test_telegram_failure_keeps_watch_and_continues_other_movies(self):
        self.seed([{"url": GEORGE_MICHAEL_URL}, {"url": OTHER_MOVIE_URL}])
        self.get_movie.side_effect = lambda url: movie_result(url, on_sale=True)
        self.send.side_effect = [URLError("Telegram unavailable"), None]
        watcher.main()
        self.assertEqual(self.read("movies.json"), [{"url": GEORGE_MICHAEL_URL}])
        saved = self.read("state.json")["movies"]
        self.assertIn("Telegram sale alert failed", saved[watcher.GEORGE_MICHAEL_FAITH_TOUR_SLUG]["lastError"])
        self.assertFalse(saved[watcher.GEORGE_MICHAEL_FAITH_TOUR_SLUG].get("alerted", False))
        self.assertTrue(saved["the-odyssey"]["alerted"])

    def test_missing_telegram_credentials_does_not_consume_the_watch(self):
        self.seed([{"url": GEORGE_MICHAEL_URL}])
        self.get_movie.side_effect = lambda url: movie_result(url, on_sale=True)
        with patch.dict(os.environ, {}, clear=True):
            watcher.main()
        self.assertEqual(self.read("movies.json"), [{"url": GEORGE_MICHAEL_URL}])
        self.assertEqual(self.read("sales-started.json"), [])
        self.send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
