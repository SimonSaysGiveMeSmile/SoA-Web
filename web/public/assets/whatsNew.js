/* What's new — a release note shown once per release, styled like a push
 * notification, plus the full list behind ⋯ More → What's new (desktop) and
 * ⋯ → What's new (phone).
 *
 * Shared by the full dashboard (assets/app.js) and the phone companion
 * (/m/app.js). The feed is release-notes.json beside the assets, fetched from
 * the PAGE's own origin with cache: 'no-store' — never from the paired
 * backend — so the same notes show on the public site and on the daemon.
 *
 * Seen state is one id in localStorage ('soa-web:whats-new:seen'): the newest
 * note this surface has shown. Everything newer is unseen. Someone who has
 * never seen a note gets only the newest one, not a backlog. */

const SEEN_KEY = 'soa-web:whats-new:seen';
const FEED_URL = new URL('../release-notes.json', import.meta.url).href;
const MARK_URL = new URL('./favicon.svg', import.meta.url).href;
const CSS_URL = new URL('./whatsNew.css', import.meta.url).href;
const SHOW_DELAY_MS = 1200;

let _layout = 'desktop';
let _notes = null;        // notes visible on this surface, newest first
let _all = null;          // the whole feed, newest first (seen ids index into it)
let _feedPromise = null;
let _card = null;
let _sheet = null;
let _mounted = false;

function readSeen() {
    try { return localStorage.getItem(SEEN_KEY) || null; } catch (_) { return null; }
}
function writeSeen(id) {
    if (!id) return;
    try { localStorage.setItem(SEEN_KEY, id); } catch (_) {}
}

function injectCss() {
    if (document.querySelector('link[data-whats-new]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_URL;
    link.dataset.whatsNew = '';
    document.head.appendChild(link);
}

function isValid(n) {
    return n && typeof n.id === 'string' && n.id && typeof n.title === 'string' && n.title;
}

function loadFeed() {
    if (!_feedPromise) {
        _feedPromise = fetch(FEED_URL, { cache: 'no-store', credentials: 'same-origin' })
            .then(r => (r.ok ? r.json() : { notes: [] }))
            .catch(() => ({ notes: [] }))
            .then(data => {
                const all = Array.isArray(data && data.notes) ? data.notes.filter(isValid) : [];
                _all = all;
                _notes = all.filter(n => !Array.isArray(n.surfaces) || n.surfaces.includes(_layout));
                return _notes;
            });
    }
    return _feedPromise;
}

// Notes on this surface the viewer has not seen yet, newest first. The seen id
// is looked up in the whole feed so a note hidden here still orders the rest.
function unseenNotes() {
    if (!_notes || !_notes.length) return [];
    const seen = readSeen();
    if (!seen) return [_notes[0]];                 // first visit: the newest note only
    const at = _all.findIndex(n => n.id === seen);
    if (at >= 0) return _notes.filter(n => _all.indexOf(n) < at);
    // The seen note left the feed: fall back to its date prefix.
    const seenDate = seen.slice(0, 10);
    return _notes.filter(n => String(n.date || n.id).slice(0, 10) > seenDate);
}

function markAllSeen() {
    if (_notes && _notes.length) writeSeen(_notes[0].id);
    syncDot();
}

function syncDot() {
    const has = unseenNotes().length > 0;
    for (const id of ['toggle-more', 'whats-new', 'btn-overflow', 'btn-whats-new']) {
        const node = document.getElementById(id);
        if (!node) continue;
        if (has) node.dataset.news = '1';
        else delete node.dataset.news;
    }
}

function whereFor(n) {
    if (_layout === 'phone' && typeof n.where_phone === 'string' && n.where_phone) return n.where_phone;
    return typeof n.where === 'string' ? n.where : '';
}

// The card is a notification: it carries the note's first sentence only, so
// it never ends in an ellipsis. The list shows the whole body.
function firstSentence(text) {
    const s = String(text || '').trim();
    const m = /^.+?[.?!](?=\s|$)/.exec(s);
    return m ? m[0] : s;
}

function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids) if (kid) node.appendChild(kid);
    return node;
}

function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
}

// ── Readiness: never on top of the first-run welcome, pairing or boot ──────
function surfaceReady() {
    const html = document.documentElement;
    if (html.dataset.welcome === '1') return false;
    if (document.querySelector('.mwel, .welcome-overlay')) return false;
    if (_layout === 'desktop') {
        const shell = document.getElementById('shell');
        if (!shell || shell.classList.contains('hidden')) return false;
        const boot = document.getElementById('boot');
        if (boot && !boot.classList.contains('hidden')) return false;
    } else {
        const rec = document.getElementById('reconnect-overlay');
        if (rec && !rec.hidden) return false;
    }
    return true;
}

