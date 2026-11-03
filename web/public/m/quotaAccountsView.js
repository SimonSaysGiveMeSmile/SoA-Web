// Shared desktop/tablet/phone account monitor. Nodes survive polling so inputs,
// focus, open sign-in controls and scroll position do not reset on each reading.
const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'text') node.textContent = value;
        else if (key === 'class') node.className = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
    }
    for (const child of children) node.append(child);
    return node;
}
const button = (text, label, fn) => el('button', { type: 'button', text, 'aria-label': label, onclick: fn });
const duration = ms => {
    const minutes = Math.max(0, Math.ceil(ms / 60000)), hours = Math.floor(minutes / 60);
    return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};
const number = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));
const money = n => Number.isFinite(n) ? '≈$' + (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n >= 10 ? Math.round(n) : n.toFixed(2)) : '—';
const providerName = p => p === 'codex' ? 'Codex' : 'Claude';
let sequence = 0;
export class QuotaAccountsView {
    constructor({ parent, api = x => x, onData = () => {}, onDetails = null, externalDetailsId = null, request = (...args) => fetch(...args) }) {
        this.api = api; this.request = request; this.onData = onData; this.onDetails = onDetails;
        this.externalDetailsId = externalDetailsId; this.openAccountId = null;
        this.rows = new Map(); this.cards = new Map(); this.activity = {}; this.controllers = new Set(); this.dead = false; this.busy = false;
        this.pendingFields = new Map();
        this.data = null; this.online = true;
        if (!document.querySelector('link[data-quota-accounts]')) document.head.append(el('link', {
            rel: 'stylesheet', href: new URL('./quotaAccounts.css?v=rings-20261103', import.meta.url).href, 'data-quota-accounts': '' }));
        this.root = el('section', { class: 'quota-accounts', 'aria-label': 'Account usage' });
        this.manage = button('Accounts', 'Choose monitored accounts', () => this.setManage(this.manager.hidden));
        this.manage.setAttribute('aria-expanded', 'false');
        this.pause = button('Pause', 'Pause all monitoring', () => this.act({ action: 'monitoring', enabled: !this.data?.monitoring }));
        this.state = el('span', { class: 'qa-state' });
        this.bar = el('div', { class: 'qa-toolbar' }, [this.manage, this.state, this.pause]);
        this.error = el('p', { class: 'qa-error', role: 'status', 'aria-live': 'polite' }); this.error.hidden = true;
        this.list = el('div', { class: 'qa-account-list' });
        this.provider = el('select', { 'aria-label': 'Provider' }, [el('option', { value: 'claude', text: 'Claude' }), el('option', { value: 'codex', text: 'Codex' })]);
        this.label = el('input', { type: 'text', maxlength: '48', placeholder: 'Account name', 'aria-label': 'New account name', autocomplete: 'off' });
        this.add = button('Add & connect', 'Add and connect account', () => this.addAccount());
        this.form = el('form', { class: 'qa-add', onsubmit: e => { e.preventDefault(); void this.addAccount(); } }, [this.provider, this.label, this.add]);
        this.manager = el('div', { class: 'qa-manager', id: 'qa-manager-' + ++sequence }, [this.list, this.form]);
        this.manager.hidden = true; this.manage.setAttribute('aria-controls', this.manager.id);
        this.grid = el('div', { class: 'qa-grid' });
        this.details = el('div', { class: 'qa-details', id: 'qa-details-' + sequence });
        this.details.hidden = true;
        this.empty = button('Choose accounts to show', 'Choose accounts to show in this panel', () => this.setManage(true));
        this.empty.className = 'qa-empty';
        this.root.append(this.bar, this.error, this.manager, this.grid, this.details, this.empty);
        parent.append(this.root);
    }
    setManage(open) { this.manager.hidden = !open; this.manage.setAttribute('aria-expanded', String(open)); }
    toggleDetails(account) {
        if (account.system && this.onDetails) { this.onDetails(account.provider); return; }
        const next = this.openAccountId === account.id ? null : account.id;
        this.onDetails?.(null);
        this.openAccountId = next;
        this.renderDetails();
    }
    setExternalOpen(id) {
        if (id || this.data?.accounts.find(a => a.id === this.openAccountId)?.system) this.openAccountId = id;
        this.renderDetails();
    }
    focusAccount(id) { (this.cards.get(id)?.gauge.disabled === false ? this.cards.get(id).gauge : this.manage).focus({ preventScroll: true }); }
    renderDetails() {
        const account = this.data?.accounts.find(a => a.id === this.openAccountId && a.visible);
        for (const [id, c] of this.cards) {
            const open = account?.id === id;
            c.gauge.setAttribute('aria-expanded', String(open));
            c.gauge.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} ${c.title.textContent} usage details`);
            c.gauge.title = open ? 'Hide details' : 'Show details';
        }
        this.details.hidden = !account || !!(account.system && this.onDetails);
        if (this.details.hidden) return;
        const q = account.quota || {}, rows = [el('strong', { text: account.label })];
        for (const [key, label] of [['weekly', 'Weekly'], ['session', q.windows?.session?.windowMinutes === 300 ? 'Session · 5h' : 'Session']]) {
            const w = q.windows?.[key];
            if (!w || !Number.isFinite(w.usedPercent) || w.resetsAt !== null && w.resetsAt <= Date.now()) continue;
            rows.push(el('div', { class: 'qa-detail-row' }, [el('span', { text: label }), el('strong', { text: `${Math.round(w.usedPercent)}%` }),
                el('span', { class: 'qa-detail-reset', text: Number.isFinite(w.resetsAt) ? `Resets in ${duration(w.resetsAt - Date.now())}` : 'Reset not reported' })]));
        }
        if (rows.length === 1) rows.push(el('span', { text: 'Usage not reported' }));
        const source = q.source === 'codex-app-server' ? 'Codex' : q.source === 'claude-code-statusline' ? 'Claude Code' : 'Claude';
        rows.push(el('span', { class: 'qa-detail-source', text: `${source}${q.available && (!this.online || q.status !== 'ready') ? ' · Cached' : ''}` }));
        this.details.dataset.account = account.id;
        this.details.replaceChildren(...rows);
    }
    async refresh() {
        if (this.loading || this.dead) return;
        this.loading = true;
        const ctl = new AbortController(); this.controllers.add(ctl); const timer = setTimeout(() => ctl.abort(), 10000);
        try {
            const response = await this.request(this.api('/preview/4011/api/usage-quota'), { credentials: 'include', cache: 'no-store', signal: ctl.signal });
            if (!response.ok) throw new Error('Account monitor unavailable');
            const data = await response.json(); this.setData(data); this.onData(data);
        } catch (_) { this.setOffline(); }
        finally { clearTimeout(timer); this.controllers.delete(ctl); this.loading = false; }
    }
    act(body) {
        const token = {}, fields = body.action === 'update' ? ['visible', 'enabled', 'label'].filter(k => k in body) : [];
        for (const field of fields) this.pendingFields.set(`${body.id}/${field}`, { token, value: body[field] });
        const pending = (this.mutations || Promise.resolve()).then(() => this.post(body));
        this.mutations = pending.catch(() => {});
        return pending.finally(() => {
            for (const field of fields) {
                const key = `${body.id}/${field}`;
                if (this.pendingFields.get(key)?.token === token) this.pendingFields.delete(key);
            }
            this.render();
        });
    }
    async post(body) {
        if (this.dead || !this.data?.actionToken) return null;
        this.busy = true; this.error.hidden = true; this.root.setAttribute('aria-busy', 'true');
        const ctl = new AbortController(); this.controllers.add(ctl); const timer = setTimeout(() => ctl.abort(), 14000);
        try {
            const response = await this.request(this.api('/preview/4011/api/usage-quota/accounts'), {
                method: 'POST', credentials: 'include', cache: 'no-store', signal: ctl.signal,
                headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-soa-quota-action': this.data.actionToken }, body: JSON.stringify(body) });
            const data = await response.json();
            if (!response.ok || !data.ok) throw new Error(data.error || 'Could not update this account.');
            this.setData(data); this.onData(data); return data;
        } catch (error) {
            if (!this.dead) { this.error.textContent = error.name === 'AbortError' ? 'Connection timed out. Retry.' : error.message; this.error.hidden = false; this.render(); }
            return null;
        } finally { clearTimeout(timer); this.controllers.delete(ctl); this.busy = false; this.root.removeAttribute('aria-busy'); }
    }
    async addAccount() {
        const before = new Set(this.data?.accounts.map(a => a.id));
        const provider = this.provider.value;
        const label = this.label.value.trim() || `${providerName(provider)} ${(this.data?.accounts.filter(a => a.provider === provider).length || 0) + 1}`;
        const data = await this.act({ action: 'create', provider, label });
        if (!data) return;
        this.label.value = ''; this.setManage(true);
        const added = data.accounts.find(a => !before.has(a.id));
        if (added) { await this.act({ action: 'login', id: added.id }); this.rows.get(added.id)?.name.focus(); }
    }
    setData(data) {
        if (this.dead || data?.service !== 'soa-usage-quota' || !Array.isArray(data.accounts)) return false;
        if (this.data && data.revision < this.data.revision) return false;
        this.data = data; this.online = true;
        if (this.openAccountId && (!data.monitoring || !data.accounts.some(a => a.id === this.openAccountId && a.visible && a.enabled))) {
            this.openAccountId = null; this.onDetails?.(null);
        }
        this.render(); return true;
    }
    setOffline() { if (!this.dead) { this.online = false; this.render(); } }
    setActivity(provider, data, costs) { this.activity[provider] = { data, costs }; this.renderCards(); }
    createRow(account) {
        const name = el('input', { type: 'text', maxlength: '48', 'aria-label': `Name for ${account.label}`, autocomplete: 'off',
            onchange: () => this.act({ action: 'update', id: account.id, label: name.value }) });
        const info = el('span', { class: 'qa-account-info' });
        const check = (key, text) => {
            const input = el('input', { type: 'checkbox', 'aria-label': `${text} ${account.label}`, onchange: () => this.act({ action: 'update', id: account.id, [key]: input.checked }) });
            return { input, label: el('label', { class: 'qa-check' }, [input, el('span', { text })]) };
        };
        const visible = check('visible', 'Show'), enabled = check('enabled', 'Monitor');
        const connect = button('Connect', `Connect ${account.label}`, () => this.act({ action: 'login', id: account.id }));
        const local = el('span', { class: 'qa-local', text: 'Local CLI' });
        const login = el('div', { class: 'qa-login' }); login.hidden = true;
        const link = el('a', { target: '_blank', rel: 'noopener noreferrer', text: 'Continue sign-in ↗' });
        const code = el('code', { class: 'qa-user-code' });
        const status = el('span', { class: 'qa-login-status' });
        const codeInput = el('input', { type: 'password', autocomplete: 'off', placeholder: 'Code from Claude', 'aria-label': `Sign-in code for ${account.label}` });
        const submit = button('Finish', 'Submit sign-in code', async () => { const value = codeInput.value; codeInput.value = ''; await this.act({ action: 'code', id: account.id, code: value }); });
        const cancel = button('Cancel', 'Cancel sign-in', () => this.act({ action: 'cancel', id: account.id }));
        const codeForm = el('div', { class: 'qa-code-form' }, [codeInput, submit]);
        codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit.click(); } });
        login.append(status, link, code, codeForm, cancel);
        const row = el('div', { class: 'qa-account-row', 'data-account': account.id }, [
            el('div', { class: 'qa-account-name' }, [name, info]),
            el('div', { class: 'qa-account-options' }, [visible.label, enabled.label, connect, local]), login]);
        this.list.append(row);
        const result = { row, name, info, visible, enabled, connect, local, login, link, code, codeForm, status, cancel };
        this.rows.set(account.id, result); return result;
    }
    createCard(account) {
        const title = el('strong', { class: 'qa-card-name' });
        const subtitle = el('span', { class: 'qa-card-provider' });
        const hide = button('×', `Hide ${account.label} from panel`, () => this.act({ action: 'update', id: account.id, visible: false }));
        hide.className = 'qa-hide';
        const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('aria-hidden', 'true');
        const rings = {};
        for (const [key, radius] of [['weekly', 43], ['session', 32]]) {
            const group = document.createElementNS(NS, 'g'); group.setAttribute('class', 'qa-ring-' + key);
            for (const type of ['track', 'value']) {
                const circle = document.createElementNS(NS, 'circle');
                for (const [k, v] of Object.entries({ cx: 50, cy: 50, r: radius, fill: 'none', 'stroke-width': 6, class: type })) circle.setAttribute(k, v);
                if (type === 'value') { circle.setAttribute('stroke-dasharray', String(2 * Math.PI * radius)); circle.setAttribute('stroke-linecap', 'round'); rings[key] = { circle, length: 2 * Math.PI * radius, group }; }
                group.append(circle);
            }
            svg.append(group);
        }
        const percent = el('strong', { class: 'qa-percent' }), period = el('span', { class: 'qa-period' });
        const gauge = el('button', { type: 'button', class: 'qa-gauge', 'aria-expanded': 'false',
            'aria-controls': account.system && this.onDetails ? this.externalDetailsId : this.details.id,
            onclick: () => this.toggleDetails(account) }, [svg, el('div', { class: 'qa-center' }, [percent, period])]);
        const session = el('div', { class: 'qa-session' });
        const reset = el('div', { class: 'qa-reset' });
        const state = el('div', { class: 'qa-card-state' });
        const resume = button('Resume', `Resume monitoring ${account.label}`, () => this.data.monitoring ? this.act({ action: 'update', id: account.id, enabled: true }) : this.act({ action: 'monitoring', enabled: true }));
        const range = el('div', { class: 'qa-range' });
        const activity = el('div', { class: 'qa-activity' });
        const card = el('article', { class: 'qa-card', 'data-account': account.id, 'data-provider': account.provider }, [el('div', { class: 'qa-card-header' }, [title, hide]), subtitle, gauge, session, reset, state, resume, range, activity]);
        this.grid.append(card);
        const result = { card, title, hide, subtitle, gauge, rings, percent, period, session, reset, state, resume, range, activity };
        this.cards.set(account.id, result); return result;
    }
    render() {
        if (!this.data || this.dead) return;
        const accounts = this.data.accounts, ids = new Set(accounts.map(a => a.id));
        this.manage.textContent = `Accounts · ${accounts.length}`;
        this.state.textContent = !this.online ? 'Offline' : !this.data.monitoring ? 'Paused' : '';
        this.pause.textContent = this.data.monitoring ? 'Pause' : 'Resume';
        this.pause.setAttribute('aria-label', this.data.monitoring ? 'Pause all monitoring' : 'Resume all monitoring');
        this.pause.disabled = !this.online;
        for (const [id, row] of this.rows) if (!ids.has(id)) { row.row.remove(); this.rows.delete(id); }
        for (const a of accounts) {
            const r = this.rows.get(a.id) || this.createRow(a), conn = a.quota?.connection;
            if (document.activeElement !== r.name) r.name.value = this.pendingFields.get(`${a.id}/label`)?.value ?? a.label;
            r.info.textContent = [providerName(a.provider), conn?.email || conn?.plan || (conn?.state === 'connected' ? 'Connected' : 'Not connected')].filter(Boolean).join(' · ');
            r.visible.input.checked = this.pendingFields.get(`${a.id}/visible`)?.value ?? a.visible;
            r.enabled.input.checked = this.pendingFields.get(`${a.id}/enabled`)?.value ?? a.enabled;
            for (const input of [r.name, r.visible.input, r.enabled.input]) input.disabled = !this.online;
            r.connect.hidden = a.system; r.local.hidden = !a.system;
            r.connect.textContent = conn?.state === 'connected' ? 'Reconnect' : 'Connect';
            r.connect.disabled = !this.online || !a.enabled || !this.data.monitoring || a.login?.state === 'pending';
            r.login.hidden = !a.login;
            if (a.login) {
                r.status.textContent = a.login.message || (a.login.url ? 'Finish in your provider’s sign-in page.' : 'Preparing sign-in…');
                r.link.hidden = !a.login.url; if (a.login.url) r.link.href = a.login.url; else r.link.removeAttribute('href');
                r.code.textContent = a.login.code || ''; r.code.hidden = !a.login.code;
                r.codeForm.hidden = a.provider !== 'claude' || !a.login.url || a.login.state !== 'pending';
                r.cancel.hidden = a.login.state !== 'pending';
            }
        }
        this.add.disabled = !this.online || accounts.length >= this.data.maxAccounts;
        this.renderCards();
    }
    renderCards() {
        if (!this.data || this.dead) return;
        const accounts = this.data.accounts.filter(a => a.visible), ids = new Set(accounts.map(a => a.id));
        this.grid.classList.toggle('qa-has-session-cost', accounts.some(a => a.system && a.quota?.windows?.session));
        for (const [id, c] of this.cards) if (!ids.has(id)) { c.card.remove(); this.cards.delete(id); }
        this.empty.hidden = accounts.length > 0;
        const now = Date.now();
        for (const a of accounts) {
            const c = this.cards.get(a.id) || this.createCard(a), q = a.quota || {}, paused = !this.data.monitoring || !a.enabled;
            const current = w => w && Number.isFinite(w.usedPercent) && (w.resetsAt === null || w.resetsAt > now);
            const week = current(q.windows?.weekly) ? q.windows.weekly : null;
            const session = current(q.windows?.session) ? q.windows.session : null;
            const fresh = this.online && !paused && q.status === 'ready' && q.updatedAt && now - q.updatedAt < 300000;
            c.title.textContent = a.label; c.title.title = a.label;
            c.hide.setAttribute('aria-label', `Hide ${a.label} from panel`); c.hide.disabled = !this.online;
            c.subtitle.textContent = [a.label.toLowerCase() === a.provider ? '' : providerName(a.provider), q.connection?.plan].filter(Boolean).join(' · ');
            c.subtitle.hidden = !c.subtitle.textContent;
            c.card.dataset.state = paused ? 'paused' : fresh ? 'ready' : 'stale';
            c.gauge.disabled = paused;
            c.percent.textContent = week ? `${Math.round(week.usedPercent)}%` : '—';
            c.period.textContent = 'Weekly';
            for (const [key, w] of [['weekly', week], ['session', session]]) {
                const r = c.rings[key];
                r.circle.setAttribute('stroke-dashoffset', String(r.length * (1 - (w?.usedPercent || 0) / 100)));
                r.circle.style.visibility = w && w.usedPercent > 0 ? '' : 'hidden';
                r.group.style.display = key === 'session' && !session ? 'none' : '';
                r.group.dataset.level = w?.usedPercent >= 95 ? 'critical' : w?.usedPercent >= 80 ? 'high' : '';
            }
            c.session.textContent = session ? `${session.windowMinutes === 300 ? '5h' : 'Session'} · ${Math.round(session.usedPercent)}%` : '';
            c.session.hidden = !session;
            const next = [week, session].filter(w => w && Number.isFinite(w.resetsAt)).sort((a, b) => a.resetsAt - b.resetsAt)[0];
            c.reset.textContent = next ? `↻ ${duration(next.resetsAt - now)}` : '—';
            c.reset.title = next ? `${next === week ? 'Weekly' : 'Session'} resets ${new Date(next.resetsAt).toLocaleString()}` : 'Reset time not reported';
            const connection = q.connection?.state;
            c.state.textContent = !this.online ? 'Offline' : paused ? 'Paused' : connection === 'sign-in-required' ? 'Connect in Accounts' : connection === 'reconnect' ? 'Reconnect' : q.official?.error === 'rate limited' && !fresh ? 'Rate limited · retrying' :
                !q.available ? 'Waiting for usage' : !fresh ? 'Cached' : '';
            c.state.title = q.updatedAt ? `Last reading ${new Date(q.updatedAt).toLocaleString()}` : 'No reading yet';
            c.state.hidden = !c.state.textContent;
            c.resume.hidden = !paused; c.resume.disabled = !this.online;
            const pace = q.pace?.weekly;
            c.range.textContent = fresh && pace?.state === 'limited' ? 'At limit' : fresh && pace?.state === 'estimated' ? `Range ≈ ${duration(pace.remainingMs)}` : fresh && pace?.state === 'reset-first' ? 'Reset before limit' : '';
            c.range.hidden = !c.range.textContent;
            this.paintActivity(a, c, fresh);
        }
        this.renderDetails();
    }
    paintActivity(a, c, fresh) {
        const entry = a.system && this.activity[a.provider], d = entry?.data;
        const valid = fresh && d?.available !== false && d?.hasData && Number.isFinite(d.updatedAt) && Date.now() - d.updatedAt < 15000;
        c.activity.hidden = !valid;
        if (!valid) return;
        // These older local collectors are provider-wide. Explicitly label the
        // scope; never attach their totals to additional account profiles.
        const series = Array.isArray(d.series) ? d.series.slice(-12) : [];
        const burn = series.at(-1);
        const costsFresh = entry?.costs?.available && entry.costs.status === 'ready' && Number.isFinite(entry.costs.updatedAt) && Date.now() - entry.costs.updatedAt < 15000;
        const cost = a.provider === 'codex' ? (costsFresh ? entry.costs.windows : null) : { today: d.today, week: d.week, block: d.block?.active ? d.block : null };
        const signature = JSON.stringify([series, cost, !!a.quota?.windows?.session]);
        if (c.activity.dataset.signature === signature) return;
        c.activity.dataset.signature = signature;
        const top = el('div', { class: 'qa-local-burn' }, [el('span', { text: 'This Mac' }), el('strong', { text: Number.isFinite(burn) ? (d.partialHistory ? '≈' : '') + number(burn) + ' tok/min' : '—' })]);
        const chart = el('div', { class: 'qa-bars', role: 'img', 'aria-label': 'Local token activity, one-minute bars' });
        const max = Math.max(1, ...Object.values(this.activity).flatMap(e => Date.now() - e.data?.updatedAt < 15000 ? e.data?.series || [] : []).filter(Number.isFinite));
        for (const value of series) { const bar = el('i'); bar.style.height = (Number.isFinite(value) ? Math.max(1, value / max * 100) : 0) + '%'; chart.append(bar); }
        const windows = [...(a.quota?.windows?.session ? [['block', '5h']] : []), ['today', 'Today'], ['week', '7d']];
        const costs = el('div', { class: 'qa-local-costs', title: 'Local API-price estimates, not subscription charges or all-account spend. An asterisk means some records could not be priced.' },
            windows.map(([key, label]) => el('span', { 'data-period': key, text: label + ' ' + money(cost?.[key]?.cost) + (cost?.[key]?.partial ? '*' : '') })));
        c.activity.replaceChildren(top, chart, costs);
    }
    destroy() { this.dead = true; for (const c of this.controllers) c.abort(); this.controllers.clear(); this.root.remove(); }
}
