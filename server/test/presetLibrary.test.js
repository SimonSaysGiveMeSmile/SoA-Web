'use strict';
// The shipped skill library (mcp/presets/**): loads cleanly, stays inside its
// description budget, and carries none of the instructions the library rules
// forbid. Plus the daemon's boot-time sync hook. Everything runs against temp
// dirs: never the real vault or the real ~/.claude / ~/.codex, and no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soa-presets-test-')));
test.after(() => fs.rmSync(T, { recursive: true, force: true }));
const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'soa-mcp');
const PRESETS = path.resolve(__dirname, '..', '..', 'mcp', 'presets');
for (const k of ['SOA_MCP_PRESETS_DISABLE', 'SOA_MCP_PRESETS_DIR', 'SOA_MCP_SKILL_PREFIX', 'SOA_MCP_SYNC', 'CODEX_HOME']) delete process.env[k];
process.env.SOA_WEB_STATE_DIR = path.join(T, 'state');
process.env.SOA_MCP_CLAUDE_SKILLS_DIR = path.join(T, 'claude-skills');
process.env.SOA_MCP_CODEX_SKILLS_DIR = path.join(T, 'codex-skills');
const m = require(SCRIPT);
const { startPresetSync } = require('../src/presetSync');

const FORBIDDEN = ['claude -p', 'codex exec', 'dangerously', 'bypassPermissions', 'npx -y', '@latest',
    'PROACTIVELY', 'MUST BE USED', 'core.hooksPath', 'git push --force', '/Users/'];
const MAX_DESC = 300, MAX_TOTAL = 4000;

