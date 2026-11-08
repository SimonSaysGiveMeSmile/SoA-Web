// Two per-device choices for a touch screen, shared by the phone companion
// (/m/app.js) and the full dashboard (/assets/app.js):
//
//   Layout   which view opens on this device: the phone companion (/m/) or
//            the full dashboard (/). Switching carries the pairing across, so
//            neither side asks to pair again. Remembered in this browser only.
//
//   Safari bars (iPhone/iPad Safari, not a Home Screen app)
//            Safari tucks its address bar and toolbar away only when the PAGE
//            scrolls. The companion is a fixed full-height shell whose views
//            scroll inside it, so the page never moved and the bars never
//            went. With this on, the page is given a little room to scroll
//            behind the shell (`html.soa-scrollbars`, styles.css): a swipe
//            that the terminal can't take any further (parked at the newest
//            output, or a short screen) carries on to the page, and Safari
//            hides its bars as it would on any scrolling site. A page cannot
//            scroll itself into this — Safari only answers a real swipe.
//
// Storage (localStorage, this browser only):
//   soa-web:layout    'phone' | 'full'   (absent = the device's default)
//   soa.m.scrollBars  'off'              (absent = on)
// Never sent anywhere. A hop between the two layouts is marked in
// sessionStorage so an automatic redirect can never bounce back and forth.

export const LAYOUT_KEY = 'soa-web:layout';
const BARS_KEY = 'soa.m.scrollBars';
const HOP_KEY = 'soa-web:layout-hop';
// The companion's saved session and unlock (see /m/app.js).
const M_SESSION_KEY = 'son-of-anton.session';
const M_UNLOCK_KEY = 'soa.m.unlock';
const M_UNLOCK_OWNER_KEY = 'soa.m.unlock.owner';
// The dashboard's saved pairing (see /assets/app.js).
const D_KEY = 'soa_web_backend';

function get(store, key) { try { return store.getItem(key); } catch (_) { return null; } }
function set(store, key, value) { try { store.setItem(key, value); } catch (_) {} }
function originOf(url) { try { return new URL(url).origin; } catch (_) { return ''; } }
function readJson(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; } }

export function layoutPref() {
    const v = get(localStorage, LAYOUT_KEY);
    return v === 'phone' || v === 'full' ? v : '';
}

export function isIOS() {
    const ua = navigator.userAgent || '';
    return /iPhone|iPad|iPod/.test(ua) || (/Mac/.test(navigator.platform || '') && navigator.maxTouchPoints > 1);
}

// Opened from the Home Screen or the native shell: no browser bars at all.
export function chromeless() {
    try {
        return !!window.Capacitor || navigator.standalone === true
            || ['standalone', 'fullscreen'].some(m => matchMedia(`(display-mode: ${m})`).matches);
    } catch (_) { return false; }
}

// Only iOS Safari in a tab needs the page to scroll: Android takes real full
// screen from the first tap (fullscreen.js), and an installed app has no bars.
export function scrollBarsApplies() { return isIOS() && !chromeless(); }
export function scrollBarsOn() { return scrollBarsApplies() && get(localStorage, BARS_KEY) !== 'off'; }

export function applyScrollBars() {
    const on = scrollBarsOn();
    document.documentElement.classList.toggle('soa-scrollbars', on);
    // Turning it off with the bars tucked away: put the page back at the top,
    // or the shell would sit over a page Safari still thinks is scrolled.
    if (!on && window.scrollY) window.scrollTo(0, 0);
}

function recentHop() {
    const t = Number(get(sessionStorage, HOP_KEY)) || 0;
    return Date.now() - t < 15000;
}
function go(url, pref) {
    if (pref) set(localStorage, LAYOUT_KEY, pref);
    set(sessionStorage, HOP_KEY, String(Date.now()));
    location.href = url;
}

// ── Companion → full dashboard ───────────────────────────────────────────

// Hand this pairing to the dashboard's own storage on this origin, then open
// it. Nothing goes in the URL, so no token lands in history or a tunnel log.
export function openDashboard(link) {
    if (link && link.backend && link.token) {
        const unlock = link.unlock || (get(localStorage, M_UNLOCK_OWNER_KEY) === originOf(link.backend)
            ? get(localStorage, M_UNLOCK_KEY) || '' : '');
        set(localStorage, D_KEY, JSON.stringify({
            backend: String(link.backend).replace(/\/+$/, ''), token: String(link.token), unlock,
        }));
    }
    set(localStorage, 'soa_web_welcomed', '1');
    go(new URL('/', location.origin).href, 'full');
}

// ── Full dashboard → companion ───────────────────────────────────────────

export function openCompanion(saved) {
    if (saved && saved.backend && saved.token) {
        const backend = String(saved.backend).replace(/\/+$/, '');
        const same = originOf(backend) === location.origin;
        set(localStorage, M_SESSION_KEY, JSON.stringify({
            token: saved.token, origin: location.origin,
            backend: same ? null : backend, altOrigin: null, ts: Date.now(),
        }));
        if (saved.unlock) {
            set(localStorage, M_UNLOCK_KEY, saved.unlock);
            set(localStorage, M_UNLOCK_OWNER_KEY, originOf(backend));
        }
    }
    go(new URL('/m/', location.origin).href, 'phone');
}

// ── The companion's Settings sheet ───────────────────────────────────────