function whenReady() {
    return new Promise(resolve => {
        const started = Date.now();
        const tick = () => {
            if (surfaceReady()) {
                // Settle first: the boot screen fades, the first tab paints.
                setTimeout(() => (surfaceReady() ? resolve(true) : setTimeout(tick, 600)), SHOW_DELAY_MS);
                return;
            }
            if (Date.now() - started > 15 * 60 * 1000) { resolve(false); return; }
            setTimeout(tick, 600);
        };
        tick();
    });
}

// ── The notification card ──────────────────────────────────────────────────
function placeCard(card) {
    if (_layout !== 'desktop') return;
    const bar = document.querySelector('.topbar');
    const r = bar && bar.getBoundingClientRect();
    const below = r && r.height > 0 ? Math.round(r.bottom) : 0;
    card.style.setProperty('--wn-top', below + 'px');
}

function dismissCard({ seen = true } = {}) {
    const card = _card;
    if (!card) return;
    _card = null;
    if (seen) markAllSeen();
    // Hand focus back only if the viewer had moved it into the card.
    const back = card._returnFocus;
    const hadFocus = card.contains(document.activeElement);
    window.removeEventListener('resize', card._onResize);
    document.removeEventListener('keydown', card._onDocKey);
    if (card._menuObs) card._menuObs.disconnect();
    if (card._barObs) card._barObs.disconnect();
    const done = () => card.remove();
    if (reducedMotion()) done();
    else {
        card.dataset.state = 'leaving';
        card.addEventListener('transitionend', done, { once: true });
        setTimeout(done, 260);
    }
    if (hadFocus && back && back.isConnected && typeof back.focus === 'function') {
        try { back.focus({ preventScroll: true }); } catch (_) {}
    }
}

function showCard(unseen) {
    if (_card || !unseen.length) return;
    const featured = unseen.find(n => n.kind !== 'fix') || unseen[0];
    const more = unseen.length - 1;
    const where = whereFor(featured);

    const titleId = 'wn-card-title';
    const gotIt = h('button', { type: 'button', class: 'wn-btn', text: 'Got it' });
    const seeAll = h('button', { type: 'button', class: 'wn-btn wn-btn-primary', text: 'See what’s new' });
    const card = h('div', {
        class: 'wn-card',
        'data-layout': _layout,
        role: 'status',
        'aria-live': 'polite',
        'aria-labelledby': titleId,
    },
        h('div', { class: 'wn-card-head' },
            h('img', { class: 'wn-mark', src: MARK_URL, alt: '', width: '20', height: '20', 'aria-hidden': 'true' }),
            h('span', { class: 'wn-app', text: 'What’s new' }),
            more > 0 ? h('span', { class: 'wn-more', text: `+${more} more` }) : null),
        h('p', { class: 'wn-title', id: titleId, text: featured.title }),
        featured.body ? h('p', { class: 'wn-body', text: firstSentence(featured.body) }) : null,
        where ? h('p', { class: 'wn-where', text: where }) : null,
        h('div', { class: 'wn-actions' }, gotIt, seeAll));

    // Clicking a button must not pull focus out of the terminal.
    for (const b of [gotIt, seeAll]) b.addEventListener('mousedown', e => e.preventDefault());
    gotIt.addEventListener('click', () => dismissCard());
    seeAll.addEventListener('click', () => { dismissCard(); openWhatsNew(); });
    card.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismissCard(); }
    });
    // Esc from nowhere in particular also dismisses; Esc typed into the
    // terminal or a field stays theirs (it interrupts an agent).
    card._onDocKey = (e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        const a = document.activeElement;
        if (a && a !== document.body && a !== document.documentElement) return;
        dismissCard();
    };
    card._onResize = () => placeCard(card);
    card._returnFocus = document.activeElement;

    placeCard(card);
    if (reducedMotion()) card.dataset.state = 'shown';
    else card.dataset.state = 'entering';
    document.body.appendChild(card);
    _card = card;
    window.addEventListener('resize', card._onResize);
    document.addEventListener('keydown', card._onDocKey);
    // The ⋯ More menu drops down into the card's corner: step aside while it
    // is open so the card never covers the menu, and come back when it closes.
    // A topbar that wraps or changes pack after the card is up moves it too.
    const bar = _layout === 'desktop' && document.querySelector('.topbar');
    if (bar && typeof ResizeObserver === 'function') {
        card._barObs = new ResizeObserver(() => placeCard(card));
        card._barObs.observe(bar);
    }
    const menu = _layout === 'desktop' && document.getElementById('more-menu');
    if (menu && typeof MutationObserver === 'function') {
        const sync = () => { if (menu.hidden) delete card.dataset.behind; else card.dataset.behind = '1'; };
        card._menuObs = new MutationObserver(sync);
        card._menuObs.observe(menu, { attributes: true, attributeFilter: ['hidden'] });
        sync();
    }
    if (card.dataset.state === 'entering') {
        requestAnimationFrame(() => requestAnimationFrame(() => { if (_card === card) card.dataset.state = 'shown'; }));
    }
}

