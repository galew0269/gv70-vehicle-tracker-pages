#!/usr/bin/env python3
"""
update_gv70_lease_feed.py
=========================

Refreshes feed/gv70_lease_feed.json with the latest 2026 Genesis Electrified GV70
lease values that can be detected from public source pages.

Design goals
------------
- Robust: never raises on a source failure. Each source is wrapped in try/except.
- Conservative: if parsing fails for a source, the previously known record is kept
  and the source is flagged ``status="stale"``. Numeric values are validated before
  being written.
- No secrets: only public HTTP GETs are made. No API keys, no auth.
- Stdlib only: uses urllib + re + json so the script runs on any GitHub Actions
  ``ubuntu-latest`` image without extra dependencies.

Exit codes
----------
- ``0`` always (so the workflow never fails because a public page shifted).
  Source-level outcomes are reflected in the JSON's per-offer ``status`` field
  and a brief summary is printed to stdout.

Usage
-----
    python scripts/update_gv70_lease_feed.py
    python scripts/update_gv70_lease_feed.py --feed-path feed/gv70_lease_feed.json
    python scripts/update_gv70_lease_feed.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_FEED_PATH = "feed/gv70_lease_feed.json"

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36 GV70LeaseTracker/1.0"
)

# Sources we attempt to read. Each entry has a ``key``, the ``url``, and a
# ``parse`` function that returns (monthly_payment, term_months, due_at_signing)
# or ``None`` if it could not extract values.
SOURCES: List[Dict[str, Any]] = []


def fetch(url: str, timeout: int = 20) -> Optional[str]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            charset = resp.headers.get_content_charset() or "utf-8"
            raw = resp.read()
            try:
                return raw.decode(charset, errors="replace")
            except LookupError:
                return raw.decode("utf-8", errors="replace")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
        print(f"[fetch] {url} failed: {exc}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

_MONEY_RE = re.compile(r"\$\s?(\d[\d,]{1,5})")
_MONTHS_RE = re.compile(r"(\d{2})\s*(?:-|\s)?\s*month", re.IGNORECASE)


def _ints(values: List[str]) -> List[int]:
    out: List[int] = []
    for v in values:
        try:
            out.append(int(str(v).replace(",", "").strip()))
        except (TypeError, ValueError):
            continue
    return out


def _validate_offer(monthly: Optional[int], term: Optional[int], due: Optional[int]) -> bool:
    """Sanity bounds — refuse to overwrite the feed with absurd values."""
    if monthly is None or not (200 <= monthly <= 3000):
        return False
    if term is not None and not (12 <= term <= 60):
        return False
    if due is not None and not (0 <= due <= 25000):
        return False
    return True


def _strip_html(html: str) -> str:
    # Cheap, dependency-free: drop scripts/styles, then tags.
    html = re.sub(r"(?is)<script.*?</script>", " ", html)
    html = re.sub(r"(?is)<style.*?</style>", " ", html)
    text = re.sub(r"(?is)<[^>]+>", " ", html)
    return re.sub(r"\s+", " ", text).strip()


def parse_generic_lease(html: str) -> Optional[Tuple[int, Optional[int], Optional[int]]]:
    """Best-effort parse: look for a /mo dollar value, a NN-month term, and a due-at-signing dollar value."""
    if not html:
        return None
    text = _strip_html(html)

    # Monthly: prefer "$NNN /mo" or "$NNN per month"
    monthly: Optional[int] = None
    m = re.search(r"\$\s?(\d{2,4})\s*(?:/|\s)?\s*(?:mo|month)", text, re.IGNORECASE)
    if m:
        monthly = _ints([m.group(1)])[0] if _ints([m.group(1)]) else None

    if monthly is None:
        # Fallback: any plausible monthly payment in the page
        candidates = [v for v in _ints(_MONEY_RE.findall(text)) if 200 <= v <= 3000]
        if candidates:
            monthly = min(candidates)

    term: Optional[int] = None
    tm = _MONTHS_RE.search(text)
    if tm:
        try:
            term = int(tm.group(1))
        except ValueError:
            term = None

    due: Optional[int] = None
    d = re.search(r"\$\s?([\d,]{3,7})\s*(?:due\s*at\s*signing|due)", text, re.IGNORECASE)
    if d:
        ints = _ints([d.group(1)])
        if ints:
            due = ints[0]

    if monthly is None:
        return None
    return monthly, term, due


# ---------------------------------------------------------------------------
# Source registration
# ---------------------------------------------------------------------------

def register_source(key: str, label: str, url: str, parser=parse_generic_lease) -> None:
    SOURCES.append({"key": key, "label": label, "url": url, "parser": parser})


register_source("genesis", "Genesis", "https://www.genesis.com/us/en/offers/electrified-gv70")
register_source("kbb",     "KBB",     "https://www.kbb.com/genesis/electrified-gv70/deals-incentives/")
register_source("truecar", "TrueCar", "https://www.truecar.com/genesis/electrified-gv70/lease/")
register_source("edmunds", "Edmunds", "https://www.edmunds.com/genesis-electrified-gv70-lease-deals/")


# ---------------------------------------------------------------------------
# Main update flow
# ---------------------------------------------------------------------------

def _index_offers(offers: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    return {str(o.get("source", "")).lower(): o for o in offers if isinstance(o, dict)}


def update_feed(feed_path: Path, dry_run: bool = False) -> Dict[str, Any]:
    if not feed_path.exists():
        print(f"[update] feed file not found at {feed_path}; nothing to update", file=sys.stderr)
        return {"changed": False, "reason": "missing-feed"}

    try:
        feed = json.loads(feed_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[update] could not parse existing feed: {exc}", file=sys.stderr)
        return {"changed": False, "reason": "bad-feed"}

    offers = feed.get("offers")
    if not isinstance(offers, list) or not offers:
        print("[update] feed has no offers list; aborting", file=sys.stderr)
        return {"changed": False, "reason": "no-offers"}

    by_source = _index_offers(offers)
    summary: List[str] = []
    any_change = False

    for src in SOURCES:
        key = src["key"]
        label = src["label"]
        url = src["url"]
        parser = src["parser"]

        # Match the offer record by label (case-insensitive) — falls back to key.
        offer = by_source.get(label.lower()) or by_source.get(key.lower())
        if offer is None:
            summary.append(f"{label}: no matching offer in feed; skipped")
            continue

        try:
            html = fetch(url)
            if not html:
                offer["status"] = "stale (fetch failed)"
                summary.append(f"{label}: fetch failed; kept previous values")
                continue

            parsed = parser(html)
            if not parsed:
                offer["status"] = "stale (parse failed)"
                summary.append(f"{label}: parse returned nothing; kept previous values")
                continue

            monthly, term, due = parsed
            if not _validate_offer(monthly, term, due):
                offer["status"] = "stale (out-of-range)"
                summary.append(f"{label}: parsed values out of bounds ({monthly},{term},{due}); kept previous")
                continue

            old_payment = offer.get("monthly_payment")
            offer["monthly_payment"] = int(monthly)
            if term is not None:
                offer["term_months"] = int(term)
            if due is not None:
                offer["due_at_signing"] = int(due)
            offer["status"] = "active"

            if old_payment != offer["monthly_payment"]:
                any_change = True
            summary.append(
                f"{label}: ok (${monthly}/mo, "
                f"{offer.get('term_months', '—')} mo, ${offer.get('due_at_signing', '—')} due)"
            )
        except Exception as exc:  # belt-and-braces: never let one source crash the run
            offer["status"] = "stale (error)"
            summary.append(f"{label}: unexpected error {exc.__class__.__name__}: {exc}")

        # Be polite to public sources.
        time.sleep(1.0)

    feed.setdefault("meta", {})
    feed["meta"]["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    feed["meta"].setdefault("vehicle", "2026 Genesis Electrified GV70")
    feed["meta"].setdefault("currency", "USD")
    feed["meta"]["last_run_summary"] = summary

    if dry_run:
        print("[update] dry-run; not writing feed")
        print("\n".join(summary))
        return {"changed": False, "reason": "dry-run", "summary": summary}

    try:
        feed_path.write_text(
            json.dumps(feed, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    except OSError as exc:
        print(f"[update] failed writing feed: {exc}", file=sys.stderr)
        return {"changed": False, "reason": "write-failed", "summary": summary}

    print("[update] feed written:", feed_path)
    print("\n".join(summary))
    return {"changed": any_change, "summary": summary}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Refresh GV70 lease feed JSON.")
    p.add_argument("--feed-path", default=DEFAULT_FEED_PATH, help="Path to gv70_lease_feed.json")
    p.add_argument("--dry-run", action="store_true", help="Parse sources but do not write the feed file")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parent.parent
    feed_path = (repo_root / args.feed_path).resolve()
    if not str(feed_path).startswith(str(repo_root)):
        print("[update] refusing to write outside repo root", file=sys.stderr)
        return 0  # never fail the workflow

    try:
        update_feed(feed_path, dry_run=args.dry_run)
    except Exception as exc:  # last-resort guard
        print(f"[update] top-level error suppressed: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
