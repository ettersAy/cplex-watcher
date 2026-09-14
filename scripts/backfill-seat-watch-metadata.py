#!/usr/bin/env python3
"""Fetch and save one Cineplex movie profile for every configured seat watch."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from seat_watcher import _read_json, _write_json, request_showtime_detail
from seat_watch_command import showtime_display_metadata, watch_movie_metadata


def main():
    config_path = ROOT / "seat-watches.json"
    config = _read_json(config_path, {"watches": {}})
    updated = 0
    for watch in config.get("watches", {}).values():
        showtimes = [(showtime_id, showtime) for showtime_id, showtime in watch.get("showtimes", {}).items() if showtime.get("enabled")]
        if not showtimes:
            continue
        showtime_id, showtime = showtimes[0]
        detail = request_showtime_detail(str(watch["theatreId"]), showtime_id)
        watch.update(watch_movie_metadata(detail))
        showtime.update(showtime_display_metadata(detail, str(watch["theatreId"]), showtime_id))
        updated += 1
    _write_json(config_path, config)
    print(f"Backfilled Cineplex metadata for {updated} seat watch(es).")


if __name__ == "__main__":
    main()
