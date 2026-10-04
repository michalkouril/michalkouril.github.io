#!/usr/bin/env python3
"""Refresh the Google Scholar numbers in the page header.

    python3 tools/update-stats.py            # fetch Scholar, rewrite index.html
    python3 tools/update-stats.py --dry-run  # show what would change

Updates the citations, h-index and i10-index in the `.metrics` block of
index.html, and the month next to "Google Scholar". The file is only written
when the visible text actually changes.

Exit status is 0 when the page is up to date (changed or not), 1 when the
numbers couldn't be refreshed: Scholar blocked the request, the page layout
changed, or the new numbers look wrong (Scholar counts never really go down,
so a big drop means we parsed the wrong thing). The page is left alone then.
"""

import datetime
import pathlib
import re
import sys
import urllib.request

PROFILE = "https://scholar.google.com/citations?user=duTVse8AAAAJ&hl=en"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " \
     "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
PAGE = pathlib.Path(__file__).resolve().parent.parent / "index.html"
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()

# Each pattern must match exactly once in index.html. Group 1 is the value.
FIELDS = {
    "citations": r"<b>([\d,]+)</b> citations",
    "h-index": r"<b>(\d+)</b> h-index",
    "i10-index": r"<b>(\d+)</b> i10-index",
    "date": r"Google Scholar</a>, ([A-Z][a-z]{2} \d{4})</span>",
}


def fetch_scholar():
    """Return {citations, h-index, i10-index} from the public profile."""
    req = urllib.request.Request(PROFILE, headers={"User-Agent": UA,
                                                   "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        html = resp.read().decode("utf-8", errors="replace")
    # The stats table lists each metric twice: all time, then the last five
    # years. We want the all-time column.
    cells = re.findall(r'class="gsc_rsb_std">(\d+)<', html)
    if len(cells) != 6:
        raise ValueError(f"expected 6 stats cells, found {len(cells)} "
                         "(blocked by a CAPTCHA, or the layout changed)")
    return {"citations": int(cells[0]), "h-index": int(cells[2]),
            "i10-index": int(cells[4])}


def sane(old, new):
    """Reject numbers that fell -- a sign we scraped the wrong thing."""
    if new["citations"] < old["citations"] * 0.95:
        return f"citations fell from {old['citations']} to {new['citations']}"
    for k in ("h-index", "i10-index"):
        if new[k] < old[k] - 1:
            return f"{k} fell from {old[k]} to {new[k]}"
    return None


def main(argv):
    dry_run = "--dry-run" in argv
    html = PAGE.read_text(encoding="utf-8")

    old = {}
    for name, pat in FIELDS.items():
        found = re.findall(pat, html)
        if len(found) != 1:
            print(f"index.html: expected one {name} value, found {len(found)}")
            return 1
        old[name] = found[0]
    old_nums = {k: int(old[k].replace(",", "")) for k in FIELDS if k != "date"}

    try:
        new = fetch_scholar()
    except Exception as e:  # network error, HTTP 429, CAPTCHA page, ...
        print(f"Could not read Google Scholar: {type(e).__name__}: {e}")
        return 1
    problem = sane(old_nums, new)
    if problem:
        print(f"Not updating: {problem}.")
        return 1

    today = datetime.date.today()
    values = {"citations": f"{new['citations']:,}",
              "h-index": str(new["h-index"]),
              "i10-index": str(new["i10-index"]),
              "date": f"{MONTHS[today.month - 1]} {today.year}"}
    for name, pat in FIELDS.items():
        print(f"  {name:<10} {old[name]:>8} -> {values[name]}")
        html = re.sub(pat, lambda m: m.group(0).replace(m.group(1),
                                                         values[name]), html)

    if html == PAGE.read_text(encoding="utf-8"):
        print("Already up to date.")
    elif dry_run:
        print("Dry run: index.html not written.")
    else:
        PAGE.write_text(html, encoding="utf-8")
        print("index.html updated.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
