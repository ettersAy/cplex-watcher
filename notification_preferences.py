"""Personal Telegram opt-outs, without publishing chat IDs in repository state."""

import hashlib
import hmac
import json
import os
import re
from pathlib import Path


PREFERENCES_FILE = "notification-preferences.json"


def telegram_chat_ids(value):
    """Return distinct chat IDs from a comma- or whitespace-separated secret."""
    return list(dict.fromkeys(chat_id for chat_id in re.split(r"[\s,]+", value or "") if chat_id))


def configured_recipients():
    default = (os.getenv("TELEGRAM_RECIPIENTS") or os.getenv("TELEGRAM_CHAT_IDS")
               or os.getenv("TELEGRAM_CHAT_ID") or "")
    special = os.getenv("TELEGRAM_GEORGE_MICHAEL_ALERT_CHAT_IDS", "")
    recipients = {recipient_key(chat_id): chat_id for chat_id in telegram_chat_ids(f"{default},{special}")}
    if not recipients:
        raise ValueError("Telegram recipients are not configured")
    return default, special, recipients


def recipient_key(chat_id):
    secret = os.environ.get("TELEGRAM_PREFERENCES_KEY")
    if not secret:
        raise ValueError("TELEGRAM_PREFERENCES_KEY is not configured")
    return hmac.new(secret.encode(), str(chat_id).encode(), hashlib.sha256).hexdigest()


def load_preferences(root):
    recipients = json.loads((Path(root) / PREFERENCES_FILE).read_text())["recipients"]
    if not isinstance(recipients, dict) or any(not isinstance(value, dict) for value in recipients.values()):
        raise ValueError("notification-preferences.json must contain recipient objects")
    return recipients


def save_preferences(root, preferences):
    (Path(root) / PREFERENCES_FILE).write_text(
        json.dumps({"recipients": preferences}, indent=2, sort_keys=True) + "\n"
    )


def watches_enabled(preference, watch_key):
    return not preference.get("stoppedAll", False) and watch_key not in preference.get("stoppedWatches", [])


def notification_chat_ids(chat_ids, watch_key, preferences):
    return [chat_id for chat_id in chat_ids
            if watches_enabled(preferences.get(recipient_key(chat_id), {}), watch_key)]
