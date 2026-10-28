// pairScan.js — pair this browser with a desktop by scanning its QR code.
//
// The first-open wizard can already scan, but it is shown once. Everything
// after that — Settings, the recovery panel when the link is gone, the sandbox
// — used to assume a keyboard and a desktop install. On an iPad that is the
// wrong assumption twice over: it has the camera the desktop never had, and
// re-pairing is exactly what it needs after a dropped link.
//
// So the scan lives here, once, and the three surfaces call it. It reuses the
// phone companion's scanner (/m/qrscan.js: BarcodeDetector where it exists,
// jsQR everywhere else, back-camera preference, torch) and ends the way the
// wizard does — this page, pointed at the paired daemon.

const T = {
    en: { scan: 'Scan a desktop QR code', paste: 'Or paste the pairing link', connect: 'CONNECT', pw: 'pairing password',
          cancel: 'Cancel', hint: 'Point the camera at the QR code in the desktop sidebar (MOBILE LINK).', torch: 'Light',
          err_code: 'That is not a Son of Anton pairing code.',
          err_token: 'That link has no pairing token — scan the QR in the desktop’s MOBILE LINK widget.',
          err_cam: 'No camera here. Paste the pairing link instead.',
          err_denied: 'Camera access was refused. Allow it in the browser, or paste the link.',
          err_open: 'The camera could not start ({detail}). Paste the link instead.',
          err_unreach: 'Could not reach that desktop. Check the link and that it is online.',
          err_pw: 'Wrong password.',
          pw_hint: 'This desktop takes its pairing password — enter it below.',
          err_nologin: 'The desktop accepted the password but does not allow password login. On the desktop: MOBILE LINK → ALLOW PASSWORD LOGIN.' },
    zh: { scan: '扫描桌面二维码', paste: '或粘贴配对链接', connect: '连接', pw: '配对密码',
          cancel: '取消', hint: '将相机对准桌面侧栏（MOBILE LINK）中的二维码。', torch: '补光',
          err_code: '这不是 Son of Anton 的配对码。', err_token: '该链接没有配对令牌——请扫描桌面 MOBILE LINK 中的二维码。',
          err_cam: '此设备没有相机。请改为粘贴配对链接。', err_denied: '相机权限被拒绝。请在浏览器中允许，或粘贴链接。',
          err_open: '相机无法启动（{detail}）。请改为粘贴链接。', err_unreach: '无法连接该桌面。请检查链接并确认其在线。',
          err_pw: '密码错误。', pw_hint: '该桌面需要配对密码——请在下方输入。',
          err_nologin: '桌面接受了密码，但未允许密码登录。请在桌面的 MOBILE LINK 中开启 ALLOW PASSWORD LOGIN。' },
    fr: { scan: 'Scanner le QR code d’un bureau', paste: 'Ou coller le lien d’association', connect: 'CONNECTER', pw: 'mot de passe d’association',
          cancel: 'Annuler', hint: 'Visez le QR code de la barre latérale du bureau (MOBILE LINK).', torch: 'Lampe',
          err_code: 'Ce n’est pas un code d’association Son of Anton.', err_token: 'Ce lien n’a pas de jeton — scannez le QR code du widget MOBILE LINK.',
          err_cam: 'Pas de caméra ici. Collez plutôt le lien.', err_denied: 'Accès caméra refusé. Autorisez-le dans le navigateur, ou collez le lien.',
          err_open: 'La caméra n’a pas démarré ({detail}). Collez plutôt le lien.', err_unreach: 'Impossible de joindre ce bureau. Vérifiez le lien et qu’il est en ligne.',
          err_pw: 'Mot de passe incorrect.', pw_hint: 'Ce bureau demande son mot de passe d’association — saisissez-le ci-dessous.',
          err_nologin: 'Le bureau a accepté le mot de passe mais n’autorise pas la connexion par mot de passe. Sur le bureau : MOBILE LINK → ALLOW PASSWORD LOGIN.' },
    de: { scan: 'Desktop-QR-Code scannen', paste: 'Oder den Kopplungslink einfügen', connect: 'VERBINDEN', pw: 'Kopplungspasswort',
          cancel: 'Abbrechen', hint: 'Kamera auf den QR-Code in der Desktop-Seitenleiste (MOBILE LINK) richten.', torch: 'Licht',
          err_code: 'Das ist kein Son-of-Anton-Kopplungscode.', err_token: 'Der Link hat kein Kopplungs-Token — scanne den QR-Code im MOBILE-LINK-Widget.',
          err_cam: 'Keine Kamera hier. Füge stattdessen den Link ein.', err_denied: 'Kamerazugriff abgelehnt. Im Browser erlauben oder den Link einfügen.',
          err_open: 'Die Kamera startet nicht ({detail}). Füge stattdessen den Link ein.', err_unreach: 'Desktop nicht erreichbar. Link prüfen und ob er online ist.',
          err_pw: 'Falsches Passwort.', pw_hint: 'Dieser Desktop verlangt sein Kopplungspasswort — unten eingeben.',
          err_nologin: 'Der Desktop hat das Passwort angenommen, erlaubt aber keine Passwort-Anmeldung. Am Desktop: MOBILE LINK → ALLOW PASSWORD LOGIN.' },
    es: { scan: 'Escanear el QR de un escritorio', paste: 'O pega el enlace de emparejamiento', connect: 'CONECTAR', pw: 'contraseña de emparejamiento',
          cancel: 'Cancelar', hint: 'Apunta la cámara al QR de la barra lateral del escritorio (MOBILE LINK).', torch: 'Luz',
          err_code: 'Eso no es un código de emparejamiento de Son of Anton.', err_token: 'Ese enlace no tiene token — escanea el QR del widget MOBILE LINK.',
          err_cam: 'Aquí no hay cámara. Pega el enlace en su lugar.', err_denied: 'Acceso a la cámara denegado. Permítelo en el navegador o pega el enlace.',
          err_open: 'La cámara no pudo iniciarse ({detail}). Pega el enlace en su lugar.', err_unreach: 'No se pudo contactar con ese escritorio. Revisa el enlace y que esté en línea.',
          err_pw: 'Contraseña incorrecta.', pw_hint: 'Este escritorio pide su contraseña de emparejamiento — escríbela abajo.',
          err_nologin: 'El escritorio aceptó la contraseña pero no permite iniciar sesión con contraseña. En el escritorio: MOBILE LINK → ALLOW PASSWORD LOGIN.' },
};
function lang() {
    try { return localStorage.getItem('soa-web:lang') || (navigator.language || 'en').slice(0, 2).toLowerCase(); }
    catch (_) { return 'en'; }
}
function t(key) { const d = T[lang()] || T.en; return d[key] || T.en[key] || key; }

