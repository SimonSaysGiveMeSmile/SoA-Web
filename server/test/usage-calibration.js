#!/usr/bin/env node
/**
 * Calibrate claudeUsage's cost estimate against Claude Code's own /usage math.
 *
 * Ground truth: the /usage screen prints per-model token counts and dollar
 * cost (screenshotted 2026-07-03, session 6face46a). Those counts don't pin
 * the 5-minute vs 1-hour cache-write mix — the only rate that differs between
 * the two (1.25x vs 2x base input) — so the check is a BRACKET: pricing the
 * screenshot's exact token counts must put /usage's dollars between the
 * all-5m and all-1h bounds. With correct rates the bracket is a few dollars
 * wide; with the old (pre-Opus-4.5) table it misses by 2-3x, so this cleanly
 * separates right pricing from wrong.
 *
 * Also asserts the legacy table would FAIL, so the test can't silently pass
 * both ways.
 */
const { costOf } = require('../src/claudeUsage');

// tokens from the /usage screen; usd is what Claude Code itself charged them
// at. First two rows: 2026-07-03 screenshot (session 6face46a). Last two:
// 2026-07-08 screenshot of a 17d session (haiku row includes 10 web searches
// at $10/1k — checks the server-tool line item).
const CASES = [
    { name: 'claude-opus-4-8', model: 'claude-opus-4-8', input: 31900, output: 204300, cacheRead: 20.4e6, cacheWrite: 797200, usd: 22.25 },
    { name: 'claude-fable-5', model: 'claude-fable-5', input: 15100, output: 91200, cacheRead: 11.2e6, cacheWrite: 571700, usd: 24.24 },
    { name: 'claude-opus-4-8 (17d)', model: 'claude-opus-4-8', input: 936800, output: 3.0e6, cacheRead: 500.7e6, cacheWrite: 16.4e6, usd: 473.22 },
    { name: 'claude-haiku-4-5 (+search)', model: 'claude-haiku-4-5-20251001', input: 148700, output: 204600, cacheRead: 11.4e6, cacheWrite: 1.4e6, webSearch: 10, usd: 4.21 },
];

function priceWith(c, mix1h) {
    return costOf({
        ts: Date.parse('2026-07-03T20:00:00Z'),
        model: c.model,
        input: c.input,
        output: c.output,
        cacheRead: c.cacheRead,
        cw5m: c.cacheWrite * (1 - mix1h),
        cw1h: c.cacheWrite * mix1h,
        fast: false,
        geoUs: false,
        webSearch: c.webSearch || 0,
    });
}

let pass = true;
for (const c of CASES) {
    const lo = priceWith(c, 0), hi = priceWith(c, 1);
    const ok = c.usd >= lo - 0.02 && c.usd <= hi + 0.02;
    console.log(`${c.name}: /usage $${c.usd.toFixed(2)} vs computed [$${lo.toFixed(2)} … $${hi.toFixed(2)}] (5m→1h cache-write mix) ${ok ? 'OK' : 'MISS'}`);
    if (!ok) pass = false;
}

// Legacy-table guard: at the old Opus rates ($15/$75, cr $1.50) the same
// tokens price far above the bracket — proves the test discriminates.
const legacy = (c) => (c.input * 15 + c.output * 75 + c.cacheRead * 1.5 + c.cacheWrite * 18.75) / 1e6;
const l = legacy(CASES[0]);
const guard = l > CASES[0].usd * 2;
console.log(`legacy-table guard: old pricing gives $${l.toFixed(2)} (should be >2x /usage's $${CASES[0].usd}) ${guard ? 'OK' : 'MISS'}`);
if (!guard) pass = false;

console.log(pass ? 'CALIBRATION PASS' : 'CALIBRATION FAIL');
process.exit(pass ? 0 : 1);
