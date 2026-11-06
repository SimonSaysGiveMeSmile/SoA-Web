---
name: eng-perf-profile
description: "Use when the user says \"this is slow\", \"make it faster\", \"why is memory so high?\", or wants a speed-up proven: measure a baseline, profile to find the real hotspot, change one thing at a time, and re-measure."
---

# Measure, then optimise

Guessing where time goes is wrong more often than it is right. The procedure
is: agree on a number, find where it is spent, change one thing, check the
number again. Stop when the target is met or the next gain is lost in noise.

## 1. Pin down the question

Before touching code, write these down (in the reply or a scratch note):

- **Operation:** the exact thing that is slow (a request, a CLI command, a
  page load, a test suite, a batch job).
- **Metric:** wall time, p50/p95 latency, throughput, peak memory, CPU,
  bundle size, cost per run. Pick one primary metric.
- **Target:** "under 200 ms p95" or "half of today". If the user has none,
  propose one and say it is a proposal.
- **Correctness gate:** the tests or output comparison that must stay green.
- **Budget:** how many attempts or how much time you will spend before
  reporting back. Default to a handful of variants, not an open-ended search.

## 2. Baseline

- Use realistic input: production-like data size and shape, a warm cache if
  production is warm, a cold one if users hit it cold.
- Run it several times (5 or more for anything under a few seconds) and record
  the median and spread. A single run is an anecdote.
- Keep the machine quiet. Inside SoA other agents share the CPU, so note the
  load (`uptime`) next to each result and re-run when it spikes.
- Save the exact command so every later measurement uses it unchanged.

## 3. Profile to find the hotspot

Measure where the time goes before forming a theory.

- **JS/TS (Node):** `node --cpu-prof script.js` then open the `.cpuprofile`
  in Chrome DevTools; `--heap-prof` for memory. Browser: the Performance panel
  and Lighthouse.
- **Python:** `python -m cProfile -o out.prof script.py`, read with `pstats`;
  `tracemalloc` for memory. A sampling profiler such as py-spy if installed.
- **Go:** `go test -bench . -cpuprofile cpu.out`, then `go tool pprof cpu.out`;
  `-memprofile` for allocations.
- **Swift:** Instruments (Time Profiler, Allocations) on a Release build.
- **Rust:** `cargo bench` or a release build under `perf`/`samply`; debug
  builds are not representative.
- **Databases:** `EXPLAIN ANALYZE` the slow query; count queries per request.

Use what the project already has. Do not install profilers globally or add
dependencies without asking.

Read the profile for the top few entries by self time and by inclusive time.
Common culprits: repeated work inside a loop, N+1 queries, serialising large
objects, synchronous I/O, missing indexes, allocation churn, needless
re-renders.

## 4. One change at a time

For each hypothesis:

1. State it: "parsing the config on every request costs ~40% of the time".
2. Make the smallest change that tests it.
3. Run the correctness gate. A faster wrong answer is rejected.
4. Re-measure with the same command and input.
5. Keep it only if the gain is clearly larger than the run-to-run spread;
   otherwise revert it.

Track the attempts in a small table:

```text
variant        | hypothesis                 | median  | spread | correct | kept
baseline       | —                          | 1.84 s  | ±0.05  | yes     | —
cache-config   | config parse per request   | 1.12 s  | ±0.04  | yes     | yes
parallel-io    | sequential fetches         | 1.10 s  | ±0.20  | yes     | no (noise)
```

## 5. When to stop

- The target is met.
- Two attempts in a row land within noise.
- The next idea needs an architectural change: report it as a recommendation
  instead of starting it.
- The budget from step 1 is spent.

Never loop on "a bit faster" without one of these limits.

## Report

- Baseline vs final on the primary metric, with the command used.
- What the profile showed and which change produced which gain.
- What was tried and rejected, briefly.
- Any trade-off introduced (memory for speed, cache staleness, complexity).

## Done means

- Before/after numbers come from the same command, input and conditions.
- Correctness tests still pass.
- Only changes that earned their gain are kept; the rest are reverted.
- Inside SoA (`SOA_WEB_TAB` set), claim the files you change with
  `soa-work claim <scope>` before editing several of them, and release after.
