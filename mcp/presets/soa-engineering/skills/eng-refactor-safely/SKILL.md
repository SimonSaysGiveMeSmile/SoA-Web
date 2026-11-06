---
name: eng-refactor-safely
description: "Use when the user says 'refactor', 'clean this up', 'extract', 'rename', 'split this file', 'untangle' or similar: restructure code without changing what it does, guarded by tests, one move at a time."
---

# Refactor without changing behaviour

A refactor changes the shape of code and nothing else: same inputs, same
outputs, same side effects, same errors. The discipline is to make one
mechanical move, prove nothing changed, and only then make the next. If the
work also changes behaviour, split it: refactor first, then build the new
behaviour with `eng-build-increments`.

## Before touching anything

1. **Write down the target shape** in a sentence or two ("move pricing rules
   out of the controller into a module with no I/O") and what is out of scope.
2. **Find the safety net.** Locate the tests that exercise the code. Run them
   and record the result. If the suite is already red, stop and say so: you
   cannot tell a regression from an existing failure.
3. **Fill coverage gaps first.** If the code you will move has no tests,
   add characterisation tests that pin what it does today, including odd or
   arguably wrong behaviour. Do not fix that behaviour now; note it.
4. **Map the callers.** Search for every use of the symbols you will move or
   rename: imports, string references, reflection, templates, config, docs,
   other packages in a monorepo. Public or exported names deserve extra care.
5. **Claim the scope** inside SoA (`SOA_WEB_TAB` set): refactors usually touch
   many files, so `soa-work check <scope>` then `soa-work claim <scope>`
   before the first edit. On a conflict, do not proceed.

## One move at a time

Typical moves, each done on its own:

- rename a symbol (use the language server or a compiler-checked rename when
  available, not a blind search-and-replace);
- extract a function, method or module;
- inline something that adds no meaning;
- move code to a new file and re-export from the old path;
- replace a conditional chain with a lookup or polymorphism;
- separate pure logic from I/O;
- delete code that is provably unused.

For each move:

1. Make the move, and only that move.
2. Build or type-check, then run the guarding tests.
3. Read the diff: it should be mechanical. Any line that changes a value,
   condition, order of side effects, error message or log output is a
   behaviour change; back it out or move it to a separate follow-up.
4. Green: continue. Red: undo the move rather than patching forward, then
   retry it smaller.

Commit between moves only if the user asked for commits; otherwise point out
the checkpoints so they can.

## Keeping callers working

- When a public name or path changes, keep a temporary alias or re-export and
  mark it deprecated, unless the user agreed to break it.
- Change interfaces in two steps: add the new form beside the old, migrate
  callers, then remove the old form once nothing uses it.
- Do not change serialised formats, database columns, environment variable
  names, CLI flags or URLs as part of a refactor; those are behaviour.

## Per-ecosystem notes

- **JS/TS**: the type checker is your fastest net (`npm run typecheck` or
  `tsc --noEmit` from the lockfile); watch for dynamic `require` and string
  keys that it cannot see.
- **Python**: dynamic attribute access, `getattr`, and entry points in
  packaging metadata hide callers; grep for the string name too.
- **Go**: `go build ./... && go vet ./...` after each move; exported
  identifiers may be used by other modules outside this repo.
- **Swift**: watch `@objc`, storyboard and string-based selectors, and access
  levels when moving types between files or modules.
- **Rust**: let `cargo check` drive each move; keep `pub use` re-exports when
  moving items that other crates import.

## Stop conditions

- The guarding tests cannot be made to pass on the untouched code.
- A move requires a behaviour change to compile or pass.
- The refactor is spreading beyond the agreed target shape or claim.
- A move has failed twice: stop, describe the obstacle, and let the user
  choose between a smaller target and a different approach.

## Finishing

1. Run the full suite plus lint and type checks used by CI.
2. Compare the final diff against the target shape; remove leftovers such as
   empty files, unused imports and dead aliases nobody needs.
3. List any odd behaviour you pinned but did not fix, as follow-ups.
4. Release the claim (`soa-work release <scope>`) inside SoA.

## Checklist

- [ ] Target shape and out-of-scope written down
- [ ] Baseline green before the first move
- [ ] Characterisation tests added where coverage was missing
- [ ] Every caller found, including string and dynamic references
- [ ] One move at a time, each followed by build and tests
- [ ] No behaviour changes in the diff
- [ ] Public names kept working or the break agreed
- [ ] Full suite green; claim released; follow-ups listed

## Done means

The code has the agreed new shape, the same tests pass as before (plus any
characterisation tests you added), the diff contains no behaviour changes,
and the user has a short list of anything worth changing next.