const packDirs = fs.readdirSync(PRESETS, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
const skillFiles = [];
for (const pack of packDirs) {
    const sd = path.join(PRESETS, pack, 'skills');
    if (!fs.existsSync(sd)) continue;
    for (const slug of fs.readdirSync(sd).sort()) skillFiles.push({ pack, slug, file: path.join(sd, slug, 'SKILL.md') });
}

test('every preset pack loads with no problems', () => {
    const p = m.loadPresets();
    assert.deepStrictEqual(p.problems, []);
    assert.deepStrictEqual(p.packs.map(x => x.name), packDirs, 'every pack dir is a loaded pack');
    for (const k of p.packs) {
        assert.match(k.version, /^\d+\.\d+\.\d+$/, k.name);
        assert.ok(k.description && k.author && k.license, `${k.name}: description, author, license`);
    }
    assert.ok(p.packs.find(x => x.name === 'soa-engineering'), 'engineering pack present');
    assert.strictEqual(Object.keys(p.skills).length, skillFiles.length, 'every skill dir was loaded');
});

test('each skill: name == slug, description <= 300 chars, regular file under the size cap', () => {
    assert.ok(skillFiles.length >= 3);
    for (const { slug, file } of skillFiles) {
        const st = fs.lstatSync(file);
        assert.ok(st.isFile() && !st.isSymbolicLink(), `${slug}: regular file`);
        assert.ok(st.size <= m.MAX_ITEM_BYTES, `${slug}: size`);
        assert.ok(!fs.lstatSync(path.dirname(file)).isSymbolicLink(), `${slug}: dir not a symlink`);
        const { meta, body } = m.parseSkillMd(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(meta.name, slug, `${slug}: front matter name`);
        assert.ok(meta.description && meta.description.trim(), `${slug}: has a description`);
        assert.ok(meta.description.length <= MAX_DESC, `${slug}: description ${meta.description.length} > ${MAX_DESC}`);
        assert.ok(body.trim().length > 0, `${slug}: has a body`);
    }
});

test('library description budget', () => {
    const total = skillFiles.reduce((n, { file }) => n + m.parseSkillMd(fs.readFileSync(file, 'utf8')).meta.description.length, 0);
    assert.ok(total <= MAX_TOTAL, `total description characters ${total} > ${MAX_TOTAL}`);
});

test('descriptions are distinct', () => {
    const seen = new Map();
    for (const { slug, file } of skillFiles) {
        const d = m.parseSkillMd(fs.readFileSync(file, 'utf8')).meta.description.toLowerCase();
        assert.ok(!seen.has(d), `${slug} duplicates ${seen.get(d)}`);
        seen.set(d, slug);
    }
});

test('no SKILL.md or pack file contains a forbidden pattern', () => {
    const files = skillFiles.map(s => s.file);
    for (const pack of packDirs) for (const f of ['pack.json', 'README.md']) { const p = path.join(PRESETS, pack, f); if (fs.existsSync(p)) files.push(p); }
    for (const f of files) {
        const text = fs.readFileSync(f, 'utf8');
        for (const bad of FORBIDDEN) assert.ok(!text.includes(bad), `${path.relative(PRESETS, f)} contains "${bad}"`);
        assert.strictEqual(m.secretKind(text), null, `${path.relative(PRESETS, f)} looks like it holds a secret`);
    }
});

test('boot sync hook: honours both kill switches without spawning', () => {
    let spawned = 0;
    const spawnFn = () => { spawned++; throw new Error('should not spawn'); };
    assert.deepStrictEqual(startPresetSync({ env: { SOA_MCP_SYNC: '0' }, spawn: spawnFn, log: () => {} }), { skipped: 'SOA_MCP_SYNC=0' });
    assert.deepStrictEqual(startPresetSync({ env: { SOA_MCP_PRESETS_DISABLE: '1' }, spawn: spawnFn, log: () => {} }), { skipped: 'SOA_MCP_PRESETS_DISABLE=1' });
    assert.deepStrictEqual(startPresetSync({ env: {}, script: path.join(T, 'missing'), spawn: spawnFn, log: () => {} }), { skipped: 'soa-mcp not found' });
    // a dev/test daemon must not sync its own (empty) vault into the real skills dirs
    const H = path.join(T, 'fakehome');
    assert.deepStrictEqual(startPresetSync({ env: { SOA_WEB_STATE_DIR: path.join(T, 'dev-state') }, home: H, spawn: spawnFn, log: () => {} }), { skipped: 'not the default state dir' });
    assert.deepStrictEqual(startPresetSync({ env: { NODE_TEST_CONTEXT: 'child' }, home: H, spawn: spawnFn, log: () => {} }), { skipped: 'under node --test' });
    assert.deepStrictEqual(startPresetSync({ env: { SOA_WEB_STATE_DIR: '~/.soa-web-local' }, home: H, script: path.join(T, 'missing'), spawn: spawnFn, log: () => {} }), { skipped: 'soa-mcp not found' });
    assert.strictEqual(spawned, 0);
    const logs = [];
    assert.deepStrictEqual(startPresetSync({ env: {}, spawn: () => { throw Object.assign(new Error('x'), { code: 'EAGAIN' }); }, log: (l) => logs.push(l) }), { error: 'spawn' });
    assert.match(logs[0], /could not start \(EAGAIN\)/);
});

test('boot sync hook: mirrors every preset into temp skills dirs and leaves user dirs alone', async (t) => {
    const CL = path.join(T, 'boot-claude'), CX = path.join(T, 'boot-codex');
    fs.mkdirSync(path.join(CL, 'eng-code-review'), { recursive: true });
    fs.writeFileSync(path.join(CL, 'eng-code-review', 'SKILL.md'), 'USER OWNED');
    const env = { PATH: process.env.PATH, HOME: path.join(T, 'home'), SOA_WEB_STATE_DIR: path.join(T, 'boot-state'),
        SOA_MCP_CLAUDE_SKILLS_DIR: CL, SOA_MCP_CODEX_SKILLS_DIR: CX };
    // The hook unrefs its child and timer (it must never hold the daemon open),
    // so keep this test's event loop alive until the child reports back.
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    const line = await new Promise((resolve) => {
        const r = startPresetSync({ env, timeoutMs: 20000, log: resolve });
        assert.deepStrictEqual(r, { started: true });
    });
    assert.match(line, /^skills sync: done; some skill dirs are not soa-mcp-managed/, 'user-owned dir reported (exit 3)');
    assert.strictEqual(fs.readFileSync(path.join(CL, 'eng-code-review', 'SKILL.md'), 'utf8'), 'USER OWNED');
    for (const { slug } of skillFiles) {
        assert.ok(fs.existsSync(path.join(CX, slug, 'SKILL.md')), `codex ${slug}`);
        assert.ok(fs.existsSync(path.join(CX, slug, m.MARKER)), `codex ${slug} marker`);
        if (slug !== 'eng-code-review') assert.ok(fs.existsSync(path.join(CL, slug, m.MARKER)), `claude ${slug}`);
    }
    // a second boot is a no-op on the managed dirs
    fs.rmSync(path.join(CL, 'eng-code-review'), { recursive: true });
    const line2 = await new Promise((resolve) => startPresetSync({ env, timeoutMs: 20000, log: resolve }));
    assert.strictEqual(line2, 'skills sync: native skills in sync');
});
