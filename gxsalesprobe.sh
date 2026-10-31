#!/usr/bin/env bash
# ─── gxsalesprobe — call one of Sales' deploy-secret routes from the CLI ─────────────────────────
#
#   ./gxsalesprobe.sh gxpin                          which GXCore the LIVE deployment runs
#   ./gxsalesprobe.sh authprobe [user=shawn]         the write guard's recent decisions
#   ./gxsalesprobe.sh goalprobe date=2026-10-01      (and goalrangeprobe, budgetprobe, expbreakprobe,
#                                                     pnlprobe, reconprobe — the post-re-pin probes)
#   ./gxsalesprobe.sh guardmode mode=log             ROLLBACK the write guard (mode=log|enforce|off)
#
# Only the routes named below are accepted. All are reads except `guardmode`, which changes the live
# write guard and must only be run on Sky's explicit instruction (CLAUDE.md, "The write guard").
#
# WHY THIS EXISTS: these routes need the deploy secret, and an inline `curl … secret=$(cat …)` is both
# an approval prompt every time and a secret in the process list. This is the same handling as the
# hub's gxstats.sh and Crew's gxcrewstats.sh: the secret rides on curl's stdin as a config file, never
# in argv, and the printed reply is scrubbed of it as a backstop.
set -uo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"

usage() { sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
[ $# -ge 1 ] || usage
ACTION="$1"; shift
case "$ACTION" in
  gxpin|authprobe|goalprobe|goalrangeprobe|budgetprobe|expbreakprobe|pnlprobe|reconprobe) ;;
  guardmode)
    case " $* " in
      *" mode=log "*|*" mode=enforce "*|*" mode=off "*) ;;
      *) echo "✗ guardmode needs mode=log, mode=enforce or mode=off"; exit 1 ;;
    esac
    echo "! guardmode CHANGES the live write guard — only on Sky's explicit instruction." >&2 ;;
  *) echo "✗ unknown or unsupported action: $ACTION"; usage ;;
esac
for kv in "$@"; do
  case "$kv" in
    secret=*|action=*) echo "✗ $kv is set by this script, not by you"; exit 1 ;;
    [a-z_]*=*) ;;
    *) echo "✗ extra arguments are key=value: $kv"; exit 1 ;;
  esac
done

# The engine URL is READ from index.html (DEFAULT_PROXY — the deployment gxengine.sh redeploys in
# place), never retyped here, and checked for shape before the secret goes near it.
ENGINE="$(python3 -c '
import re, sys
try:
    src = open("index.html", encoding="utf-8").read()
except Exception:
    sys.exit(0)
m = re.search(r"DEFAULT_PROXY\s*=\s*[\x27\x22](https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec)[\x27\x22]", src)
print(m.group(1) if m else "")
' 2>/dev/null)"
[ -n "$ENGINE" ] || { echo "✗ could not read DEFAULT_PROXY from index.html — run this from the greencross-sales repo"; exit 1; }

SECRET_FILE=".gx_deploy_secret"
[ -f "$SECRET_FILE" ] || { echo "✗ no $SECRET_FILE here — run this from the greencross-sales repo root"; exit 1; }
SECRET="$(tr -d '\r\n' < "$SECRET_FILE")"
[ -n "$SECRET" ] || { echo "✗ $SECRET_FILE is empty"; exit 1; }

ARGS=(--data-urlencode "action=$ACTION")
for kv in "$@"; do ARGS+=(--data-urlencode "$kv"); done

# Growing timeouts: the /exec hop stalls in windows, and a reply that is not JSON is Google's bounce
# page, not an answer.
resp=""
for t in 30 45 60 90; do
  resp="$(printf '%s\n' "url = \"$ENGINE\"" "--data-urlencode secret=$SECRET" \
          | curl -K - --get --silent --location --max-time "$t" "${ARGS[@]}" 2>/dev/null)"
  case "$resp" in \{*|\[*) break ;; esac
  # guardmode is a write: never retry it blind.
  [ "$ACTION" = guardmode ] && break
  sleep 2
done

printf '%s\n' "$resp" | GXSALESPROBE_SECRET="$SECRET" python3 -c '
import sys, os
sys.stdout.write(sys.stdin.read().replace(os.environ["GXSALESPROBE_SECRET"], "<secret>"))
'
case "$resp" in \{*|\[*) exit 0 ;; *) echo "✗ the engine did not return JSON (the /exec hop stalls — re-run)"; exit 2 ;; esac
