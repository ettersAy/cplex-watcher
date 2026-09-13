#!/usr/bin/env python3
"""Check Cineplex ticket availability and notify Telegram on a change."""

import html
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).parent
MOVIES_FILE = ROOT / "movies.json"
STATE_FILE = ROOT / "state.json"
USER_AGENT = "CineplexTicketWatcher/1.0 (personal ticket availability monitor)"
# Cineplex serves this static Next.js data endpoint even when a hosted runner
# receives an anti-bot HTML page without __NEXT_DATA__. Update only if Cineplex
# changes its Next.js build and the fallback reports HTTP 404.
NEXT_BUILD_ID = "sutiBBvJ_DUSdtn7Z8k2n"


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
        slug = urlparse(url).path.rstrip("/").rsplit("/", 1)[-1]
        data_url = f"https://www.cineplex.com/next-static-files/_next/data/{NEXT_BUILD_ID}/movie/{slug}.json"
        fallback_request = Request(data_url, headers={"User-Agent": USER_AGENT})
        with urlopen(fallback_request, timeout=30) as response:
            details = find_movie_details(json.loads(response.read().decode("utf-8")))
    if not details:
        raise ValueError("Cineplex page did not contain movie ticket status")

    return {
        "name": details.get("title") or details.get("movieTitle") or url.rsplit("/", 1)[-1],
        "releaseDate": details.get("releaseDate"),
        "hasShowtimes": bool(details["hasShowtimes"]),
        "url": url,
    }


def send_telegram(token, chat_id, text):
    request_json(
        f"https://api.telegram.org/bot{token}/sendMessage",
        {"chat_id": chat_id, "text": text, "disable_web_page_preview": "true"},
    )


def main():
    movies = json.loads(MOVIES_FILE.read_text())
    state = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {"movies": {}}
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")
    can_notify = bool(token and chat_id)
    changed = False

    for movie in movies:
        url = movie["url"]
        key = url.rsplit("/", 1)[-1]
        previous = state["movies"].get(key, {})
        try:
            current = get_movie(url)
        except (HTTPError, URLError, ValueError, json.JSONDecodeError) as error:
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
            continue

        status = "Started" if current["hasShowtimes"] else "Not Yet"
        print(f"{current['name']}: {status}")

        # Send one alert only. This also alerts if tickets were already on sale
        # when Telegram is connected for the first time.
        if current["hasShowtimes"] and not previous.get("alerted"):
            if can_notify:
                send_telegram(
                    token,
                    chat_id,
                    "Tickets are now on sale!\n\n"
                    f"{current['name']}\n"
                    f"Release date: {current['releaseDate'] or 'Unknown'}\n"
                    f"{current['url']}",
                )
                previous["alerted"] = True
                print("  Telegram alert sent")
            else:
                print("  Tickets are available, but Telegram secrets are not set yet")

        previous.update(current)
        previous["lastCheckedAt"] = datetime.now(timezone.utc).isoformat()
        previous["lastCheckStatus"] = "success"
        previous.pop("lastError", None)
        state["movies"][key] = previous
        changed = True

    if changed:
        STATE_FILE.write_text(json.dumps(state, indent=2) + "\n")


if __name__ == "__main__":
    main()
