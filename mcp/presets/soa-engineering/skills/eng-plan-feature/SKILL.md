---
name: eng-plan-feature
description: "Use when the user says 'plan this', 'how should we build...', 'what would it take to...', or before a new feature or change that touches more than a few files: produce scope, affected files, risks, ordered steps and a verification plan before any code is written."
---

# Plan a feature before writing code

A plan is a short written agreement about what will change, in what order, and
how you will know it worked. It costs a few minutes and saves the rework that
comes from discovering the real shape of a change halfway through it. This
skill only plans: it reads, it does not edit. Building the plan is
`eng-build-increments`; restructuring code without changing behaviour is
`eng-refactor-safely`.

## When a plan is worth it

- The request is new behaviour, not a one-line fix.
- You expect to touch more than three or four files, or more than one module.
- It changes a public surface: an API, a CLI flag, a file format, a schema,
  a config key, a stored record.
- The user asked "how would we...", "what's the approach...", "plan this".

Skip it (say so in one line) for typo fixes, a single obvious function, or when
the user has said "just do it".

## Procedure

1. **Restate the goal in one or two sentences**, in the user's terms. Name what
   is explicitly out of scope. If two readings of the request lead to different
   designs, ask one focused question now instead of guessing.
2. **Read before deciding.** Find the entry points that the feature hangs off
   (route, command, handler, view, job). Follow the call path one or two levels
   in each direction. Look for an existing helper, pattern or library already in
   the repo that does part of the job; reuse beats new code.
3. **Note the house style**: how errors are reported, how config is read, how
   tests are laid out and named, which test command CI runs.
4. **List affected files** with one line each on why. Mark new files as new.
   Include tests, docs, fixtures, generated files and migrations, not just
   source.
5. **Name the risks.** For each, say how the plan handles it:
   - data: schema or format changes, existing records, caches, migrations;
   - compatibility: callers you do not control, old clients, stored state;
   - concurrency or ordering: races, retries, idempotency;
   - security: input from outside, auth checks, secrets, file paths;
   - operations: deploy order, feature flags, rollback, restarts.
   Anything you could not confirm by reading code, label **unverified**.
6. **Order the steps.** Each step is small enough to finish and check on its
   own (roughly one focused commit). Put enabling work first: types, interfaces,
   fixtures, a failing test that pins the new behaviour. Put risky or
   irreversible steps (migrations, deletions, public renames) late and behind a
   check.
7. **Write the verification plan**: for each step, the exact command or manual
   check that shows it works, plus one end-to-end check for the whole feature.
   Prefer the project's own scripts (`npm test`, `pytest`, `go test ./...`,
   `swift test`, `cargo test`) over invented ones.
8. **State "done"** as observable outcomes, not activity: "running X now prints
   Y", "the new test passes and the old suite stays green".

## Plan template

```
Goal:        <one or two sentences>
Out of scope: <bullets>
Approach:    <three to six lines: the design and why this one>
Files:       path/a.ts      - add parseLimit()
             path/a.test.ts - new cases for limits
             docs/cli.md    - document --limit
Risks:       <risk> -> <mitigation>   (mark unverified ones)
Steps:       1. ... (check: <command>)
             2. ...
Verify:      <end-to-end check>
Done when:   <observable outcomes>
Open questions: <only the ones that block a step>
```

Keep it on one screen. A plan longer than the change is a smell; trim it.

## Decision points

- **Two viable designs?** Pick one, give the reason in a line, and mention the
  alternative. Do not present a menu unless the trade-off is the user's call
  (cost, user-visible behaviour, a dependency).
- **Needs a new dependency?** Say which, why the repo's existing tools are not
  enough, and pin an exact version. Adding it is a step the user approves.
- **Bigger than one sitting?** Split into milestones that each leave the
  project working and shippable, and plan only the first one in detail.
- **Blocked on an unknown?** Make the first step a time-boxed spike that
  answers it, with a stated question and a stop condition.

## Running inside SoA

If `SOA_WEB_TAB` is set, other agents may be working on this machine:

- run `soa-work check <repo-or-subtree>` while planning, and list any conflict
  as a risk; the claim itself is taken when building starts;
- the ordered steps can go on the context canvas with
  `soa-ctx step add "<step>"`, so the user can see them from the phone;
- if the plan has a question only the user can answer, one short `soa-msg`
  is enough.

## Checklist

- [ ] Goal and out-of-scope written down
- [ ] Entry points and call path actually read, not guessed
- [ ] Existing helpers or patterns to reuse identified
- [ ] Every affected file listed, tests and docs included
- [ ] Risks named, each with a mitigation or marked unverified
- [ ] Steps ordered, each with its own check
- [ ] End-to-end verification and "done" stated as outcomes
- [ ] No code edited yet

## Done means

The user has a plan they can approve, amend or reject in one read, and any
agent could start step 1 from it without re-reading the conversation. Stop
there and wait for the go-ahead unless the user already asked you to proceed.
