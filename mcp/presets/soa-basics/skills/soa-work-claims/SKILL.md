---
name: soa-work-claims
description: "Use before any multi-file edit, refactor or commit in a SoA session: claim the narrowest scope with soa-work, stop on conflict, release when done."
---

# Claim before you edit (soa-work)

Several agents share this machine. `soa-work` is a local, advisory work-claim
ledger that keeps two of them from editing the same tree at once. Use it for
any multi-file edit, refactor, generated-file update or commit that touches
shared or ambient state. A one-line fix in a file nobody else is near does not
need a claim.

## The loop

1. **Pick the narrowest scope** you will modify:
   - an absolute path (repo root or a subtree). Overlap is ancestor/descendant,
     so a claim on a repo collides with a claim on any folder inside it, in
     both directions;
   - or a tag for shared things that are not one path: `asset:<package>`,
     `project:<name>` (exact match).
2. **Check:** `soa-work check <scope>`. Exit 0 = clear. Exit 3 = `[CONFLICT]`,
   with who holds it.
3. **On conflict, do not proceed.** Either narrow to a subtree that does not
   overlap, ask the owner with `soa-bus dm #<id> "coordinating on <scope>?"`,
   or tell the manager / user. Never double-edit a claimed scope.
4. **Claim:** `soa-work claim <scope> --ttl 30m --note "what you are doing"`.
5. **Long jobs:** `soa-work beat <scope>` every so often so the claim stays fresh.
6. **Release the moment you finish**, and before you go idle or hand back:
   `soa-work release <scope>`.

## Good to know

- Claims self-expire (default 30 minutes) and a crashed agent's claims are
  reaped automatically, so a forgotten release only blocks others briefly, but
  release promptly anyway.
- `soa-work ls` shows every live claim; `soa-work conflicts` shows overlaps.
- To wait for a peer's claim to clear without burning a turn, use
  `soa-bus watch work-events --once` (never a bare `watch`).
- The snippet `soa-claim-wrap` in this library wraps a command in
  claim → run → release.
