#!/usr/bin/env node
/**
 * Traffic & download stats — quick CLI summary.
 *
 *   node scripts/traffic-stats.js
 *
 * Reads:
 *   ~/.soa-web/install-log.jsonl        (or $SOA_WEB_INSTALL_LOG)
 *   github.com/SimonSaysGiveMeSmile/SoA-Prod/releases  (per-asset downloads)
 *
 * No external deps. The GitHub call is unauthenticated, so it's rate-limited
 * to 60 req/h per IP — fine for an occasional check, set GITHUB_TOKEN to lift.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const LOG = process.env.SOA_WEB_INSTALL_LOG
    || path.join(os.homedir(), '.soa-web', 'install-log.jsonl');
const RELEASES_REPO = process.env.SOA_PROD_REPO || 'SimonSaysGiveMeSmile/SoA-Prod';

function readInstallLog() {
    if (!fs.existsSync(LOG)) return [];
    return fs.readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
        .filter(Boolean);
}

function summarizeInstalls(entries) {
    const now = Date.now();
    const buckets = { '24h': 0, '7d': 0, '30d': 0, 'all': entries.length };
    const byCountry = {};
    const byRef = {};
    for (const e of entries) {
        const age = now - Date.parse(e.ts);
        if (age <= 86400e3) buckets['24h']++;
        if (age <= 7 * 86400e3) buckets['7d']++;
        if (age <= 30 * 86400e3) buckets['30d']++;
        const c = e.country || '??';
        byCountry[c] = (byCountry[c] || 0) + 1;
        const r = (e.ref || '').slice(0, 60) || '(direct)';
        byRef[r] = (byRef[r] || 0) + 1;
    }
    return { buckets, byCountry, byRef };
}

function topN(obj, n = 10) {
    return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const headers = { 'user-agent': 'soa-traffic-stats' };
        if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
        https.get(url, { headers }, res => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error(`${res.statusCode}: ${body.slice(0, 200)}`));
                try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function summarizeReleases() {
    const releases = await fetchJson(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=20`);
    const rows = [];
    let total = 0;
    for (const r of releases) {
        for (const a of (r.assets || [])) {
            rows.push({ tag: r.tag_name, name: a.name, dl: a.download_count, size: a.size });
            total += a.download_count;
        }
    }
    return { rows, total, releaseCount: releases.length };
}

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

(async () => {
    const installs = summarizeInstalls(readInstallLog());
    console.log('\n── install.sh hits ─────────────────────────────────────');
    console.log(`log:     ${LOG}`);
    console.log(`24h: ${installs.buckets['24h']}   7d: ${installs.buckets['7d']}   30d: ${installs.buckets['30d']}   all-time: ${installs.buckets.all}`);
    if (installs.buckets.all > 0) {
        console.log('\ntop countries:');
        for (const [c, n] of topN(installs.byCountry)) console.log(`  ${pad(c, 6)} ${n}`);
        console.log('\ntop referrers:');
        for (const [r, n] of topN(installs.byRef)) console.log(`  ${pad(r, 60)} ${n}`);
    }

    console.log('\n── desktop release downloads ──────────────────────────');
    try {
        const rel = await summarizeReleases();
        console.log(`repo: ${RELEASES_REPO}    releases: ${rel.releaseCount}    total downloads: ${rel.total}`);
        console.log('\nper asset:');
        for (const r of rel.rows.sort((a, b) => b.dl - a.dl)) {
            console.log(`  ${pad(r.tag, 12)} ${pad(r.name, 40)} ${r.dl}`);
        }
    } catch (e) {
        console.log(`(github fetch failed: ${e.message})`);
    }
    console.log('');
})();
