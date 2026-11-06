---
name: eng-dependency-audit
description: "Use when the user asks to audit, pin or clean up dependencies, says \"check our deps\", \"upgrade <package>\", \"any vulnerable packages?\", \"check our licences\", \"is this lib still maintained\", or before adding a new dependency. Uses the ecosystem's own tools; no major upgrade without asking."
---

# Dependency audit

Find out what the project actually depends on, which of those are risky, and
make the build reproducible, using the package manager's own tools. Report
first; change only what the user approves. Code-level flaws in the user's own
source belong to `eng-security-review`.

## Ground rules

- Read lockfiles and manifests before running anything.
- Use the project's existing package manager (look at the lockfile: do not
  run `npm` in a `pnpm` repo). No global installs, no auto-confirmed `npx`
  downloads, no floating `latest` tags.
  If an audit tool is missing, say so and give the install command for the
  user to run.
- Audits that query a vulnerability database send package names and versions
  over the network; that is fine for the user's own project, mention it once.
- Never upgrade a major version, swap a package or delete a lockfile without
  asking. Patch and minor bumps within the declared range are proposals too
  until the user says go.
- Inside SoA (`SOA_WEB_TAB` set): `soa-work claim <repo>` before touching
  manifests or lockfiles, release when done. Lockfiles are shared state.

## 1. Inventory

- Manifests and lockfiles present, and whether the lockfile is committed and
  in sync with the manifest.
- Direct vs transitive count; dev-only vs shipped.
- Anything installed outside the package manager: vendored copies, curl'd
  scripts, git URLs, local paths, CDN `<script>` tags without a pinned version
  or integrity hash.

## 2. Known vulnerabilities

| Ecosystem | Command (read-only) |
| --- | --- |
| npm | `npm audit --omit=dev` then `npm audit` |
| pnpm / yarn | `pnpm audit` / `yarn npm audit` |
| Python | `pip-audit -r requirements.txt` (or against the lock), `uv pip list --outdated` |
| Go | `govulncheck ./...` (reports only reachable code), `go list -m -u all` |
| Rust | `cargo audit`, `cargo outdated` if installed |
| Swift | `swift package show-dependencies`; check advisories by hand, no native audit |
| Ruby / Java / .NET | `bundle audit`, `mvn dependency:tree` / OWASP check, `dotnet list package --vulnerable` |

For each advisory note: severity, whether the vulnerable code path is used
(reachability matters more than the score), whether it ships to production,
and the smallest fixing version.

## 3. Health and risk

For each direct dependency that matters, check quickly:

- **Abandoned**: no release in two or more years, archived repo, open security
  issues unanswered, a single maintainer on a critical package.
- **Deprecated**: the registry marks it deprecated or points at a successor.
- **Bloat**: a large tree pulled in for one small function the language now
  has built in.
- **Suspicious**: name one letter off a popular package, very recent first
  publish, install scripts (`preinstall`/`postinstall`) doing network work.
- **Duplicates**: several majors of the same package in the tree.

## 4. Licences

List licences of everything shipped (not dev tooling). Flag:

- unknown or missing licences;
- strong copyleft (GPL, AGPL) in a closed-source or SaaS product, or anything
  incompatible with the project's own licence;
- "non-commercial" or custom licences.

Tools: `npm exec -- license-checker` only if it is already a dev dependency, otherwise
`pip-licenses`, `go-licenses`, `cargo deny check licenses`, or read the
`LICENSE` files. You are not giving legal advice; state what you found.

## 5. Pinning and lockfile hygiene

- Lockfile committed, one lockfile per package manager, CI installs with the
  frozen form (`npm ci`, `pnpm install --frozen-lockfile`, `uv sync --locked`,
  `cargo build --locked`, `go mod verify`).
- Ranges in manifests are a policy choice: apps usually pin exact or rely on
  the lockfile; libraries keep ranges. Do not flip the policy silently.
- Git and URL dependencies pinned to a commit hash, not a branch.
- CI actions, Docker base images and tool versions pinned (tag plus digest
  where the project already does that).
- Scripts and docs that tell people to install a floating `latest` tag or run
  unpinned installers.

## 6. Report

A table, worst first: package, current, issue (vuln / abandoned / licence /
unpinned), shipped?, proposed action, breaking? (yes for majors). Then a
short "safe now" list (patch/minor within range, no API change) and a
"needs a decision" list (majors, replacements, removals).

## 7. Applying approved changes

One logical change at a time: bump, reinstall with the project's command,
run the test suite and the build, read the changelog for anything flagged
breaking. Stop and report if tests fail; do not chain further upgrades on a
red build. Commit only if the user asked, one commit per group.

## Done means

- Inventory, vulnerabilities, health and licences each covered or marked
  "not checked" with the reason.
- Every proposed change says whether it is breaking.
- No major upgrade, removal or lockfile regeneration without approval.
- If changes were applied: tests and build pass, claim released.
