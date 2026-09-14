#!/usr/bin/env python3
"""Repeatable no-network checks for seat_watcher.py."""

import sys
import json
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from seat_watcher import apply_available_seats, availability_url, grouped_alert_html, layout_url, parse_rule, scan_all, select_seats
from seat_watch_command import command_result_html, register_preview_watch, run, showtime_display_metadata, validate_showtimes, validate_watch


def layout_fixture():
    rows = []
    for row in "EFGHI":
        seats = [{"id": f"1_{row}_{number}", "label": f"{row}{number}", "type": "Standard"} for number in range(1, 31)]
        rows.append({"label": row, "seats": seats})
    rows.append({"label": "D", "seats": [{"id": "1_D_15", "label": "D15", "type": "Standard"}]})
    return {"standardSeats": {"rows": rows}, "dboxSeats": {"rows": []}, "balconySeats": {"rows": []}}


def main():
    rule = parse_rule("E9-E17, F14-F23, G14-G23, H14-H23, I14-I23")
    selected = select_seats(layout_fixture(), rule)
    assert len(selected) == 49, len(selected)
    assert "1_F_20" in selected
    assert "1_H_15" in selected
    assert "1_E_10" in selected
    assert "1_F_24" not in selected
    assert "1_E_18" not in selected
    assert "1_D_15" not in selected

    command_watch = validate_watch({
        "name": "Dune", "theatreId": "9406", "theatreName": "Test", "rule": rule,
        "showtimes": [{"id": "405765"}],
    })
    assert command_watch["showtimes"]["405765"] == {"enabled": True}
    try:
        validate_watch({
            "name": "Dune", "theatreId": "9406", "theatreName": "Test", "rule": {"E": [9, 17]},
            "showtimes": [{"id": "405765"}],
        })
        raise AssertionError("Malformed seat-rule shape was accepted")
    except ValueError as error:
        assert "two positive integers" in str(error)

    metadata = showtime_display_metadata({
        "theatreId": 9406, "movie": "Dune", "movieId": 61104, "theatre": "Test",
        "showDate": "2027-01-14T00:00:00",
        "showtime": {"vistaSessionId": 405853, "showStartDateTime": "2027-01-14T12:15:00"},
    }, "9406", "405853")
    assert metadata == {
        "showDate": "2027-01-14T00:00:00",
        "startsAt": "2027-01-14T12:15:00",
        "displayTime": "Jan 14, 12:15 PM",
    }
    calls = []
    validation_watch = validate_watch({
        "name": "Dune", "theatreId": "9406", "theatreName": "Test", "rule": rule,
        "showtimes": [{"id": "405853"}],
    })
    validate_showtimes(
        validation_watch,
        fetch_detail=lambda theatre_id, showtime_id: calls.append((theatre_id, showtime_id)) or {
            "theatreId": 9406,
            "movie": "Dune", "movieId": 61104, "theatre": "Test",
            "showDate": "2027-01-14T00:00:00",
            "showtime": {"vistaSessionId": 405853, "showStartDateTime": "2027-01-14T12:15:00"},
        },
        fetch_json=lambda url: (
            layout_fixture() if url == layout_url("9406", "405853")
            else {"seatAvailabilities": {seat_id: "Occupied" for seat_id in selected}}
        ),
    )
    assert calls == [("9406", "405853")]
    assert validation_watch["showtimes"]["405853"]["displayTime"] == "Jan 14, 12:15 PM"

    preview_detail = {
        "theatreId": 9406, "theatre": "Scotia Bank", "movie": "Dune: Part 3", "movieId": 61104,
        "showDate": "2027-01-14T00:00:00",
        "showtime": {"vistaSessionId": 405853, "showStartDateTime": "2027-01-14T12:15:00"},
    }
    preview_watches = {}
    preview_watch, preview_operation = register_preview_watch(
        preview_watches, "9406", "405853", fetch_detail=lambda *_: preview_detail,
        fetch_json=lambda url: layout_fixture() if "seat-layout" in url else {"seatAvailabilities": {}},
    )
    assert preview_operation == "create" and preview_watch["name"] == "Dune: Part 3"
    assert preview_watch["showtimes"]["405853"]["displayTime"] == "Jan 14, 12:15 PM"
    preview_detail["showtime"] = {"vistaSessionId": 405854, "showStartDateTime": "2027-01-14T18:00:00"}
    preview_watch, preview_operation = register_preview_watch(
        preview_watches, "9406", "405854", fetch_detail=lambda *_: preview_detail,
        fetch_json=lambda url: layout_fixture() if "seat-layout" in url else {"seatAvailabilities": {}},
    )
    assert preview_operation == "add_showtime" and sorted(preview_watch["showtimes"]) == ["405853", "405854"]

    availability = {seat_id: "Occupied" for seat_id in selected}
    new_seats, available_list = apply_available_seats(
        {}, watch_name="Dune", theatre_id="9406", showtime_id="405743", selected_seats=selected,
        seat_availabilities=availability, checked_at="2026-09-13T18:35:02Z",
    )
    assert not new_seats and not available_list

    availability["1_F_20"] = "Available"
    availability["1_E_10"] = "Available"
    new_seats, available_list = apply_available_seats(
        available_list, watch_name="Dune", theatre_id="9406", showtime_id="405743", selected_seats=selected,
        seat_availabilities=availability, checked_at="2026-09-13T18:40:02Z",
    )
    assert [seat["seatLabel"] for seat in new_seats] == ["E10", "F20"]
    alert = grouped_alert_html("Dune", "9406", "405743", new_seats, theatre_name="Scotia Bank", showtime={"displayTime": "Dec 14, 6:00 PM"})
    assert "🪑 <b>New selected seats — Dune</b>" in alert
    assert "Scotia Bank · #9406" in alert
    assert "<b>Dec 14 · #405743 · 6:00 PM</b>" in alert
    assert "E: 10" in alert and "F: 20" in alert

    duplicate_seats, unchanged_list = apply_available_seats(
        available_list, watch_name="Dune", theatre_id="9406", showtime_id="405743", selected_seats=selected,
        seat_availabilities=availability, checked_at="2026-09-13T18:45:02Z",
    )
    assert not duplicate_seats and unchanged_list == available_list

    availability["1_F_20"] = "Occupied"
    _, removed_list = apply_available_seats(
        available_list, watch_name="Dune", theatre_id="9406", showtime_id="405743", selected_seats=selected,
        seat_availabilities=availability, checked_at="2026-09-13T18:50:02Z",
    )
    availability["1_F_20"] = "Available"
    reappeared_seats, _ = apply_available_seats(
        removed_list, watch_name="Dune", theatre_id="9406", showtime_id="405743", selected_seats=selected,
        seat_availabilities=availability, checked_at="2026-09-13T18:55:02Z",
    )
    assert [seat["seatLabel"] for seat in reappeared_seats] == ["F20"]

    with tempfile.TemporaryDirectory() as temporary_directory:
        root = Path(temporary_directory)
        config = {
            "watches": {
                "dune": {
                    "id": "dune", "name": "Dune", "enabled": True, "theatreId": "9406", "theatreName": "Test",
                    "rule": rule,
                    "showtimes": {"405743": {"enabled": True, "startsAt": "2026-12-14T18:00:00-05:00", "displayTime": "Dec 14, 6:00 PM"}},
                }
            }
        }
        (root / "seat-watches.json").write_text(json.dumps(config))
        responses = {
            layout_url("9406", "405743"): layout_fixture(),
            availability_url("9406", "405743"): {"seatAvailabilities": availability, "isSoldOut": False, "isPostShowtime": False},
        }
        alerts = []
        result = scan_all(root, fetch_json=responses.__getitem__, notify=alerts.append, sleep=lambda _: None)
        assert result["newSeats"] == 2 and len(alerts) == 1
        duplicate_result = scan_all(root, fetch_json=responses.__getitem__, notify=alerts.append, sleep=lambda _: None)
        assert duplicate_result["newSeats"] == 0 and len(alerts) == 1
        failed_responses = dict(responses)
        failed_responses[availability_url("9406", "405743")] = {"bad": "shape"}
        failed_result = scan_all(root, fetch_json=failed_responses.__getitem__, notify=alerts.append, sleep=lambda _: None)
        assert failed_result["failures"] == 1
        assert json.loads((root / "available-seat-list.json").read_text())
        assert "[error]" in (root / "seat-watch.log").read_text()

    with tempfile.TemporaryDirectory() as temporary_directory:
        root = Path(temporary_directory)
        watch = {
            "id": "dune", "name": "Dune", "enabled": True, "theatreId": "9406", "theatreName": "Test",
            "rule": rule,
            "showtimes": {"405853": {"enabled": True}, "405854": {"enabled": True}},
        }
        (root / "seat-watches.json").write_text(json.dumps({"watches": {"dune": watch}}))
        (root / "available-seat-list.json").write_text(json.dumps({
            "Dune|9406|405853|one": {"seatId": "one"},
            "Dune|9406|405854|two": {"seatId": "two"},
        }))
        result = run(root, "stop_showtime", json.dumps({"id": "405854"}), "dune")
        saved = json.loads((root / "seat-watches.json").read_text())["watches"]["dune"]
        saved_available = json.loads((root / "available-seat-list.json").read_text())
        assert result["message"] == "Stopped showtime #405854 for Dune."
        assert saved["showtimes"]["405853"]["enabled"] is True
        assert saved["showtimes"]["405854"]["enabled"] is False
        assert sorted(saved_available) == ["Dune|9406|405853|one"]
        assert "<b>Showtime stopped</b>" in command_result_html(result)

    with tempfile.TemporaryDirectory() as temporary_directory:
        root = Path(temporary_directory)
        watch = {
            "id": "dune", "name": "Dune", "enabled": True, "theatreId": "9406", "theatreName": "Test",
            "rule": rule,
            "showtimes": {"405853": {"enabled": True}, "405854": {"enabled": True}},
        }
        (root / "seat-watches.json").write_text(json.dumps({"watches": {"dune": watch}}))
        (root / "available-seat-list.json").write_text(json.dumps({
            "Dune|9406|405853|one": {"seatId": "one"},
            "Dune|9406|405854|two": {"seatId": "two"},
        }))
        result = run(root, "stop", "{}", "dune")
        saved = json.loads((root / "seat-watches.json").read_text())["watches"]["dune"]
        saved_available = json.loads((root / "available-seat-list.json").read_text())
        assert result["message"] == "Stopped seat watch Dune."
        assert saved["enabled"] is False
        assert saved_available == {}

    with tempfile.TemporaryDirectory() as temporary_directory:
        root = Path(temporary_directory)
        watch = {
            "id": "dune", "name": "Dune", "enabled": True, "theatreId": "9406", "theatreName": "Test",
            "rule": rule, "showtimes": {"405853": {"enabled": True}},
        }
        (root / "seat-watches.json").write_text(json.dumps({"watches": {"dune": watch}}))
        result = run(root, "refresh", "{}", "dune")
        assert result["message"] == "Refreshed seat watch Dune."

    with tempfile.TemporaryDirectory() as temporary_directory:
        root = Path(temporary_directory)
        watch = {
            "id": "dune", "name": "Dune", "enabled": True, "theatreId": "9406", "theatreName": "Test",
            "rule": rule, "showtimes": {"405853": {"enabled": True}},
        }
        (root / "seat-watches.json").write_text(json.dumps({"watches": {"dune": watch}}))
        (root / "seat-watch-state.json").write_text(json.dumps({"watches": {"dune": {"showtimes": {}}}}))
        (root / "available-seat-list.json").write_text(json.dumps({"Dune|9406|405853|one": {"seatId": "one"}}))
        result = run(root, "delete", "{}", "dune")
        assert result["message"] == "Deleted seat watch Dune."
        assert result["watch"]["id"] == "dune"
        assert json.loads((root / "seat-watches.json").read_text())["watches"] == {}
        assert json.loads((root / "seat-watch-state.json").read_text())["watches"] == {}
        assert json.loads((root / "available-seat-list.json").read_text()) == {}
        assert "Seat watch deleted" in command_result_html(result)
    print("seat watcher core checks passed")


if __name__ == "__main__":
    main()
