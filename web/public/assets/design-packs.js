// One catalogue for settings, previews and the terminal palettes.
export const DESIGN_PACKS = Object.freeze([
    { id: 'tron', name: 'Tron', detail: 'Light on the grid', appearance: true },
    { id: 'minimal', name: 'Minimal', detail: 'A little breathing room', appearance: true },
    { id: 'liquid', name: 'Liquid Glass', detail: 'Light, depth, clarity', appearance: true },
    { id: 'brutalist', name: 'Brutalist', detail: 'Bold by construction', appearance: true },
    { id: 'classic', name: 'Classic XP', detail: 'A familiar blue horizon', appearance: false },
    { id: 'dos', name: 'MS-DOS', detail: 'Straight to the command', appearance: false },
    { id: 'macos27', name: 'macOS 27', detail: 'Liquid Glass, SF Pro, Terminal.app', appearance: true },
    { id: 'windows11', name: 'Windows 11', detail: 'Mica, Fluent, Windows Terminal', appearance: true },
    { id: 'neumorphism', name: 'Neumorphism', detail: 'Soft UI on #E0E5EC, no strokes', appearance: true },
]);

const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
};

export function designPackPicker(id, value, onChange) {
    const group = node('div', 'design-packs');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Design pack');
    // Retain the existing settings field so Save, Reset and integrations all
    // use the same value. Real radio inputs provide native arrow-key behavior.
    const select = node('select');
    select.id = id;
    select.hidden = true;
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    const radios = [];
    for (const pack of DESIGN_PACKS) {
        const option = node('option', '', pack.name);
        option.value = pack.id;
        select.append(option);
        const label = node('label', 'design-pack');
        label.dataset.pack = pack.id;
        const radio = node('input', 'design-pack-radio');
        radio.type = 'radio'; radio.name = id + '-pack'; radio.value = pack.id;
        radio.setAttribute('aria-label', pack.name);
        const preview = node('span', 'pack-preview');
        preview.setAttribute('aria-hidden', 'true');
        const bar = node('span', 'pack-preview-bar');
        bar.append(node('i'), node('i'), node('i'));
        const body = node('span', 'pack-preview-body');
        body.append(node('span', 'pack-preview-rail'));
        const terminal = node('span', 'pack-preview-terminal');
        terminal.append(node('span', 'pack-preview-prompt', pack.id === 'dos' ? 'C:\\>' : '›_'),
            node('i'), node('i'), node('i'));
        body.append(terminal); preview.append(bar, body);
        const caption = node('span', 'pack-caption');
        caption.append(node('span', 'pack-name', pack.name), node('span', 'pack-check', '✓'));
        label.append(radio, preview, caption, node('span', 'pack-detail', pack.detail));
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            select.value = pack.id;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        radios.push(radio); group.append(label);
    }
    group.prepend(select);
    const reflect = () => {
        const pack = DESIGN_PACKS.find(pack => pack.id === select.value) || DESIGN_PACKS[0];
        radios.forEach(radio => { radio.checked = radio.value === pack.id; });
        const appearance = document.getElementById('set-theme');
        if (appearance) {
            appearance.disabled = !pack.appearance;
            const description = appearance.closest('.set-row')?.querySelector('.set-desc');
            if (description) description.textContent = pack.appearance
                ? 'Choose a light, dark, or system appearance.'
                : `${pack.name} uses its signature palette.`;
        }
    };
    select.value = DESIGN_PACKS.some(pack => pack.id === value) ? value : 'tron';
    select.addEventListener('change', () => { onChange(select.value); reflect(); });
    reflect();
    queueMicrotask(reflect); // The appearance row is added after this field.
    return group;
}