/** Is a camera even conceivable here? Used to hide the button on a desktop with none. */
export function cameraLikely() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

const NGROK = { 'ngrok-skip-browser-warning': 'true' };

/** Boot this page against a paired daemon — the deep link the QR encodes. */
function enter(backend, token, unlock) {
    try {
        localStorage.setItem('soa_web_backend', JSON.stringify({ backend, token, unlock: unlock || '' }));
        localStorage.setItem('soa_web_welcomed', '1');
    } catch (_) { /* private mode: the query string below still carries it */ }
    const dest = new URL(location.origin + location.pathname);
    dest.searchParams.set('backend', backend);
    dest.searchParams.set('t', token);
    location.href = dest.toString();
}

/**
 * The pairing sheet: a scan button, a paste field, and a password field that
 * appears only when the pasted link needs one. Resolves when it closes.
 */
export function openPairSheet({ title, lead } = {}) {
    document.getElementById('pair-sheet')?.remove();
    const previousFocus = document.activeElement;
    const sheet = document.createElement('div');
    sheet.id = 'pair-sheet';
    sheet.className = 'pair-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.innerHTML = `
        <div class="pair-card">
            <h2 class="pair-title"></h2>
            <p class="pair-lead"></p>
            <button type="button" class="pair-scan">
                <span class="pair-scan-ico" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
                <span class="pair-scan-label"></span>
            </button>
            <label class="pair-field"><span class="pair-field-l"></span>
                <input class="pair-url" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://…/m/?t=…">
            </label>
            <label class="pair-field pair-pwfield" hidden><span class="pair-field-l"></span>
                <input class="pair-pw" type="password" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="current-password">
            </label>
            <div class="pair-actions">
                <button type="button" class="pair-go"></button>
                <button type="button" class="pair-close"></button>
            </div>
            <p class="pair-err" role="alert" hidden></p>
        </div>`;
    document.body.appendChild(sheet);

    const q = (s) => sheet.querySelector(s);
    q('.pair-title').textContent = title || t('scan');
    q('.pair-lead').textContent = lead || t('hint');
    q('.pair-scan-label').textContent = t('scan');
    q('.pair-field .pair-field-l').textContent = t('paste');
    q('.pair-pwfield .pair-field-l').textContent = t('pw_hint');
    q('.pair-pw').placeholder = t('pw');
    q('.pair-go').textContent = t('connect');
    q('.pair-close').textContent = t('cancel');
    if (!cameraLikely()) q('.pair-scan').hidden = true;

    const err = q('.pair-err');
    const fail = (m) => { err.textContent = m || ''; err.hidden = !m; q('.pair-go').disabled = false; };
    const close = () => { sheet.remove(); try { previousFocus?.focus?.(); } catch (_) {} };
    q('.pair-close').addEventListener('click', close);
    sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    q('.pair-scan').addEventListener('click', async () => {
        fail('');
        let mod;
        try { mod = await import('/m/qrscan.js'); }
        catch (_) { return fail(t('err_cam')); }
        if (!mod.QrScanner.supported) return fail(t('err_cam'));
        const scanner = new mod.QrScanner({
            onResult: (v) => { scanner.stop(); go(v); },
            onError: (e) => { scanner.stop(); fail((e && e.message) || t('err_cam')); },
            labels: { cancel: t('cancel'), hint: t('hint'), torch: t('torch'),
                errNoCam: t('err_cam'), errDenied: t('err_denied'), errOpen: t('err_open') },
        });
        scanner.start();
    });

    async function go(raw) {
        fail('');
        q('.pair-go').disabled = true;
        let parse;
        try { ({ parsePairingPayload: parse } = await import('/m/qrscan.js')); }
        catch (_) { return fail(t('err_code')); }
        const p = parse(raw || q('.pair-url').value);
        if (!p) return fail(t('err_code'));
        const backend = (p.backend || p.origin).replace(/\/+$/, '');
        if (p.token) return enter(backend, p.token, '');
        // No token in the link: usable only when the desktop lets its pairing
        // password stand in for the QR.
        let ping = null;
        try {
            const res = await fetch(backend + '/api/ping', { credentials: 'omit', cache: 'no-store', headers: NGROK });
            ping = await res.json();
        } catch (_) { return fail(t('err_unreach')); }
        if (!ping || !ping.ok) return fail(t('err_unreach'));
        if (!ping.passwordLogin) return fail(t('err_token'));
        const pwField = q('.pair-pwfield');
        pwField.hidden = false;
        const pw = q('.pair-pw');
        if (!pw.value) { fail(t('pw_hint')); try { pw.focus(); } catch (_) {} return; }
        let body = null;
        try {
            const res = await fetch(backend + '/api/pair/unlock', {
                method: 'POST', credentials: 'include', cache: 'no-store',
                headers: Object.assign({ 'Content-Type': 'application/json' }, NGROK),
                body: JSON.stringify({ password: pw.value }),
            });
            body = await res.json().catch(() => null);
            if (!res.ok || !body || !body.ok) return fail((body && body.error) || t('err_pw'));
        } catch (_) { return fail(t('err_unreach')); }
        if (!body.pairToken) return fail(t('err_nologin'));
        enter(backend, body.pairToken, body.unlockToken || '');
    }

    q('.pair-go').addEventListener('click', () => go());
    for (const sel of ['.pair-url', '.pair-pw']) {
        q(sel).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    }
    setTimeout(() => { try { q('.pair-url').focus(); } catch (_) {} }, 40);
    return sheet;
}
