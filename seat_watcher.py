#!/usr/bin/env python3
"""Pure helpers for Cineplex seat-watch selection, state, and rendering.

Network and GitHub Actions orchestration deliberately live outside these helpers
so the data contract can be tested without calling Cineplex or Telegram.
"""

from __future__ import annotations

import html
import json
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


SEAT_SECTION_NAMES = ("standardSeats", "dboxSeats", "balconySeats")
SEAT_LABEL_PATTERN = re.compile(r"^([A-Z]+)(\d+)$")
USER_AGENT = "CineplexTicketWatcher/1.0 (personal ticket availability monitor)"
THEATRICAL_BASE_URL = "https://apis.cineplex.com/prod/cpx/theatrical/api/v1"
CINEPLEX_HOME_URL = "https://www.cineplex.com/"
_discovered_subscription_key = None
_subscription_key_discovery_attempted = False


def parse_rule(value: str) -> dict[str, list[list[int]]]:
    """Parse `E9-E17, F14-F23` into the committed rule shape."""
    result: dict[str, list[list[int]]] = {}
    seen: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for item in value.split(","):
        match = re.fullmatch(r"\s*([A-Za-z]+)\s*(\d+)\s*-\s*([A-Za-z]+)\s*(\d+)\s*", item)
        if not match:
            raise ValueError("Seat ranges must look like E9-E17.")
        start_row, start, end_row, end = match.groups()
        row = start_row.upper()
        if row != end_row.upper():
            raise ValueError("A seat range cannot cross rows.")
        start_number, end_number = int(start), int(end)
        if start_number <= 0 or end_number <= 0 or start_number > end_number:
            raise ValueError("Seat ranges must use positive ascending numbers.")
        for previous_start, previous_end in seen[row]:
            if start_number <= previous_end and end_number >= previous_start:
                raise ValueError(f"Overlapping seat range for row {row}.")
        seen[row].append((start_number, end_number))
        result.setdefault(row, []).append([start_number, end_number])
    if not result:
        raise ValueError("Provide at least one seat range.")
    return result


def is_selected_label(label: str, rule: dict[str, list[list[int]]]) -> bool:
    match = SEAT_LABEL_PATTERN.fullmatch(label or "")
    if not match:
        return False
    row, value = match.groups()
    return any(start <= int(value) <= end for start, end in rule.get(row, []))


def select_seats(layout: dict, rule: dict[str, list[list[int]]]) -> dict[str, dict[str, str]]:
    """Return selected API IDs keyed by ID, using visible `seat.label` only."""
    selected: dict[str, dict[str, str]] = {}
    for section_name in SEAT_SECTION_NAMES:
        for row in layout.get(section_name, {}).get("rows", []):
            for seat in row.get("seats", []):
                seat_id = seat.get("id")
                label = seat.get("label")
                if isinstance(seat_id, str) and isinstance(label, str) and is_selected_label(label, rule):
                    selected[seat_id] = {"label": label, "type": seat.get("type", "Unknown")}
    return selected


def watch_seat_key(watch_name: str, theatre_id: str, showtime_id: str, seat_id: str) -> str:
    return "|".join((watch_name, theatre_id, showtime_id, seat_id))


def apply_available_seats(
    available_list: dict,
    *,
    watch_name: str,
    theatre_id: str,
    showtime_id: str,
    selected_seats: dict[str, dict[str, str]],
    seat_availabilities: dict[str, str],
    checked_at: str | None = None,
) -> tuple[list[dict[str, str]], dict]:
    """Return new available seats and the next de-duplication list.

    This function is only called after a successful availability response.
    """
    checked_at = checked_at or datetime.now(timezone.utc).isoformat()
    next_list = dict(available_list)
    currently_available = {
        seat_id
        for seat_id in selected_seats
        if seat_availabilities.get(seat_id) == "Available"
    }
    new_seats: list[dict[str, str]] = []
    for seat_id in sorted(currently_available, key=lambda value: selected_seats[value]["label"]):
        key = watch_seat_key(watch_name, theatre_id, showtime_id, seat_id)
        if key not in next_list:
            entry = {
                "watchName": watch_name,
                "theatreId": theatre_id,
                "showtimeId": showtime_id,
                "seatId": seat_id,
                "seatLabel": selected_seats[seat_id]["label"],
                "availableSince": checked_at,
            }
            next_list[key] = entry
            new_seats.append(entry)
    prefix = f"{watch_name}|{theatre_id}|{showtime_id}|"
    for key in list(next_list):
        if key.startswith(prefix) and next_list[key]["seatId"] not in currently_available:
            del next_list[key]
    return new_seats, next_list


