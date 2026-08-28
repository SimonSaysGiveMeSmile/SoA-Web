// WS bind decisions. The 2026-08-25 regression: a pairing token for an EMPTY
// session (the desktop's cookie had lapsed and it was silently re-provisioned)
// bound the phone to that empty session, and restore-on-connect then rehydrated
// the whole saved fleet beside the one still running. An empty token session
// must defer to a populated primary; a token session WITH tabs still wins.
const test = require('node:test');
const assert = require('node:assert/strict');

const { decideWsBind, httpMayProvision } = require('../src/tunnelGate');

const tok = { id: 'tok' };

test('decideWsBind: token session with tabs binds to the token session', () => {
    const d = decideWsBind({ tokenSession: tok, tokenSessionHasTabs: true, primaryExists: true, isLocal: false });
    assert.deepEqual(d, { action: 'bind', source: 'token', via: 'pair-token' });
});

test('decideWsBind: EMPTY token session + live primary → share the primary, not the empty session', () => {
    const d = decideWsBind({ tokenSession: tok, tokenSessionHasTabs: false, primaryExists: true, isLocal: false });
    assert.equal(d.action, 'bind');
    assert.equal(d.source, 'primary-or-new');
    assert.equal(d.via, 'primary-over-empty-token');
});

test('decideWsBind: empty token session with NO primary anywhere still binds to the token (boot / first pair)', () => {
    const d = decideWsBind({ tokenSession: tok, tokenSessionHasTabs: false, primaryExists: false, isLocal: false });
    assert.deepEqual(d, { action: 'bind', source: 'token', via: 'pair-token' });
});

test('decideWsBind: legacy callers that omit the new fields keep token-wins behaviour', () => {
    const d = decideWsBind({ tokenSession: tok, existingHasTabs: false, isLocal: false, openTunnel: false, sessionTokenMode: false });
    assert.equal(d.source, 'token');
});

test('decideWsBind: populated cookie session wins over primary', () => {
    const d = decideWsBind({ tokenSession: null, existingHasTabs: true, isLocal: true, primaryExists: true });
    assert.deepEqual(d, { action: 'bind', source: 'cookie', via: 'cookie' });
});

test('decideWsBind: local caller with an empty/no cookie session shares the primary', () => {
    const d = decideWsBind({ tokenSession: null, existingHasTabs: false, isLocal: true });
    assert.deepEqual(d, { action: 'bind', source: 'primary-or-new', via: 'primary-share' });
});

test('decideWsBind: remote caller without token or populated session is rejected', () => {
    const d = decideWsBind({ tokenSession: null, existingHasTabs: false, isLocal: false, openTunnel: false, sessionTokenMode: false });
    assert.equal(d.action, 'reject');
});

test('httpMayProvision: remote anonymous callers cannot mint sessions unless the tunnel is open', () => {
    assert.equal(httpMayProvision({ isLocal: false, openTunnel: false, sessionTokenMode: false }), false);
    assert.equal(httpMayProvision({ isLocal: true, openTunnel: false, sessionTokenMode: false }), true);
});
