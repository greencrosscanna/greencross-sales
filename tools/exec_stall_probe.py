#!/usr/bin/env python3
"""Measure the /exec STALL RATE — the instrument for "it's slow again".

WHY THIS EXISTS AS A FILE. Three times now ("60+sec on mobile", v2.592, v2.597, and again on
2026-09-16) the answer has turned on one number: what fraction of /exec requests simply fail to come
back. Each time it was measured with a throwaway script that was then lost, so the next session
could not re-run it and had only the previous session's conclusion to go on. A conclusion is not a
measurement. This is the throwaway, checked in.

WHAT IT MEASURES, AND WHAT IT CANNOT. Apps Script's /exec hop intermittently fails to return —
measured 2026-09-15 at 3.4% (6 of 174 fired SIX-WIDE) taking 11-60s while the requests beside them
answered in three. That is a Google-side flake outside this app's server work, so:

  * `?action=loadprobe` CANNOT SEE IT. loadprobe times the server's own execution; the stall happens
    outside the handler, so a clean loadprobe walk and a stalling load are perfectly consistent.
  * The route does not matter. This fires `action=libversion` — public, no secret, trivial work — on
    purpose: it isolates the HOP from anything the handler does. A slow reply here is the hop.
  * SIX AT A TIME, because that is the shape a real load fires and a load is only as fast as its
    slowest request. NOT because sequential requests are safe: the often-cited "25 of 25 clean
    sequentially" on 2026-09-15 expects 0.85 stalls at a 3.4% rate, so a clean 25 happens 42% of
    the time by chance. It establishes no concurrency threshold. Six is the load's shape, full stop.

WHAT THE ANSWER LICENSES. The app's only lever is how fast it gives up on a stalled request
(`gasFetchJson(url, null, CAPS)` in index.html — live [12000, 25000], settled [8000, 12000, 16000]).
Re-tune those only against a measured rate. If the rate is ~4% and the ceilings are already short,
the load is as fast as this app can make it and the next move is not in this repo.

USAGE
    python3 tools/exec_stall_probe.py                 # 40 rounds x 6 parallel = 240 requests
    python3 tools/exec_stall_probe.py --rounds 10     # quicker look
    python3 tools/exec_stall_probe.py --url <other /exec>

Stdlib only, so it runs anywhere python3 does.
"""

import argparse
import concurrent.futures
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# The deployment index.html hardcodes as DEFAULT_PROXY. Kept in sync by hand; --url overrides.
DEFAULT_EXEC = ("https://script.google.com/macros/s/"
                "AKfycbzju5HeWTGq_5uND_o6M-Gzdcy-lRQw7flOwzI013Me03SumhV8lYV_O_Z4-cIBn-lp/exec")

# Measured 2026-09-15 on this app's live /exec, six at a time: 6 stalls in 174 six-wide requests.
# Printed beside the fresh numbers so the output interprets itself instead of needing this file read
# alongside it.
#
# THE BASELINE AND THIS INSTRUMENT ARE NOT THE SAME EXPERIMENT, and that is worth knowing before
# comparing a fresh run to it. Those 174 were authenticated store-month pulls (store=...&
# phase=settled), so 2.5-3.5s of THIS APP's backend work sits inside every timing; this probe fires
# `libversion` precisely to remove that. A fresh six-wide libversion run is what would replace 3.4%
# honestly. (The same day's wider runs — 12/18/30 concurrent, 60 requests, >=6 stalls — are NOT in
# this rate and must not be averaged into it. CLAUDE.md, the v2.597 section, has the full ledger.)
BASELINE = {"median": 3.1, "p95": 4.1, "stall_pct": 3.4, "when": "2026-09-15", "n": 174}

# The per-attempt ceilings index.html actually allows a live half. A request slower than the first
# ceiling costs a retry; one slower than the sum costs the store its place in the load.
LIVE_CAPS_S = [12.0, 25.0]


