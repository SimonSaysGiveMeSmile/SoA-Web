'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
// Everything runs in a throwaway dir: never the real vault or the real skills dirs.
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soa-mcp-test-')));
process.env.SOA_MCP_BIN = path.resolve(__dirname, '..', '..', 'scripts', 'soa-mcp');
delete process.env.SOA_MCP_SYNC; // the tool calls below autosync into the temp skills dirs
for (const k of ['SOA_MCP_PRESETS_DISABLE', 'SOA_MCP_CLAUDE_CONFIG', 'CODEX_HOME']) delete process.env[k];
test.after(() => fs.rmSync(T, { recursive: true, force: true }));
process.env.SOA_WEB_STATE_DIR = path.join(T, 'state-unit');
process.env.SOA_MCP_CLAUDE_SKILLS_DIR = path.join(T, 'claude-skills');
process.env.SOA_MCP_CODEX_SKILLS_DIR = path.join(T, 'codex-skills');
delete process.env.SOA_MCP_SKILL_PREFIX;
fs.rmSync(process.env.SOA_WEB_STATE_DIR, { recursive: true, force: true });
fs.rmSync(process.env.SOA_MCP_CLAUDE_SKILLS_DIR, { recursive: true, force: true });
fs.rmSync(process.env.SOA_MCP_CODEX_SKILLS_DIR, { recursive: true, force: true });
const m = require(process.env.SOA_MCP_BIN);
const mode = f => fs.statSync(f).mode & 0o777;

