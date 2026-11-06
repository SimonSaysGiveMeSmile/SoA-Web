// SoA code panel editor: CodeMirror 6 packed into one ESM file.
// Rebuild: see BUILD.md next to cm.js.
import { EditorState, Compartment, Prec } from '@codemirror/state';
import {
    EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
    highlightSpecialChars, drawSelection, dropCursor, rectangularSelection,
    crosshairCursor,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
    foldGutter, foldKeymap, indentOnInput, bracketMatching, syntaxHighlighting,
    HighlightStyle, StreamLanguage, indentUnit,
} from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import {
    autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap,
} from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { php } from '@codemirror/lang-php';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { diff } from '@codemirror/legacy-modes/mode/diff';

export { EditorView, EditorState, Compartment, keymap };

const legacy = (mode) => () => StreamLanguage.define(mode);

// [label, factory]; factories run on demand so an unused grammar costs nothing at runtime.
const LANGS = {
    javascript: ['JavaScript', () => javascript()],
    jsx: ['JavaScript (JSX)', () => javascript({ jsx: true })],
    typescript: ['TypeScript', () => javascript({ typescript: true })],
    tsx: ['TypeScript (TSX)', () => javascript({ jsx: true, typescript: true })],
    json: ['JSON', () => json()],
    css: ['CSS', () => css()],
    html: ['HTML', () => html()],
    markdown: ['Markdown', () => markdown()],
    python: ['Python', () => python()],
    rust: ['Rust', () => rust()],
    go: ['Go', () => go()],
    java: ['Java', () => java()],
    cpp: ['C/C++', () => cpp()],
    php: ['PHP', () => php()],
    sql: ['SQL', () => sql()],
    xml: ['XML', () => xml()],
    yaml: ['YAML', () => yaml()],
    shell: ['Shell', legacy(shell)],
    swift: ['Swift', legacy(swift)],
    toml: ['TOML', legacy(toml)],
    ruby: ['Ruby', legacy(ruby)],
    lua: ['Lua', legacy(lua)],
    dockerfile: ['Dockerfile', legacy(dockerFile)],
    // legacy-modes has no make grammar; shell tokenising gets comments, strings and $(vars) right.
    makefile: ['Makefile', legacy(shell)],
    diff: ['Diff', legacy(diff)],
};

const EXT = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
    ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
    json: 'json', jsonc: 'json', webmanifest: 'json',
    css: 'css', scss: 'css', less: 'css',
    html: 'html', htm: 'html',
    md: 'markdown', markdown: 'markdown',
    py: 'python', pyi: 'python',
    rs: 'rust', go: 'go',
    java: 'java', kt: 'java', kts: 'java',
    c: 'cpp', h: 'cpp', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp', hh: 'cpp', m: 'cpp', mm: 'cpp',
    php: 'php', sql: 'sql',
    xml: 'xml', svg: 'xml', plist: 'xml', xsd: 'xml',
    yaml: 'yaml', yml: 'yaml',
    sh: 'shell', bash: 'shell', zsh: 'shell', command: 'shell',
    swift: 'swift', toml: 'toml', rb: 'ruby', lua: 'lua',
    dockerfile: 'dockerfile', mk: 'makefile', make: 'makefile',
    diff: 'diff', patch: 'diff',
};

const NAMES = {
    dockerfile: 'dockerfile', containerfile: 'dockerfile',
    makefile: 'makefile', gnumakefile: 'makefile',
    gemfile: 'ruby', rakefile: 'ruby',
    '.zshrc': 'shell', '.bashrc': 'shell', '.bash_profile': 'shell', '.zprofile': 'shell', '.profile': 'shell',
};

function langKey(filename) {
    const base = String(filename || '').split(/[\\/]/).pop().toLowerCase();
    if (NAMES[base]) return NAMES[base];
    if (base.startsWith('dockerfile.') || base.endsWith('.dockerfile')) return 'dockerfile';
    const dot = base.lastIndexOf('.');
    if (dot < 0) return null;
    return EXT[base.slice(dot + 1)] || null;
}

function languageFor(filename) {
    const key = langKey(filename);
    if (!key) return { name: 'Plain text', ext: [] };
    const [name, make] = LANGS[key];
    try { return { name, ext: make() }; } catch { return { name: 'Plain text', ext: [] }; }
}

