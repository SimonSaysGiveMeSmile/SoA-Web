# soa-mcp preset packs

Read-only content that ships with SoA and is served by `scripts/soa-mcp`
alongside each device's own library. A user item with the same name shadows a
preset; presets can never be deleted or overwritten through the MCP tools.
`SOA_MCP_PRESETS_DISABLE=1` hides them all.

## Adding a pack

```
mcp/presets/<pack>/
  pack.json                 {"name": "<pack>", "version": "1.0.0", "description": "…",
                             "author": "…", "license": "MIT",
                             "snippets": {"<slug>": {"title": "…", "language": "shell",
                                                     "description": "…", "tags": ["…"]}}}
  skills/<slug>/SKILL.md    front matter `name: <slug>` + `description: …`, then the body
  snippets/<slug>.<ext>     the code; metadata (optional) lives in pack.json "snippets"
```

Rules (enforced by the loader; `soa-mcp presets` prints any problem):

- `<pack>` and every `<slug>` match `[a-z0-9-]{1,64}`, and `pack.json` `name`
  equals the directory name.
- Each item is at most 256 KB; no symlinks.
- Slugs are global across packs: the first pack (alphabetically) wins, later
  duplicates are reported and skipped. Prefix slugs with your pack's theme.
- No credentials, personal paths, hostnames or private context. Use `~`,
  `$HOME` and env vars.
