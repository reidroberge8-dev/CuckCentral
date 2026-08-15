#!/usr/bin/env python3
"""Bake ADP and current injury-status fields into data/players.json.

Data sources (both free, no login required):
  - ADP: FantasyFootballCalculator.com public API (12-team PPR mock drafts).
  - Injury status: Sleeper's public NFL players API (this is a *current*
    designation - Questionable/Out/IR/PUP/etc - not a season-long injury
    risk prediction; there is no free equivalent of Draft Sharks'
    proprietary injury-risk model, so this is the honest substitute).

This is a one-time bake (same pattern as the Mike Clay projections already
in players.json) rather than a live client-side fetch, because:
  - FantasyFootballCalculator's API has no CORS headers, so it can't be
    fetched directly from a browser running on a different origin
    (GitHub Pages).
  - Sleeper's full player list is ~12,000 entries / several MB - too heavy
    to make every visitor's browser download on every page load, so it's
    filtered down to just the players already in our pool.

Re-run this script whenever you want fresher ADP/injury data (e.g. weekly
during draft season), then commit the updated data/players.json.
"""
import json
import re
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PLAYERS_PATH = REPO / "data" / "players.json"

FFC_ADP_URL = "https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=12&year=2026"
SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl"

FANTASY_POS = {"QB", "RB", "WR", "TE"}


def normalize_name(raw):
    """Must stay identical to normalizeName() in app.js."""
    if not raw:
        return ""
    s = raw.lower()
    s = s.replace(".", "")
    s = s.replace("'", "")
    s = re.sub(r"\s+(jr|sr|ii|iii|iv|v)\.?$", "", s)
    s = re.sub(r"[^a-z0-9\s]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def main():
    players = json.loads(PLAYERS_PATH.read_text(encoding="utf-8"))

    # ---- ADP ----
    ffc = fetch_json(FFC_ADP_URL)
    adp_by_key = {}
    for p in ffc["players"]:
        key = (normalize_name(p["name"]), p["position"])
        adp_by_key[key] = p["adp"]

    adp_matched = 0
    for p in players:
        if p["pos"] not in FANTASY_POS:
            continue
        key = (normalize_name(p["name"]), p["pos"])
        p["adp"] = adp_by_key.get(key)
        if p["adp"] is not None:
            adp_matched += 1

    # ---- Injury status ----
    sleeper = fetch_json(SLEEPER_PLAYERS_URL)
    injury_by_key = {}
    for sp in sleeper.values():
        pos = sp.get("position")
        if pos not in FANTASY_POS:
            continue
        name = sp.get("full_name")
        if not name:
            continue
        key = (normalize_name(name), pos)
        status = sp.get("injury_status")
        if status:
            injury_by_key[key] = {
                "status": status,
                "bodyPart": sp.get("injury_body_part"),
            }

    injury_matched = 0
    for p in players:
        if p["pos"] not in FANTASY_POS:
            continue
        key = (normalize_name(p["name"]), p["pos"])
        info = injury_by_key.get(key)
        p["injuryStatus"] = info["status"] if info else None
        p["injuryBodyPart"] = info["bodyPart"] if info else None
        if info:
            injury_matched += 1

    PLAYERS_PATH.write_text(json.dumps(players, indent=None), encoding="utf-8")
    fantasy_total = sum(1 for p in players if p["pos"] in FANTASY_POS)
    print(f"Fantasy-relevant players: {fantasy_total}")
    print(f"ADP matched: {adp_matched} / {fantasy_total}")
    print(f"Injury status matched (currently banged up): {injury_matched} / {fantasy_total}")


if __name__ == "__main__":
    main()
