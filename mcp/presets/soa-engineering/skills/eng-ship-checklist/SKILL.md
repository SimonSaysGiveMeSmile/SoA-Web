---
name: eng-ship-checklist
description: "Use when the user says \"ready to ship?\", \"open a PR\", \"cut a release\" or \"write the PR description\" for a finished change: run the pre-merge checklist (tests green, docs and changelog, migration and rollback plan) and draft a plain-language PR description."
---

# Before it ships

Shipping is the moment a mistake becomes someone else's problem. This
checklist is short on purpose: go through it in order, and report each item as
done, not applicable, or blocking. It prepares the change; it does not merge,
tag, deploy or push unless the user asked for that step.

## 1. Scope is what it claims to be

- `git status` and `git diff <base>...HEAD --stat`: only intended files are
  in the change. No stray debug prints, scratch files, `.env`, keys, local
  paths or large generated artifacts.
- One concern per PR. If unrelated fixes rode along, suggest splitting them.
- The branch is current with its base, or the conflicts are understood.

## 2. Checks are green

Run what the project defines, the same way CI does:

- Build, type check, lint, and the full test suite, not just the tests you
  touched. Use the scripts in the repo (`npm test`, `pytest`, `go test ./...`,
  `swift test`, `cargo test`).
- Use locked dependencies (`npm ci`, a lockfile install), not fresh upgrades.
- A flaky test that "usually passes" is a finding: name it rather than
  re-running until it is green.
- If something cannot run locally (needs a device, a secret, a service), say
  which check is unverified and rely on CI for it explicitly.

## 3. Behaviour is verified, not assumed

- Exercise the change the way a user would: run the command, open the page,
  call the endpoint. Tests prove what they test; this proves the feature.
- Check one failure path too (bad input, no network, empty state).
- For UI changes, look at both narrow and wide layouts and any themes the
  project supports.

## 4. Docs and changelog

- README, usage docs or help text updated where behaviour or flags changed.
- A changelog entry if the project keeps one, written for users ("Fixed X when
  Y"), not as a commit log.
- New config, env vars or permissions are documented with their defaults.

## 5. Migration and rollback

Answer both before merging anything that touches data, schemas, config or a
public interface:

- **Migration:** what runs, in which order, and how long it takes on real
  data. Is it backward compatible while old and new code run side by side?
  Does any client or caller need to change first?
- **Rollback:** the exact steps to undo it (revert the commit, a down
  migration, a feature flag off, the previous release tag). If a step is
  irreversible (dropped column, deleted files, sent emails), say so loudly and
  get the user's go-ahead.
- **Watch after release:** the log line, metric or page that will show it
  working or failing.

For a release: the version bump follows the project's scheme, and the tag goes
on a commit that already passed CI.

## 6. PR description in plain words

Draft it for a reader who has not seen the work:

```markdown
## What
One or two sentences on what changes for the user or the system.

## Why
The problem or request behind it; link the issue.

## How
The approach in a few bullets, including anything surprising.

## Testing
What was run and what was checked by hand; anything left unverified.

## Risk and rollback
What could break, how we would notice, and how to undo it.
```

Keep it free of jargon the reviewer would have to look up, internal hostnames,
personal paths and secrets. Match the repo's existing PR template if it has one.

## Report

A checklist with each item marked:

```text
[ok]      tests: 412 passed (npm test)
[ok]      docs: README flags table updated
[n/a]     migration: no schema change
[blocker] rollback: config key renamed, old daemons will fail to start
```

## Done means

- Every item is ok, n/a, or a named blocker with a proposed fix.
- The PR description is drafted and shown to the user.
- Nothing was committed, pushed, tagged or deployed beyond what the user asked
  for, and no force push was used.
- Inside SoA (`SOA_WEB_TAB` set), any multi-file fix-ups were made under a
  `soa-work claim`, released when finished.
