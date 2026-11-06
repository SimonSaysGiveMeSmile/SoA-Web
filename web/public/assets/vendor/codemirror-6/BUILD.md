# CodeMirror 6 bundle (cm.js)

`cm.js` is CodeMirror 6 plus the language packs the code panel uses, packed by
esbuild into ONE minified ES module with no runtime imports. `entry.js` is its
source. Licences and the exact package list are in `LICENSE`.

## Rebuild

```bash
mkdir cm-build && cd cm-build && npm init -y
npm install --save-exact \
  @codemirror/state@6.7.6 @codemirror/view@6.43.15 @codemirror/commands@6.11.1 \
  @codemirror/language@6.13.1 @codemirror/search@6.7.2 @codemirror/autocomplete@6.20.4 \
  @codemirror/lang-javascript@6.2.5 @codemirror/lang-json@6.0.2 @codemirror/lang-css@6.3.1 \
  @codemirror/lang-html@6.4.12 @codemirror/lang-markdown@6.5.2 @codemirror/lang-python@6.2.1 \
  @codemirror/lang-rust@6.0.2 @codemirror/lang-go@6.0.1 @codemirror/lang-java@6.0.2 \
  @codemirror/lang-cpp@6.0.3 @codemirror/lang-php@6.0.2 @codemirror/lang-sql@6.10.0 \
  @codemirror/lang-xml@6.1.0 @codemirror/lang-yaml@6.1.3 @codemirror/legacy-modes@6.5.5 \
  @lezer/highlight@1.2.5 esbuild@0.28.2
cp <this dir>/entry.js .
./node_modules/.bin/esbuild entry.js --bundle --format=esm --minify --target=es2020 \
  --legal-comments=none --outfile=<this dir>/cm.js
```

Check `npm ls @codemirror/state @codemirror/view` shows ONE copy of each: two
copies break `instanceof` checks inside CodeMirror and the editor fails to start.
When bumping versions, pin exact versions (never a range or `latest`), update
the list above and in `LICENSE`, and bump the importer's cache-bust tag.

## API

```js
import { createEditor, EditorView, EditorState, Compartment, keymap } from '/assets/vendor/codemirror-6/cm.js';
const ed = createEditor({ parent, doc, filename, readOnly, onChange, onSave, onCursor, tabSize });
```

- `onChange(update)`: fires on every document change (`update.state.doc`).
- `onSave()`: Mod-s (default action prevented, wins over every other binding).
- `onCursor({ line, col, selected, selections, lines, language })`: 1-based, de-duplicated.
- Returns `{ view, setDoc(text), getDoc(), setFilename(name) -> language label,
  language, setReadOnly(bool), focus(), gotoLine(line, col), destroy() }`.
  `setDoc` builds a fresh state, so undo history does not carry across files.

The theme reads only host CSS custom properties (`--soa-bg-deep`, `--soa-fg`,
`--soa-bg-panel`, `--soa-accent`, `--soa-accent-dim`, `--soa-line`,
`--soa-line-soft`, `--soa-yellow`, `--soa-red`, `--soa-green`, `--soa-mono`,
`--soa-code-size`) and token colours from `--soa-code-{kw,str,num,comment,fn,type,def,prop,tag,op,meta,const,heading,link,inserted,deleted,changed,invalid}`,
each with a mid-tone fallback that reads on light and dark grounds.
Makefiles use the shell tokenizer (legacy-modes ships no make grammar).