// Every colour comes from the host page's tokens so the editor follows the active
// pack and light/dark. Fallbacks are mid-tone so they stay legible on either ground.
const soaTheme = EditorView.theme({
    '&': {
        height: '100%',
        color: 'var(--soa-fg, #d6e2ea)',
        backgroundColor: 'var(--soa-bg-deep, #0b1016)',
        fontSize: 'var(--soa-code-size, 13px)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
        fontFamily: 'var(--soa-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        lineHeight: '1.5',
    },
    '.cm-content': { caretColor: 'var(--soa-accent, #4fd1ff)', padding: '6px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--soa-accent, #4fd1ff)', borderLeftWidth: '2px' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'color-mix(in srgb, var(--soa-accent, #4fd1ff) 28%, transparent) !important',
    },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--soa-accent, #4fd1ff) 7%, transparent)' },
    '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--soa-accent, #4fd1ff) 16%, transparent)' },
    '.cm-searchMatch': {
        backgroundColor: 'color-mix(in srgb, var(--soa-yellow, #e6c84f) 30%, transparent)',
        outline: '1px solid color-mix(in srgb, var(--soa-yellow, #e6c84f) 60%, transparent)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'color-mix(in srgb, var(--soa-accent, #4fd1ff) 35%, transparent)',
    },
    '&.cm-focused .cm-matchingBracket': {
        backgroundColor: 'color-mix(in srgb, var(--soa-accent, #4fd1ff) 22%, transparent)',
        outline: '1px solid color-mix(in srgb, var(--soa-accent, #4fd1ff) 55%, transparent)',
    },
    '&.cm-focused .cm-nonmatchingBracket': { color: 'var(--soa-red, #e05561)' },
    '.cm-gutters': {
        backgroundColor: 'var(--soa-bg-panel, transparent)',
        color: 'var(--soa-accent-dim, #6b8a99)',
        border: 'none',
        borderRight: '1px solid var(--soa-line-soft, rgba(127,127,127,.18))',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '3ch' },
    '.cm-activeLineGutter': {
        backgroundColor: 'color-mix(in srgb, var(--soa-accent, #4fd1ff) 10%, transparent)',
        color: 'var(--soa-fg, #d6e2ea)',
    },
    '.cm-foldGutter .cm-gutterElement': { padding: '0 4px', cursor: 'pointer' },
    '.cm-foldPlaceholder': {
        backgroundColor: 'transparent',
        border: '1px solid var(--soa-line, rgba(127,127,127,.35))',
        color: 'var(--soa-accent-dim, #6b8a99)',
        borderRadius: '3px',
        padding: '0 4px',
    },
    '.cm-panels': {
        backgroundColor: 'var(--soa-bg-panel, #111821)',
        color: 'var(--soa-fg, #d6e2ea)',
    },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--soa-line, rgba(127,127,127,.35))' },
    '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--soa-line, rgba(127,127,127,.35))' },
    '.cm-panel.cm-search': { padding: '6px 8px', fontFamily: 'inherit' },
    '.cm-panel.cm-search label': { fontSize: '12px', color: 'var(--soa-accent-dim, #6b8a99)' },
    '.cm-textfield': {
        backgroundColor: 'var(--soa-bg-deep, #0b1016)',
        color: 'var(--soa-fg, #d6e2ea)',
        border: '1px solid var(--soa-line, rgba(127,127,127,.35))',
        borderRadius: '4px',
        padding: '3px 6px',
        fontFamily: 'inherit',
    },
    '.cm-textfield:focus-visible, .cm-button:focus-visible': {
        outline: '2px solid var(--soa-accent, #4fd1ff)',
        outlineOffset: '1px',
    },
    '.cm-button': {
        backgroundImage: 'none',
        backgroundColor: 'transparent',
        color: 'var(--soa-fg, #d6e2ea)',
        border: '1px solid var(--soa-line, rgba(127,127,127,.35))',
        borderRadius: '4px',
        padding: '3px 8px',
        fontFamily: 'inherit',
    },
    '.cm-button:active': { backgroundImage: 'none', backgroundColor: 'color-mix(in srgb, var(--soa-accent, #4fd1ff) 18%, transparent)' },
    '.cm-panel button[name=close]': { color: 'var(--soa-accent-dim, #6b8a99)', fontSize: '18px' },
    '.cm-tooltip': {
        backgroundColor: 'var(--soa-bg-panel, #111821)',
        color: 'var(--soa-fg, #d6e2ea)',
        border: '1px solid var(--soa-line, rgba(127,127,127,.35))',
        borderRadius: '6px',
    },
    '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--soa-mono, ui-monospace, SFMono-Regular, Menlo, monospace)' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: 'color-mix(in srgb, var(--soa-accent, #4fd1ff) 24%, transparent)',
        color: 'var(--soa-fg, #d6e2ea)',
    },
    '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--soa-accent, #4fd1ff)' },
    '.cm-completionDetail': { color: 'var(--soa-accent-dim, #6b8a99)' },
    '.cm-placeholder': { color: 'var(--soa-accent-dim, #6b8a99)' },
    '@media (forced-colors: active)': {
        '.cm-cursor': { borderLeftColor: 'CanvasText' },
        '.cm-selectionBackground': { backgroundColor: 'Highlight !important' },
    },
});

