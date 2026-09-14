#!/usr/bin/env python3
"""Read-only proof that Cineplex showtime metadata can be discovered automatically.

Usage: python3 scripts/check-showtime-detail.py 9406 405853
"""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from seat_watcher import request_showtime_detail


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("theatre_id")
    parser.add_argument("showtime_id")
    args = parser.parse_args()
    detail = request_showtime_detail(args.theatre_id, args.showtime_id)
    showtime = detail.get("showtime", {})
    print({
        "theatreId": detail.get("theatreId"),
        "showtimeId": showtime.get("vistaSessionId"),
        "showDate": detail.get("showDate"),
        "showStartDateTime": showtime.get("showStartDateTime"),
    })


if __name__ == "__main__":
    main()
