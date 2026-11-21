"""Run one timer-driven ticket scan per UTC half-hour. Manual watches are unchanged."""

import json
import os
import time

import watcher

SLOT_SECONDS = 30 * 60


def run(request, now, state_path, scan):
    if not request:
        scan()
        return

    slot = int(now) // SLOT_SECONDS
    if request != "fallback":
        prefix = "ticket-check-"
        value = request.removeprefix(prefix)
        if not request.startswith(prefix) or not value.isascii() or not value.isdecimal() or len(value) > 10:
            raise ValueError("Invalid ticket check request ID")
        if int(value) != slot:
            print(f"Skipping ticket check outside its slot: {request}")
            return

    state = json.loads(state_path.read_text())
    if state.get("lastTicketCheckSlot", -1) >= slot:
        print(f"Ticket check slot {slot} already ran")
        return

    scan()
    # Reload the watcher result, and commit the slot with its alert state in the same job.
    state = json.loads(state_path.read_text())
    failures = sum(entry.get("lastCheckStatus") == "failed" for entry in state.get("movies", {}).values())
    print(f"Ticket scan attempted for slot {slot}; saved movie-level errors: {failures}")
    state["lastTicketCheckSlot"] = slot
    state_path.write_text(json.dumps(state, indent=2) + "\n")


if __name__ == "__main__":
    run(os.environ.get("TICKET_CHECK_REQUEST"), time.time(), watcher.STATE_FILE, watcher.main)
