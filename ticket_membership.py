"""Personal ticket following and replay-safe command application."""
import base64
import hashlib
import hmac
import json
import os
import secrets
import re
import sys
from http.client import HTTPException
import time
from pathlib import Path

from notification_preferences import configured_recipients, recipient_key, telegram_chat_ids

SPECIAL_SLUG = "george-michael-the-faith-tour"
NONCE = re.compile(r"[A-Za-z0-9_-]{22}")
SLUG = re.compile(r"[a-z0-9-]{1,200}")
RECEIPTS = "ticketConfirmationReceipts"


def movie_slug(url):
    return url.rstrip("/").rsplit("/", 1)[-1]


def follows(movie, key, owner):
    return key not in movie.get("unfollowers", ()) and (
        owner or movie_slug(movie["url"]) == SPECIAL_SLUG or key in movie.get("subscribers", ()))


def private_owners(default):
    return [chat_id for chat_id in telegram_chat_ids(default) if re.fullmatch(r"[1-9][0-9]*", chat_id)]


def unfollow(root, key, slug, nonce, expires_at, *, now=None, keep=False, cancel=False):
    """Called under the ticket workflow's shared write queue, before its atomic Git push."""
    root = Path(root)
    now = int(time.time() * 1000) if now is None else now
    default, _, recipients = configured_recipients()
    if key not in recipients or not SLUG.fullmatch(slug) or not NONCE.fullmatch(nonce):
        raise ValueError("Invalid ticket confirmation")
    if expires_at <= now or expires_at > now + 10 * 60 * 1000:
        return {"status": "expired"}
    state_path = root / "state.json"
    movies_path = root / "movies.json"
    state = json.loads(state_path.read_text())
    receipts = {key: expiry for key, expiry in state.get(RECEIPTS, {}).items() if expiry > now}
    if nonce in receipts:
        return {"status": "duplicate"}
    movies = json.loads(movies_path.read_text())
    movie = next((movie for movie in movies if movie_slug(movie["url"]) == slug), None)
    owner = recipients[key] in telegram_chat_ids(default)
    if keep and not owner:
        raise ValueError("Keep response requires owner scope")
    receipts[nonce] = expires_at
    state[RECEIPTS] = receipts
    if cancel:
        state_path.write_text(json.dumps(state, indent=2) + "\n")
        return {"status": "cancelled"}
    if movie is None or not follows(movie, key, owner):
        state_path.write_text(json.dumps(state, indent=2) + "\n")
        return {"status": "unchanged"}
    if keep:
        state_path.write_text(json.dumps(state, indent=2) + "\n")
        return {"status": "kept", "name": movie.get("name") or slug}
    movie.setdefault("unfollowers", []).append(key)
    state_path.write_text(json.dumps(state, indent=2) + "\n")
    movies_path.write_text(json.dumps(movies, indent=2) + "\n")
    return {"status": "unfollowed", "name": movie.get("name") or slug, "slug": slug, "friend": not owner}


def effective_ticket_recipients(url, default, secondary, subscribers=(), unfollowers=()):
    """Filter default owner and secondary recipients without exposing identities."""
    owners = telegram_chat_ids(default)
    movie = {"url": url, "subscribers": subscribers, "unfollowers": unfollowers}
    candidates = list(dict.fromkeys(owners + telegram_chat_ids(secondary)))
    if not unfollowers:
        legacy = telegram_chat_ids(secondary) if movie_slug(url) == SPECIAL_SLUG else []
        if not subscribers:
            return list(dict.fromkeys(owners + legacy))
        return list(dict.fromkeys(owners + [chat for chat in telegram_chat_ids(secondary)
                                             if chat in legacy or recipient_key(chat) in subscribers]))
    return [chat for chat in candidates if follows(movie, recipient_key(chat), chat in owners)]

OWNER_INSTRUCTIONS = ("\n\nReply Stop too to stop your own watch, or Keep watching. "
                      "No reply keeps your watch. This offer expires in 10 minutes.")


def owner_offer(chat_id, slug, message, secret, now=None):
    """Use the same domain and payload serialization as the Worker reply verifier."""
    now = int(time.time() * 1000) if now is None else now
    if not secret:
        raise ValueError("Telegram confirmation signing is unavailable")
    prompt = message + OWNER_INSTRUCTIONS

    def encode(value):
        raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        return raw.encode("utf-8")

    payload = base64.urlsafe_b64encode(encode([
        "unfollow_owner_offer", slug, "", secrets.token_urlsafe(16), now + 10 * 60 * 1000
    ])).decode("ascii").rstrip("=")
    signed = encode(["cineplex-telegram-command-confirmation-v1", str(chat_id), [payload, prompt]])
    mac = base64.urlsafe_b64encode(hmac.new(secret.encode(), signed, hashlib.sha256).digest()).decode("ascii").rstrip("=")
    return f"{prompt}\nConfirmation code: {payload}.{mac}"


def notify_friend_change(root, result, token, send):
    """Notify private owners only after the workflow saved an actual friend change."""
    if not (result.get("friend_started") or (result["status"] == "unfollowed" and result.get("friend"))):
        return
    default, _, _ = configured_recipients()
    owners = private_owners(default)
    if len(owners) != 1:
        print("Friend change notice skipped: no unique private admin destination", file=sys.stderr)
        return

    def deliver(chat_id, message, **kwargs):
        try:
            send(token, chat_id, message, **kwargs)
        except (OSError, HTTPException, ValueError) as error:
            # A notice failure never re-applies a mutation or reveals the account.
            print(f"Friend change notice failed: {type(error).__name__}", file=sys.stderr)

    if result["status"] == "unfollowed" and result.get("friend"):
        movies = json.loads((Path(root) / "movies.json").read_text())
        movie = next((movie for movie in movies if movie_slug(movie["url"]) == result["slug"]), None)
        for chat in owners:
            message = f"A friend stopped following {result['name']}. This did not change your watch."
            markup = None
            if movie and follows(movie, recipient_key(chat), owner=True):
                message = owner_offer(chat, result["slug"], message, os.environ["TELEGRAM_PREFERENCES_KEY"])
                markup = {"force_reply": True}
            deliver(chat, message, reply_markup=markup)
    elif result.get("friend_started"):
        for chat in owners:
            deliver(chat, f"A friend started following {result['movie']['name']}.")
