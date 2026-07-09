/**
 * tunnelProvision — zero-effort cloudflared.
 *
 * Finds the cloudflared binary, and when a fresh machine has none, downloads
 * the official release from GitHub into the daemon's own state dir — so a
 * brand-new install can bring up a Cloudflare quick tunnel with ONE CLICK in
 * the web UI: no brew, no account, no terminal. Quick tunnels
 * (trycloudflare.com) need no Cloudflare account at all; the binary is the
 * only prerequisite, so the daemon owning it closes the last gap.
 *
 * The managed binary lives at <state>/bin/cloudflared — inside the install's
 * own state dir, never a system path (no sudo, uninstall removes it, and a
 * dev daemon's copy can't fight the production one). Downloads via Node's
 * https never set com.apple.quarantine, so Gatekeeper doesn't block the
 * managed binary on macOS.
 *
 * Env knobs:
 *   SOA_WEB_CLOUDFLARED      explicit binary path — used when it exists,
 *                            otherwise ignored (falls through to discovery).
 *   SOA_WEB_TUNNEL_AUTOFETCH '0' disables the download (discovery only).
 *   SOA_WEB_TUNNEL_FRESH     '1' skips system discovery (managed copy +
 *                            download only) — simulates a fresh machine for
 *                            tests even when brew's cloudflared is present.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { STATE_DIR } = require('./stateDir');
const { dbg } = require('./debug');

const BIN_DIR = path.join(STATE_DIR, 'bin');
const MANAGED_BIN = path.join(BIN_DIR, 'cloudflared');

// Release asset per platform/arch (verified against the 2026.7.1 release):
// darwin ships .tgz archives (~19–21 MB), linux ships raw static binaries
// (~34–40 MB). Windows is out of scope (the daemon itself targets mac/linux).
// arm → armhf: Node reports 'arm' for both, and hard-float is right for every
// modern 32-bit Pi OS. No ia32 mapping — the release has no linux-386 asset.
function assetName() {
    if (process.platform === 'darwin') {
        const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
        return arch ? `cloudflared-darwin-${arch}.tgz` : null;
    }
    if (process.platform === 'linux') {
        const arch = { x64: 'amd64', arm64: 'arm64', arm: 'armhf' }[process.arch];
        return arch ? `cloudflared-linux-${arch}` : null;
    }
    return null;
}

function assetUrl() {
    const asset = assetName();
    if (!asset) return null;
    // "latest/download" is GitHub's stable alias — no API call, no rate limit,
    // no JSON parsing; it 302s straight to the newest release's asset.
    return `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
}

// ── discovery ─────────────────────────────────────────────────────────────

function _exists(p) { try { return !!p && fs.existsSync(p); } catch (_) { return false; } }

// Same well-known-paths-first probe tunnel.js uses, so a launchd-stripped
// PATH can't hide a brew/apt install.
function _findSystemBinary() {
    const candidates = [
        '/opt/homebrew/bin/cloudflared',
        '/usr/local/bin/cloudflared',
        '/usr/bin/cloudflared',
        '/bin/cloudflared',
    ];
    for (const c of candidates) if (_exists(c)) return Promise.resolve(c);
    return new Promise(resolve => {
        execFile('which', ['cloudflared'], (err, stdout) => {
            resolve(!err && stdout.trim() ? stdout.trim() : null);
        });
    });
}

// ── download ──────────────────────────────────────────────────────────────

// GET that follows redirects (github.com 302s to objects.githubusercontent)
// and streams to a file, reporting {pct,receivedMB,totalMB} as bytes land.
function _download(url, dest, onProgress, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) return reject(new Error('too many redirects'));
        const req = https.get(url, { headers: { 'user-agent': 'soa-web-tunnel-provision' } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(_download(res.headers.location, dest, onProgress, redirects + 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`download failed: HTTP ${res.statusCode}`));
            }
            const total = parseInt(res.headers['content-length'] || '0', 10);
            let received = 0;
            const out = fs.createWriteStream(dest);
            res.on('data', chunk => {
                received += chunk.length;
                if (onProgress && total) {
                    onProgress({
                        pct: Math.min(99, Math.round(received / total * 100)),
                        receivedMB: +(received / 1e6).toFixed(1),
                        totalMB: +(total / 1e6).toFixed(1),
                    });
                }
            });
            res.pipe(out);
            out.on('finish', () => out.close(() => resolve()));
            out.on('error', reject);
            res.on('error', reject);
        });
        req.on('error', reject);
        // A quick-tunnel binary is ~20–40 MB; 5 min covers even a slow link,
        // and a hung socket must not wedge the pairing state machine forever.
        req.setTimeout(300000, () => { try { req.destroy(new Error('download timeout')); } catch (_) {} });
    });
}

function _extractTgz(tgz, destDir) {
    // bsdtar ships with macOS (the only .tgz platform); shelling out beats
    // adding a tar dependency for one file.
    return new Promise((resolve, reject) => {
        execFile('tar', ['-xzf', tgz, '-C', destDir], { timeout: 60000 }, err => {
            err ? reject(new Error('extract failed: ' + err.message)) : resolve();
        });
    });
}

// Positive verification: the binary must actually run on this machine (catches
// a truncated download or a wrong-arch asset before we ever trust it).
// Deliberately no checksum step: the release publishes hashes only via the
// GitHub API (rate-limited) and the release-notes body (which hashes the
// *inner* binary for the darwin .tgz, not the archive), and both come from
// the same TLS origin as the download itself — so a hash check adds nothing
// against a compromised origin and only re-detects corruption, which
// executing --version already catches.
function _verifyRuns(bin) {
    return new Promise((resolve, reject) => {
        execFile(bin, ['--version'], { timeout: 15000 }, (err, stdout) => {
            if (err) return reject(new Error('downloaded cloudflared does not run: ' + err.message));
            resolve(String(stdout || '').trim());
        });
    });
}

let _inflight = null; // single-flight: concurrent pair-starts share one download

async function _fetchManaged(onProgress) {
    const url = assetUrl();
    if (!url) throw new Error(`no cloudflared build for ${process.platform}/${process.arch}`);
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-cfd-'));
    const isTgz = url.endsWith('.tgz');
    const tmpFile = path.join(tmpDir, isTgz ? 'cloudflared.tgz' : 'cloudflared');
    try {
        dbg('tunnel', 'provision: downloading', url);
        await _download(url, tmpFile, onProgress);
        let binSrc = tmpFile;
        if (isTgz) {
            await _extractTgz(tmpFile, tmpDir);
            binSrc = path.join(tmpDir, 'cloudflared');
            if (!_exists(binSrc)) throw new Error('archive did not contain a cloudflared binary');
        }
        fs.chmodSync(binSrc, 0o755);
        const version = await _verifyRuns(binSrc);
        // Rename is atomic only within a filesystem; tmpdir may be elsewhere,
        // so copy into place then swap.
        const staging = MANAGED_BIN + '.new';
        fs.copyFileSync(binSrc, staging);
        fs.chmodSync(staging, 0o755);
        fs.renameSync(staging, MANAGED_BIN);
        dbg('tunnel', 'provision: installed', MANAGED_BIN, `(${version})`);
        return MANAGED_BIN;
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
}

/**
 * Resolve a usable cloudflared binary, downloading one when the machine has
 * none. Returns the path, or null (never throws) — callers treat null as
 * "provider unavailable" and fall through to the next tunnel provider.
 * onProgress (optional) receives {pct, receivedMB, totalMB} during a download.
 */
async function ensureCloudflared(onProgress) {
    const fresh = process.env.SOA_WEB_TUNNEL_FRESH === '1';

    // 1. Operator override.
    if (!fresh) {
        const explicit = process.env.SOA_WEB_CLOUDFLARED;
        if (_exists(explicit)) return explicit;
    }
    // 2. Our own managed copy (previous download).
    if (_exists(MANAGED_BIN)) return MANAGED_BIN;
    // 3. System install (brew/apt/manual).
    if (!fresh) {
        const sys = await _findSystemBinary();
        if (sys) return sys;
    }
    // 4. Download. Single-flight so a double-click can't race two downloads.
    if (process.env.SOA_WEB_TUNNEL_AUTOFETCH === '0') return null;
    if (!_inflight) {
        _inflight = _fetchManaged(onProgress).finally(() => { _inflight = null; });
    }
    try {
        return await _inflight;
    } catch (err) {
        dbg('tunnel', 'provision failed:', err.message);
        return null;
    }
}

module.exports = { ensureCloudflared, assetName, MANAGED_BIN };
