const fs = require('fs');
const { stateFile } = require('./stateDir');

const PROFILE_FILE = stateFile('user.json');

const DEFAULTS = {
    displayName: 'User',
    avatarColor: '#4a6566',
    locationPermission: false,
};

const AVATAR_COLORS = new Set([
    '#4a6566', '#aacfd1', '#ffb86c', '#50fa7b', '#ff5555', '#6272a4', '#bd93f9',
]);

function readProfile() {
    try {
        const raw = fs.readFileSync(PROFILE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return { ...DEFAULTS, ...parsed };
    } catch (_) {
        return { ...DEFAULTS };
    }
}

function writeProfile(patch) {
    const current = readProfile();
    const next = { ...current };
    if (typeof patch.displayName === 'string') {
        next.displayName = patch.displayName.trim().slice(0, 50) || DEFAULTS.displayName;
    }
    if (typeof patch.avatarColor === 'string' && AVATAR_COLORS.has(patch.avatarColor)) {
        next.avatarColor = patch.avatarColor;
    }
    if (typeof patch.locationPermission === 'boolean') {
        next.locationPermission = patch.locationPermission;
    }
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(next, null, 2));
    return next;
}

function mount(app, requireAuthed) {
    app.get('/api/user/profile', requireAuthed, (req, res) => {
        res.json({ ok: true, profile: readProfile() });
    });

    app.post('/api/user/profile', requireAuthed, (req, res) => {
        try {
            const profile = writeProfile(req.body || {});
            res.json({ ok: true, profile });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
}

module.exports = { mount, readProfile };
