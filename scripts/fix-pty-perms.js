#!/usr/bin/env node
/**
 * node-pty prebuilt helpers sometimes ship without the execute bit after
 * `npm install` — posix_spawnp then fails with EACCES at runtime. This
 * postinstall repairs the bit for every prebuild that looks like a helper.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
if (!fs.existsSync(root)) process.exit(0);

let fixed = 0;
for (const arch of fs.readdirSync(root)) {
    const dir = path.join(root, arch);
    if (!fs.statSync(dir).isDirectory()) continue;
    const helper = path.join(dir, 'spawn-helper');
    if (!fs.existsSync(helper)) continue;
    try {
        fs.chmodSync(helper, 0o755);
        fixed++;
    } catch (_) { /* non-fatal */ }
}
if (fixed) console.log(`[soa-web] repaired exec bit on ${fixed} node-pty helper(s)`);
