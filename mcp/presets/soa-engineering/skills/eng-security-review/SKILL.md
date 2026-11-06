---
name: eng-security-review
description: "Use when the user asks for a security review, says \"secure this\", \"harden it\", \"is this safe\" or \"how could someone break this\", or wants a security pass on auth, file handling, payments or a public endpoint in their own code: trace inputs to sinks, rank exploitable flaws, give patches."
---

# Security review of your own code

Read the code the way someone trying to break it would, then hand back a short,
ranked list of real problems with fixes. This is for code the user owns or is
authorised to test. Do not probe, scan or attack third-party systems, and do
not write working exploits against anything outside the user's own local or
test environment. Dependency CVEs are `eng-dependency-audit`'s job; mention
them here only when the code actually reaches the vulnerable path.

## 1. Scope and threat model (five minutes, not an essay)

- What is in scope: a diff, a service, a whole repo? Default to what the user
  pointed at.
- Who are the attackers: anonymous internet user, logged-in user of another
  tenant, malicious file/URL supplier, compromised dependency, local user.
- What is worth stealing or breaking: credentials, other users' data, money,
  the host itself (shell, filesystem), availability.
- Draw the trust boundaries: every place data crosses from less trusted to
  more trusted (HTTP handler, CLI arg, webhook, queue message, uploaded file,
  env from a CI job, LLM output fed to a tool).

## 2. Walk the inputs

List each entry point, then follow its data to where it is used ("sinks").
For each boundary ask: is it validated by type, length, format and allowed
set, on the server side, before use?

## 3. Checklist by class

Work through what applies; skip what does not exist in this codebase.

- **Authn**: password hashing (argon2/bcrypt/scrypt, not fast hashes), session
  or token expiry and rotation, constant-time comparison of secrets, login
  throttling, reset-flow tokens single-use and short-lived.
- **Authz**: every handler checks the caller may act on *this* object (IDOR),
  not just that they are logged in. Admin routes gated on the server. Tenant
  id taken from the session, never from the request body.
- **Secrets**: none in source, tests, fixtures, logs or client bundles; check
  git history (`git log -p -S '<prefix>'`) for anything once committed. Env
  vars or a secret store, loaded once, failing closed when missing.
- **Injection**: SQL built by string concatenation, shell commands with
  interpolated input (`exec`, `os.system`, `subprocess(shell=True)`,
  backticks), template rendering of raw input (XSS, SSTI), NoSQL operator
  injection, LDAP/XPath, regexes built from input (ReDoS).
- **SSRF**: any server-side fetch of a user-supplied URL. Allow-list hosts and
  schemes, resolve and reject private/loopback/link-local addresses, do not
  follow redirects blindly, cap size and time.
- **Path traversal**: user input joined into file paths, archive extraction
  (zip-slip), symlink following. Resolve then confirm the result is still
  under the intended root.
- **Deserialisation**: `pickle`, `yaml.load` without a safe loader, Java/.NET
  object streams, `eval`/`Function` on JSON-ish input, prototype pollution in
  deep-merge helpers.
- **CORS / CSRF**: no reflected `Origin` with credentials, no `*` with
  cookies; cookie-authed state changes need a CSRF token or `SameSite` plus
  an origin check. WebSocket upgrades check origin and auth too.
- **Sensitive data in logs and errors**: tokens, passwords, full card or ID
  numbers, session cookies, request bodies, stack traces returned to clients.
- **Transport and headers**: HTTPS only where it matters, HSTS, a CSP that is
  not `unsafe-inline` everywhere, `X-Content-Type-Options`, cookie
  `Secure`/`HttpOnly`.
- **Resource limits**: body size, upload size and type, pagination caps, rate
  limits on expensive or enumerable endpoints.
- **Agent/LLM features**: model output passed to shells, file writes or URLs
  is untrusted input; tool permissions are the narrowest that work.

Per ecosystem, a quick first pass:

- JS/TS: `grep -rniE "eval\(|new Function|child_process|innerhtml"` (case-insensitive,
  so it also finds React's raw-HTML prop).
- Python: `pickle.loads`, `yaml.load(`, `shell=True`, f-strings in `execute(`.
- Go: `exec.Command("sh", "-c"`, `filepath.Join` with request data, `InsecureSkipVerify`.
- Swift: `NSAllowsArbitraryLoads`, secrets in `Info.plist`, Keychain vs `UserDefaults`.
- Rust: `unsafe` blocks near parsing, `Command::new` with joined strings.

If the project already has a linter or SAST config (semgrep rules, bandit,
gosec, eslint security plugins), run it the way the project does. Do not
install new global tools to do this.

## 4. Confirm before reporting

A finding needs a concrete path: this input, through this code, reaches this
sink, and the attacker gains this. If you can show it with a unit test or a
local request against the user's dev server, do. If you cannot trace it, mark
it "possible" rather than inflating it.

## 5. Report

Rank by severity, highest first:

| Severity | Meaning |
| --- | --- |
| Critical | Remote, unauthenticated, leads to code execution, full data access or account takeover |
| High | Authenticated user reaches other users' data or privileges; secret exposed |
| Medium | Needs unusual conditions or gives limited impact |
| Low | Hardening, defence in depth |

For each finding give: title, file:line, the attack in one or two sentences,
impact, and a minimal patch (a diff or exact code). Group repeats of the same
pattern into one finding with all locations. End with what you did not check.

## 6. Applying fixes

Only edit when the user asks. Inside SoA (`SOA_WEB_TAB` is set), run
`soa-work check <repo>` and `soa-work claim <repo>` before a multi-file fix
and release afterwards. Add a regression test per fixed finding where the
project has tests. Rotate, do not just delete, any secret that was committed:
tell the user which ones, since rotation is theirs to do.

## Done means

- Scope and attacker model stated in a few lines.
- Every entry point listed and followed to its sinks.
- Findings ranked, each with location, impact and a patch.
- Unchecked areas and any committed secrets called out.
- No changes made, pushed or committed unless the user asked.
