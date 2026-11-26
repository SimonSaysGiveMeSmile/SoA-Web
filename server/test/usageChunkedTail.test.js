'use strict';
// claudeUsage reads transcripts in slices: a file past V8's string limit
// (1.85 GB, 2026-11-26) used to throw on every poll and be re-read forever.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-tail-'));
process.env.SOA_CLAUDE_PROJECTS_DIR = dir;
const cu = require('../src/claudeUsage');

const usageLine = (i) => JSON.stringify({ type: 'assistant', sessionId: 's1', cwd: '/x', timestamp: new Date().toISOString(),
    requestId: 'r' + i, message: { id: 'm' + i, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 2 } } }) + '\n';
const filler = (n) => JSON.stringify({ type: 'user', sessionId: 's1', cwd: '/x', message: { content: 'é🙂'.repeat(n) } }) + '\n';

test('a file bigger than one slice, with multi-byte text and a line longer than a slice', () => {
    const f = path.join(dir, 'a.jsonl');
    let body = usageLine(0) + filler(3 * 1024 * 1024) /* ~18 MB line */ + usageLine(1);
    for (let i = 2; i < 3000; i++) body += filler(1000) + usageLine(i);
    fs.writeFileSync(f, body);
    cu._resetForTest();
    const size = fs.statSync(f).size;
    const c = cu._tailForTest({ full: f, size }, 0);
    assert.strictEqual(c.readOffset, size, 'offset is the byte length, landed at EOF');
    assert.strictEqual(c.records.length, 3000);
});

test('a partial last line waits for its newline', () => {
    const f = path.join(dir, 'b.jsonl');
    const done = usageLine(0), half = usageLine(1);
    fs.writeFileSync(f, done + half.slice(0, 40));
    cu._resetForTest();
    let c = cu._tailForTest({ full: f, size: fs.statSync(f).size }, 0);
    assert.strictEqual(c.records.length, 1);
    assert.strictEqual(c.readOffset, Buffer.byteLength(done));
    fs.appendFileSync(f, half.slice(40));
    c = cu._tailForTest({ full: f, size: fs.statSync(f).size }, 0);
    assert.strictEqual(c.records.length, 2);
});

test('a read budget stops mid-file and the next call resumes exactly', () => {
    const f = path.join(dir, 'c.jsonl');
    let body = '';
    for (let i = 0; i < 4000; i++) body += filler(2000) + usageLine(i);
    fs.writeFileSync(f, body);
    cu._resetForTest();
    const size = fs.statSync(f).size;
    let c, calls = 0;
    do { c = cu._tailForTest({ full: f, size }, 0, { left: 1 }); calls++; } while (c.readOffset < size && calls < 1000);
    assert.ok(calls > 1, 'took several budgeted calls');
    assert.strictEqual(c.readOffset, size);
    assert.strictEqual(c.records.length, 4000);
});