def preview_url(theatre_id: str, showtime_id: str) -> str:
    return f"https://www.cineplex.com/ticketing/preview?theatreId={theatre_id}&showtimeId={showtime_id}"


def grouped_alert_html(watch_name: str, theatre_id: str, showtime_id: str, seats: list[dict[str, str]]) -> str:
    """Build one safe Telegram HTML alert for all new seats in a showtime."""
    rows: dict[str, list[int]] = defaultdict(list)
    for seat in seats:
        match = SEAT_LABEL_PATTERN.fullmatch(seat["seatLabel"])
        if match:
            rows[match.group(1)].append(int(match.group(2)))
    details = "\n".join(f"{row}: " + ", ".join(map(str, sorted(numbers))) for row, numbers in sorted(rows.items()))
    return (
        f"🎟 <b>{html.escape(watch_name)}</b> — new seats available\n"
        f"Theatre #{html.escape(theatre_id)} · "
        f"<a href=\"{html.escape(preview_url(theatre_id, showtime_id), quote=True)}\">#{html.escape(showtime_id)}</a>\n"
        f"{details}"
    )


def _read_json(path: Path, default):
    return json.loads(path.read_text()) if path.exists() else default


def _write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")


def request_json(url: str, headers: dict[str, str] | None = None) -> dict:
    request = Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urlopen(request, timeout=30) as response:
        value = json.loads(response.read().decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Cineplex response must be a JSON object")
    return value


def layout_url(theatre_id: str, showtime_id: str) -> str:
    return f"https://apis.cineplex.com/prod/ticketing/api/v1/theatre/{theatre_id}/showtime/{showtime_id}/seat-layout"


def availability_url(theatre_id: str, showtime_id: str) -> str:
    return f"https://apis.cineplex.com/prod/ticketing/api/v1/theatre/{theatre_id}/showtime/{showtime_id}/seat-availability"


def showtime_detail_url(theatre_id: str, showtime_id: str) -> str:
    """Return Cineplex's one-time metadata endpoint for a known showtime."""
    return f"{THEATRICAL_BASE_URL}/theatres/{theatre_id}/showtimes/{showtime_id}"


def _request_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def _public_chunk_urls(page: str) -> list[str]:
    urls = []
    for value in re.findall(r'''["']([^"']*_next/static/[^"']*?\.js)["']''', page):
        url = urljoin(CINEPLEX_HOME_URL, value)
        if url not in urls:
            urls.append(url)
    return urls


def _extract_public_subscription_key(source: str) -> str | None:
    """Read Cineplex's currently public browser header without persisting it."""
    anchor = "apis.cineplex.com/prod/cpx/theatrical/api"
    for match in re.finditer(re.escape(anchor), source):
        start = max(0, match.start() - 600)
        end = match.end() + 600
        key = re.search(r'''Ocp-Apim-Subscription-Key"?\s*:\s*"([0-9a-f]{32})"''', source[start:end], re.I)
        if key:
            return key.group(1)
    return None


def _discover_public_subscription_key() -> str | None:
    try:
        page = _request_text(CINEPLEX_HOME_URL)
        for url in _public_chunk_urls(page)[:30]:
            try:
                key = _extract_public_subscription_key(_request_text(url))
                if key:
                    return key
            except (HTTPError, URLError, UnicodeDecodeError):
                continue
    except (HTTPError, URLError, UnicodeDecodeError):
        return None
    return None


def request_showtime_detail(theatre_id: str, showtime_id: str) -> dict:
    """Fetch display metadata once while registering a showtime, never while scanning."""
    global _discovered_subscription_key, _subscription_key_discovery_attempted
    if not _subscription_key_discovery_attempted:
        _subscription_key_discovery_attempted = True
        _discovered_subscription_key = _discover_public_subscription_key()
    if not _discovered_subscription_key:
        raise ValueError("Could not retrieve Cineplex's public showtime-date configuration")
    return request_json(
        showtime_detail_url(theatre_id, showtime_id),
        {"Ocp-Apim-Subscription-Key": _discovered_subscription_key},
    )


def montreal_timestamp(value: datetime | None = None) -> str:
    from zoneinfo import ZoneInfo

    return (value or datetime.now(timezone.utc)).astimezone(ZoneInfo("America/Toronto")).strftime("%y-%m-%d %H:%M:%S")


def append_log(path: Path, level: str, message: str) -> None:
    lines = path.read_text().splitlines() if path.exists() else []
    lines.append(f"[{montreal_timestamp()}] [{level}] {message}")
    path.write_text("\n".join(lines[-1000:]) + "\n")


def _showtime_prefix(watch_name: str, theatre_id: str, showtime_id: str) -> str:
    return f"{watch_name}|{theatre_id}|{showtime_id}|"


def _remove_showtime_entries(available_list: dict, watch_name: str, theatre_id: str, showtime_id: str) -> None:
    prefix = _showtime_prefix(watch_name, theatre_id, showtime_id)
    for key in [key for key in available_list if key.startswith(prefix)]:
        del available_list[key]


def _validate_availability(value: dict) -> dict[str, str]:
    seats = value.get("seatAvailabilities")
    if not isinstance(seats, dict) or any(not isinstance(key, str) or not isinstance(status, str) for key, status in seats.items()):
        raise ValueError("Cineplex availability response has an invalid seatAvailabilities object")
    return seats


def _fetch_with_retry(fetch_json, url: str, *, sleep=time.sleep, attempts: int = 3) -> dict:
    """Retry only transient network and HTTP service failures."""
    for attempt in range(1, attempts + 1):
        try:
            return fetch_json(url)
        except HTTPError as error:
            transient = error.code == 429 or error.code >= 500
            if not transient or attempt == attempts:
                raise
        except URLError:
            if attempt == attempts:
                raise
        sleep(0.25 * attempt)
    raise RuntimeError("unreachable retry state")


def scan_all(root: Path, *, fetch_json=request_json, notify=None, sleep=time.sleep) -> dict:
    """Scan enabled watches, persist state, and return a safe result summary.

    `fetch_json` and `notify` are injected by tests. `notify(text)` must raise on
    delivery failure; an alert failure is logged but does not erase seat state.
    """
    config_path = root / "seat-watches.json"
    state_path = root / "seat-watch-state.json"
    available_path = root / "available-seat-list.json"
    log_path = root / "seat-watch.log"
    config = _read_json(config_path, {"watches": {}})
    state = _read_json(state_path, {"watches": {}})
    available_list = _read_json(available_path, {})
    if not isinstance(config.get("watches"), dict):
        raise ValueError("seat-watches.json must contain a watches object")
    append_log(log_path, "info", "seat watcher scan started")
    result = {"watches": 0, "showtimes": 0, "failures": 0, "newSeats": 0}

    for watch_id, watch in config["watches"].items():
        if not watch.get("enabled"):
            continue
        result["watches"] += 1
        theatre_id = str(watch["theatreId"])
        watch_name = str(watch["name"])
        rule = watch["rule"]
        watch_state = state.setdefault("watches", {}).setdefault(watch_id, {"showtimes": {}})
        for showtime_id, showtime in watch.get("showtimes", {}).items():
            if not showtime.get("enabled"):
                continue
            result["showtimes"] += 1
            showtime_id = str(showtime_id)
            current = watch_state.setdefault("showtimes", {}).setdefault(showtime_id, {})
            try:
                selected = current.get("selectedSeats", {})
                if not selected:
                    append_log(log_path, "info", f"watch={watch_name} showtime={showtime_id} cineplex layout call initiated")
                    selected = select_seats(_fetch_with_retry(fetch_json, layout_url(theatre_id, showtime_id), sleep=sleep), rule)
                    if not selected:
                        raise ValueError("Seat layout did not contain any seats matching this watch rule")
                    current["selectedSeats"] = selected
                append_log(log_path, "info", f"watch={watch_name} showtime={showtime_id} cineplex availability call initiated")
                availability_response = _fetch_with_retry(fetch_json, availability_url(theatre_id, showtime_id), sleep=sleep)
                seat_availabilities = _validate_availability(availability_response)
                checked_at = datetime.now(timezone.utc).isoformat()
                if availability_response.get("isPostShowtime") is True:
                    showtime["enabled"] = False
                    showtime["completed"] = True
                    current.update({"lastCheckedAt": checked_at, "lastCheckStatus": "completed"})
                    current.pop("lastError", None)
                    _remove_showtime_entries(available_list, watch_name, theatre_id, showtime_id)
                    append_log(log_path, "info", f"watch={watch_name} showtime={showtime_id} completed")
                    continue
                new_seats, available_list = apply_available_seats(
                    available_list,
                    watch_name=watch_name,
                    theatre_id=theatre_id,
                    showtime_id=showtime_id,
                    selected_seats=selected,
                    seat_availabilities=seat_availabilities,
                    checked_at=checked_at,
                )
                current["selectedSeats"] = {
                    seat_id: {**seat, "status": seat_availabilities.get(seat_id, "Missing")}
                    for seat_id, seat in selected.items()
                }
                current.update({"lastCheckedAt": checked_at, "lastCheckStatus": "success"})
                current.pop("lastError", None)
                found = sum(status == "Available" for seat_id, status in seat_availabilities.items() if seat_id in selected)
                append_log(log_path, "info", f"watch={watch_name} showtime={showtime_id} selected_available={found}")
                if new_seats:
                    result["newSeats"] += len(new_seats)
                    if notify:
                        try:
                            notify(grouped_alert_html(watch_name, theatre_id, showtime_id, new_seats))
                            append_log(log_path, "info", f"watch={watch_name} showtime={showtime_id} telegram availability alert sent seats=" + ",".join(seat["seatLabel"] for seat in new_seats))
                        except Exception as error:  # Do not hide delivery error from the durable log.
                            append_log(log_path, "error", f"watch={watch_name} showtime={showtime_id} telegram delivery failed: {type(error).__name__}")
            except (HTTPError, URLError, ValueError, json.JSONDecodeError) as error:
                result["failures"] += 1
                checked_at = datetime.now(timezone.utc).isoformat()
                current.update({"lastCheckedAt": checked_at, "lastCheckStatus": "failed", "lastError": str(error)})
                append_log(log_path, "error", f"watch={watch_name} showtime={showtime_id} cineplex availability call failed: {type(error).__name__}: {error}")
                if notify:
                    try:
                        notify(
                            f"❌ <b>{html.escape(watch_name)}</b> — seat check failed\n"
                            f"Showtime #{html.escape(showtime_id)} · Theatre #{html.escape(theatre_id)}\n"
                            f"{html.escape(str(error))}\nNext automatic retry: about 5 min"
                        )
                    except Exception as notify_error:
                        append_log(log_path, "error", f"watch={watch_name} showtime={showtime_id} telegram failure delivery failed: {type(notify_error).__name__}")
        statuses = [item.get("lastCheckStatus") for item in watch_state["showtimes"].values()]
        watch_state["lastCheckedAt"] = datetime.now(timezone.utc).isoformat()
        watch_state["lastCheckStatus"] = "failed" if "failed" in statuses else "success"

    _write_json(config_path, config)
    _write_json(state_path, state)
    _write_json(available_path, available_list)
    append_log(log_path, "info", f"seat watcher scan completed watches={result['watches']} showtimes={result['showtimes']} failures={result['failures']} new_seats={result['newSeats']}")
    return result


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Run configured Cineplex seat watches")
    parser.add_argument("operation", choices=("scan",), nargs="?", default="scan")
    parser.add_argument("--root", type=Path, default=Path(__file__).parent)
    parser.add_argument("--notify", action="store_true", help="send configured Telegram notifications")
    args = parser.parse_args()
    notify = None
    if args.notify:
        token = os.getenv("TELEGRAM_BOT_TOKEN")
        recipients = os.getenv("TELEGRAM_RECIPIENTS") or os.getenv("TELEGRAM_CHAT_IDS") or os.getenv("TELEGRAM_CHAT_ID")
        if not token or not recipients:
            raise SystemExit("seat watcher notification requested but Telegram secrets are not configured")
        from watcher import send_telegram

        notify = lambda text: send_telegram(token, recipients, text, parse_mode="HTML")
    try:
        result = scan_all(args.root, notify=notify)
    except (OSError, ValueError, HTTPError, URLError, json.JSONDecodeError) as error:
        print(f"seat watcher failed: {error}", file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
