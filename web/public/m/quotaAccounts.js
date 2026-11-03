import { QuotaAccountsView } from './quotaAccountsView.js?v=rings-20261103';
let closeCurrent;
export function openQuotaAccountsSheet({ api, available = true }) {
    closeCurrent?.();
    const previous = document.activeElement;
    const dialog = document.createElement('dialog'); dialog.className = 'qa-phone-sheet';
    dialog.setAttribute('aria-label', 'Account usage');
    const header = document.createElement('header');
    const title = document.createElement('strong'); title.textContent = 'Account usage';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Done';
    const body = document.createElement('div'); body.className = 'qa-phone-body';
    header.append(title, close); dialog.append(header, body); document.body.append(dialog);
    let view, timer, finished = false;
    const finish = () => { if (finished) return; finished = true; clearInterval(timer); view?.destroy(); dialog.remove(); if (closeCurrent === closeThis) closeCurrent = null; previous?.focus({ preventScroll: true }); };
    const closeThis = () => { dialog.close(); finish(); };
    closeCurrent = closeThis;
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', finish, { once: true });
    if (available) {
        view = new QuotaAccountsView({ parent: body, api });
        void view.refresh();
        timer = setInterval(() => { if (!document.hidden) void view.refresh(); }, 2500);
    } else {
        body.textContent = 'Pair this device to manage your accounts.';
        const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = new URL('./quotaAccounts.css?v=rings-20261103', import.meta.url); document.head.append(css);
    }
    dialog.showModal(); close.focus({ preventScroll: true });
    return { close: closeThis, view };
}
