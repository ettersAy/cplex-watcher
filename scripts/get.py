from getpass import getpass
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import urlopen

token = getpass("Telegram bot token: ").strip()
secret = getpass("Webhook secret: ").strip()
worker_url = input("Worker URL: ").strip().rstrip("/")

try:
    # Checks the token before changing the webhook.
    print("Bot check:", urlopen(f"https://api.telegram.org/bot{token}/getMe").read().decode())

    url = f"https://api.telegram.org/bot{token}/setWebhook?" + urlencode({
        "url": worker_url + "/telegram",
        "secret_token": secret,
    })
    print("Webhook result:", urlopen(url).read().decode())
except HTTPError as error:
    print("Telegram error:", error.read().decode())
