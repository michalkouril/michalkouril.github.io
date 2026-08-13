#!/usr/bin/env python3
"""Check that every outgoing link in the site's HTML is still alive.

    python3 tools/check-links.py            # check every .html in the repo
    python3 tools/check-links.py index.html # check specific files

Exit status is 0 when nothing is broken, 1 when something is. Links that are
merely refusing robots (publishers, LinkedIn) are reported but do not fail the
run -- they are reachable in a browser, and failing on them would train you to
ignore this check.
"""

import concurrent.futures
import pathlib
import socket
import re
import sys
import time
import urllib.error
import urllib.request

TIMEOUT = 15
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " \
     "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"

# Hosts that answer humans but block automated requests. A 403/405/999 from
# these is expected, not a broken link.
BOT_BLOCKED = {403, 405, 429, 999}

# Pseudo-status for a host that is reachable but too slow to answer in time.
# Slow is not broken: some research hosts routinely take 20s+, and failing on
# them would block commits over someone else's server load.
TIMEOUT_STATUS = -1

C = {"ok": "\033[32m", "warn": "\033[33m", "bad": "\033[31m",
     "dim": "\033[2m", "off": "\033[0m"}
if not sys.stdout.isatty():
    C = dict.fromkeys(C, "")


def find_links(paths):
    """Map each absolute http(s) URL to the files that reference it."""
    links = {}
    for path in paths:
        html = path.read_text(encoding="utf-8", errors="replace")
        for url in re.findall(r'(?:href|src)="(https?://[^"]+)"', html):
            links.setdefault(url, set()).add(path.name)
    return links


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_no_redirect = urllib.request.build_opener(_NoRedirect)


def check_doi(url):
    """A DOI is good if doi.org resolves it, whatever the publisher then does.

    Publishers block robots constantly -- Taylor & Francis alone has answered
    403, 404 and 503 for the same valid DOI. Following through to them tells us
    nothing about the link, so stop at the redirect.
    """
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with _no_redirect.open(req, timeout=TIMEOUT) as r:
            return url, r.status, ""
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400:
            return url, e.code, "DOI resolves"
        return url, e.code, e.reason or ""
    except Exception as e:
        reason = getattr(e, "reason", e)
        if isinstance(reason, (TimeoutError, socket.timeout)):
            return url, TIMEOUT_STATUS, "no response in %ds" % TIMEOUT
        return url, 0, type(e).__name__


def check(url, _attempt=1):
    if url.startswith(("https://doi.org/", "http://doi.org/", "https://dx.doi.org/")):
        return check_doi(url)

    """Return (url, status, note). status is an int, or 0 if unreachable.

    Server errors and connection failures get one retry, so that a flaky
    upstream does not block a commit or turn the run red for no reason.
    """
    for method in ("HEAD", "GET"):
        req = urllib.request.Request(url, method=method, headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        })
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return url, r.status, ""
        except urllib.error.HTTPError as e:
            if method == "HEAD" and e.code in (403, 405, 501):
                continue  # some servers only dislike HEAD; retry as GET
            if e.code >= 500 and _attempt == 1:
                time.sleep(3)
                return check(url, _attempt + 1)
            return url, e.code, e.reason or ""
        except Exception as e:  # timeout, DNS, TLS, connection refused
            reason = getattr(e, "reason", e)
            timed_out = isinstance(reason, (TimeoutError, socket.timeout))
            if method == "HEAD" and not timed_out:
                continue
            if _attempt == 1 and not timed_out:
                time.sleep(3)
                return check(url, _attempt + 1)
            if timed_out:
                return url, TIMEOUT_STATUS, "no response in %ds" % TIMEOUT
            return url, 0, type(e).__name__
    return url, 0, "unreachable"


def main(argv):
    root = pathlib.Path(__file__).resolve().parent.parent
    if argv:
        paths = [pathlib.Path(a).resolve() for a in argv]
    else:
        paths = sorted(p for p in root.rglob("*.html")
                       if ".git" not in p.parts)
    paths = [p for p in paths if p.is_file()]
    if not paths:
        print("no HTML files to check")
        return 0

    links = find_links(paths)
    print(f"Checking {len(links)} outgoing links "
          f"across {len(paths)} file(s)...\n")

    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        results = sorted(pool.map(check, links), key=lambda r: r[0])

    # If nothing at all resolved, this machine is offline. Say so rather than
    # reporting every link on the site as broken.
    if results and all(s == 0 for _, s, _ in results):
        print(f"{C['warn']}No link resolved -- this machine looks offline. "
              f"Skipping the check.{C['off']}")
        return 0

    broken, blocked, slow = [], [], []
    for url, status, note in results:
        where = ", ".join(sorted(links[url]))
        if 200 <= status < 400:
            tag, col = f"{status}", C["ok"]
        elif status == TIMEOUT_STATUS:
            tag, col = "slow", C["warn"]
            slow.append((url, note, where))
        elif status in BOT_BLOCKED:
            tag, col = f"{status} bot-blocked", C["warn"]
            blocked.append((url, status, where))
        else:
            tag, col = (f"{status} {note}".strip() if status
                        else f"unreachable ({note})"), C["bad"]
            broken.append((url, tag, where))
        print(f"  {col}{tag:<22}{C['off']} {url}")

    print()
    if blocked:
        print(f"{C['warn']}{len(blocked)} link(s) refused automated requests "
              f"(fine in a browser):{C['off']}")
        for url, status, where in blocked:
            print(f"    {status}  {url}  {C['dim']}[{where}]{C['off']}")
        print()
    if slow:
        print(f"{C['warn']}{len(slow)} link(s) too slow to verify "
              f"(reachable, just sluggish):{C['off']}")
        for url, note, where in slow:
            print(f"    {url}  {C['dim']}[{note}]{C['off']}")
        print()
    if broken:
        print(f"{C['bad']}{len(broken)} BROKEN link(s):{C['off']}")
        for url, tag, where in broken:
            print(f"    {tag}  {url}  {C['dim']}[{where}]{C['off']}")
        return 1

    print(f"{C['ok']}All links alive.{C['off']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
