// This browser's bounded offline archive. No tokens or server-side sharing.
const KEY = 'soa.mobile.history.v1';
const MAX_CHARS = 1400000;
export class SessionHistory {
    constructor(storage) {
        this.storage = storage;
        this.records = [];
        this.available = true;
        try {
            const saved = JSON.parse(storage.getItem(KEY) || 'null');
            if (saved?.version === 1 && Array.isArray(saved.records))
                this.records = saved.records.filter(r => r && typeof r.key === 'string' && Array.isArray(r.messages)).slice(0, 40);
        } catch (_) { /* corrupt or unavailable storage must not prevent boot */ }
    }
    key(source, tab) { return JSON.stringify([source, tab.historyId || `legacy:${tab.id}:${tab.cwd || ''}`]); }
    get(source, tab) { return this.records.find(r => r.key === this.key(source, tab)); }
    update(source, tab, fields = {}) {
        const key = this.key(source, tab);
        let record = this.records.find(r => r.key === key);
        if (!record) { record = { key, messages: [], draft: '', terminal: '' }; this.records.push(record); }
        Object.assign(record, { source, tabId: tab.id, title: String(tab.title || `TAB ${tab.id}`).slice(0, 200), updated: Date.now() });
        if (fields.messages) {
            let chars = 0;
            record.messages = fields.messages.slice(-200).reverse().filter(m => {
                chars += String(m.full || '').length;
                return chars <= 100000;
            }).reverse().map(m => ({ from: m.from === 'you' ? 'you' : 'agent', full: String(m.full || '').slice(0, 32000), t: m.t }));
        }
        if (typeof fields.draft === 'string') record.draft = fields.draft.slice(0, 16000);
        if (typeof fields.terminal === 'string') record.terminal = fields.terminal.slice(-24000);
        this.records.sort((a, b) => b.updated - a.updated);
        this.records = this.records.slice(0, 40);
        this.save();
        return record;
    }
    save() {
        let json = JSON.stringify({ version: 1, records: this.records });
        while (json.length > MAX_CHARS && this.records.length > 1) {
            this.records.pop();
            json = JSON.stringify({ version: 1, records: this.records });
        }
        try { this.storage.setItem(KEY, json); this.available = true; }
        catch (_) { this.available = false; }
    }
    clear() { this.records = []; this.save(); }
}

export function openHistory(store, { connected = false, onClose = () => {}, onClear = () => {} } = {}) {
    document.getElementById('session-history')?.remove();
    const panel = document.createElement('section');
    panel.id = 'session-history';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'History on this device');
    const heading = document.createElement('h2');
    heading.textContent = 'History on this device';
    const close = document.createElement('button');
    close.textContent = 'Back';
    const previousFocus = document.activeElement;
    close.onclick = () => { panel.remove(); onClose(); previousFocus?.focus(); };
    const note = document.createElement('p');
    note.textContent = (connected ? 'Saved copies. ' : 'Offline copies — available without a connection. ') +
        'Recent conversations, drafts and terminal output stay in this browser. Nothing is sent from this view.';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Saved session');
    const content = document.createElement('div');
    content.className = 'history-content';
    const render = () => {
        content.replaceChildren();
        const r = store.records[Number(select.value)];
        if (!r) { content.textContent = 'No saved sessions on this device yet.'; return; }
        const meta = document.createElement('p');
        meta.textContent = `${r.source} · Saved ${new Date(r.updated).toLocaleString()}`;
        content.append(meta);
        for (const m of r.messages) {
            const bubble = document.createElement('div');
            bubble.className = 'chat-msg ' + (m.from === 'you' ? 'you' : 'agent');
            bubble.textContent = `${m.from === 'you' ? 'You' : 'Agent'}: ${m.full}`;
            content.append(bubble);
        }
        if (r.draft) {
            const draft = document.createElement('p');
            draft.className = 'history-draft';
            draft.textContent = 'Unsent draft: ' + r.draft;
            content.append(draft);
        }
        if (r.terminal) {
            const details = document.createElement('details');
            const summary = document.createElement('summary');
            summary.textContent = 'Last saved terminal output';
            const pre = document.createElement('pre');
            pre.textContent = r.terminal;
            details.append(summary, pre);
            content.append(details);
        }
    };
    store.records.forEach((r, i) => {
        const option = document.createElement('option');
        option.value = String(i); option.textContent = r.title;
        select.append(option);
    });
    select.onchange = render;
    const clear = document.createElement('button');
    clear.textContent = 'Clear saved history';
    clear.onclick = () => {
        if (!window.confirm('Clear saved conversations, drafts and terminal snapshots from this browser?')) return;
        store.clear(); onClear(); select.replaceChildren(); render();
    };
    panel.append(close, heading, note, select, content, clear);
    if (!store.available) {
        const warning = document.createElement('p');
        warning.textContent = 'Browser storage is unavailable or full. New history may not survive closing this page.';
        panel.append(warning);
    }
    panel.addEventListener('keydown', e => {
        if (e.key === 'Escape') close.click();
        if (e.key === 'Tab') {
            const focusable = [...panel.querySelectorAll('button, select, summary')];
            const first = focusable[0], last = focusable.at(-1);
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });
    document.body.append(panel); render(); close.focus();
}
