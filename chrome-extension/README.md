# Cineplex Seat Watcher Chrome extension

1. Open `chrome://extensions`, enable **Developer mode**, then choose **Load unpacked**.
2. Select this `chrome-extension` folder.
3. Open the extension popup and save the same `UI_ACCESS_TOKEN` used by the web interface.
4. Open a Cineplex ticket-preview URL. The prompt lets you queue the same workflow as `/watchseat <URL>`.

The token stays in `chrome.storage.local` in the current Chrome profile. It is never added to the Cineplex page or committed to this repository.
