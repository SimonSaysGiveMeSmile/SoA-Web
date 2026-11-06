---
name: eng-build-increments
description: "Use when implementing an agreed change or plan ('go ahead', 'build it', 'implement step 2'): write it in small slices that match the codebase's existing style, and run a check after each slice before starting the next."
---

# Build in small, verified slices

Large uncommitted changes fail in ways that are hard to locate. Small slices,
each checked before the next begins, keep every failure close to its cause.
This skill is for writing new or changed behaviour. If there is no plan yet and
the change is more than a few files, use `eng-plan-feature` first. If the goal
is to restructure without changing behaviour, use `eng-refactor-safely`.

## Before the first slice

1. **Know the baseline.** Run the project's test (and, if quick, lint and type)
   command once on the untouched tree. Note anything already failing so you do
   not chase it later or claim it as yours.
2. **Learn the local style** from two or three neighbouring files: naming,
   error handling, logging, imports, file layout, test structure. Your code
   should read as if the same author wrote it. Do not introduce a new pattern,
   formatter setting or library to solve a problem the repo already solves.
3. **Claim the scope** when running inside SoA (`SOA_WEB_TAB` is set) and the
   change spans several files: `soa-work check <scope>`, then
   `soa-work claim <scope> --ttl 30m --note "<what>"`. On a conflict, stop and
   coordinate instead of editing.

## The slice loop

For each slice:

1. **Pick the next smallest piece that can be checked on its own**: one
   function and its test, one endpoint, one UI state, one config key wired
   end to end. A slice usually touches one to three files.
2. **Pin the behaviour first when you can.** Write or extend a test that fails
   for the right reason, then make it pass (`eng-test-first` has the full
   red-green cycle). Where a test is impractical (a
   layout tweak, a shell script), decide the manual check before editing.
3. **Make the change**, minimal and in style. No unrelated clean-ups in the
   same slice; note them for later.
4. **Check.** Run the narrowest command that covers the slice (a single test
   file, a package, a type check of the changed module), then glance at the
   diff of just this slice. Read the output; do not assume green.
5. **Decide**:
   - passes and the diff is what you meant: move on;
   - fails because of your slice: fix it now, while it is small;
   - fails for a reason you do not understand after two honest attempts:
     stop, revert the slice, and reassess rather than stacking fixes.
6. **Record progress** in whatever the user is watching: the plan, a todo list,
   or `soa-ctx step done <n>` inside SoA.

Commit between slices only if the user has asked you to commit. Otherwise keep
the slices visible in the working tree and mention the natural commit points.

## Per-ecosystem notes

- **JS/TS**: run the package's own scripts (`npm test -- <file>`, `npm run
  typecheck`); use `npx --no-install` for tools already in the lockfile, never
  fetch new ones on the fly.
- **Python**: `pytest path/to/test_x.py -q`; keep to the project's typing and
  formatting conventions rather than imposing new ones.
- **Go**: `go test ./pkg/...` and `go vet` on the touched package; wrap errors
  the way neighbouring code does.
- **Swift**: `swift test --filter <Case>` or the scheme's test target; keep UI
  changes on the main actor as the surrounding code does.
- **Rust**: `cargo test -p <crate> <name>` and `cargo clippy` on that crate;
  follow the crate's existing error type.

## Stop conditions

Stop and report instead of pushing on when:

- a slice needs a change outside the agreed scope or claim;
- a new dependency, migration, or public API change appears that the plan did
  not include;
- the baseline suite starts failing in places unrelated to your slice;
- you have made three attempts at one slice without a clear cause.

## After the last slice

1. Run the full test suite and any lint or type check CI runs.
2. Exercise the feature once the way a user would (run the command, load the
   page, call the endpoint) and compare to the plan's "done when".
3. Read the whole diff top to bottom: debug prints, commented-out code,
   leftover TODOs, accidental files, secrets, personal paths.
4. Release the claim (`soa-work release <scope>`) inside SoA.
5. Summarise: what changed, how it was verified, anything left undone or
   deliberately deferred.

## Checklist

- [ ] Baseline recorded before editing
- [ ] Code matches neighbouring style; no new patterns without reason
- [ ] Each slice checked before the next began
- [ ] No unrelated changes mixed in
- [ ] Full suite and real-use check run at the end
- [ ] Diff reviewed; claim released; summary given

## Done means

Every planned slice is in, the full checks pass (or pre-existing failures are
named as such), the feature has been tried for real, and the user knows what
was verified and what was not.
