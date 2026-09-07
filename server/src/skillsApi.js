/**
 * GET /api/skills — enumerate the Claude Code skills available on this machine.
 *
 * Skills are directories holding a SKILL.md with YAML frontmatter (name +
 * description). Two sources:
 *   - user skills:   ~/.claude/skills/<name>/SKILL.md
 *   - plugin skills: <installPath>/skills/<name>/SKILL.md for each plugin listed
 *                    in ~/.claude/plugins/installed_plugins.json
 *
 * Read-only, cheap, memoized for a few seconds (skills change rarely). Powers
 * the dashboard's SKILLS side panel so the user can see what's on tap.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const USER_SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
const INSTALLED_PLUGINS = path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');

const CACHE_MS = 5000;
let _cache = null;
let _cacheAt = 0;

// Pull `name` and `description` out of a SKILL.md frontmatter block. The block
// is the text between the first two `---` fences; values are single-line.
function parseFrontmatter(md) {
    const out = { name: '', description: '' };
    if (!md.startsWith('---')) return out;
    const end = md.indexOf('\n---', 3);
    if (end < 0) return out;
    const block = md.slice(3, end);
    for (const line of block.split('\n')) {
        const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1].toLowerCase();
        if (key === 'name' || key === 'description') {
            let v = m[2].trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
            out[key] = v;
        }
    }
    return out;
}

// Read every <dir>/<skill>/SKILL.md under a skills root. `source`/`plugin` tag
// where each came from. Silently skips anything unreadable.
function readSkillsRoot(skillsDir, source, plugin) {
    const found = [];
    let entries = [];
    try { entries = fs.readdirSync(skillsDir, { withFileTypes: true }); }
    catch (_) { return found; }
    for (const ent of entries) {
        // Accept real dirs AND symlinks (user skills are often symlinked in from
        // app bundles). Non-skill entries fail the SKILL.md read below harmlessly.
        if (ent.isFile()) continue;
        const mdPath = path.join(skillsDir, ent.name, 'SKILL.md');
        let md;
        try { md = fs.readFileSync(mdPath, 'utf8'); }
        catch (_) { continue; }
        const fm = parseFrontmatter(md);
        const name = fm.name || ent.name;
        found.push({
            name,
            id: name,
            description: fm.description || '',
            source,          // 'user' | 'plugin'
            plugin: plugin || null,
        });
    }
    return found;
}

function readPluginSkills() {
    const found = [];
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(INSTALLED_PLUGINS, 'utf8')); }
    catch (_) { return found; }
    const plugins = (cfg && cfg.plugins) || {};
    for (const [key, installs] of Object.entries(plugins)) {
        if (!Array.isArray(installs)) continue;
        const pluginName = key.split('@')[0];
        for (const inst of installs) {
            const installPath = inst && inst.installPath;
            if (!installPath) continue;
            found.push(...readSkillsRoot(path.join(installPath, 'skills'), 'plugin', pluginName));
        }
    }
    return found;
}

function collect() {
    const user = readSkillsRoot(USER_SKILLS_DIR, 'user', null);
    const plugin = readPluginSkills();
    // Dedupe by name (user skills win over plugin skills of the same name).
    const byName = new Map();
    for (const s of [...plugin, ...user]) byName.set(s.name, s);
    const skills = [...byName.values()].sort((a, b) => {
        if (a.source !== b.source) return a.source === 'user' ? -1 : 1; // user first
        return a.name.localeCompare(b.name);
    });
    return {
        skills,
        counts: {
            total: skills.length,
            user: skills.filter(s => s.source === 'user').length,
            plugin: skills.filter(s => s.source === 'plugin').length,
        },
    };
}

function snapshot() {
    const now = Date.now();
    if (_cache && (now - _cacheAt) < CACHE_MS) return _cache;
    _cache = collect();
    _cacheAt = now;
    return _cache;
}

function mount(app, requireAuthed) {
    app.get('/api/skills', requireAuthed, (req, res) => {
        try { res.json({ ok: true, data: snapshot() }); }
        catch (e) { res.status(500).json({ ok: false, error: String(e && e.message || e) }); }
    });
}

module.exports = { mount, snapshot };
