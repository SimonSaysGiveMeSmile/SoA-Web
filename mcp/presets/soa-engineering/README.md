# soa-engineering

Everyday engineering skills, one per station. Each description says when it
applies, so the agent picks the right one; nobody has to memorise the list.
They are mirrored into `~/.claude/skills` and the Codex skills dir by
`soa-mcp sync` (the daemon runs it at boot; `SOA_MCP_SYNC=0` turns that off).

| Station | Skill | Use it for |
| --- | --- | --- |
| Plan | `eng-plan-feature` | Scope, affected files, risks and ordered steps before code |
| Build | `eng-build-increments` | Implementing an agreed change in small, checked slices |
| Build | `eng-refactor-safely` | Restructuring code without changing behaviour |
| Test | `eng-test-first` | Red, green, tidy for a behaviour you already understand |
| Test | `eng-test-gaps` | Raising coverage on existing code, with a hard stop |
| Test | `eng-debug-systematic` | Reproduce, narrow, one hypothesis at a time, regression test |
| Secure | `eng-security-review` | Threat model and input-to-sink review of your own code |
| Secure | `eng-dependency-audit` | Vulnerable, abandoned, unpinned or mislicensed dependencies |
| Review | `eng-code-review` | Reading a diff for bugs first, then clarity, perf and tests |
| Review | `eng-perf-profile` | Baseline, profile, one change at a time, re-measure |
| Ship | `eng-ship-checklist` | Pre-merge checklist and a plain-language PR description |

Every skill works on the user's own code, commits or pushes only when asked,
never spawns other agents or headless runs, and reminds SoA tabs
(`SOA_WEB_TAB` set) to take a `soa-work` claim before multi-file edits.

## Acknowledgements

The pack's structure was inspired by [ECC](https://github.com/affaan-m/ECC)
(MIT License, © Affaan Mustafa). The text is original to SoA.
