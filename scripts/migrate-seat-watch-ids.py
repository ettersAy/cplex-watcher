#!/usr/bin/env python3
"""Merge duplicate seat watches and use Cineplex movieId as their stable ID."""

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read_json(path, fallback):
    return json.loads(path.read_text()) if path.exists() else fallback


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def merge_state(target, source):
    target_showtimes = target.setdefault("showtimes", {})
    target_showtimes.update(source.get("showtimes", {}))
    for key, value in source.items():
        if key != "showtimes" and key not in target:
            target[key] = value


def migrate(root):
    config_path = root / "seat-watches.json"
    state_path = root / "seat-watch-state.json"
    available_path = root / "available-seat-list.json"
    config = read_json(config_path, {"watches": {}})
    state = read_json(state_path, {"watches": {}})
    available = read_json(available_path, {})
    watches = config.get("watches")
    if not isinstance(watches, dict):
        raise ValueError("seat-watches.json must contain a watches object")

    groups = {}
    for old_id, watch in watches.items():
        movie_id = watch.get("movieId")
        if not isinstance(movie_id, int) or isinstance(movie_id, bool):
            raise ValueError(f"Seat watch {old_id} has no Cineplex movieId; backfill its metadata first")
        groups.setdefault(str(movie_id), []).append((old_id, watch))

    new_watches, id_map, name_map = {}, {}, {}
    for movie_id, entries in groups.items():
        theatres = {str(watch.get("theatreId")) for _, watch in entries}
        if len(theatres) != 1:
            raise ValueError(f"Movie #{movie_id} is watched in multiple theatres; it cannot use one movieId key yet")
        old_id, canonical = max(entries, key=lambda item: len(item[1].get("showtimes", {})))
        canonical = {**canonical, "showtimes": dict(canonical.get("showtimes", {}))}
        for _, watch in entries:
            canonical["showtimes"].update(watch.get("showtimes", {}))
        canonical["id"] = movie_id
        canonical["name"] = canonical.get("movie") or canonical["name"]
        canonical["enabled"] = any(watch.get("enabled") for _, watch in entries)
        new_watches[movie_id] = canonical
        for source_id, source_watch in entries:
            id_map[source_id] = movie_id
            name_map[(source_watch["name"], str(source_watch["theatreId"]))] = (canonical["name"], str(canonical["theatreId"]))

    new_state = {**state, "watches": {}}
    for old_id, source in state.get("watches", {}).items():
        target_id = id_map.get(old_id, old_id)
        merge_state(new_state["watches"].setdefault(target_id, {}), source)

    new_available = {}
    for key, value in available.items():
        replacement = key
        for (old_name, old_theatre), (new_name, new_theatre) in name_map.items():
            prefix = f"{old_name}|{old_theatre}|"
            if key.startswith(prefix):
                replacement = f"{new_name}|{new_theatre}|{key[len(prefix):]}"
                break
        new_available[replacement] = value

    config["watches"] = new_watches
    write_json(config_path, config)
    write_json(state_path, new_state)
    write_json(available_path, new_available)
    return {"watches": len(new_watches), "merged": len(watches) - len(new_watches), "ids": sorted(new_watches)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    print(json.dumps(migrate(args.root)))
