---
name: eng-debug-systematic
description: "Use when the user reports a bug, a failing test, a crash or \"it works on my machine\", says \"why is this broken\" or \"debug this\", or a first fix attempt did not work: reproduce, narrow, test one hypothesis at a time, fix the root cause, add a regression test."
---

# Debug systematically

Guessing and patching feels fast and usually is not. The rule here: do not
change production code until you can say, with evidence, why the bug happens.

## 1. Pin down the symptom

Write down, in a few lines:

- what was expected and what happened instead (exact error text, wrong value);
- where: command, input, environment (OS, runtime version, branch, config);
- since when: did it ever work? What changed since (a commit, a dependency, data)?

Read the whole error and stack trace. The first frame in *your* code is usually
the place to start, not the top of the trace.

## 2. Reproduce it

- Get a reproduction you can run on demand, as small and fast as possible: one
  test, one script, one request.
- If it is intermittent, find what makes it vary (timing, ordering, data,
  concurrency). Run it a bounded number of times (say 20) and record the rate.
- If you cannot reproduce it after a fair try, stop and tell the user what you
  tried and what information would help (logs, input, versions). Do not ship a
  speculative fix as if it were a confirmed one.

Where possible, capture the reproduction as a failing test now; it becomes the
regression test later.

## 3. Narrow it down

Shrink the space before theorising:

- **Input:** cut the failing input in half until the smallest failing case remains.
- **Code path:** add temporary logging or use a debugger at the boundaries
  (input in, output out) and move inward toward where the value first goes wrong.
- **History:** if it used to work, `git bisect` between a good and a bad commit
  with the reproduction as the check. Bisect checks out old commits, so run it
  only on a clean tree (inside SoA, one you have claimed with `soa-work`) and
  finish with `git bisect reset`.
- **Environment:** compare a working and a failing setup one difference at a time.

## 4. Hypothesis, then experiment

Keep a short running log:

```
H1: cache returns stale entry after TTL      test: set TTL=1s, wait 2s  result: fresh - rejected
H2: timezone offset applied twice in parse() test: parse at UTC+0 vs +9 result: off by 9h - confirmed
```

- One hypothesis at a time, with an experiment whose outcome could prove it wrong.
- Change one thing per experiment, and undo experiments that did not pan out.
- After three rejected hypotheses, step back: re-read the symptom, check your
  assumptions (is this the code that actually runs? stale build, cache, wrong
  config file, different binary on PATH?).
- If you are still stuck, report the log so far to the user rather than looping.

## 5. Fix the root cause

- Fix where the wrong value is first produced, not where it is finally noticed.
  A `try/except` or null check at the crash site usually hides the bug.
- Look for the same mistake elsewhere (same helper, copied code) and mention it;
  fix those too only if they are in scope.
- Keep the fix minimal. Refactors go in a separate change.
- Inside SoA (`SOA_WEB_TAB` is set), claim the scope with `soa-work` before a
  multi-file fix.

## 6. Prove it with a regression test

- The test reproduces the original symptom, fails without the fix and passes
  with it. Check both directions (revert the fix briefly, or run it before).
- Name it after the behaviour ("parse keeps the offset once"), not the ticket.
- Run the full relevant suite. Remove temporary logging and debug flags.

## Ecosystem notes

- **JS/TS:** `node --inspect-brk`, or `DEBUG=*` for libraries using `debug`;
  watch for unawaited promises and mixed ESM/CJS copies of one module.
- **Python:** `python -X dev`, `breakpoint()`, `pytest -x --pdb`; check which
  interpreter and venv actually run.
- **Go:** `go test -race` for flaky concurrency; `dlv test` to step.
- **Swift:** run with Address/Thread Sanitizer; `lldb` breakpoints on the throw.
- **Rust:** `RUST_BACKTRACE=1`; `cargo test -- --nocapture` to see output.

## Done means

- [ ] The root cause is stated in one or two sentences with the evidence.
- [ ] A regression test fails without the fix and passes with it.
- [ ] Full suite passes; temporary instrumentation removed.
- [ ] Report: symptom, cause, fix, test, and any related risks found.
- [ ] Any `soa-work` claim released. Commit only if the user asked.
