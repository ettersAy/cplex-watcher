#!/usr/bin/env python3
"""Check Cineplex ticket availability and notify Telegram on a change."""

import html
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

from seat_watcher import request_theatrical_json
from notification_preferences import load_preferences, notification_chat_ids

ROOT = Path(__file__).parent
MOVIES_FILE = ROOT / "movies.json"
SALES_STARTED_FILE = ROOT / "sales-started.json"
STATE_FILE = ROOT / "state.json"
USER_AGENT = "CineplexTicketWatcher/1.0 (personal ticket availability monitor)"
# Cineplex serves this static Next.js data endpoint even when a hosted runner
# receives an anti-bot HTML page without __NEXT_DATA__. Update only if Cineplex
# changes its Next.js build and the fallback reports HTTP 404.
NEXT_BUILD_ID = "dMZo1h-2zVfKeg1QAE-PC"
GEORGE_MICHAEL_FAITH_TOUR_SLUG = "george-michael-the-faith-tour"
MONTREAL_CITY = "Montréal"


def movie_slug(url):
    return urlparse(url).path.rstrip("/").rsplit("/", 1)[-1]


def city_key(value):
    return unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().strip().casefold()


def find_bookable_session(showtimes, film_id, theatre_id):
    for block in showtimes:
        if str(block["theatreId"]) != str(theatre_id):
            continue
        for date_block in block["dates"]:
            for film in date_block["movies"]:
                if str(film["id"]) != str(film_id):
                    continue
                for experience in film["experiences"]:
                    for session in experience["sessions"]:
                        if (session["isShowtimeEnabledOnline"] is True
                                and session["vistaSessionId"]
                                and session["isSoldOut"] is False
                                and session["isInThePast"] is False):
                            return session
    return None


def find_city_showtime(film_id, city):
    """Return the first bookable session in the city, or None after a valid empty check."""
    params = {"language": "en", "filmId": film_id}
    theatres = request_theatrical_json("theatres", params)
    try:
        for group in ("favouriteTheatres", "nearbyTheatres", "otherTheatres"):
            for theatre in theatres[group]:
                if city_key(theatre["location"]["city"]) != city_key(city):
                    continue
                theatre_params = {**params, "locationId": theatre["theatreId"]}
                dates = request_theatrical_json("dates/bookable", theatre_params, response_type=list)
                for date in dates:
                    day = datetime.fromisoformat(date)
                    shows = request_theatrical_json("showtimes", {
                        **theatre_params, "date": f"{day.month}/{day.day}/{day.year}",
                    }, response_type=list)
                    session = find_bookable_session(shows, film_id, theatre["theatreId"])
                    if session:
                        return {
                            "theatreId": theatre["theatreId"],
                            "theatreName": theatre["theatreName"],
                            "showtimeId": session["vistaSessionId"],
                            "startsAt": session["showStartDateTime"],
                        }
    except (KeyError, TypeError) as error:
        raise ValueError(f"Cineplex city-showtime response has an unexpected format: {error}") from error
    return None


def request_json(url, data=None):
    payload = urlencode(data).encode() if data else None
    request = Request(url, data=payload, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def find_movie_details(value):
    """Return the first object containing Cineplex's movie status fields."""
    if isinstance(value, dict):
        if "hasShowtimes" in value and ("releaseDate" in value or "title" in value):
            return value
        for child in value.values():
            found = find_movie_details(child)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_movie_details(child)
            if found:
                return found
    return None


def get_movie(url):
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=30) as response:
        page = response.read().decode("utf-8")

    match = re.search(
        r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>',
        page,
        flags=re.DOTALL | re.IGNORECASE,
    )
    if match:
        details = find_movie_details(json.loads(html.unescape(match.group(1))))
    else:
        slug = movie_slug(url)
        data_url = f"https://www.cineplex.com/next-static-files/_next/data/{NEXT_BUILD_ID}/movie/{slug}.json"
        fallback_request = Request(data_url, headers={"User-Agent": USER_AGENT})
        with urlopen(fallback_request, timeout=30) as response:
            details = find_movie_details(json.loads(response.read().decode("utf-8")))
    if not details:
        raise ValueError("Cineplex page did not contain movie ticket status")

    movie = {
        "name": details.get("title") or details.get("movieTitle") or url.rsplit("/", 1)[-1],
        "releaseDate": details.get("releaseDate"),
        "hasShowtimes": bool(details["hasShowtimes"]),
        "url": url,
    }
    if movie_slug(url) == GEORGE_MICHAEL_FAITH_TOUR_SLUG:
        if not details.get("id"):
            raise ValueError("Cineplex movie details did not contain a film ID for the Montréal check")
        showtime = find_city_showtime(details["id"], MONTREAL_CITY)
        movie.update({
            "city": MONTREAL_CITY,
            "nationalHasShowtimes": movie["hasShowtimes"],
            "hasShowtimes": showtime is not None,
            "showtime": showtime,
        })
    return movie


def rearm_montreal_watch(movies, sales_started, state):
    """Replace the old national result once; respect later completion or removal."""
    key = GEORGE_MICHAEL_FAITH_TOUR_SLUG
    if state["movies"].get(key, {}).get("city") == MONTREAL_CITY:
        return False
    existing = next((movie for movie in movies + sales_started if movie_slug(movie["url"]) == key), None)
    if existing is None:
        return False
    if not any(movie_slug(movie["url"]) == key for movie in movies):
        movies.append({"url": existing["url"], "name": existing["name"]})
    sales_started[:] = [movie for movie in sales_started if movie_slug(movie["url"]) != key]
    state["movies"][key] = {"city": MONTREAL_CITY}
    print("Rearmed George Michael for Montréal ticket sales")
    return True