// Adds a Layout section (and, on iOS Safari, the bars setting) above
// "Open keyboard automatically", reusing the sheet's own segmented buttons.
// `link()` returns { backend, token, unlock } for the current pairing.
export function mountCompanionLayout({ link, fullscreen } = {}) {
    applyScrollBars();
    window.addEventListener('pageshow', applyScrollBars);

    // Chose the full dashboard earlier: open it, in a browser tab only. An
    // older Home Screen install is scoped to /m/, so leaving it there would
    // open the dashboard in a Safari sheet; there the switch stays explicit.
    const dash = readJson(D_KEY);
    if (layoutPref() === 'full' && !chromeless() && !recentHop() && dash && dash.token
        && !/[#&?]t=/.test(location.href)) {
        set(sessionStorage, HOP_KEY, String(Date.now()));
        location.replace(new URL('/', location.origin).href);
        return;
    }

    const anchor = document.getElementById('kbd-focus-grid')?.closest('.settings-section');
    if (anchor && !document.getElementById('layout-grid')) {
        const section = document.createElement('div');
        section.className = 'settings-section';
        section.innerHTML =
            '<div class="settings-label">Layout</div>' +
            '<div class="settings-hint">Phone is built for this screen. Full dashboard is the computer view, with the sidebar and side panel. Your choice is remembered on this device.</div>' +
            '<div class="sound-grid" id="layout-grid" role="group" aria-label="Layout"></div>' +
            '<div id="bars-block" hidden style="margin-top:20px">' +
            '<div class="settings-label">Hide Safari bars when scrolling</div>' +
            '<div class="settings-hint">Swipe up in the terminal and Safari hides its address bar and toolbar. They come back when you scroll to the top or tap the bottom edge. To remove them for good, add SoA to your Home Screen.</div>' +
            '<div class="sound-grid" id="bars-grid" role="group" aria-label="Hide Safari bars when scrolling"></div>' +
            '</div>';
        anchor.parentNode.insertBefore(section, anchor);

        const seg = (grid, opts, current, pick) => {
            const paint = () => {
                const cur = current();
                grid.querySelectorAll('.sound-option').forEach(b => {
                    const on = b.dataset.pref === cur;
                    b.classList.toggle('active', on);
                    b.setAttribute('aria-pressed', on ? 'true' : 'false');
                });
            };
            for (const [key, label] of opts) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'sound-option';
                b.dataset.pref = key;
                b.textContent = label;
                b.addEventListener('click', () => { pick(key); paint(); });
                grid.appendChild(b);
            }
            paint();
        };
        seg(section.querySelector('#layout-grid'), [['phone', 'Phone'], ['full', 'Full dashboard']],
            () => 'phone',
            (key) => {
                if (key === 'full') openDashboard(typeof link === 'function' ? link() : null);
                else set(localStorage, LAYOUT_KEY, 'phone');
            });
        if (scrollBarsApplies()) {
            section.querySelector('#bars-block').hidden = false;
            seg(section.querySelector('#bars-grid'), [['on', 'On'], ['off', 'Off']],
                () => (get(localStorage, BARS_KEY) === 'off' ? 'off' : 'on'),
                (key) => {
                    if (key === 'off') set(localStorage, BARS_KEY, 'off');
                    else { try { localStorage.removeItem(BARS_KEY); } catch (_) {} }
                    applyScrollBars();
                });
        }
    }

    // iOS Safari: say once that the Home Screen app has no bars at all. The
    // banner is in flow, closes itself after 20 s and stays dismissed.
    if (fullscreen && scrollBarsApplies()) setTimeout(() => fullscreen.showHint(), 4000);
}

// ── The dashboard on a touch screen ──────────────────────────────────────

// Returns true when it is leaving for the companion (the caller stops booting).
// `saved()` returns the dashboard's { backend, token, unlock }.
export function mountDashboardLayout({ touch, saved } = {}) {
    if (!touch) return false;
    const pairing = typeof saved === 'function' ? saved() : null;
    const m = readJson(M_SESSION_KEY);
    let pairLink = false;
    try { pairLink = new URLSearchParams(location.search).has('backend'); } catch (_) {}
    if (layoutPref() === 'phone' && !chromeless() && !recentHop() && !pairLink
        && ((m && m.token) || (pairing && pairing.token))) {
        if (m && m.token) {
            set(sessionStorage, HOP_KEY, String(Date.now()));
            location.replace(new URL('/m/', location.origin).href);
        } else openCompanion(pairing);
        return true;
    }
    // ⋯ → PHONE, beside What's new. Built here so desktops never carry it.
    const news = document.getElementById('whats-new');
    if (news && !document.getElementById('phone-layout')) {
        const btn = document.createElement('button');
        btn.id = 'phone-layout';
        btn.type = 'button';
        btn.className = 'more-item mi-phone';
        btn.setAttribute('role', 'menuitem');
        btn.dataset.label = 'Phone layout';
        btn.title = 'Switch this device to the phone layout';
        btn.setAttribute('aria-label', 'Phone layout');
        btn.style.setProperty('--mi-icon', `url("data:image/svg+xml;utf8,${encodeURIComponent(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><rect x='7' y='2.5' width='10' height='19' rx='2'/><path d='M11 18.5h2'/></svg>")}")`);
        btn.textContent = 'PHONE';
        btn.addEventListener('click', () => openCompanion(typeof saved === 'function' ? saved() : null));
        news.parentNode.insertBefore(btn, news);
    }
    return false;
}
