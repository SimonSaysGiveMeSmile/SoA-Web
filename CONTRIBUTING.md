# Contributing

Thanks for the interest. SoA-Web is GPL-3.0 and welcomes patches.

## Workflow

`main` is protected — direct pushes are blocked, force-pushes and deletions are off. All changes land via PR.

1. Fork the repo (or create a branch if you have write access).
2. Branch from `main`: `git checkout -b feat/short-description`.
3. Commit in focused chunks. Follow the existing message style:
   - `feat(area): …` — new behavior
   - `fix(area): …` — bug fix
   - `refactor(area): …` — no behavior change
4. Run the checks before opening the PR:
   ```bash
   npm test
   node scripts/smoke-ws.js   # requires a running server
   ```
5. Open a PR against `main`. Resolve any conversation threads before merging.

## Scope

Keep PRs small and single-purpose. If you're touching the server and the SPA in one change, say why in the description — otherwise split it.

## What's out of scope

The items listed under "What's deliberately missing" in `README.md` (voice input, Electron-era native features, auto-updater) are intentional. Proposals to add them back should open an issue first.

## Security

If you find something security-relevant (auth bypass, PTY escape, CORS gap), don't open a public issue. Email the maintainer or open a private security advisory on GitHub.
