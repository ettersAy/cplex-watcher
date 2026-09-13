#!/usr/bin/env python3
"""Find one or more Cineplex movies for the GitHub Actions registration flow."""

import argparse
import json
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from watcher import get_movie


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
