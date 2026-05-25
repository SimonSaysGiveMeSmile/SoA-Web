// Folder picker modal used by the "new tab in folder" flow. Lists
// directories from /api/browse and lets the user navigate up/down before
// confirming a starting cwd. Falls back to opening a tab at the default
// shell cwd if the user just hits Cancel.

const el = (tag, props = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (v != null) n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
};

function _apiFetch(path) {
    const cfg = window.__SOA_WEB__ || {};
    const base = cfg._resolvedBackend || '';
    const token = cfg._resolvedToken || '';
    const url = new URL(base + path, location.origin);
    if (token) url.searchParams.set('t', token);
    return fetch(url.toString(), { credentials: 'include' });
}

async function fetchListing(p) {
    const q = p ? '?path=' + encodeURIComponent(p) : '';
    const res = await _apiFetch('/api/browse' + q);
    if (!res.ok) throw new Error('browse failed: ' + res.status);
    return res.json();
}

// Open the picker. Resolves with the selected absolute path, or null when
// the user closes the modal without choosing.
export function pickFolder() {
    return new Promise(resolve => {
        const backdrop = el('div', { class: 'soa-modal-backdrop' });
        const card = el('div', { class: 'soa-modal soa-folder-picker' });
        const title = el('div', { class: 'soa-modal-title', text: 'OPEN NEW TAB IN…' });
        const pathEl = el('div', { class: 'fp-path', text: '' });
        const list = el('div', { class: 'fp-list' });
        const note = el('p', { class: 'soa-modal-note fp-note', text: 'Pick the folder where Son of Anton should start the terminal.' });
        const useBtn = el('button', { class: 'soa-modal-copy', text: 'OPEN HERE' });
        const cancelBtn = el('button', { class: 'soa-modal-close', text: 'CANCEL' });
        const actions = el('div', { class: 'fp-actions' }, [useBtn, cancelBtn]);

        let currentPath = null;
        let closed = false;
        const close = (result) => {
            if (closed) return;
            closed = true;
            backdrop.remove();
            document.removeEventListener('keydown', onKey);
            resolve(result);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); close(null); }
            else if (e.key === 'Enter' && currentPath) { e.preventDefault(); close(currentPath); }
        };
        document.addEventListener('keydown', onKey);
        backdrop.addEventListener('click', e => { if (e.target === backdrop) close(null); });
        cancelBtn.addEventListener('click', () => close(null));
        useBtn.addEventListener('click', () => { if (currentPath) close(currentPath); });

        async function navigate(target) {
            list.textContent = '';
            list.appendChild(el('div', { class: 'fp-loading', text: 'loading…' }));
            try {
                const data = await fetchListing(target);
                currentPath = data.path;
                pathEl.textContent = data.path;
                list.textContent = '';
                if (data.parent) {
                    const up = el('button', { class: 'fp-row fp-row--up', text: '⬑ ..' });
                    up.addEventListener('click', () => navigate(data.parent));
                    list.appendChild(up);
                }
                if (data.home && data.home !== data.path) {
                    const home = el('button', { class: 'fp-row fp-row--home', text: '⌂ ' + data.home });
                    home.addEventListener('click', () => navigate(data.home));
                    list.appendChild(home);
                }
                if (!data.dirs.length) {
                    list.appendChild(el('div', { class: 'fp-empty', text: '(no subfolders)' }));
                }
                for (const name of data.dirs) {
                    const child = data.path.replace(/\/?$/, '/') + name;
                    const row = el('button', { class: 'fp-row', text: '📁 ' + name });
                    row.addEventListener('click', () => navigate(child));
                    row.addEventListener('dblclick', () => close(child));
                    list.appendChild(row);
                }
            } catch (err) {
                list.textContent = '';
                list.appendChild(el('div', { class: 'fp-empty', text: 'failed: ' + (err.message || err) }));
            }
        }

        card.append(title, pathEl, list, note, actions);
        backdrop.appendChild(card);
        document.body.appendChild(backdrop);
        navigate(null); // null → server defaults to $HOME
    });
}