def fetch(url, timeout):
    """One request. Returns (seconds, http_code_or_label). Never raises."""
    start = time.monotonic()
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            r.read()
            return time.monotonic() - start, r.status
    except urllib.error.HTTPError as e:
        return time.monotonic() - start, e.code
    except Exception as e:                                    # timeout, reset, DNS, TLS
        return time.monotonic() - start, type(e).__name__


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=DEFAULT_EXEC, help="the /exec to measure")
    ap.add_argument("--action", default="libversion",
                    help="route to call (default: libversion — public, trivial, isolates the hop)")
    ap.add_argument("--rounds", type=int, default=40, help="rounds of parallel requests")
    ap.add_argument("--parallel", type=int, default=6,
                    help="requests per round (6 = one per store, the shape a load fires)")
    ap.add_argument("--stall", type=float, default=10.0,
                    help="seconds at which a request counts as STALLED, not merely slow")
    ap.add_argument("--timeout", type=float, default=60.0, help="give up on one request after")
    ap.add_argument("--gap", type=float, default=1.0, help="seconds between rounds")
    args = ap.parse_args()

    url = args.url + ("&" if "?" in args.url else "?") + urllib.parse.urlencode(
        {"action": args.action})
    total = args.rounds * args.parallel
    print(f"\n{total} requests — {args.parallel} at a time x {args.rounds} rounds")
    print(f"  {url}\n")

    times, codes, round_max = [], [], []
    for rnd in range(args.rounds):
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.parallel) as pool:
            results = list(pool.map(lambda _: fetch(url, args.timeout), range(args.parallel)))
        secs = [s for s, _ in results]
        times.extend(secs)
        codes.extend(c for _, c in results)
        round_max.append(max(secs))
        # A round is what a reader actually waits for, so show the slowest in it, and flag stalls.
        marks = "".join("!" if s >= args.stall else "." for s in secs)
        print(f"  round {rnd + 1:3d}  slowest {max(secs):6.1f}s   {marks}"
              + ("   <- STALL" if max(secs) >= args.stall else ""))
        if rnd + 1 < args.rounds:
            time.sleep(args.gap)

    times.sort()
    stalls = [s for s in times if s >= args.stall]
    p95 = times[min(int(len(times) * 0.95), len(times) - 1)]
    bad_codes = sorted({c for c in codes if c != 200})

    print(f"\n{'':-<64}")
    print(f"  requests        {len(times)}")
    print(f"  median          {statistics.median(times):6.1f}s     "
          f"(baseline {BASELINE['median']}s, {BASELINE['when']})")
    print(f"  p95             {p95:6.1f}s     (baseline {BASELINE['p95']}s)")
    print(f"  worst           {times[-1]:6.1f}s")
    pct = 100.0 * len(stalls) / len(times)
    print(f"  STALLS >={args.stall:.0f}s     {len(stalls):4d}  = {pct:4.1f}%  "
          f"(baseline {BASELINE['stall_pct']}%, n={BASELINE['n']} six-wide)")
    if bad_codes:
        print(f"  non-200         {bad_codes}")

    # The number that decides a re-tune: a load fires ~16 requests, so the chance a load carries one.
    if times:
        carried = 1.0 - (1.0 - pct / 100.0) ** 16
        print(f"\n  a 16-request load carries a stall ~{100 * carried:.0f}% of the time")
        over_first = sum(1 for s in times if s > LIVE_CAPS_S[0])
        over_both = sum(1 for s in times if s > sum(LIVE_CAPS_S))
        print(f"  over the {LIVE_CAPS_S[0]:.0f}s first ceiling   {over_first:4d}"
              f"  ({100.0 * over_first / len(times):4.1f}%)  -> costs a retry")
        print(f"  over {sum(LIVE_CAPS_S):.0f}s total          {over_both:4d}"
              f"  ({100.0 * over_both / len(times):4.1f}%)  -> costs the store its place")
        print(f"  slowest request per round, median  {statistics.median(round_max):.1f}s"
              "   <- what a load actually waits for")

    print(f"\n  Ceilings live in index.html (gasFetchJson CAPS). Re-tune only against this rate;\n"
          f"  if the rate is ~4% and ceilings are already short, the remaining cost is Google's.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
