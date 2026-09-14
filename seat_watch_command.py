#!/usr/bin/env python3
"""GitHub Action command handler for seat-watch configuration changes."""

import argparse
import json
import re
from datetime import datetime
from pathlib import Path

from seat_watcher import (
    _read_json,
    _remove_showtime_entries,
    _write_json,
    availability_url,
    layout_url,
    request_json,
    request_showtime_detail,
    preview_url,
    select_seats,
)

DEFAULT_RULE = {"E": [[9, 17]], "F": [[14, 23]], "G": [[14, 23]], "H": [[14, 23]], "I": [[14, 23]]}


def slug(value):
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def read_payload(value):
    try:
        result = json.loads(value)
    except json.JSONDecodeError as error:
        raise ValueError(f"Request payload must be JSON: {error.msg}") from error
    if not isinstance(result, dict):
        raise ValueError("Request payload must be a JSON object")
    return result


def valid_showtime_id(value):
    if not isinstance(value, str) or not value.isdigit():
        raise ValueError("Showtime ID must contain digits only")
    return value


def validate_rule(rule):
    if not isinstance(rule, dict) or not rule:
        raise ValueError("Seat rule is required")
    normalized = {}
    for row, ranges in rule.items():
        normalized_row = row.upper() if isinstance(row, str) else ""
        if not re.fullmatch(r"[A-Z]+", normalized_row) or not isinstance(ranges, list) or not ranges:
            raise ValueError("Seat rule must contain row ranges such as E: [[9, 17]]")
        if normalized_row in normalized:
            raise ValueError(f"Seat rule contains row {normalized_row} more than once")
        normalized_ranges = []
        for seat_range in ranges:
            if (
                not isinstance(seat_range, list)
                or len(seat_range) != 2
                or any(not isinstance(number, int) or isinstance(number, bool) for number in seat_range)
            ):
                raise ValueError("Each seat range must contain two positive integers")
            start, end = seat_range
            if start <= 0 or end <= 0 or start > end:
                raise ValueError("Seat ranges must use positive ascending numbers")
            if any(start <= previous_end and end >= previous_start for previous_start, previous_end in normalized_ranges):
                raise ValueError(f"Overlapping seat range for row {normalized_row}")
            normalized_ranges.append([start, end])
        normalized[normalized_row] = normalized_ranges
    return normalized


def validate_watch(payload):
    name = payload.get("name")
    theatre_id = payload.get("theatreId")
    theatre_name = payload.get("theatreName")
    showtimes = payload.get("showtimes")
    rule = payload.get("rule")
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 80:
        raise ValueError("Watch name is required and must be at most 80 characters")
    if not isinstance(theatre_id, str) or not theatre_id.isdigit():
        raise ValueError("Theatre ID must contain digits only")
    if not isinstance(theatre_name, str) or not theatre_name.strip():
        raise ValueError("Theatre name is required")
    rule = validate_rule(rule)
    if not isinstance(showtimes, list) or not showtimes:
        raise ValueError("Provide at least one showtime")
    normalized = {}
    for item in showtimes:
        if not isinstance(item, dict):
            raise ValueError("Each showtime must be an object")
        showtime_id = valid_showtime_id(item.get("id"))
        if showtime_id in normalized:
            raise ValueError(f"Showtime #{showtime_id} was provided more than once")
        # A showtime ID is sufficient for the seat-layout and availability APIs.
        # Date/time are optional display metadata and must never prevent a
        # Telegram command from adding a watch.
        metadata = {"enabled": True}
        if isinstance(item.get("startsAt"), str) and item["startsAt"].strip():
            metadata["startsAt"] = item["startsAt"].strip()
        if isinstance(item.get("displayTime"), str) and item["displayTime"].strip():
            metadata["displayTime"] = item["displayTime"].strip()
        normalized[showtime_id] = metadata
    return {
        "id": slug(name), "name": name.strip(), "enabled": True, "theatreId": theatre_id,
        "theatreName": theatre_name.strip(), "rule": rule, "showtimes": normalized,
    }


def showtime_display_metadata(detail, theatre_id, showtime_id):
    """Keep only the date/time fields needed by the UI and Telegram output."""
    if str(detail.get("theatreId")) != str(theatre_id):
        raise ValueError(f"Showtime #{showtime_id} does not belong to theatre #{theatre_id}")
    showtime = detail.get("showtime")
    if not isinstance(showtime, dict) or str(showtime.get("vistaSessionId")) != str(showtime_id):
        raise ValueError(f"Cineplex detail response does not match showtime #{showtime_id}")
    starts_at = showtime.get("showStartDateTime")
    show_date = detail.get("showDate")
    if not isinstance(starts_at, str) or not isinstance(show_date, str):
        raise ValueError(f"Cineplex detail response for #{showtime_id} is missing its date/time")
    try:
        parsed = datetime.fromisoformat(starts_at)
    except ValueError as error:
        raise ValueError(f"Cineplex detail response for #{showtime_id} has an invalid start time") from error
    metadata = {
        "showDate": show_date,
        "startsAt": starts_at,
        "displayTime": parsed.strftime("%b %d, %-I:%M %p").replace(" 0", " "),
    }
    for field in ("seatMapUrl", "ticketingUrl", "ticketingRedesignUrl", "getTicketingUrlApi", "deeplinkUrl", "showtimeShareKey", "showStartDateTimeUtc", "isInThePast", "isReservedSeating", "isShowtimeEnabledOnline", "seatsRemaining", "isSoldOut", "auditorium"):
        if field in showtime:
            metadata[field] = showtime[field]
    return metadata


