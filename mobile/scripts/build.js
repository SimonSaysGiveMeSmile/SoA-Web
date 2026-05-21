#!/usr/bin/env node
/**
 * No-op build script.
 *
 * son-of-anton-mobile is a no-build PWA: every source file is already a
 * browser-runnable asset under ./dist. We keep this script for two reasons:
 *
 *   1. Symmetry with `npm run build` workflows.
 *   2. So future iterations (Tailwind, esbuild, etc.) can hook in without
 *      breaking callers.
 *
 * Today it just verifies that the expected files exist and reports their
 * sizes, so packagers can sanity-check the bundle.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const DESKTOP_PKG = path.resolve(ROOT, '..', 'desktop', 'package.json');
const MOBILE_PKG = path.join(ROOT, 'package.json');

const desktopVersion = readVersion(DESKTOP_PKG);
if (desktopVersion) syncMobileVersion(desktopVersion);

const REQUIRED = [
    'index.html',
    'styles.css',
    'app.js',
    'socket.js',
    'ansi.js',
    'keyboard.js',
    'manifest.webmanifest',
    'sw.js',
    'icon.svg',
];

let total = 0;
let failed = false;
console.log(`son-of-anton-mobile build · ${DIST}\n`);
for (const name of REQUIRED) {
    const full = path.join(DIST, name);
    try {
        const stat = fs.statSync(full);
        total += stat.size;
        console.log(`  OK  ${name.padEnd(28)} ${formatBytes(stat.size)}`);
    } catch (_) {
        failed = true;
        console.log(`  ✗   ${name.padEnd(28)} MISSING`);
    }
}

if (desktopVersion) {
    const versionPath = path.join(DIST, 'version.json');
    const payload = { version: desktopVersion, builtAt: new Date().toISOString() };
    fs.writeFileSync(versionPath, JSON.stringify(payload, null, 2) + '\n');
    const stat = fs.statSync(versionPath);
    total += stat.size;
    console.log(`  OK  version.json${' '.repeat(16)}${formatBytes(stat.size)}  (v${desktopVersion})`);
}

console.log(`\n  total: ${formatBytes(total)}`);
if (failed) {
    console.error('\nbuild failed: some required files are missing');
    process.exit(1);
}

function readVersion(pkgPath) {
    try {
        return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null;
    } catch (_) {
        return null;
    }
}

function syncMobileVersion(version) {
    try {
        const pkg = JSON.parse(fs.readFileSync(MOBILE_PKG, 'utf8'));
        if (pkg.version === version) return;
        pkg.version = version;
        fs.writeFileSync(MOBILE_PKG, JSON.stringify(pkg, null, 2) + '\n');
        console.log(`  ↻  mobile package.json version → ${version}\n`);
    } catch (_) { /* ignore */ }
}

function formatBytes(b) {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b/1024).toFixed(1)} KB`;
    return `${(b/1024/1024).toFixed(2)} MB`;
}