// ── The list ───────────────────────────────────────────────────────────────
function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    try { return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }); }
    catch (_) { return `${m[1]}-${m[2]}-${m[3]}`; }
}

function closeSheet() {
    const sheet = _sheet;
    if (!sheet) return;
    _sheet = null;
    document.removeEventListener('keydown', sheet._onKey, true);
    sheet.remove();
    let back = sheet._returnFocus;
    // Opened from ⋯ More: that menu has closed, so return to its toggle.
    if (back && back.closest && back.closest('#more-menu')) back = document.getElementById('toggle-more');
    if (back && back.isConnected && back.getClientRects().length && typeof back.focus === 'function') {
        try { back.focus({ preventScroll: true }); } catch (_) {}
    }
}

function renderSheet(notes) {
    const titleId = 'wn-sheet-title';
    const close = h('button', { type: 'button', class: 'wn-btn wn-close', text: 'Close' });
    const list = h('ol', { class: 'wn-list' });
    if (!notes.length) {
        list.appendChild(h('li', { class: 'wn-empty', text: 'Nothing new right now.' }));
    }
    for (const n of notes) {
        const where = whereFor(n);
        list.appendChild(h('li', { class: 'wn-item' },
            h('div', { class: 'wn-item-head' },
                h('h3', { class: 'wn-item-title', text: n.title }),
                n.kind === 'fix' ? h('span', { class: 'wn-badge', text: 'Fix' }) : null),
            n.date ? h('p', { class: 'wn-date', text: fmtDate(n.date) }) : null,
            n.body ? h('p', { class: 'wn-body', text: n.body }) : null,
            n.detail ? h('p', { class: 'wn-detail', text: n.detail }) : null,
            where ? h('p', { class: 'wn-where', text: where }) : null));
    }
    const dialog = h('div', {
        class: 'wn-sheet',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
    },
        h('div', { class: 'wn-sheet-head' },
            h('h2', { class: 'wn-sheet-title', id: titleId, text: 'What’s new' }),
            close),
        list);
    const backdrop = h('div', { class: 'wn-backdrop', 'data-layout': _layout }, dialog);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) closeSheet(); });
    close.addEventListener('click', closeSheet);
    return { backdrop, dialog, close };
}

export async function openWhatsNew() {
    injectCss();
    if (_sheet) return;
    const returnFocus = document.activeElement;
    const notes = await loadFeed();
    if (_sheet) return;
    dismissCard({ seen: false });
    markAllSeen();
    const { backdrop, dialog, close } = renderSheet(notes);
    backdrop._returnFocus = returnFocus;
    backdrop._onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSheet(); return; }
        if (e.key !== 'Tab') return;
        // Keep Tab inside the sheet while it is open.
        const items = [...dialog.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])')];
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        else if (!dialog.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', backdrop._onKey, true);
    document.body.appendChild(backdrop);
    _sheet = backdrop;
    try { close.focus({ preventScroll: true }); } catch (_) {}
}

export function mountWhatsNew({ layout = 'desktop' } = {}) {
    if (_mounted) return;
    _mounted = true;
    _layout = layout === 'phone' ? 'phone' : 'desktop';
    injectCss();
    for (const id of ['whats-new', 'btn-whats-new']) {
        const btn = document.getElementById(id);
        if (btn) btn.addEventListener('click', () => { openWhatsNew(); });
    }
    loadFeed().then(() => {
        syncDot();
        if (!unseenNotes().length) return null;
        return whenReady();
    }).then(ok => {
        if (!ok || _sheet) return;
        const unseen = unseenNotes();
        if (unseen.length) showCard(unseen);
    }).catch(() => {});
}
