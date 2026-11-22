#!/usr/bin/env python3
"""Weekly watch lists and personal /stop commands, run by GitHub Actions."""

import argparse
import html
import json
import os
import sys
from datetime import datetime, timedelta
from http.client import HTTPException
from pathlib import Path
from zoneinfo import ZoneInfo
from urllib.error import HTTPError

from notification_preferences import configured_recipients, load_preferences, save_preferences, watches_enabled
from watcher import (GEORGE_MICHAEL_FAITH_TOUR_SLUG, MONTREAL_CITY, movie_slug,
                     sale_alert_chat_ids, send_telegram, telegram_chat_ids)

ROOT = Path(__file__).parent
MONTREAL = ZoneInfo("America/Toronto")


def active_watches(root, default, special, now):
    watches = []
    for movie in json.loads((root / "movies.json").read_text()):
        slug = movie_slug(movie["url"])
        detail = f"ticket sales in {MONTREAL_CITY}" if slug == GEORGE_MICHAEL_FAITH_TOUR_SLUG else "ticket sales"
        watches.append({"key": f"ticket:{slug}", "name": movie.get("name") or slug.replace("-", " "),
                        "detail": detail, "recipients": sale_alert_chat_ids(movie["url"], default, special, movie.get("subscribers", []))})
    for watch_id, watch in json.loads((root / "seat-watches.json").read_text())["watches"].items():
        if not watch["enabled"]:
            continue
        for showtime in watch["showtimes"].values():
            if not showtime["enabled"] or showtime.get("completed"):
                continue
            starts_at = showtime.get("showStartDateTimeUtc") or showtime.get("startsAt")
            if starts_at:
                starts = datetime.fromisoformat(starts_at.replace("Z", "+00:00"))
                if starts.tzinfo is None:
                    starts = starts.replace(tzinfo=MONTREAL)
                if starts <= now:
                    continue
            watches.append({"key": f"seat:{watch_id}", "name": watch["name"],
                            "detail": f"seats at {watch.get('theatreName') or watch['theatreId']}",
                            "recipients": telegram_chat_ids(default)})
            break
    owners = telegram_chat_ids(default)
    for watch in watches:
        watch["owners"] = owners
    return watches


def alert_status(preference, watch_key):
    if preference.get("stoppedAll"):
        return "off (all alerts paused)"
    if watch_key in preference.get("stoppedWatches", []):
        return "off (paused for this title)"
    return "on"


def watch_audience(watch, viewer_key, recipients, preferences):
    """Describe scope and alert settings separately; friends see only their own alert setting."""
    key = watch["key"]
    alert_kind = "Seat alerts" if key.startswith("seat:") else "Ticket alerts"
    mine = alert_status(preferences[viewer_key], key)
    if recipients[viewer_key] not in watch["owners"]:
        return [f"Your {alert_kind.lower()}: {mine}"]

    followers = [("You", mine)]
    for keys, role in (
        (sorted(key for key, chat_id in recipients.items() if chat_id in watch["owners"] and key != viewer_key), "Other owner"),
        (sorted(key for key, chat_id in recipients.items() if chat_id not in watch["owners"]), "Friend"),
    ):
        for index, recipient in enumerate(keys, 1):
            if recipients[recipient] in watch["recipients"]:
                label = role if len(keys) == 1 else f"{role} {index}"
                followers.append((label, alert_status(preferences[recipient], key)))
    more = f"; {len(followers) - 12} more in /state" if len(followers) > 12 else ""
    shown = followers[:12]
    return ["Following: " + " and ".join(label for label, _ in shown) + more,
            f"{alert_kind}: " + "; ".join(f"{label} {setting}" for label, setting in shown) + more]


def weekly_message(watches):
    lines = ["<b>Weekly watch reminder</b>", "", "Active watches with your alerts on:"]
    for watch in watches:
        lines.append(f"• {html.escape(watch['name'][:120])} — {html.escape(watch['detail'][:200])}")
        lines.extend(f"   {html.escape(detail)}" for detail in watch.get("audience", []))
    lines.extend(["", "Pause an alert: <code>/stop Movie Name</code>",
                  "Turn off only this reminder: <code>/stop reminder</code>",
                  "Manage alert and reminder settings: <code>/state</code>"])
    return "\n".join(lines)


def weekly_messages(watches):
    batch = []
    for watch in watches:
        # Keep complete HTML lines below Telegram's message limit.
        if batch and len(weekly_message([*batch, watch])) > 3900:
            yield weekly_message(batch)
            batch = []
        batch.append(watch)
    if batch:
        yield weekly_message(batch)


