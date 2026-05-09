/**
 * i18n — tiny client-side translation layer.
 *
 * Chosen language persists in localStorage and is broadcast via a
 * `soa:lang` window event so widgets/shells can re-render on change.
 * Keep dictionaries dense and flat — keys are dotted paths, values are
 * strings with `{name}` placeholders for interpolation.
 *
 * Scope note: short all-caps data labels (HOST, CORES, LOAD-1m, etc.)
 * are intentionally left in English — they read as terminal data codes
 * rather than prose, and translating them breaks column alignment in
 * the sidebar widgets. Everything a user would actually *read* is
 * translated: boot status, tab titles, prompts, button labels, widget
 * headers, error states.
 */

const STORAGE_KEY = 'soa-web:lang';
const DEFAULT_LANG = 'en';
const SUPPORTED = ['en', 'zh', 'fr', 'de', 'es'];

export const LANGS = [
    { code: 'en', label: 'EN', name: 'English' },
    { code: 'zh', label: '中文', name: '中文' },
    { code: 'fr', label: 'FR', name: 'Français' },
    { code: 'de', label: 'DE', name: 'Deutsch' },
    { code: 'es', label: 'ES', name: 'Español' },
];

const DICTS = {
    en: {
        'brand.sub': 'WEB TERMINAL · PROTOCOL v1',
        'boot.negotiating': 'negotiating session…',
        'boot.opening': 'opening channel…',
        'boot.booting_sandbox': 'booting sandbox…',
        'boot.opening_shell': 'opening shell…',
        'boot.failed': 'boot failed: {detail}',
        'topbar.sidebar': '◨ SIDE',
        'topbar.sidebar_title': 'Toggle sidebar (Ctrl+Shift+B)',
        'topbar.audio_on': '♪ FX',
        'topbar.audio_off': '♪ OFF',
        'topbar.audio_title': 'Mute / unmute sound FX',
        'topbar.new_tab': '＋ TAB',
        'topbar.new_tab_title': 'New tab (Ctrl+Shift+T)',
        'topbar.lang_title': 'Language',
        'tab.default': 'tab {id}',
        'tab.rename_prompt': 'Rename tab',
        'tab.exited': '[process exited with code {code}]',
        'tab.exited_short': '[process exited: {code}]',
        'status.tabs_one': '{n} tab',
        'status.tabs_other': '{n} tabs',
        'status.ready': 'ready',
        'status.disconnected': 'disconnected',
        'status.connecting': 'connecting',
        'status.open': 'open',
        'status.closed': 'closed',
        'status.sandbox': 'sandbox · {host}',
        'widget.clock': 'CLOCK',
        'widget.system': 'SYSTEM',
        'widget.cpu': 'CPU',
        'widget.memory': 'MEMORY',
        'widget.network': 'NETWORK',
        'widget.commits': 'COMMITS',
        'widget.mobile_link': 'MOBILE LINK',
        'widget.net.empty': 'no interfaces',
        'widget.git.empty': 'no commits',
        'widget.git.unavailable': 'unavailable',
        'mqr.pair': 'PAIR',
        'mqr.stop': 'STOP',
        'mqr.copy': 'copy',
        'mqr.empty': 'tap PAIR to bring up a tunnel',
        'mqr.state.idle': 'IDLE',
        'mqr.state.starting': 'STARTING',
        'mqr.state.online': 'ONLINE',
        'mqr.state.error': 'ERROR',
    },
    zh: {
        'brand.sub': '网页终端 · 协议 v1',
        'boot.negotiating': '正在建立会话…',
        'boot.opening': '正在打开通道…',
        'boot.booting_sandbox': '正在启动沙盒…',
        'boot.opening_shell': '正在打开 shell…',
        'boot.failed': '启动失败:{detail}',
        'topbar.sidebar': '◨ 侧栏',
        'topbar.sidebar_title': '切换侧栏 (Ctrl+Shift+B)',
        'topbar.audio_on': '♪ 音效',
        'topbar.audio_off': '♪ 静音',
        'topbar.audio_title': '开启 / 关闭音效',
        'topbar.new_tab': '＋ 标签',
        'topbar.new_tab_title': '新建标签 (Ctrl+Shift+T)',
        'topbar.lang_title': '语言',
        'tab.default': '标签 {id}',
        'tab.rename_prompt': '重命名标签',
        'tab.exited': '[进程已退出,代码 {code}]',
        'tab.exited_short': '[进程已退出:{code}]',
        'status.tabs_one': '{n} 个标签',
        'status.tabs_other': '{n} 个标签',
        'status.ready': '就绪',
        'status.disconnected': '已断开',
        'status.connecting': '连接中',
        'status.open': '已连接',
        'status.closed': '已关闭',
        'status.sandbox': '沙盒 · {host}',
        'widget.clock': '时钟',
        'widget.system': '系统',
        'widget.cpu': 'CPU',
        'widget.memory': '内存',
        'widget.network': '网络',
        'widget.commits': '提交',
        'widget.mobile_link': '移动链接',
        'widget.net.empty': '无网络接口',
        'widget.git.empty': '无提交记录',
        'widget.git.unavailable': '不可用',
        'mqr.pair': '配对',
        'mqr.stop': '停止',
        'mqr.copy': '复制',
        'mqr.empty': '点击"配对"以启动隧道',
        'mqr.state.idle': '空闲',
        'mqr.state.starting': '启动中',
        'mqr.state.online': '在线',
        'mqr.state.error': '错误',
    },
    fr: {
        'brand.sub': 'TERMINAL WEB · PROTOCOLE v1',
        'boot.negotiating': 'négociation de la session…',
        'boot.opening': 'ouverture du canal…',
        'boot.booting_sandbox': 'démarrage du bac à sable…',
        'boot.opening_shell': 'ouverture du shell…',
        'boot.failed': 'échec du démarrage : {detail}',
        'topbar.sidebar': '◨ CÔTÉ',
        'topbar.sidebar_title': 'Afficher / masquer le panneau (Ctrl+Maj+B)',
        'topbar.audio_on': '♪ FX',
        'topbar.audio_off': '♪ OFF',
        'topbar.audio_title': 'Activer / couper les effets sonores',
        'topbar.new_tab': '＋ ONGLET',
        'topbar.new_tab_title': 'Nouvel onglet (Ctrl+Maj+T)',
        'topbar.lang_title': 'Langue',
        'tab.default': 'onglet {id}',
        'tab.rename_prompt': "Renommer l'onglet",
        'tab.exited': '[processus terminé avec le code {code}]',
        'tab.exited_short': '[processus terminé : {code}]',
        'status.tabs_one': '{n} onglet',
        'status.tabs_other': '{n} onglets',
        'status.ready': 'prêt',
        'status.disconnected': 'déconnecté',
        'status.connecting': 'connexion',
        'status.open': 'connecté',
        'status.closed': 'fermé',
        'status.sandbox': 'bac à sable · {host}',
        'widget.clock': 'HORLOGE',
        'widget.system': 'SYSTÈME',
        'widget.cpu': 'CPU',
        'widget.memory': 'MÉMOIRE',
        'widget.network': 'RÉSEAU',
        'widget.commits': 'COMMITS',
        'widget.mobile_link': 'LIEN MOBILE',
        'widget.net.empty': 'aucune interface',
        'widget.git.empty': 'aucun commit',
        'widget.git.unavailable': 'indisponible',
        'mqr.pair': 'APPAIRER',
        'mqr.stop': 'ARRÊT',
        'mqr.copy': 'copier',
        'mqr.empty': 'appuyez sur APPAIRER pour ouvrir un tunnel',
        'mqr.state.idle': 'INACTIF',
        'mqr.state.starting': 'DÉMARRAGE',
        'mqr.state.online': 'EN LIGNE',
        'mqr.state.error': 'ERREUR',
    },
    de: {
        'brand.sub': 'WEB-TERMINAL · PROTOKOLL v1',
        'boot.negotiating': 'Sitzung wird ausgehandelt…',
        'boot.opening': 'Kanal wird geöffnet…',
        'boot.booting_sandbox': 'Sandbox wird gestartet…',
        'boot.opening_shell': 'Shell wird geöffnet…',
        'boot.failed': 'Start fehlgeschlagen: {detail}',
        'topbar.sidebar': '◨ SEITE',
        'topbar.sidebar_title': 'Seitenleiste umschalten (Strg+Umschalt+B)',
        'topbar.audio_on': '♪ FX',
        'topbar.audio_off': '♪ AUS',
        'topbar.audio_title': 'Soundeffekte ein- / ausschalten',
        'topbar.new_tab': '＋ TAB',
        'topbar.new_tab_title': 'Neuer Tab (Strg+Umschalt+T)',
        'topbar.lang_title': 'Sprache',
        'tab.default': 'Tab {id}',
        'tab.rename_prompt': 'Tab umbenennen',
        'tab.exited': '[Prozess beendet mit Code {code}]',
        'tab.exited_short': '[Prozess beendet: {code}]',
        'status.tabs_one': '{n} Tab',
        'status.tabs_other': '{n} Tabs',
        'status.ready': 'bereit',
        'status.disconnected': 'getrennt',
        'status.connecting': 'verbinde',
        'status.open': 'verbunden',
        'status.closed': 'geschlossen',
        'status.sandbox': 'Sandbox · {host}',
        'widget.clock': 'UHR',
        'widget.system': 'SYSTEM',
        'widget.cpu': 'CPU',
        'widget.memory': 'SPEICHER',
        'widget.network': 'NETZWERK',
        'widget.commits': 'COMMITS',
        'widget.mobile_link': 'MOBIL-LINK',
        'widget.net.empty': 'keine Schnittstellen',
        'widget.git.empty': 'keine Commits',
        'widget.git.unavailable': 'nicht verfügbar',
        'mqr.pair': 'KOPPELN',
        'mqr.stop': 'STOPP',
        'mqr.copy': 'kopieren',
        'mqr.empty': 'KOPPELN drücken, um einen Tunnel zu öffnen',
        'mqr.state.idle': 'LEERLAUF',
        'mqr.state.starting': 'STARTET',
        'mqr.state.online': 'ONLINE',
        'mqr.state.error': 'FEHLER',
    },
    es: {
        'brand.sub': 'TERMINAL WEB · PROTOCOLO v1',
        'boot.negotiating': 'negociando sesión…',
        'boot.opening': 'abriendo canal…',
        'boot.booting_sandbox': 'iniciando sandbox…',
        'boot.opening_shell': 'abriendo shell…',
        'boot.failed': 'error al iniciar: {detail}',
        'topbar.sidebar': '◨ LADO',
        'topbar.sidebar_title': 'Mostrar / ocultar panel (Ctrl+Mayús+B)',
        'topbar.audio_on': '♪ FX',
        'topbar.audio_off': '♪ OFF',
        'topbar.audio_title': 'Activar / silenciar efectos de sonido',
        'topbar.new_tab': '＋ PESTAÑA',
        'topbar.new_tab_title': 'Nueva pestaña (Ctrl+Mayús+T)',
        'topbar.lang_title': 'Idioma',
        'tab.default': 'pestaña {id}',
        'tab.rename_prompt': 'Renombrar pestaña',
        'tab.exited': '[proceso terminado con código {code}]',
        'tab.exited_short': '[proceso terminado: {code}]',
        'status.tabs_one': '{n} pestaña',
        'status.tabs_other': '{n} pestañas',
        'status.ready': 'listo',
        'status.disconnected': 'desconectado',
        'status.connecting': 'conectando',
        'status.open': 'conectado',
        'status.closed': 'cerrado',
        'status.sandbox': 'sandbox · {host}',
        'widget.clock': 'RELOJ',
        'widget.system': 'SISTEMA',
        'widget.cpu': 'CPU',
        'widget.memory': 'MEMORIA',
        'widget.network': 'RED',
        'widget.commits': 'COMMITS',
        'widget.mobile_link': 'ENLACE MÓVIL',
        'widget.net.empty': 'sin interfaces',
        'widget.git.empty': 'sin commits',
        'widget.git.unavailable': 'no disponible',
        'mqr.pair': 'VINCULAR',
        'mqr.stop': 'PARAR',
        'mqr.copy': 'copiar',
        'mqr.empty': 'pulsa VINCULAR para abrir un túnel',
        'mqr.state.idle': 'INACTIVO',
        'mqr.state.starting': 'INICIANDO',
        'mqr.state.online': 'EN LÍNEA',
        'mqr.state.error': 'ERROR',
    },
};

