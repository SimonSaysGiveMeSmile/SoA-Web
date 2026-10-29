// Theme switches delegate to the existing controls, so their
// save, reset, and server-loaded values keep one source of truth.
const switches = new Map();
const root = document.documentElement;
let watching = false;

function enhance(wrap) {
    if (switches.has(wrap)) return;
    const input = wrap.querySelector(':scope > input[type="hidden"]');
    const segment = wrap.querySelector(':scope > .seg');
    const options = segment?.querySelectorAll(':scope > button');
    const label = wrap.closest('.set-row')?.querySelector('.set-label');
    if (!input || !/^(true|false)$/.test(input.value) || options?.length !== 2 || !label) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'minimal-switch';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-label', label.textContent.trim());
    function sync() {
        button.setAttribute('aria-checked', String(input.value === 'true'));
        button.disabled = input.disabled || [...options].every(option => option.disabled);
    }
    button.addEventListener('click', () => {
        // boolSelect orders its existing controls ON, OFF.
        const next = options[input.value === 'true' ? 1 : 0];
        if (!next.disabled) next.click();
        sync();
    });
    sync();
    wrap.dataset.minimalSwitch = '';
    wrap.appendChild(button);
    const observer = new MutationObserver(sync);
    // Hidden inputs reflect .value to the value attribute, including values
    // loaded asynchronously by the automation pane.
    observer.observe(input, { attributes: true, attributeFilter: ['value', 'disabled'] });
    options.forEach(option => observer.observe(option, {
        attributes: true, attributeFilter: ['class', 'disabled'],
    }));
    switches.set(wrap, () => {
        observer.disconnect();
        if (document.activeElement === button) {
            delete wrap.dataset.minimalSwitch;
            options[input.value === 'true' ? 0 : 1].focus();
        }
        button.remove();
        delete wrap.dataset.minimalSwitch;
    });
}

function scan(node) {
    if (!(node instanceof Element) || node.closest('.xterm')) return;
    if (node.matches('.ctl-wrap')) enhance(node);
    node.querySelectorAll('.ctl-wrap').forEach(enhance);
}

const contentObserver = new MutationObserver(records => {
    // No polling or terminal repaint work. Only new settings controls matter.
    if (records.some(record => record.target === document.body)) watchSettings();
    for (const record of records) {
        for (const node of record.addedNodes) scan(node);
    }
    for (const [wrap, dispose] of switches) {
        if (!wrap.isConnected) { dispose(); switches.delete(wrap); }
    }
});

function watchSettings() {
    contentObserver.disconnect();
    contentObserver.observe(document.body, { childList: true });
    document.querySelectorAll('#settings-modal').forEach(modal => {
        contentObserver.observe(modal, { childList: true, subtree: true });
    });
}

function applyMode() {
    const minimal = ['minimal', 'liquid', 'macos27', 'windows11', 'neumorphism'].includes(root.dataset.ui);
    if (minimal === watching) return;
    watching = minimal;
    if (minimal) {
        scan(document.body);
        watchSettings();
    } else {
        contentObserver.disconnect();
        for (const dispose of switches.values()) dispose();
        switches.clear();
    }
}

new MutationObserver(applyMode).observe(root, {
    attributes: true, attributeFilter: ['data-ui'],
});
applyMode();
