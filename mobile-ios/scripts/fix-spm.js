#!/usr/bin/env node
/*
 * fix-spm.js — repoint Capacitor's SPM manifests at the LOCAL vendored
 * XCFrameworks (ios/capacitor-swift-pm-local/) after `npx cap sync ios`.
 *
 * Why: `cap sync ios` regenerates ios/App/CapApp-SPM/Package.swift with the
 * network binaryTarget dependency
 *   .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "…")
 * and in this environment xcodebuild's SPM artifact fetch stalls indefinitely
 * on "Resolve Package Graph". The XCFrameworks are vendored locally, so this
 * script rewrites every manifest that references the GitHub URL to the local
 * path, and deletes the stale swiftpm Package.resolved so Xcode re-resolves
 * against the local graph.
 *
 * Wired into every build path that runs `cap sync` (see package.json), so the
 * trap can no longer be sprung by a routine `npm run build`.
 *
 * IDEMPOTENT: re-running when everything is already local is a clean no-op.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// url-form emitted by the Capacitor CLI (`exact:`/`from:` both seen across versions)
const GITHUB_PKG_RE =
  /\.package\(\s*url:\s*"https:\/\/github\.com\/ionic-team\/capacitor-swift-pm(?:\.git)?"\s*,\s*(?:exact|from|branch|revision):\s*"[^"]*"\s*\)/g;

let changed = 0;

function repoint(file, localPath) {
  if (!fs.existsSync(file)) {
    console.log(`[fix-spm] skip (missing): ${path.relative(ROOT, file)}`);
    return;
  }
  const src = fs.readFileSync(file, 'utf8');
  const out = src.replace(
    GITHUB_PKG_RE,
    `.package(name: "capacitor-swift-pm", path: "${localPath}")`
  );
  if (out !== src) {
    fs.writeFileSync(file, out);
    changed++;
    console.log(`[fix-spm] repointed -> local vendor: ${path.relative(ROOT, file)}`);
  } else if (out.includes('capacitor-swift-pm-local')) {
    console.log(`[fix-spm] already local: ${path.relative(ROOT, file)}`);
  } else {
    console.log(`[fix-spm] no capacitor-swift-pm dependency found: ${path.relative(ROOT, file)}`);
  }
}

// 1) The app-level manifest cap sync regenerates every run.
//    (path is relative to ios/App/CapApp-SPM/)
repoint(
  path.join(ROOT, 'ios', 'App', 'CapApp-SPM', 'Package.swift'),
  '../../capacitor-swift-pm-local'
);

// 2) Plugin manifests under node_modules/@capacitor/* — cap sync does not
//    rewrite these, but `npm install`/`npm ci` restores the npm-shipped copies
//    (which use the GitHub URL), so fix them too. (path is relative to
//    node_modules/@capacitor/<plugin>/)
const capDir = path.join(ROOT, 'node_modules', '@capacitor');
if (fs.existsSync(capDir)) {
  for (const entry of fs.readdirSync(capDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(capDir, entry.name, 'Package.swift');
    if (fs.existsSync(manifest)) {
      repoint(manifest, '../../../ios/capacitor-swift-pm-local');
    }
  }
}

// 3) Delete stale swiftpm Package.resolved files (pins from a previous graph
//    make Xcode try the network again).
function findResolved(dir, hits) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'build' || entry.name === 'DerivedData') continue;
      findResolved(p, hits);
    } else if (entry.name === 'Package.resolved' && p.includes('swiftpm')) {
      hits.push(p);
    }
  }
}
const resolved = [];
findResolved(path.join(ROOT, 'ios', 'App'), resolved);
for (const p of resolved) {
  fs.rmSync(p, { force: true });
  changed++;
  console.log(`[fix-spm] deleted stale ${path.relative(ROOT, p)}`);
}

console.log(changed ? `[fix-spm] done (${changed} change(s)).` : '[fix-spm] done (no-op — already fixed).');
