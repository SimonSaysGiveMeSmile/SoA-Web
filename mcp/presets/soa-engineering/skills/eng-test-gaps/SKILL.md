---
name: eng-test-gaps
description: "Use when the user says \"raise coverage\", \"get us to N%\", \"what isn't tested\", \"add tests for this\" or \"fill the test gaps\" on existing code: measure, test the riskiest untested paths toward their target (default 80% lines), and stop to report what is left rather than write filler."
---

# Close meaningful test gaps

Coverage is a map of where nobody has looked, not a score to max out. The goal
is tests that would catch a real regression. When the remaining gap can only be
closed with tests that assert nothing useful, you stop and say so.

For building new behaviour test-first, use `eng-test-first`. For a specific bug,
use `eng-debug-systematic`.

## 1. Agree the target and the scope

- Target: the number the user named; otherwise **80% line coverage** of the
  code in scope. Say which metric (lines, or branches if they asked).
- Scope: a package, directory or the files changed on this branch. Exclude
  generated code, vendored code, migrations and fixtures, and say so.
- Inside SoA (`SOA_WEB_TAB` is set), claim the test directories with
  `soa-work` before adding files across them.

## 2. Measure the baseline

Use the project's existing coverage setup if it has one. If it has none, use the
tool already installed; ask before adding a dependency.

- **JS/TS:** `npx --no-install vitest run --coverage`, `npx --no-install jest --coverage`,
  or `node --test --experimental-test-coverage`.
- **Python:** `pytest --cov=<pkg> --cov-report=term-missing` (pytest-cov), or
  `coverage run -m pytest && coverage report -m`.
- **Go:** `go test -coverprofile=cover.out ./... && go tool cover -func=cover.out`.
- **Swift:** `swift test --enable-code-coverage`, then `xcrun llvm-cov report`
  on the generated profile (path from `swift test --show-codecov-path`).
- **Rust:** `cargo llvm-cov` or `cargo tarpaulin`, only if already installed.

Record the baseline per file. Keep the full suite green before adding anything.

## 3. Rank the gaps by risk, not by size

Look at the uncovered lines themselves. Order the work:

1. error and failure paths in code that handles money, auth, data loss, parsing
   or user input;
2. branches with business rules (limits, permissions, state transitions);
3. public functions with no test at all;
4. everything else.

Skip, and list as "not worth a unit test": trivial getters, logging-only lines,
`main()` wiring, platform glue that needs a real device or service, and code
that is dead (flag dead code to the user instead of testing it).

## 4. Write tests, a batch at a time

For each gap in order:

- Write a test that asserts a behaviour a caller depends on. The test name
  says what would break.
- Check it is real: briefly break the line it covers (flip a condition, return
  early). The test must fail. Undo the break. If it still passes, the test is
  filler; rewrite or drop it.
- Prefer fakes at real boundaries over mocking the unit's own internals.
- Do not change production code to make it testable without saying so; a small
  seam (injecting a clock) is fine, a redesign needs the user's go-ahead.

Re-measure after each batch of a few files.

## 5. The hard stop

Stop when **any** of these is true, then report:

- the target is reached for the agreed scope;
- the next gaps are all in the "not worth a unit test" list;
- each further test would only execute lines without asserting an outcome;
- three consecutive batches moved coverage by less than one point;
- reaching the number needs refactoring production code the user has not approved.

Never write tests that call code just to mark lines, assert `true`, snapshot
huge output nobody will read, or weaken existing tests. Never lower the target
or edit coverage thresholds/exclusions to make the number pass.

## Report

```
Scope: <dirs>   Metric: lines   Target: 80%
Before: 61.2%   After: 78.4%   (+N tests in M files)
Covered: <the risky paths now tested, one line each>
Left uncovered, and why:
  - src/x/cli.ts main wiring  - integration only
  - src/y/legacy.py:120-188   - appears dead; confirm before deleting
Next step if you want the last 1.6%: <concrete option, e.g. a fake for the S3 client>
```

## Done means

- [ ] Baseline and final numbers measured the same way, on the same scope.
- [ ] Every new test fails when the code it covers is broken.
- [ ] Full suite passes; no test skipped or loosened.
- [ ] The report lists what is left and why, whether or not the target was hit.
- [ ] Any `soa-work` claim released. Commit only if the user asked.
