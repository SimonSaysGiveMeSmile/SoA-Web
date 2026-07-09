'use strict';
// Unit tests for server/src/entitlements.js — the premium-feature gate.
// Run: node server/test/entitlements.js   (exit 0 = all pass)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-ent-'));
const LIC = path.join(TMP, 'license.json');
process.env.SOA_WEB_LICENSE_FILE = LIC;

const ent = require('../src/entitlements');

let pass = 0;
function ok(name, cond) { assert.ok(cond, 'FAIL — ' + name); console.log('PASS —', name); pass++; }
function clearEnv() {
    delete process.env.SOA_WEB_MANAGER_ENABLED;
    delete process.env.SOA_WEB_ALL_FEATURES;
    delete process.env.SOA_WEB_LICENSE_SECRET;
    try { fs.unlinkSync(LIC); } catch (_) {}
    ent.reload();
}
function writeLic(obj) { fs.writeFileSync(LIC, JSON.stringify(obj)); ent.reload(); }

// 1) default locked
clearEnv();
ok('default: manager locked', ent.isEnabled('manager') === false);
ok('default: capabilities.manager false', ent.capabilities().manager === false);

// 2) env override on/off + precedence
clearEnv();
process.env.SOA_WEB_MANAGER_ENABLED = '1';
ok('env flag 1 → enabled', ent.isEnabled('manager') === true);
process.env.SOA_WEB_MANAGER_ENABLED = 'off';
ok('env flag off → locked', ent.isEnabled('manager') === false);
clearEnv();
process.env.SOA_WEB_ALL_FEATURES = '1';
ok('env(all) → enabled', ent.isEnabled('manager') === true);

// 3) unsigned license accepted when no secret configured
clearEnv();
writeLic({ features: ['manager'], plan: 'pro', issuedTo: 'Owner' });
ok('unsigned license (no secret) → enabled', ent.isEnabled('manager') === true);
ok('resolve source = license', ent.resolve('manager').source === 'license');

// 4) expired license rejected
clearEnv();
writeLic({ features: ['manager'], expiresAt: '2000-01-01T00:00:00Z' });
ok('expired license → locked', ent.isEnabled('manager') === false);
ok('expired reason', ent.loadLicense().reason === 'expired');

// 5) disabled license rejected
clearEnv();
writeLic({ features: ['manager'], enabled: false });
ok('disabled license → locked', ent.isEnabled('manager') === false);

// 6) feature not granted by license
clearEnv();
writeLic({ features: ['somethingelse'] });
ok('license without manager → locked', ent.isEnabled('manager') === false);

// 7) signature enforcement when a secret is set
clearEnv();
process.env.SOA_WEB_LICENSE_SECRET = 'topsecret';
const payload = { features: ['manager'], plan: 'pro', issuedTo: 'Alice', issuedAt: '2026-01-01T00:00:00Z', expiresAt: null };
const goodSig = ent.expectedSig(payload, 'topsecret');
writeLic({ ...payload, sig: goodSig });
ok('signed license (valid sig) → enabled', ent.isEnabled('manager') === true);
writeLic({ ...payload, sig: 'deadbeef' });
ok('signed license (bad sig) → locked', ent.isEnabled('manager') === false);
ok('bad-signature reason', ent.loadLicense().reason === 'bad-signature');
writeLic({ ...payload }); // no sig at all, but secret is set
ok('unsigned license while secret set → locked', ent.isEnabled('manager') === false);

// 8) env override still wins even with a secret + no license
clearEnv();
process.env.SOA_WEB_LICENSE_SECRET = 'topsecret';
process.env.SOA_WEB_MANAGER_ENABLED = '1';
ok('env override beats missing license', ent.isEnabled('manager') === true);

// 9) requireEntitled middleware
clearEnv();
function runMw(enabled) {
    if (enabled) process.env.SOA_WEB_MANAGER_ENABLED = '1'; else delete process.env.SOA_WEB_MANAGER_ENABLED;
    ent.reload();
    const mw = ent.requireEntitled('manager');
    let nexted = false, statusCode = null, body = null;
    const res = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
    mw({ headers: {} }, res, () => { nexted = true; });
    return { nexted, statusCode, body };
}
const enabledRun = runMw(true);
ok('middleware: entitled → next()', enabledRun.nexted === true && enabledRun.statusCode === null);
const lockedRun = runMw(false);
ok('middleware: locked → 403', lockedRun.nexted === false && lockedRun.statusCode === 403);
ok('middleware: 403 code stable', lockedRun.body && lockedRun.body.code === 'FEATURE_NOT_ENTITLED' && lockedRun.body.feature === 'manager');

// 10) unknown feature safe
clearEnv();
ok('unknown feature → locked', ent.isEnabled('nope') === false);

clearEnv();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
console.log(`\nALL PASS (${pass} checks)`);
