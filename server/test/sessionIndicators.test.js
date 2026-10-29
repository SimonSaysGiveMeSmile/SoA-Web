const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../../web/public/assets/app.js'), 'utf8');
const shellSource = app.slice(app.indexOf('class Shell {'), app.indexOf('// ── Boot'));
const metadataSource = fs.readFileSync(path.join(__dirname, '../../web/public/m/sessionMetadata.js'), 'utf8').replaceAll('export function', 'function');

function harness(mode = 'tabs') {
    const elements = new Map();
    const notifications = [];
    const sent = [];
    class Element {
        constructor(tag, attrs = {}, children = []) { this.tag = tag; this.attrs = { ...attrs }; this.children = children; this.events = {}; this.classList = { toggle() {} }; }
        addEventListener(type, fn) { this.events[type] = fn; }
        setAttribute(key, value) { this.attrs[key] = value; }
        removeAttribute(key) { delete this.attrs[key]; }
        remove() { if (this.attrs.id) elements.delete(this.attrs.id); }
        click() { this.events.click?.({}); }
    }
    class Notification {
        static permission = 'granted';
        constructor(title, options) { this.title = title; this.options = options; notifications.push(this); }
        close() { this.closed = true; }
    }
    const context = vm.createContext({
        console, Map, Set, Notification,
        window: { focus() {} },
        document: { getElementById: id => elements.get(id), body: { appendChild: node => elements.set(node.attrs.id, node) } },
        el: (tag, attrs, children) => new Element(tag, attrs, children),
        requestAnimationFrame: fn => fn(), setTimeout: () => 1, clearTimeout() {},
        INPUT_KIND: { SWITCH_TAB: 'switch-tab' },
    });
    vm.runInContext(metadataSource + '\n' + shellSource + '\nthis.Shell = Shell; this.modelBadge = modelBadge; this.sessionMetadata = sessionMetadata;', context);
    const shell = Object.create(context.Shell.prototype);
    const runtime = id => ({ id, title: 'Tab ' + id, _opened: true, container: new Element('div'),
        detachRenderer() {}, fitNow() {}, attachRenderer() {}, flushPendingReplay() {}, scrollToBottom() {}, focus() {} });
    Object.assign(shell, {
        tabs: new Map([[1, runtime(1)], [2, runtime(2)]]), activeId: 1, viewMode: mode,
        _agentModel: new Map(), _agentKind: new Map(), _agentEffort: new Map(),
        _pollDirty: new Set(), _previewVisible: new Map(),
        bridge: { input: (kind, body) => sent.push({ kind, ...body }) },
        audio: { play() {} }, _chatTitleFor: id => 'Tab ' + id,
        _syncTabsUI() {}, _paintRendererStatus() {}, _syncPreviewPaneVisibility() {},
        _renderChatHead() {}, _renderChat() {}, _renderChatStatus() {}, _updateChatBtn() {},
        _openTileTerminal(id) { this._tileOverlayId = id; },
        _toggleChat() { throw new Error('Notification must not toggle CHAT'); },
    });
    return { shell, context, elements, notifications, sent };
}

test('provider guard rejects legacy Claude metadata on Codex while displaying actual Codex details', () => {
    const { context, shell } = harness();
    const legacy = context.sessionMetadata({ agent: 'codex', model: 'claude-fable-5', effort: 'ultracode' });
    assert.equal(legacy.model, null);
    assert.equal(legacy.effort, null);
    shell._onManager({ sessions: [
        { id: 1, agent: 'claude', model: 'claude-opus-5-5', effort: 'ultracode' },
        { id: 2, agent: 'codex', model: 'gpt-6-astra', effort: 'max', modelSource: 'codex-thread' },
    ] });
    const badge = shell._makeModelBadge(2);
    assert.equal(badge.attrs.text, 'GPT-6 Astra');
    assert.equal(badge.attrs.title, 'Codex · gpt-6-astra');
    assert.equal(shell._makeEffortBadge(2).attrs.text, 'max');
    assert.equal(shell._makeModelBadge(1).attrs.text, 'Opus 5.5');
    assert.equal(shell._makeEffortBadge(1).attrs.text, 'ultracode');
    shell._onManager({ sessions: [{ id: 2, agent: 'codex', model: null, effort: null }] });
    assert.equal(shell._makeModelBadge(2).attrs.text, 'Codex');
    assert.equal(shell._makeEffortBadge(2), null, 'missing current telemetry clears stale effort');
});

test('model labels expose the version and variant, including future unknown model IDs', () => {
    const { context } = harness();
    for (const [model, label] of [['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark'], ['custom-model-v2', 'custom-model-v2']]) {
        assert.equal(context.modelBadge({ agent: 'codex', model }).label, label);
    }
    assert.equal(context.modelBadge({ agent: 'claude', model: 'claude-opus-4-8[1m]' }).label, 'Opus 4.8');
    assert.equal(context.modelBadge({ agent: 'claude', model: 'claude-fable-5' }).label, 'Fable 5');
});

for (const mode of ['tabs', 'tiles', 'chat', 'manager', 'monitor', 'meeting']) {
    test('message notification opens its tab and preserves ' + mode, () => {
        const { shell, elements, sent } = harness(mode);
        shell._showImBanner(2, 'Finished the requested work');
        elements.get('soa-im-banner').click();
        assert.equal(shell.activeId, 2);
        assert.equal(shell.viewMode, mode);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].kind, 'switch-tab');
        assert.equal(sent[0].id, 2);
        if (mode === 'tiles') assert.equal(shell._tileOverlayId, 2);
    });
}

test('status toasts support keyboard navigation and OS notifications select the exact tab', () => {
    const { shell, elements, notifications, sent } = harness('tabs');
    shell._showStatusToast('Tab 2 needs input', 2);
    elements.get('soa-agent-toast').events.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(shell.activeId, 2);
    shell._osNotify('Tab 1 finished', 1);
    notifications[0].onclick();
    assert.equal(shell.activeId, 1);
    assert.equal(shell.viewMode, 'tabs');
    assert.equal(notifications[0].closed, true);
    assert.deepEqual(sent.map(s => s.id), [2, 1]);
});

test('an old notification cannot navigate to a closed or replaced tab', () => {
    const { shell, elements, notifications, sent } = harness();
    shell._showImBanner(2, 'Finished');
    shell._osNotify('Finished', 2);
    shell.tabs.set(2, { title: 'A different session with the reused numeric ID' });
    elements.get('soa-im-banner').click();
    notifications[0].onclick();
    assert.equal(shell.activeId, 1);
    assert.equal(sent.length, 0);
});

test('HTTP status refresh updates the active tab model without overriding live activity detection', async () => {
    const { shell, context } = harness();
    const statuses = [];
    shell._setStatus = (id, status) => statuses.push({ id, status });
    context.fetch = async () => ({ ok: true, json: async () => ({ sessions: [
        { id: 1, agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', modelSource: 'codex-thread', status: 'working' },
    ] }) });
    await shell._pullServerStatus();
    assert.equal(shell._makeModelBadge(1).attrs.title, 'Codex · gpt-6.1-sol');
    assert.equal(shell._agentEffort.get(1), 'high');
    assert.equal(statuses.length, 0, 'the active terminal still owns its live activity state');
});