function detectInitial() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored && SUPPORTED.includes(stored)) return stored;
    } catch (_) {}
    const nav = (navigator.language || navigator.userLanguage || '').toLowerCase();
    const primary = nav.split('-')[0];
    if (SUPPORTED.includes(primary)) return primary;
    return DEFAULT_LANG;
}

let current = detectInitial();

function interpolate(str, vars) {
    if (!vars) return str;
    return str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

export function t(key, vars) {
    const dict = DICTS[current] || DICTS[DEFAULT_LANG];
    const val = dict[key] != null ? dict[key] : (DICTS[DEFAULT_LANG][key] != null ? DICTS[DEFAULT_LANG][key] : key);
    return interpolate(val, vars);
}

export function getLang() { return current; }

export function setLang(lang) {
    if (!SUPPORTED.includes(lang) || lang === current) return;
    current = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) {}
    try { document.documentElement.lang = lang; } catch (_) {}
    window.dispatchEvent(new CustomEvent('soa:lang', { detail: { lang } }));
}

export function onLangChange(handler) {
    const wrapped = e => handler(e.detail.lang);
    window.addEventListener('soa:lang', wrapped);
    return () => window.removeEventListener('soa:lang', wrapped);
}

export function applyStatic(root = document) {
    try { root.documentElement && (root.documentElement.lang = current); } catch (_) {}
    root.querySelectorAll('[data-i18n]').forEach(n => {
        const key = n.getAttribute('data-i18n');
        if (key) n.textContent = t(key);
    });
    root.querySelectorAll('[data-i18n-title]').forEach(n => {
        const key = n.getAttribute('data-i18n-title');
        if (key) n.setAttribute('title', t(key));
    });
}

window.addEventListener('soa:lang', () => applyStatic(document));
