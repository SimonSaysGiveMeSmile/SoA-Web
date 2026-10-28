// Image drafts stay in memory, scoped to the selected terminal. Only Send uploads.
export class ChatAttachments {
    constructor({ currentTab, status, composer, input }) {
        Object.assign(this, { currentTab, status });
        this.drafts = new Map();
        this.tray = document.createElement('div');
        this.tray.className = 'chat-attachments';
        this.tray.id = 'chat-attachments';
        this.tray.hidden = true;
        composer.before(this.tray);
        this.picker = document.createElement('input');
        this.picker.type = 'file';
        this.picker.accept = 'image/png,image/jpeg,image/webp,image/gif';
        this.picker.multiple = true;
        this.picker.hidden = true;
        this.picker.id = 'chat-image-input';
        this.button = document.createElement('button');
        this.button.type = 'button';
        this.button.id = 'chat-attach';
        this.button.className = 'chat-send';
        this.button.textContent = '+';
        this.button.setAttribute('aria-label', 'Attach images');
        composer.prepend(this.button, this.picker);
        this.button.onclick = () => {
            this.pickerTab = this.currentTab();
            this.picker.click();
        };
        this.picker.onchange = () => {
            this.add(this.picker.files, this.pickerTab ?? this.currentTab());
            this.picker.value = '';
        };
        input.addEventListener('paste', e => {
            const files = Array.from(e.clipboardData?.files || []);
            if (files.length) { e.preventDefault(); this.add(files, this.currentTab()); }
        });
    }
    get(id) { return this.drafts.get(id) || []; }
    add(files, id = this.currentTab()) {
        if (this.busy || id == null) return;
        const draft = this.get(id).slice();
        let bytes = [...this.drafts.values()].flat().reduce((n, a) => n + a.file.size, 0);
        let error = '';
        for (const file of Array.from(files || [])) {
            if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { error = 'Choose a JPEG, PNG, WebP or GIF image.'; continue; }
            if (!file.size || file.size > 10 * 1024 * 1024) { error = 'Each image must be between 1 byte and 10 MB.'; continue; }
            if (draft.length >= 6 || bytes + file.size > 30 * 1024 * 1024) { error = 'Use up to 6 images per message and 30 MB of image drafts in total.'; break; }
            draft.push({ file, url: URL.createObjectURL(file) });
            bytes += file.size;
        }
        if (draft.length) this.drafts.set(id, draft);
        this.render();
        this.status(error || 'Images attached. Add a message, then Send. Keep this page open until sent.');
    }
    remove(id, attachments) {
        for (const a of attachments) URL.revokeObjectURL(a.url);
        const remaining = this.get(id).filter(a => !attachments.includes(a));
        if (remaining.length) this.drafts.set(id, remaining);
        else this.drafts.delete(id);
        this.render();
    }
    setBusy(busy) { this.busy = busy; this.button.disabled = busy; this.render(); }
    render() {
        const id = this.currentTab(), draft = this.get(id);
        document.getElementById('chat-view')?.classList.toggle('vc-has-images', !!draft.length);
        this.tray.replaceChildren();
        this.tray.hidden = !draft.length;
        for (const a of draft) {
            const item = document.createElement('div');
            item.className = 'chat-attachment';
            const img = document.createElement('img');
            img.src = a.url; img.alt = a.file.name;
            const name = document.createElement('span');
            name.textContent = a.file.name;
            const remove = document.createElement('button');
            remove.type = 'button'; remove.textContent = '×'; remove.disabled = !!this.busy;
            remove.setAttribute('aria-label', 'Remove ' + a.file.name);
            remove.onclick = () => this.remove(id, [a]);
            item.append(img, name, remove);
            this.tray.append(item);
        }
    }
}
