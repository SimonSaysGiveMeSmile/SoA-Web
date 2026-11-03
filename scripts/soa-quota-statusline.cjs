#!/usr/bin/env node
// Official Claude status-line payload, scoped to one saved account profile.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function capture(data, directory, now = Date.now()) {
    if (!directory || !data?.session_id || !data.rate_limits) return;
    const windows = {};
    for (const key of ['five_hour', 'seven_day']) {
        const w = data.rate_limits[key];
        windows[key] = w && Number.isFinite(w.used_percentage) && w.used_percentage >= 0 && w.used_percentage <= 100 && Number.isFinite(w.resets_at)
            ? { used_percentage: w.used_percentage, resets_at: w.resets_at } : null;
    }
    const signature = crypto.createHash('sha256').update(JSON.stringify(windows)).digest('hex');
    const name = crypto.createHash('sha256').update(String(data.session_id)).digest('hex') + '.json';
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, name);
    let prior; try { prior = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
    const value = { version: 1, source: 'claude-code-statusline', windows, signature,
        updatedAt: prior?.signature === signature ? prior.updatedAt : now, receivedAt: now };
    const temp = file + '.' + process.pid;
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temp, file);
}
if (require.main === module) {
    let text = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { if (text.length < 1024 * 1024) text += chunk; });
    process.stdin.on('end', () => { try { capture(JSON.parse(text), process.argv[2]); } catch (_) {} });
}
module.exports = { capture };
