---
name: eng-test-first
description: "Use when the user says \"TDD\", \"test first\" or \"write the test before the code\", or asks for new behaviour (or a fix whose cause is already known) pinned by a test: write one failing test, make it pass with the smallest change, then tidy. Unknown cause: eng-debug-systematic."
---

# Test first: red, green, tidy

One behaviour at a time. A test that has never failed has not proven anything,
so the failure you see first is part of the evidence.

This skill is for building a behaviour you already understand. If you do not
yet know *why* something is broken, use `eng-debug-systematic` first. If the
goal is raising a coverage number on existing code, use `eng-test-gaps`.

## Before you start

- Find how the project already runs tests (`package.json` scripts, `Makefile`,
  `pyproject.toml`, CI workflow) and use that command. Do not add a new test
  framework unless the user asks.
- Run the existing suite once so you know its baseline. Pre-existing failures
  are noted, not fixed silently as part of this work.
- Inside SoA (`SOA_WEB_TAB` is set), claim the scope with `soa-work` before a
  multi-file change (see `soa-work-claims`).
- Write down the behaviour as one sentence a user would recognise:
  "an expired token is rejected with 401", not "test validateToken".

## The cycle

### 1. Red: one failing test

- Put it next to the existing tests for that module, in the same style.
- Name it after the behaviour, and make the assertion about observable output
  (a return value, a response, a file written), not about private calls.
- Run **only that test** and read the failure. It must fail for the reason you
  expect: an assertion on the missing behaviour. A failure from a typo, an
  import error or a missing fixture is not red yet; fix the test and rerun.
- For a bug fix, the failing test reproduces the bug as reported.

### 2. Green: the smallest change that passes

- Change production code only as much as this test demands. Hard-coding is
  acceptable for a moment if the next test will force the general version.
- Rerun the single test, then the surrounding file or package.
- If it still fails after two honest attempts, stop and re-read the failure
  instead of piling on changes. The test, or your understanding, may be wrong.

### 3. Tidy: refactor with the tests green

- Remove duplication, rename for clarity, extract a helper, in production and
  test code alike.
- Behaviour does not change in this step. Rerun after each refactor.
- Keep it proportional: tidy what you touched, not the whole module.

Then pick the next behaviour (an edge case, an error path) and repeat. Stop when
the behaviours the user asked for are all pinned; do not invent extra scope.

## Choosing the next test

Work from the simplest case outward:

1. the happy path with ordinary input;
2. boundaries: empty, zero, one, maximum, off-by-one;
3. invalid input and the error the caller should see;
4. the interactions that matter (persistence, a network boundary) with a fake
   at the edge, not a mock of every internal function.

## Good tests, briefly

- Deterministic: no real clock, randomness or network without control. Inject
  the clock, seed the RNG, fake the HTTP client.
- Independent: each test sets up its own state and can run alone or in any order.
- Fast enough to run on every change. Slow end-to-end checks belong in their
  own, smaller set.
- One reason to fail. If a test name needs "and", split it.

## Ecosystem notes

- **JS/TS:** run one test with `npx --no-install vitest run path -t "name"` or
  `npx --no-install jest path -t "name"`; `node --test` for the built-in runner.
- **Python:** `pytest path/test_x.py::test_name -x`. Use `tmp_path` and
  `monkeypatch` rather than touching real files or env.
- **Go:** `go test ./pkg -run TestName`. Table-driven tests suit the boundary step.
- **Swift:** `swift test --filter Suite/testName`; inject protocols for I/O.
- **Rust:** `cargo test name`; unit tests in a `#[cfg(test)]` module beside the code.

## Done means

- [ ] Each requested behaviour has a test that was seen failing, then passing.
- [ ] The full relevant suite passes (or only the noted pre-existing failures remain).
- [ ] No test was skipped, deleted or loosened to get to green.
- [ ] Production code has no leftover debug output or hard-coded shortcuts.
- [ ] You report: tests added (names), the red-then-green evidence, and anything deferred.
- [ ] Any `soa-work` claim is released. Commit only if the user asked.