test('slug rules', () => {
    for (const ok of ['a', 'hello-curl', 'x'.repeat(64), '0abc']) assert.strictEqual(m.slugOf(ok), ok);
    for (const bad of ['', '-x', 'A', 'a_b', 'a b', 'x'.repeat(65), '../etc', 'a/b', 'a\\b', '..', 'a\0b', 'é'])
        assert.throws(() => m.slugOf(bad), m.UserError, bad);
});
test('secret detection', () => {
    const fakes = ['sk-' + 'a'.repeat(24), 'sk-ant-api03-' + 'b'.repeat(20), 'ghp_' + 'c'.repeat(36), 'AKIA' + 'ABCDEFGHIJKLMNOP',
        '-----BEGIN OPENSSH PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----', 'xoxb-' + '1234567890-abc', 'xoxp-' + '1234567890-abc'];
    for (const f of fakes) assert.ok(m.secretKind('x ' + f + ' y'), f);
    for (const ok of ['curl -s localhost:1', 'task-sk-1', 'export KEY="$OPENAI_API_KEY"', 'AKIA lowercase']) assert.strictEqual(m.secretKind(ok), null, ok);
});
test('save/get skill, modes, front matter, overwrite guard', () => {
    const r = m.saveSkill({ name: 'deploy-check', description: 'How to deploy: "safely"', body: '# Steps\n1. test' });
    assert.ok(r.ok);
    const f = path.join(m.MCP_DIR, 'skills', 'deploy-check', 'SKILL.md');
    assert.strictEqual(mode(f), 0o600);
    assert.strictEqual(mode(m.MCP_DIR), 0o700);
    assert.strictEqual(mode(path.dirname(f)), 0o700);
    assert.strictEqual(mode(path.join(m.MCP_DIR, 'index.json')), 0o600);
    const s = m.readSkill('deploy-check');
    assert.strictEqual(s.description, 'How to deploy: "safely"');
    assert.match(s.body, /1\. test/);
    assert.match(fs.readFileSync(f, 'utf8'), /^---\nname: deploy-check\ndescription: /);
    assert.throws(() => m.saveSkill({ name: 'deploy-check', description: 'd', body: 'b' }), /already exists/);
    assert.ok(m.saveSkill({ name: 'deploy-check', description: 'd2', body: 'b2', overwrite: true }).replaced);
    // whole SKILL.md as the body
    m.saveSkill({ name: 'whole', body: '---\nname: whole\ndescription: from fm\n---\nhello' });
    assert.strictEqual(m.readSkill('whole').description, 'from fm');
    assert.strictEqual(m.readSkill('whole').body.trim(), 'hello');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(f)), ['SKILL.md'], 'no tmp files left');
});
test('secret refusal and allow_secrets', () => {
    const key = 'ghp_' + 'Z'.repeat(36);
    assert.throws(() => m.saveSnippet({ name: 'leak', code: `TOKEN=${key}` }), (e) => e instanceof m.UserError && !e.message.includes(key));
    assert.throws(() => m.saveSkill({ name: 'leak2', description: 'd', body: '-----BEGIN PRIVATE KEY-----' }), /secret|private key/i);
    assert.ok(m.saveSnippet({ name: 'leak-ok', code: `TOKEN=${key}`, allow_secrets: true }).ok);
    m.deleteItem('snippet', { name: 'leak-ok', confirm: true });
});
test('size limits', () => {
    assert.throws(() => m.saveSnippet({ name: 'big', code: 'x'.repeat(m.MAX_ITEM_BYTES + 1) }), /limit/);
    assert.ok(m.saveSnippet({ name: 'big-ok', code: 'x'.repeat(m.MAX_ITEM_BYTES - 10) }).ok);
    m.deleteItem('snippet', { name: 'big-ok', confirm: true });
});
test('snippets: language → ext, tags, change of language, list/search', () => {
    m.saveSnippet({ name: 'hello-curl', code: 'curl -s localhost:1\n', language: 'bash', tags: ['net', 'Demo'] });
    assert.ok(fs.existsSync(path.join(m.MCP_DIR, 'snippets', 'hello-curl.sh')));
    const s = m.readSnippet('hello-curl');
    assert.strictEqual(s.language, 'shell'); assert.deepStrictEqual(s.tags, ['net', 'demo']);
    assert.strictEqual(s.source, 'user'); assert.strictEqual(typeof m.listSnippets().find(x => x.name === 'hello-curl').source, 'string');
    m.saveSnippet({ name: 'hello-curl', code: 'print(1)', language: 'python', overwrite: true });
    assert.ok(!fs.existsSync(path.join(m.MCP_DIR, 'snippets', 'hello-curl.sh')));
    assert.ok(fs.existsSync(path.join(m.MCP_DIR, 'snippets', 'hello-curl.py')));
    m.saveSnippet({ name: 'tagged', code: 'x', tags: ['net'] });
    assert.deepStrictEqual(m.listSnippets({ tag: 'net' }).map(x => x.name), ['tagged']);
    assert.ok(m.search({ query: 'print' }).some(h => h.name === 'hello-curl'));
    assert.throws(() => m.saveSnippet({ name: 'x', code: 'y', language: '../../evil' }), m.UserError);
});
test('symlink refusal', () => {
    const outside = path.join(T, 'outside.txt'); fs.writeFileSync(outside, 'secret outside');
    const link = path.join(m.MCP_DIR, 'snippets', 'linked.sh');
    fs.symlinkSync(outside, link);
    assert.ok(!m.listSnippets().some(s => s.name === 'linked'), 'symlinked file not listed');
    assert.throws(() => m.saveSnippet({ name: 'linked', code: 'pwn', language: 'sh' }), /symlink/);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'secret outside');
    fs.unlinkSync(link);
    const dirOut = path.join(T, 'outside-dir'); fs.mkdirSync(dirOut, { recursive: true });
    fs.symlinkSync(dirOut, path.join(m.MCP_DIR, 'skills', 'evil'));
    assert.throws(() => m.saveSkill({ name: 'evil', description: 'd', body: 'b' }), /symlink/);
    assert.deepStrictEqual(fs.readdirSync(dirOut), []);
    fs.unlinkSync(path.join(m.MCP_DIR, 'skills', 'evil'));
});
test('presets: listed, read-only, shadowed by user items', () => {
    const p = m.loadPresets();
    assert.ok(p.packs.find(x => x.name === 'soa-basics'));
    const sk = m.listSkills().find(s => s.name === 'soa-work-claims');
    assert.strictEqual(sk.source, 'preset');
    assert.throws(() => m.deleteItem('skill', { name: 'soa-work-claims', confirm: true }), /read-only preset/);
    assert.throws(() => m.deleteItem('snippet', { name: 'soa-claim-wrap', confirm: true }), /read-only preset/);
    m.saveSkill({ name: 'soa-work-claims', description: 'mine', body: 'my version' });
    const s2 = m.listSkills().find(s => s.name === 'soa-work-claims');
    assert.strictEqual(s2.source, 'user'); assert.match(s2.shadows, /preset:soa-basics/);
    assert.strictEqual(m.readSkill('soa-work-claims').body.trim(), 'my version');
    const r = m.deleteItem('skill', { name: 'soa-work-claims', confirm: true });
    assert.match(r.note, /visible again/);
    assert.strictEqual(m.readSkill('soa-work-claims').source, 'preset');
});
test('delete needs confirm', () => {
    assert.throws(() => m.deleteItem('skill', { name: 'whole' }), /confirm/);
    assert.ok(m.deleteItem('skill', { name: 'whole', confirm: true }).ok);
    assert.ok(!fs.existsSync(path.join(m.MCP_DIR, 'skills', 'whole')));
});
test('export_skill: one-item sync to both clients, idempotent, refuses a hand-edited copy', () => {
    const CL = process.env.SOA_MCP_CLAUDE_SKILLS_DIR, CX = process.env.SOA_MCP_CODEX_SKILLS_DIR;
    const r = m.exportSkill({ name: 'deploy-check' });
    assert.ok(r.ok && /^created /.test(r.native.claude) && /^created /.test(r.native.codex), JSON.stringify(r));
    assert.ok(fs.existsSync(path.join(CL, 'deploy-check', 'SKILL.md')) && fs.existsSync(path.join(CX, 'deploy-check', 'SKILL.md')));
    // only that item: presets were not synced by a one-item export
    assert.ok(!fs.existsSync(path.join(CL, 'soa-work-claims')));
    assert.match(m.exportSkill({ name: 'deploy-check' }).native.claude, /^up to date/);
    fs.appendFileSync(path.join(CL, 'deploy-check', 'SKILL.md'), '\nmy local note\n');
    m.saveSkill({ name: 'deploy-check', description: 'changed', body: 'new', overwrite: true });
    const r2 = m.exportSkill({ name: 'deploy-check' });
    assert.match(r2.native.claude, /edited by hand/);
    assert.match(r2.native.codex, /^updated /);
    assert.match(fs.readFileSync(path.join(CL, 'deploy-check', 'SKILL.md'), 'utf8'), /my local note/, 'hand edit preserved');
    fs.rmSync(path.join(CL, 'deploy-check'), { recursive: true });   // the documented way to re-sync
    assert.match(m.exportSkill({ name: 'deploy-check' }).native.claude, /^created /);
    assert.throws(() => m.exportSkill({ name: 'nope' }), /no skill/);
});
test('sync: presets + user, user shadows preset, marker + modes, never touches unmanaged', () => {
    const CL = process.env.SOA_MCP_CLAUDE_SKILLS_DIR, CX = process.env.SOA_MCP_CODEX_SKILLS_DIR;
    // the user's own skills that must survive everything below
    fs.mkdirSync(path.join(CL, 'chatgpt'), { recursive: true });
    fs.writeFileSync(path.join(CL, 'chatgpt', 'SKILL.md'), 'USER OWNED');
    fs.mkdirSync(path.join(CX, '.system', 'imagegen'), { recursive: true });
    fs.writeFileSync(path.join(CX, '.system', 'imagegen', 'SKILL.md'), 'BUILTIN');
    fs.mkdirSync(path.join(CX, 'unrelated'), { recursive: true });
    fs.writeFileSync(path.join(CX, 'unrelated', 'SKILL.md'), 'OTHER');
    m.saveSkill({ name: 'chatgpt', description: 'vault chatgpt', body: 'vault body' });
    m.saveSkill({ name: 'imagegen', description: 'vault imagegen', body: 'vault body' });
    m.saveSkill({ name: 'soa-msg-etiquette', description: 'my own etiquette', body: 'shadow body' });
    const dry = m.syncSkills({ dryRun: true });
    const before = fs.readdirSync(CL).sort().join(',');
    assert.strictEqual(fs.readdirSync(CL).sort().join(','), before, 'dry run wrote nothing');
    assert.ok(dry.targets[0].created.includes('soa-work-claims'));
    const r = m.syncSkills();
    const [cl, cx] = r.targets;
    assert.strictEqual(cl.client, 'claude'); assert.strictEqual(cx.client, 'codex');
    for (const t of [cl, cx]) for (const n of ['soa-work-claims', 'soa-ctx-next-steps', 'soa-msg-etiquette']) assert.ok(t.created.includes(n) || t.unchanged.includes(n) || t.updated.includes(n), `${t.client} ${n}`);
    assert.ok(cl.conflicts.some(c => c.name === 'chatgpt' && /not managed/.test(c.reason)));
    assert.strictEqual(fs.readFileSync(path.join(CL, 'chatgpt', 'SKILL.md'), 'utf8'), 'USER OWNED');
    assert.ok(cx.conflicts.some(c => c.name === 'imagegen' && /built-in/.test(c.reason)));
    assert.ok(!fs.existsSync(path.join(CX, 'imagegen')));
    assert.ok(cx.created.includes('chatgpt'), 'no conflict on the codex side');
    const f = path.join(CX, 'soa-msg-etiquette', 'SKILL.md');
    assert.match(fs.readFileSync(f, 'utf8'), /^---\nname: soa-msg-etiquette\ndescription: "my own etiquette"\n---\n\nshadow body\n$/);
    assert.strictEqual(mode(f), 0o600);
    assert.strictEqual(mode(path.dirname(f)), 0o700);
    const mk = JSON.parse(fs.readFileSync(path.join(CX, 'soa-msg-etiquette', m.MARKER), 'utf8'));
    assert.strictEqual(mk.managedBy, 'soa-mcp'); assert.strictEqual(mk.source, 'user');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(CX, 'soa-work-claims', m.MARKER), 'utf8')).source, 'preset:soa-basics');
    assert.deepStrictEqual(fs.readdirSync(CX).filter(n => n.startsWith('.soa-mcp-new')), [], 'no temp dirs left');
    // idempotent
    const again = m.syncSkills();
    for (const t of again.targets) assert.strictEqual(t.created.length + t.updated.length + t.removed.length, 0);
    // deleting the shadow brings the preset content back
    m.deleteItem('skill', { name: 'soa-msg-etiquette', confirm: true });
    assert.ok(m.syncSkills().targets[1].updated.includes('soa-msg-etiquette'));
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /shadow body/);
    // deleting a user skill removes only the managed mirror
    m.deleteItem('skill', { name: 'chatgpt', confirm: true });
    m.deleteItem('skill', { name: 'imagegen', confirm: true });
    const rm = m.syncSkills();
    assert.ok(rm.targets[1].removed.includes('chatgpt'));
    assert.ok(!fs.existsSync(path.join(CX, 'chatgpt')));
    assert.strictEqual(fs.readFileSync(path.join(CL, 'chatgpt', 'SKILL.md'), 'utf8'), 'USER OWNED');
    assert.strictEqual(fs.readFileSync(path.join(CX, 'unrelated', 'SKILL.md'), 'utf8'), 'OTHER');
    assert.strictEqual(fs.readFileSync(path.join(CX, '.system', 'imagegen', 'SKILL.md'), 'utf8'), 'BUILTIN');
});
test('sync: removal keeps extra files and hand edits; symlinked root refused', () => {
    const CX = process.env.SOA_MCP_CODEX_SKILLS_DIR;
    m.saveSkill({ name: 'tmp-a', description: 'a', body: 'a' });
    m.saveSkill({ name: 'tmp-b', description: 'b', body: 'b' });
    m.syncSkills();
    fs.writeFileSync(path.join(CX, 'tmp-a', 'notes.txt'), 'mine');
    fs.appendFileSync(path.join(CX, 'tmp-b', 'SKILL.md'), 'edit');
    m.deleteItem('skill', { name: 'tmp-a', confirm: true });
    m.deleteItem('skill', { name: 'tmp-b', confirm: true });
    const r = m.syncSkills().targets[1];
    assert.ok(r.removed.includes('tmp-a') && fs.readFileSync(path.join(CX, 'tmp-a', 'notes.txt'), 'utf8') === 'mine');
    assert.ok(r.conflicts.some(c => c.name === 'tmp-b' && /edited by hand/.test(c.reason)) && fs.existsSync(path.join(CX, 'tmp-b', 'SKILL.md')));
    fs.rmSync(path.join(CX, 'tmp-a'), { recursive: true }); fs.rmSync(path.join(CX, 'tmp-b'), { recursive: true });
    const real = path.join(T, 'state-unit', 'real-skills'); fs.mkdirSync(real, { recursive: true });
    const link = path.join(T, 'state-unit', 'link-skills'); try { fs.unlinkSync(link); } catch (_) {}
    fs.symlinkSync(real, link);
    process.env.SOA_MCP_CODEX_SKILLS_DIR = link;
    try { assert.match(m.syncSkills().targets[1].skipped, /symlink/); assert.deepStrictEqual(fs.readdirSync(real), []); }
    finally { process.env.SOA_MCP_CODEX_SKILLS_DIR = CX; }
});
test('sync: a symlinked SKILL.md in one mirror is a conflict, not a failed sync, and is never followed', () => {
    const CL = process.env.SOA_MCP_CLAUDE_SKILLS_DIR, CX = process.env.SOA_MCP_CODEX_SKILLS_DIR;
    m.saveSkill({ name: 'tmp-ln', description: 'l', body: 'one' });
    m.syncSkills();
    const outside = path.join(T, 'state-unit', 'outside-ln.txt'); fs.writeFileSync(outside, 'KEEP');
    fs.unlinkSync(path.join(CX, 'tmp-ln', 'SKILL.md')); fs.symlinkSync(outside, path.join(CX, 'tmp-ln', 'SKILL.md'));
    m.saveSkill({ name: 'tmp-ln', description: 'l', body: 'two', overwrite: true });
    const r = m.syncSkills();
    assert.ok(r.targets[0].updated.includes('tmp-ln') && /two/.test(fs.readFileSync(path.join(CL, 'tmp-ln', 'SKILL.md'), 'utf8')));
    assert.ok(r.targets[1].conflicts.some(c => c.name === 'tmp-ln' && /symlink/.test(c.reason)));
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'KEEP');
    m.deleteItem('skill', { name: 'tmp-ln', confirm: true }); m.syncSkills();
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'KEEP');
    fs.rmSync(path.join(CX, 'tmp-ln'), { recursive: true, force: true });
});
test('sync: prefix renames mirrors and cleans the old names; "off" disables a target', () => {
    const CL = process.env.SOA_MCP_CLAUDE_SKILLS_DIR, CX = process.env.SOA_MCP_CODEX_SKILLS_DIR;
    process.env.SOA_MCP_SKILL_PREFIX = 'soa';
    try {
        const r = m.syncSkills();
        assert.ok(r.targets[0].created.includes('soa-soa-work-claims') && r.targets[0].removed.includes('soa-work-claims'));
        assert.match(fs.readFileSync(path.join(CL, 'soa-deploy-check', 'SKILL.md'), 'utf8'), /^---\nname: soa-deploy-check\n/);
        process.env.SOA_MCP_SKILL_PREFIX = 'Bad_Prefix';
        assert.throws(() => m.syncSkills(), /SOA_MCP_SKILL_PREFIX/);
    } finally { delete process.env.SOA_MCP_SKILL_PREFIX; }
    m.syncSkills();
    assert.ok(fs.existsSync(path.join(CL, 'soa-work-claims')) && !fs.existsSync(path.join(CL, 'soa-soa-work-claims')));
    process.env.SOA_MCP_CODEX_SKILLS_DIR = 'off';
    try { const r = m.syncSkills(); assert.match(r.targets[1].skipped, /disabled/); } finally { process.env.SOA_MCP_CODEX_SKILLS_DIR = CX; }
});
test('registration reader: claude json + codex toml', () => {
    const d = path.join(T, 'state-unit', 'reg'); fs.mkdirSync(d, { recursive: true });
    const self = process.env.SOA_MCP_BIN;
    fs.writeFileSync(path.join(d, 'claude.json'), JSON.stringify({ mcpServers: { other: { command: 'x' }, soa: { type: 'stdio', command: self, args: [] } } }));
    fs.writeFileSync(path.join(d, 'config.toml'), `model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n\n[mcp_servers.soa]\ncommand = "${self}"\n\n[tui]\nfoo = true\n`);
    const save = { c: process.env.SOA_MCP_CLAUDE_CONFIG, h: process.env.CODEX_HOME };
    process.env.SOA_MCP_CLAUDE_CONFIG = path.join(d, 'claude.json'); process.env.CODEX_HOME = d;
    try {
        const r = m.registration(self);
        assert.match(r.claude, /^registered \(user scope\)/); assert.doesNotMatch(r.claude, /not this script/);
        assert.match(r.codex, /^registered → /); assert.doesNotMatch(r.codex, /not this script/);
        fs.writeFileSync(path.join(d, 'config.toml'), `[mcp_servers.other]\ncommand = "y"\n`);
        assert.match(m.registration(self).codex, /^not registered/);
    } finally { for (const [k, v] of [['SOA_MCP_CLAUDE_CONFIG', save.c], ['CODEX_HOME', save.h]]) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
});
test('initialize carries short instructions pointing at the vault', async () => {
    const s = m.makeSession(null);
    const r = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const ins = r.result.instructions;
    assert.ok(ins.length < 600, 'short');
    for (const w of ['list_skills', 'get_skill', 'search', 'save_skill', 'this device']) assert.ok(ins.includes(w), w);
    const tl = await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(tl.result.tools.some(t => t.name === 'sync_skills'));
    const sv = await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'save_skill', arguments: { name: 'via-tool', description: 'd', body: 'b' } } });
    const out = JSON.parse(sv.result.content[0].text);
    assert.match(out.native.claude, /^created /); assert.match(out.native.codex, /^created /);
    const dl = await s.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delete_skill', arguments: { name: 'via-tool', confirm: true } } });
    assert.match(JSON.parse(dl.result.content[0].text).native.codex, /^removed /);
});
test('index rebuilds from files when lost', () => {
    fs.unlinkSync(path.join(m.MCP_DIR, 'index.json'));
    assert.ok(m.listSkills().some(s => s.name === 'deploy-check' && s.source === 'user'));
    assert.ok(m.listSnippets().some(s => s.name === 'hello-curl' && s.language === 'python'));
});
test('item cap', () => {
    const idx = path.join(m.MCP_DIR, 'index.json');
    // create items up to the cap cheaply by writing files directly
    const dir = path.join(m.MCP_DIR, 'snippets');
    const have = m.listSnippets().filter(s => s.source === 'user').length + m.listSkills().filter(s => s.source === 'user').length;
    for (let i = have; i < m.MAX_ITEMS; i++) fs.writeFileSync(path.join(dir, `fill-${i}.txt`), 'x', { mode: 0o600 });
    assert.throws(() => m.saveSnippet({ name: 'one-too-many', code: 'x' }), /full/);
    for (const f of fs.readdirSync(dir)) if (f.startsWith('fill-')) fs.unlinkSync(path.join(dir, f));
    assert.ok(m.saveSnippet({ name: 'one-too-many', code: 'x' }).ok);
    void idx;
});
test('fleet allowlist blocks mutating actions', async () => {
    assert.deepStrictEqual([...m.FLEET_ACTIONS].sort(), ['list', 'read']);
    await assert.rejects(m.daemonCall('POST', '/api/sessions', { action: 'send', id: 1, text: 'x' }), /blocked/);
    await assert.rejects(m.daemonCall('POST', '/api/fleet/restore', { action: 'list' }), /blocked/);
    await assert.rejects(m.daemonCall('DELETE', '/api/tabs/1'), /blocked/);
});
