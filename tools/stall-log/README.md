# Raw /exec stall-probe runs

Written here by the two scheduled tasks `sales-stall-probe-morning` and
`sales-stall-probe-afternoon` (in `~/.claude/scheduled-tasks/`), one file per run, named
`YYYY-MM-DD-HHMM.txt`. Each file is the **complete** `tools/exec_stall_probe.py` output,
round lines included.

## Why the whole output and not the summary

Because of what the 2026-09-17 run found. The summary line said `6 stalls = 2.5%`, which reads as
six unlucky requests scattered through 240. The round lines said something else entirely:

```
round 12  slowest 27.0s  !!!!!!   <- STALL
```

All six stalls were in **one round**, and they were all six requests of that round. Every other
round was clean. Under the independent per-request model that gives 1.6 × 10⁻¹⁰ — so the failure is
not a dropped request, it is the endpoint going away for ~27 seconds and taking everything in flight
with it. **The rate and the shape lead to opposite conclusions, and only the round lines carry the
shape.** A summary-only log would have thrown away the finding.

This is the same lesson twice over: the 2026-09-15 numbers were sorted before storage, so nothing
could place a stall in time, and every later session had to argue from a percentage. Keep the rows.

## The question these runs exist to answer

**How long is a window, and how often does one happen?** One observation is 27s. The ceiling that
would ride one out — and whether a later retry beats a third attempt — depends entirely on that
distribution. **Nothing should be re-tuned until several runs across several days and hours are in
here.** Tuning a ceiling on a single measurement is the v2.592 mistake, and this repo has now
recorded it three times.

## Reading a file

`!` in a round line is a request that took ≥10s; `.` is one that did not. Six marks per round, in
completion order within that round. A whole round of `!` is a window. Scattered single `!` across
many rounds would be the independent model, and would mean today's finding does not generalize —
**that is the result worth watching for**, because it is the one that would overturn it.

Files here are gitignored so an accumulating log never dirties the tree; `gx-preflight` tests
against HEAD rather than the working tree the moment `git status` is non-empty. A run worth citing
gets committed deliberately, beside the CLAUDE.md entry that cites it.
