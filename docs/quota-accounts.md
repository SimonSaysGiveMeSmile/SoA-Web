# Saved usage accounts

Open **TOKEN USAGE → Accounts** in the left panel, or **⋯ → Usage** on a phone.
The two existing local CLI entries are retained. Add named Claude or Codex
profiles as needed; the limit is 100 saved profiles, not four cards.

- **Show** pins an account to the panel. The × on a card only hides it.
- **Monitor** pauses or resumes collection for that account. Pausing retains
  the native login and settings. The toolbar pauses/resumes all collection.
- **Add & connect** creates a separate native CLI profile. New accounts start
  hidden. Finish the provider's sign-in, then select Show when needed.
- Preferences live on the paired Mac and synchronize to its other clients.

Claude sign-in runs the unmodified `claude auth login --claudeai` in an isolated
`CLAUDE_CONFIG_DIR`; it stores credentials in its scoped Keychain entry or native
credentials file. Its browser URL and optional pasted authorization code are
relayed in memory. Codex uses its documented app-server device-code flow with an
isolated `CODEX_HOME`, native credential storage and refresh handling. No model
turn is started for monitoring. Default local CLI accounts cannot be signed out
or replaced through this panel. Native sign-in expiration may require reconnect.

Account configuration is stored in `STATE_DIR/quota-accounts/accounts.json`
(0600 in a 0700 directory). Each generated UUID owns its own CLI directory,
identity binding, quota cache and status-line records. Credentials are never
sent to the dashboard or included in the account configuration/usage payload.
A saved custom profile rejects a different login identity; use Add for another
subscription. Paused profiles stop collectors, while hidden profiles can keep
monitoring. Concurrent quota refresh work is bounded to two accounts.

Codex quota uses `account/read`, `account/rateLimits/read` and update events.
Claude retains the existing read-only OAuth usage collector and has a scoped
documented status-line hook as fallback. The OAuth usage endpoint is a provider
endpoint, not a documented public monitoring API; failures remain visible and
do not turn cached data into a current reading. Each account independently
determines whether it has a session window. Unknown windows stay unknown.
Official-source readings are preferred over other session records.

The API retains its version-1 `data.claude`, `data.codex` and cost fields for
existing alerts/tools. It adds `accounts`, `monitoring`, `revision` and an
ephemeral action nonce. Mutations use POST `/api/usage-quota/accounts`, a nonce
header and a JSON payload transported as text/plain through the existing
authenticated preview proxy. This avoids its JSON body parser consuming the
request. The sidecar listens only on loopback, grants no CORS permissions and
validates Host on writes. Browser preferences never accept arbitrary CLI paths.

Provider-wide legacy token/cost totals are labelled **This Mac**, attached only
to the default local CLI cards. They are not assigned to extra account profiles
or represented as subscription charges. Account quota histories remain separate.

Both desktop and standalone phone clients use `m/quotaAccountsView.js` and its
scoped CSS. Polling preserves input focus, open settings and sign-in state.
Preferences have revisions so an older in-flight response cannot undo a change.
No changes are needed to the terminal daemon or tunnel; restart only the quota
sidecar after installing the server files.

Validation: `node --test server/test/quotaAccounts.test.js` covers persistence,
13+ profiles, bounded polling, isolation, pause races, native auth adapters and
write protections. `node tools/check_quota_accounts.cjs` drives the component,
phone sheet, real preview proxy and widget integration using fake readers only.
