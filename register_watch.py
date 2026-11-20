#!/usr/bin/env python3
"""Find one or more Cineplex movies for the GitHub Actions registration flow."""

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from watcher import get_movie
from notification_preferences import configured_recipients, telegram_chat_ids


SITEMAP_URL = "https://www.cineplex.com/dynamic-sitemap.xml"
USER_AGENT = "CineplexTicketWatcher/2.0 (personal ticket availability monitor)"


def normalise(value):
    return re.sub(r"[^a-z0-9]", "", value.lower())


def find_movie(title):
    query = normalise(title)
    if not query:
        return {"status": "error", "error": "Please provide a movie name. Example: /watch Runner"}

    request = Request(SITEMAP_URL, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=30) as response:
        sitemap = response.read().decode("utf-8")

    urls = re.findall(r"<loc>(.*?)</loc>", sitemap)
    candidates = [url for url in urls if "/movie/" in url and query in normalise(url.rsplit("/", 1)[-1])][:12]
    if not candidates:
        return {"status": "error", "error": f"I could not find a Cineplex movie matching “{title}”."}

    details = []
    for url in candidates:
        try:
            details.append(get_movie(url))
        except (HTTPError, URLError, ValueError, json.JSONDecodeError) as error:
            print(f"WARNING: Could not read {url}: {error}", file=sys.stderr)

    exact = next((movie for movie in details if normalise(movie["name"]) == query), None)
    if exact:
        return {"status": "already_on_sale" if exact["hasShowtimes"] else "watching", "movie": exact}

    matches = [movie for movie in details if query in normalise(movie["name"])]
    if len(matches) == 1:
        movie = matches[0]
        return {"status": "already_on_sale" if movie["hasShowtimes"] else "watching", "movie": movie}
    if len(matches) > 1:
        return {"status": "error", "error": "I found several matches. Send a more specific title:\n" + "\n".join(f"• {movie['name']}" for movie in matches)}
    return {"status": "error", "error": f"I could not confirm a Cineplex movie matching “{title}" + "”."}


def save_registration(root, registration, recipient_key=""):
    """Save one shared watch, plus the requesting friend's private subscription."""
    subscriber = ""
    if recipient_key:
        default, _, recipients = configured_recipients()
        if recipient_key not in recipients:
            raise ValueError("This recipient is not configured for watch notifications")
        if recipients[recipient_key] not in telegram_chat_ids(default):
            subscriber = recipient_key

    movies_path = root / "movies.json"
    sales_path = root / "sales-started.json"
    movies = json.loads(movies_path.read_text())
    sales = json.loads(sales_path.read_text()) if sales_path.exists() else []
    for result in registration.get("results", [registration]):
        if result["status"] not in ("watching", "already_on_sale"):
            continue
        movie = result["movie"]
        target = movies if result["status"] == "watching" else sales
        existing = next((entry for entry in target if entry["url"] == movie["url"]), None)
        if existing is None:
            existing = {"url": movie["url"], "name": movie["name"]}
            if result["status"] == "already_on_sale":
                existing["salesStartedAt"] = datetime.now(timezone.utc).isoformat()
            target.append(existing)
        elif result["status"] == "watching":
            result["status"] = "already_watching"
        if subscriber and subscriber not in existing.setdefault("subscribers", []):
            existing["subscribers"].append(subscriber)
            # A globally existing watch can still be new to this friend.
            if result["status"] == "already_watching":
                result["status"] = "watching"
    movies_path.write_text(json.dumps(movies, indent=2) + "\n")
    sales_path.write_text(json.dumps(sales, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("title", nargs="?")
    parser.add_argument("--many", help="Newline-separated movie titles to look up")
    args = parser.parse_args()

    def lookup(title):
        try:
            return find_movie(title)
        except (HTTPError, URLError, ValueError, json.JSONDecodeError) as error:
            return {"status": "error", "error": f"Cineplex search failed: {error}"}

    if args.many is not None:
        titles = [line.strip() for line in args.many.splitlines() if line.strip()]
        result = {"results": [lookup(title) for title in titles]}
    elif args.title:
        result = lookup(args.title)
    else:
        parser.error("provide a movie title or --many")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