const v = (name, fallback) => `var(--soa-code-${name}, ${fallback})`;
const soaHighlight = HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: v('kw', '#a66bd8') },
    { tag: [t.string, t.special(t.string), t.regexp, t.character], color: v('str', '#4f9f63') },
    { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: v('num', '#c97a26') },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: v('comment', 'var(--soa-accent-dim, #7d8b96)'), fontStyle: 'italic' },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: v('fn', '#3a8fd8') },
    { tag: [t.typeName, t.className, t.namespace, t.self], color: v('type', '#c1922b') },
    { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: v('def', 'inherit') },
    { tag: [t.propertyName, t.attributeName], color: v('prop', '#2f9db3') },
    { tag: [t.tagName, t.angleBracket], color: v('tag', '#d0585e') },
    { tag: [t.attributeValue], color: v('str', '#4f9f63') },
    { tag: [t.operator, t.derefOperator], color: v('op', 'inherit') },
    { tag: [t.meta, t.processingInstruction, t.annotation], color: v('meta', '#7d8b96') },
    { tag: [t.escape, t.constant(t.variableName), t.standard(t.variableName)], color: v('const', '#c97a26') },
    { tag: t.heading, color: v('heading', 'var(--soa-accent, #3a8fd8)'), fontWeight: '700' },
    { tag: t.strong, fontWeight: '700' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: [t.link, t.url], color: v('link', 'var(--soa-accent, #3a8fd8)'), textDecoration: 'underline' },
    { tag: [t.inserted], color: v('inserted', 'var(--soa-green, #4f9f63)') },
    { tag: [t.deleted], color: v('deleted', 'var(--soa-red, #d0585e)') },
    { tag: [t.changed], color: v('changed', 'var(--soa-yellow, #c1922b)') },
    { tag: t.invalid, color: v('invalid', 'var(--soa-red, #e05561)') },
]);

export function createEditor({
    parent, doc = '', filename = '', readOnly = false,
    onChange, onSave, onCursor, tabSize = 4,
} = {}) {
    const langC = new Compartment();
    const roC = new Compartment();
    let lang = languageFor(filename);
    let ro = !!readOnly;
    let lastCursor = '';

    const roExt = (on) => [EditorState.readOnly.of(on), EditorView.editable.of(!on)];

    const reportCursor = (state) => {
        if (!onCursor) return;
        const sel = state.selection.main;
        const line = state.doc.lineAt(sel.head);
        const info = {
            line: line.number,
            col: sel.head - line.from + 1,
            selected: state.selection.ranges.reduce((n, r) => n + (r.to - r.from), 0),
            selections: state.selection.ranges.length,
            lines: state.doc.lines,
            language: lang.name,
        };
        const sig = `${info.line}:${info.col}:${info.selected}:${info.selections}:${info.lines}:${info.language}`;
        if (sig === lastCursor) return;
        lastCursor = sig;
        try { onCursor(info); } catch (e) { console.error(e); }
    };

    const extensions = () => [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(soaHighlight, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        EditorState.tabSize.of(tabSize),
        indentUnit.of(' '.repeat(Math.max(1, tabSize | 0))),
        // Above every default binding so the browser's "save page" never wins.
        Prec.highest(keymap.of([{
            key: 'Mod-s',
            preventDefault: true,
            run: () => { try { onSave?.(); } catch (e) { console.error(e); } return true; },
        }])),
        keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...completionKeymap,
            indentWithTab,
        ]),
        soaTheme,
        langC.of(lang.ext),
        roC.of(roExt(ro)),
        EditorView.updateListener.of((u) => {
            if (u.docChanged && onChange) { try { onChange(u); } catch (e) { console.error(e); } }
            if (u.docChanged || u.selectionSet) reportCursor(u.state);
        }),
    ];

    const view = new EditorView({
        parent,
        state: EditorState.create({ doc: String(doc), extensions: extensions() }),
    });
    reportCursor(view.state);

    return {
        view,
        // A fresh state, so undo history from the previous file cannot leak into this one.
        setDoc(text) {
            lastCursor = '';
            view.setState(EditorState.create({ doc: String(text ?? ''), extensions: extensions() }));
            reportCursor(view.state);
        },
        getDoc() { return view.state.doc.toString(); },
        setFilename(name) {
            lang = languageFor(name);
            view.dispatch({ effects: langC.reconfigure(lang.ext) });
            lastCursor = '';
            reportCursor(view.state);
            return lang.name;
        },
        get language() { return lang.name; },
        setReadOnly(on) {
            ro = !!on;
            view.dispatch({ effects: roC.reconfigure(roExt(ro)) });
        },
        focus() { view.focus(); },
        gotoLine(line, col = 1) {
            const d = view.state.doc;
            const ln = d.line(Math.min(Math.max(1, line | 0 || 1), d.lines));
            const pos = Math.min(ln.from + Math.max(0, (col | 0 || 1) - 1), ln.to);
            view.dispatch({
                selection: { anchor: pos },
                effects: EditorView.scrollIntoView(pos, { y: 'center' }),
            });
            view.focus();
        },
        destroy() { view.destroy(); },
    };
}
