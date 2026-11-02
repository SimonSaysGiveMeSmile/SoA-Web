---
name: soa-ctx-next-steps
description: "Use at the start and end of a SoA session's work, or after publishing something: read and update the context canvas (soa-ctx) so next steps and artifacts survive between turns."
---

# Keep the context canvas current (soa-ctx)

Each SoA session has a CONTEXT canvas on the dashboard (and on the phone) with
four bands: recent PROMPTS, WORKSPACE, ARTIFACTS and NEXT STEPS. You are one of
its authors. It is the durable surface between turns: what you produced and
what is left, readable with one command.

## At the start of a task

```bash
soa-ctx            # workspace, recent prompts, artifacts, next steps
soa-ctx steps      # just the NEXT STEPS list
```

Pick up anything the user (or a previous turn) queued before starting fresh.

## While working

- Queue follow-ups you will not finish this turn:
  `soa-ctx step add "write the migration rollback"`
- Mark what you completed: `soa-ctx step done <n>`; drop what no longer
  applies: `soa-ctx step rm <n>`.
- Keep steps concrete and short (an imperative line, not a paragraph).

## After publishing something

Published artifact URLs are picked up from the transcript automatically. Register
one explicitly when you want a readable title, or when the URL was never printed:

```bash
soa-ctx artifact <url> "Release notes v0.3"
```

## Notes

- The saved list wins over the to-do list it was seeded from; the user may edit
  it too, so read before you rewrite.
- `soa-ctx json` gives the same payload for scripting.