def watch_movie_metadata(detail):
    """Keep the stable movie/theatre fields needed by seat watches and the UI."""
    movie = detail.get("movie")
    movie_id = detail.get("movieId")
    theatre = detail.get("theatre")
    if not isinstance(movie, str) or not movie.strip() or not isinstance(movie_id, int) or not isinstance(theatre, str) or not theatre.strip():
        raise ValueError("Cineplex detail response is missing movie or theatre metadata")
    metadata = {"movie": movie.strip(), "movieId": movie_id, "theatre": theatre.strip()}
    if isinstance(detail.get("runtimeInMinutes"), int): metadata["runtimeInMinutes"] = detail["runtimeInMinutes"]
    if isinstance(detail.get("experienceTypes"), list) and all(isinstance(value, str) for value in detail["experienceTypes"]): metadata["experienceTypes"] = detail["experienceTypes"]
    return metadata


def command_result_html(result):
    """Render the action result as one compact, safe Telegram HTML message."""
    watch = result["watch"]
    operation = result["operation"]
    watch_name = re.sub(r"[&<>\"']", lambda match: {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[match.group()], watch["name"])
    theatre_name = re.sub(r"[&<>\"']", lambda match: {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[match.group()], watch["theatreName"])
    theatre_id = re.sub(r"[&<>\"']", lambda match: {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[match.group()], str(watch["theatreId"]))
    titles = {
        "add_showtime": "Showtime added",
        "stop_showtime": "Showtime stopped",
        "create": "Seat watch started",
        "edit": "Seat watch updated",
        "stop": "Seat watch stopped",
        "refresh": "Seat watch refreshed",
    }
    lines = [f"✅ <b>{titles[operation]}</b>", f"<b>{watch_name}</b> · {theatre_name} · #{theatre_id}"]
    showtime_id = result.get("showtimeId")
    if showtime_id:
        showtime = watch["showtimes"][showtime_id]
        display_time = re.sub(r"[&<>\"']", lambda match: {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[match.group()], showtime.get("displayTime", "Time unavailable"))
        url = preview_url(str(watch["theatreId"]), showtime_id)
        lines.append(f'<a href="{url}">#{showtime_id} · {display_time}</a>')
    if operation in {"create", "edit", "add_showtime", "refresh"}:
        lines.append(f"📖 <code>/seatinfo {watch_name}</code>")
    lines.append('🌐 <a href="https://ettersay.github.io/cplex-watcher/">Web interface</a>')
    return "\n\n".join(lines)


def validate_showtimes(watch, *, fetch_detail=request_showtime_detail, fetch_json=request_json, details=None):
    for showtime_id in watch["showtimes"]:
        detail = (details or {}).get(showtime_id) or fetch_detail(watch["theatreId"], showtime_id)
        watch.update(watch_movie_metadata(detail))
        watch["showtimes"][showtime_id].update(showtime_display_metadata(detail, watch["theatreId"], showtime_id))
        layout = fetch_json(layout_url(watch["theatreId"], showtime_id))
        if not select_seats(layout, watch["rule"]):
            raise ValueError(f"Showtime #{showtime_id} has no seats matching this watch rule")
        availability = fetch_json(availability_url(watch["theatreId"], showtime_id))
        if not isinstance(availability.get("seatAvailabilities"), dict):
            raise ValueError(f"Showtime #{showtime_id} returned invalid availability data")


def register_preview_watch(watches, theatre_id, showtime_id, *, fetch_detail=request_showtime_detail, fetch_json=request_json):
    """Register a preview URL showtime, reusing a matching movie/theatre watch."""
    detail = fetch_detail(theatre_id, showtime_id)
    profile = watch_movie_metadata(detail)
    movie_name, theatre_name = profile["movie"], profile["theatre"]
    matching = next((watch for watch in watches.values() if watch.get("enabled") and watch.get("name", "").casefold() == movie_name.casefold() and str(watch.get("theatreId")) == theatre_id), None)
    if matching:
        candidate = {**matching, "showtimes": {showtime_id: {"enabled": True}}}
        validate_showtimes(candidate, fetch_detail=fetch_detail, fetch_json=fetch_json, details={showtime_id: detail})
        matching["showtimes"][showtime_id] = candidate["showtimes"][showtime_id]
        return matching, "add_showtime"
    name = movie_name
    if any(watch.get("name", "").casefold() == movie_name.casefold() for watch in watches.values()):
        name = f"{movie_name} · {theatre_name}"
    watch = validate_watch({"name": name, "theatreId": theatre_id, "theatreName": theatre_name, "rule": DEFAULT_RULE, "showtimes": [{"id": showtime_id}]})
    if watch["id"] in watches:
        raise ValueError(f"A seat watch named {name} already exists")
    validate_showtimes(watch, fetch_detail=fetch_detail, fetch_json=fetch_json, details={showtime_id: detail})
    watches[watch["id"]] = watch
    return watch, "create"


def run(root, operation, payload_value, watch_id):
    config_path = root / "seat-watches.json"
    state_path = root / "seat-watch-state.json"
    available_path = root / "available-seat-list.json"
    config = _read_json(config_path, {"watches": {}})
    state = _read_json(state_path, {"watches": {}})
    available = _read_json(available_path, {})
    watches = config.setdefault("watches", {})
    if operation == "watch_preview":
        payload = read_payload(payload_value)
        theatre_id = payload.get("theatreId")
        showtime_id = payload.get("showtimeId")
        if not isinstance(theatre_id, str) or not theatre_id.isdigit():
            raise ValueError("Theatre ID must contain digits only")
        showtime_id = valid_showtime_id(showtime_id)
        watch, completed_operation = register_preview_watch(watches, theatre_id, showtime_id)
        message = f"Added preview showtime #{showtime_id} to {watch['name']}."
    elif operation in {"create", "edit"}:
        watch = validate_watch(read_payload(payload_value))
        if operation == "create" and watch["id"] in watches:
            raise ValueError(f"A watch named {watch['name']} already exists")
        target_id = watch_id or watch["id"]
        if operation == "edit" and target_id not in watches:
            raise ValueError("Seat watch was not found")
        if operation == "edit":
            old = watches[target_id]
            for old_showtime_id in old.get("showtimes", {}):
                _remove_showtime_entries(available, old["name"], old["theatreId"], old_showtime_id)
            state.setdefault("watches", {}).pop(target_id, None)
        validate_showtimes(watch)
        watches[target_id] = {**watch, "id": target_id}
        message = f"Saved seat watch {watch['name']}."
    elif operation == "stop":
        watch = watches.get(watch_id)
        if not watch:
            raise ValueError("Seat watch was not found")
        watch["enabled"] = False
        for showtime_id in watch.get("showtimes", {}):
            _remove_showtime_entries(available, watch["name"], watch["theatreId"], showtime_id)
        message = f"Stopped seat watch {watch['name']}."
    elif operation == "refresh":
        watch = watches.get(watch_id)
        if not watch or not watch.get("enabled"):
            raise ValueError("No enabled seat watch was found")
        message = f"Refreshed seat watch {watch['name']}."
    elif operation in {"add_showtime", "stop_showtime"}:
        watch = watches.get(watch_id)
        if not watch:
            raise ValueError("Seat watch was not found")
        payload = read_payload(payload_value)
        showtime_id = valid_showtime_id(payload.get("id"))
        if operation == "add_showtime":
            if showtime_id in watch["showtimes"]:
                raise ValueError(f"Showtime #{showtime_id} is already watched for {watch['name']}")
            metadata = {"enabled": True}
            if isinstance(payload.get("startsAt"), str) and payload["startsAt"].strip():
                metadata["startsAt"] = payload["startsAt"].strip()
            if isinstance(payload.get("displayTime"), str) and payload["displayTime"].strip():
                metadata["displayTime"] = payload["displayTime"].strip()
            candidate = {**watch, "showtimes": {showtime_id: metadata}}
            validate_showtimes(candidate)
            watch["showtimes"][showtime_id] = candidate["showtimes"][showtime_id]
            message = f"Added showtime #{showtime_id} to {watch['name']}."
        else:
            if showtime_id not in watch["showtimes"]:
                raise ValueError(f"Showtime #{showtime_id} is not watched for {watch['name']}")
            watch["showtimes"][showtime_id]["enabled"] = False
            _remove_showtime_entries(available, watch["name"], watch["theatreId"], showtime_id)
            message = f"Stopped showtime #{showtime_id} for {watch['name']}."
    else:
        raise ValueError("Unsupported seat-watch operation")
    _write_json(config_path, config)
    _write_json(state_path, state)
    _write_json(available_path, available)
    return {
        "message": message,
        "watchId": watch_id or watch["id"],
        "operation": completed_operation if operation == "watch_preview" else operation,
        "watch": watches[watch_id or watch["id"]],
        "showtimeId": showtime_id if operation in {"add_showtime", "stop_showtime", "watch_preview"} else None,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("create", "edit", "stop", "add_showtime", "stop_showtime", "refresh", "watch_preview"))
    parser.add_argument("--payload", default="{}")
    parser.add_argument("--watch-id", default="")
    parser.add_argument("--root", type=Path, default=Path(__file__).parent)
    args = parser.parse_args()
    try:
        print(json.dumps(run(args.root, args.operation, args.payload, args.watch_id)))
    except (OSError, ValueError) as error:
        print(json.dumps({"error": str(error)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