def telegram_chat_ids(value):
    """Return distinct chat IDs from a comma- or whitespace-separated secret."""
    return list(dict.fromkeys(chat_id for chat_id in re.split(r"[\s,]+", value or "") if chat_id))


def sale_alert_chat_ids(url, default_chat_ids, george_michael_chat_ids):
    """Return normal recipients plus George Michael's private alert recipient."""
    recipients = telegram_chat_ids(default_chat_ids)
    slug = movie_slug(url)
    if slug == GEORGE_MICHAEL_FAITH_TOUR_SLUG:
        recipients.extend(telegram_chat_ids(george_michael_chat_ids))
    return list(dict.fromkeys(recipients))


def send_telegram(token, chat_ids, text, parse_mode=None):
    for chat_id in telegram_chat_ids(chat_ids):
        data = {"chat_id": chat_id, "text": text, "disable_web_page_preview": "true"}
        if parse_mode:
            data["parse_mode"] = parse_mode
        request_json(f"https://api.telegram.org/bot{token}/sendMessage", data)


def main():
    movies = json.loads(MOVIES_FILE.read_text())
    preferences = load_preferences(ROOT)
    sales_started = json.loads(SALES_STARTED_FILE.read_text()) if SALES_STARTED_FILE.exists() else []
    state = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {"movies": {}}
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_ids = os.getenv("TELEGRAM_RECIPIENTS") or os.getenv("TELEGRAM_CHAT_IDS") or os.getenv("TELEGRAM_CHAT_ID")
    george_michael_chat_ids = os.getenv("TELEGRAM_GEORGE_MICHAEL_ALERT_CHAT_IDS")
    changed = rearm_montreal_watch(movies, sales_started, state)
    active_movies = []

    for movie in movies:
        url = movie["url"]
        key = movie_slug(url)
        previous = state["movies"].get(key, {})
        try:
            current = get_movie(url)
        except (HTTPError, URLError, TimeoutError, ValueError) as error:
            print(f"WARNING: Could not check {url}: {error}", file=sys.stderr)
            previous.update({
                "name": movie.get("name") or previous.get("name") or key,
                "url": url,
                "lastCheckedAt": datetime.now(timezone.utc).isoformat(),
                "lastCheckStatus": "failed",
                "lastError": str(error),
            })
            state["movies"][key] = previous
            changed = True
            active_movies.append(movie)
            continue

        status = "Started" if current["hasShowtimes"] else "Not Yet"
        location = f" in {current['city']}" if current.get("city") else ""
        print(f"{current['name']}{location}: {status}")

        previous.update(current)
        previous["lastCheckedAt"] = datetime.now(timezone.utc).isoformat()
        previous["lastCheckStatus"] = "success"
        previous.pop("lastError", None)
        state["movies"][key] = previous
        changed = True

        # Send one alert only. This also alerts if tickets were already on sale
        # when Telegram is connected for the first time.
        if current["hasShowtimes"] and not previous.get("alerted"):
            alert_chat_ids = sale_alert_chat_ids(url, chat_ids, george_michael_chat_ids)
            try:
                if not token or not alert_chat_ids:
                    raise ValueError("Telegram alert credentials are missing; keeping the watch for retry")
                alert_chat_ids = notification_chat_ids(alert_chat_ids, f"ticket:{key}", preferences)
                message = ("Go run buy your ticket for the movie "
                           f"<a href=\"{html.escape(current['url'], quote=True)}\">{html.escape(current['name'])}</a>{html.escape(location)}.")
                showtime = current.get("showtime")
                if showtime:
                    when = datetime.fromisoformat(showtime["startsAt"]).strftime("%b %d at %I:%M %p")
                    message += f"\n{html.escape(showtime['theatreName'])} · {when}"
                if alert_chat_ids:
                    send_telegram(
                        token,
                        ",".join(alert_chat_ids),
                        message,
                        parse_mode="HTML",
                    )
            except (HTTPError, URLError, TimeoutError, ValueError) as error:
                previous["lastCheckStatus"] = "failed"
                previous["lastError"] = f"Telegram sale alert failed: {error}"
                print(f"WARNING: watcher.main could not notify for {url}: {error}", file=sys.stderr)
                active_movies.append(movie)
                continue
            previous["alerted"] = True
            print("  Telegram alert sent" if alert_chat_ids else "  All recipients opted out; no alert sent")

        if current["hasShowtimes"]:
            if not any(existing["url"] == url for existing in sales_started):
                sales_started.append({
                    "url": url,
                    "name": current["name"],
                    "salesStartedAt": previous["lastCheckedAt"],
                })
                print("  Moved to sales-started list")
            continue

        active_movies.append(movie)

    if changed:
        MOVIES_FILE.write_text(json.dumps(active_movies, indent=2) + "\n")
        SALES_STARTED_FILE.write_text(json.dumps(sales_started, indent=2) + "\n")
        STATE_FILE.write_text(json.dumps(state, indent=2) + "\n")


if __name__ == "__main__":
    main()
