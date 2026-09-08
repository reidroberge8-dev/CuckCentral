#!/usr/bin/env python3
"""Bake ADP (and optionally injury risk) into data/players.json.

Data sources:
  - ADP: FantasyFootballCalculator.com public API (12-team PPR mock drafts).
  - Injury Risk: Draft Sharks Injury Predictor (manual paste into
    scripts/enrich_adp_injury.py; not available via public API). The
    injuryRisk field is set separately by parse_draftsharks_risk().

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
DRAFT_SHARKS_URL = "https://www.draftsharks.com/injury-predictor/"

RISK_LABELS = {1: "Very Low Risk", 2: "Low Risk", 3: "Medium Risk", 4: "High Risk", 5: "Very High Risk"}

FANTASY_POS = {"QB", "RB", "WR", "TE"}

# Name aliases: maps (normalize_name(our_name), pos) -> normalize_name(ffc_name)
# Use when the display name we want differs from what FFC uses.
# Ken Walker III is now named "Kenneth Walker III" in players.json (direct match).
NAME_ALIASES = {
    ("kenneth gainwell", "RB"): "kenny gainwell",   # ESPN: Kenneth, FFC: Kenny
    ("chigoziem okonkwo", "TE"): "chig okonkwo",    # ESPN: full name, FFC: nickname
    ("cameron ward", "QB"):      "cam ward",         # ESPN: Cameron, FFC: Cam
}


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


def fetch_draftsharks_risk():
    """Scrape Draft Sharks injury-predictor page for positional_risk_group per
    player. No public API for this - the page embeds a large JSON blob with
    a nested {player fields..., sipPlayerProfile: {positional_risk_group}}
    structure per player.

    IMPORTANT: join by player_id, not by a text lookback from the risk-group
    offset. Players with long injury histories (many sipInjuries entries) push
    their sipPlayerProfile thousands of characters past their name - a
    lookback window will silently miss them (this bit us for Ken Walker III).
    """
    req = urllib.request.Request(DRAFT_SHARKS_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        text = resp.read().decode("utf-8", errors="replace")

    # Map player_id -> (name, pos) from the "id/first_name/last_name/position" records.
    player_info = {}
    for m in re.finditer(
        r'\{"id":(\d+),"first_name":"([^"]+)","last_name":"([^"]+)","position":"([^"]+)"',
        text,
    ):
        pid, first, last, pos = m.group(1), m.group(2), m.group(3), m.group(4)
        if pos in FANTASY_POS:
            player_info[pid] = (f"{first} {last}", pos)

    # Map player_id -> positional_risk_group from sipPlayerProfile blocks.
    risk_by_pid = {}
    for m in re.finditer(
        r'"sipPlayerProfile":\{"player_id":(\d+),[^}]*?"positional_risk_group":(\d+)',
        text,
    ):
        risk_by_pid[m.group(1)] = int(m.group(2))

    risk_by_key = {}
    for pid, (name, pos) in player_info.items():
        rg = risk_by_pid.get(pid)
        if rg in RISK_LABELS:
            risk_by_key[(normalize_name(name), pos)] = RISK_LABELS[rg]
    return risk_by_key


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
        norm = normalize_name(p["name"])
        pos = p["pos"]
        # Apply alias if defined (display name differs from FFC name)
        lookup_norm = NAME_ALIASES.get((norm, pos), norm)
        key = (lookup_norm, pos)
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
        norm = normalize_name(p["name"])
        pos = p["pos"]
        lookup_norm = NAME_ALIASES.get((norm, pos), norm)
        key = (lookup_norm, pos)
        info = injury_by_key.get(key)
        p["injuryStatus"] = info["status"] if info else None
        p["injuryBodyPart"] = info["bodyPart"] if info else None
        if info:
            injury_matched += 1

    # ---- Injury risk (Draft Sharks positional_risk_group) ----
    risk_by_key = fetch_draftsharks_risk()
    risk_matched = 0
    for p in players:
        if p["pos"] not in FANTASY_POS:
            continue
        norm = normalize_name(p["name"])
        pos = p["pos"]
        lookup_norm = NAME_ALIASES.get((norm, pos), norm)
        key = (lookup_norm, pos)
        risk = risk_by_key.get(key)
        if risk:
            p["injuryRisk"] = risk
            risk_matched += 1

    PLAYERS_PATH.write_text(json.dumps(players, indent=None), encoding="utf-8")
    fantasy_total = sum(1 for p in players if p["pos"] in FANTASY_POS)
    print(f"Fantasy-relevant players: {fantasy_total}")
    print(f"ADP matched: {adp_matched} / {fantasy_total}")
    print(f"Injury status matched (currently banged up): {injury_matched} / {fantasy_total}")
    print(f"Injury risk matched (Draft Sharks): {risk_matched} / {fantasy_total}")


if __name__ == "__main__":
    main()