def update_preference(preference, watches, operation, query):
    query = query.strip()
    command = query.casefold()
    if command == "reminder":
        preference["remindersEnabled"] = operation == "start"
        return ("Weekly reminders are on for Saturdays at noon, Montréal time."
                if operation == "start" else
                "Weekly reminders are off. Your watch alert settings are unchanged.\nUse /start reminder to turn reminders back on.")
    if command == "all":
        preference["stoppedAll"] = operation == "stop"
        if operation == "start":
            preference["stoppedWatches"] = []
        return ("Your watch alerts are back on." if operation == "start" else
                "Your watch alerts and weekly reminders are paused.\nUse /start all to resume your watches. If you turned off reminders separately, use /start reminder too.")
    if operation == "start":
        return "Use /start reminder or /start all."
    matches = [watch for watch in watches if command in (watch["key"].casefold(), watch["name"].casefold())]
    if not matches and command:
        matches = [watch for watch in watches if command in watch["name"].casefold()]
    if not matches:
        return "No active watch matches that name. Use the movie name from your weekly reminder."
    if len(matches) > 1:
        return "Several watches match. Use one of these commands:\n\n" + "\n\n".join(
            f"{watch['name']} ({watch['detail']})\n/stop {watch['key']}" for watch in matches)
    watch = matches[0]
    stopped = preference.setdefault("stoppedWatches", [])
    if watch["key"] not in stopped:
        stopped.append(watch["key"])
    return f"Stopped your alerts for {watch['name']} ({watch['detail']}). Other people's watches are unchanged."


def send_reminders(preferences, recipients, watches, token, now, send=send_telegram, *, owners=()):
    if not token:
        raise ValueError("TELEGRAM_BOT_TOKEN is not configured")
    local = now.astimezone(MONTREAL)
    saturday = local.date() - timedelta(days=(local.weekday() - 5) % 7)
    if local.weekday() == 5 and local.hour < 12:
        saturday -= timedelta(days=7)
    week = saturday.isoformat()
    failures = 0
    owner_ids = set(owners)
    for key, chat_id in recipients.items():
        preference = preferences[key]
        role = "owner" if chat_id in owner_ids else "friend"
        personal = [{**watch, "audience": watch_audience(watch, key, recipients, preferences)}
                    for watch in watches if chat_id in watch["recipients"]
                    and watches_enabled(preference, watch["key"])]
        if preference.get("stoppedAll", False):
            reason = "all_paused"
        elif not preference.get("remindersEnabled", True):
            reason = "reminders_off"
        elif preference.get("lastReminderWeek") == week:
            reason = "already_sent"
        elif not personal:
            reason = "no_active_watches"
        else:
            reason = None
        log_prefix = f"telegram_reminders: week={week} role={role}"
        if reason:
            print(f"{log_prefix} result=skipped reason={reason}")
            continue
        try:
            for message in weekly_messages(personal):
                send(token, chat_id, message, parse_mode="HTML")
        except (OSError, HTTPException, ValueError) as error:
            failures += 1
            code = f" status={error.code}" if isinstance(error, HTTPError) else ""
            # Error text and IDs are omitted from public Action logs.
            print(f"{log_prefix} result=failed type={type(error).__name__}{code}", file=sys.stderr)
            continue
        preference["lastReminderWeek"] = week
        print(f"{log_prefix} result=accepted watches={len(personal)}")
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("remind", "initialize", "stop", "start", "reply"))
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    default, special, recipients = configured_recipients()
    key = os.getenv("RECIPIENT_KEY", "")
    if args.operation in ("stop", "start", "reply") and key not in recipients:
        raise ValueError("This recipient is not configured for watch notifications")
    if args.operation == "reply":
        text = (json.loads((args.root / "notification-result.json").read_text())["text"]
                if os.getenv("PREFERENCE_SAVED") == "true" else
                "I could not save your notification preference. Please try again shortly.")
        send_telegram(os.environ["TELEGRAM_BOT_TOKEN"], recipients[key], text)
        return
    preferences = load_preferences(args.root)
    # Explicit initialization also revokes accounts removed from the secrets.
    if args.operation == "initialize":
        preferences = {recipient: preferences.get(recipient, {}) for recipient in recipients}
    # Registers friends so the Worker can accept their personal commands.
    for recipient in recipients:
        preferences.setdefault(recipient, {})
    now = datetime.now(MONTREAL)
    failures = 0
    if args.operation != "initialize":
        watches = active_watches(args.root, default, special, now)
    if args.operation in ("stop", "start"):
        personal = [watch for watch in watches if recipients[key] in watch["recipients"]]
        text = update_preference(preferences[key], personal, args.operation, os.environ["PREFERENCE_QUERY"])
        (args.root / "notification-result.json").write_text(json.dumps({"text": text}) + "\n")
    elif args.operation == "remind":
        failures = send_reminders(preferences, recipients, watches, os.environ["TELEGRAM_BOT_TOKEN"], now,
                                  owners=telegram_chat_ids(default))
    save_preferences(args.root, preferences)
    if failures:
        raise SystemExit(f"telegram_reminders: {failures} delivery failure(s); rerun to retry unsent reminders")


if __name__ == "__main__":
    main()
