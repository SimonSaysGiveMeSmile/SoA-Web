/**
 * Web preview panel (desktop).
 *
 * Opens a local dev-server port (proxied via /preview/<port>/ so paired remote
 * devices can view it too) or an arbitrary URL in an embedded frame. Mirrors
 * the mobile WEB view. Reuses the .soa-modal scrim styling.
 */

const el = (tag, props = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') n.className = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (v != null) n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
};

function backendBase() {
    const c = window.__SOA_WEB__ || {};
    return (c._resolvedBackend || c.backend || '').replace(/\/+$/, '');
}
function withToken(path) {
    const c = window.__SOA_WEB__ || {};
    const t = c._resolvedToken || '';
    const u = new URL(backendBase() + path, location.origin);
    if (t) u.searchParams.set('t', t);
    return u.toString();
}

async function fetchPorts() {
    try {
        const res = await fetch(withToken('/api/ports'), { credentials: 'include', cache: 'no-store' });
        if (!res.ok) return [];
        const { data } = await res.json();
        return (data && data.ports) || [];
    } catch (_) { return []; }
}

export function openPreviewModal(app, initialTarget) {
    const backdrop = el('div', { class: 'soa-modal-backdrop' });
    const card = el('div', { class: 'soa-modal soa-preview' });

    const portSel = el('select', { class: 'pv-port' }, [el('option', { value: '', text: 'port…' })]);
    const urlInp = el('input', { class: 'pv-url', type: 'text', placeholder: 'localhost:3000 or https://…', spellcheck: 'false' });
    const goBtn = el('button', { class: 'pv-btn', text: 'OPEN' });
    const reloadBtn = el('button', { class: 'pv-btn', text: '⟳', title: 'Reload' });
    const openTabBtn = el('button', { class: 'pv-btn', text: '↗', title: 'Open in new tab' });
    const closeBtn = el('button', { class: 'pv-btn pv-close', text: '×', title: 'Close' });
    const bar = el('div', { class: 'pv-bar' }, [portSel, urlInp, goBtn, reloadBtn, openTabBtn, closeBtn]);

    const frame = el('iframe', { class: 'pv-frame', sandbox: 'allow-scripts allow-forms allow-same-origin allow-popups allow-modals' });
    const empty = el('div', { class: 'pv-empty', text: 'Pick a local port or type a URL. Local ports are proxied through /preview/ so paired phones can view them too.' });
    const frameWrap = el('div', { class: 'pv-frame-wrap' }, [frame, empty]);

    card.append(bar, frameWrap);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    let lastSrc = '';
    const open = (src) => {
        if (!src) return;
        lastSrc = src;
        frame.src = src;
        frame.style.display = 'block';
        empty.style.display = 'none';
    };
    const resolveAndOpen = (raw) => {
        let u = (raw || '').trim();
        if (!u) return;
        const lm = u.replace(/^https?:\/\//, '').match(/^(?:localhost|127\.0\.0\.1):(\d{1,5})(\/.*)?$/i);
        if (lm) open(withToken(`/preview/${lm[1]}${lm[2] || '/'}`));
        else if (/^\d{1,5}$/.test(u)) open(withToken(`/preview/${u}/`));
        else open(/^https?:\/\//.test(u) ? u : 'https://' + u);
    };

    portSel.addEventListener('change', () => { if (portSel.value) { urlInp.value = ''; open(withToken(`/preview/${portSel.value}/`)); } });
    goBtn.addEventListener('click', () => resolveAndOpen(urlInp.value));
    urlInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') resolveAndOpen(urlInp.value); });
    reloadBtn.addEventListener('click', () => { if (lastSrc) frame.src = lastSrc; });
    openTabBtn.addEventListener('click', () => { if (lastSrc) window.open(lastSrc, '_blank', 'noopener'); });

    const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    closeBtn.addEventListener('click', close);

    fetchPorts().then(ports => {
        for (const p of ports) {
            portSel.appendChild(el('option', { value: String(p.port), text: `:${p.port} ${p.process || ''}` }));
        }
    });

    // Pre-open a target handed in by the new-tab chooser (a bare port or a URL).
    if (initialTarget) { urlInp.value = initialTarget; resolveAndOpen(initialTarget); }
    urlInp.focus();
}
