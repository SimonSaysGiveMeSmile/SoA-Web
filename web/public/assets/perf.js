/**
 * perf — a live answer to "which part is making this slow?"
 *
 * Frame rate on its own cannot answer that question. Script monopolising the
 * main thread and the GPU failing to paint look identical from the outside —
 * both are just a low number — and they need opposite fixes. So this measures
 * three things at once over a rolling one-second window:
 *
 *   fps          how many frames the page actually delivered
 *   blocked      main-thread time past the 50ms long-task mark, per second
 *   parts        where that time went, by subsystem
 *
 * BLOCKED is the discriminator. High blocked time means JavaScript is in the
 * way, and `parts` names which subsystem to go after. Low blocked time with a
 * low frame rate means paint or compositing, and no amount of script tuning
 * will move it.
 *
 * Everything here is inert until perfStart(), and the call sites are all
 * guarded by `PERF.on`, so a tool for measuring overhead does not become the
 * overhead. The cost while running is one counter per frame, one addition per
 * instrumented call, and a PerformanceObserver the browser feeds passively.
 */

// Read by the instrumented call sites, which is why it is a mutable object
// rather than an exported boolean: `import { PERF }` then `PERF.on` sees the
// current value, where a plain exported binding would be captured at import.
export const PERF = { on: false };

let frames = 0;
let rafId = null;
let blockedMs = 0;
let observer = null;
let bytes = 0;
let chunks = 0;
let windowStart = 0;
const parts = new Map();   // subsystem name -> ms accumulated this window

/** Record time spent in an instrumented block. `t0` comes from performance.now(). */
export function ptime(name, t0) {
    if (!PERF.on || !t0) return;
    parts.set(name, (parts.get(name) || 0) + (performance.now() - t0));
}

/** Record one chunk of terminal output arriving from the daemon. */
export function pstream(len) {
    if (!PERF.on) return;
    bytes += len || 0;
    chunks++;
}

function reset(now) {
    windowStart = now;
    frames = 0;
    blockedMs = 0;
    bytes = 0;
    chunks = 0;
    parts.clear();
}

export function perfStart() {
    if (PERF.on) return;
    PERF.on = true;
    reset(performance.now());

    // Counting frames is the only honest way to know what the page delivered:
    // a rAF that is never called is exactly the symptom being measured.
    const loop = () => {
        if (!PERF.on) return;
        frames++;
        rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    // Long tasks are reported by the browser without polling. Everything past
    // 50ms is time the page could not have painted in, which is the definition
    // of blocking.
    try {
        observer = new PerformanceObserver(list => {
            for (const e of list.getEntries()) blockedMs += Math.max(0, e.duration - 50);
        });
        observer.observe({ entryTypes: ['longtask'] });
    } catch (_) {
        observer = null;   // not supported here; fps and parts still work
    }
}

export function perfStop() {
    PERF.on = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (observer) { try { observer.disconnect(); } catch (_) {} observer = null; }
}

/** Rates over the window since the last call, then start a fresh window. */
export function perfSnapshot() {
    const now = performance.now();
    const secs = Math.max(0.05, (now - windowStart) / 1000);

    let heapMb = 0;
    try {
        const m = performance.memory;
        if (m && m.usedJSHeapSize) heapMb = m.usedJSHeapSize / 1048576;
    } catch (_) {}

    const snap = {
        fps: frames / secs,
        blockedMsPerSec: blockedMs / secs,
        kbPerSec: bytes / 1024 / secs,
        chunksPerSec: chunks / secs,
        heapMb,
        // A subsystem costing under a tenth of a millisecond a second is not
        // the reason for anything, and listing it only buries the one that is.
        parts: [...parts.entries()]
            .map(([name, ms]) => ({ name, msPerSec: ms / secs }))
            .filter(p => p.msPerSec >= 0.1)
            .sort((a, b) => b.msPerSec - a.msPerSec),
    };

    // Learn the display's ceiling from the best second ever observed, so a
    // 120Hz panel is judged against 120 rather than being told 60 is fine.
    if (snap.fps > (window.__soaHz || 0)) window.__soaHz = snap.fps;

    reset(now);
    return snap;
}

/**
 * One line naming the culprit. This is the whole point of the widget: not a
 * number to interpret, but a statement about which half of the pipeline to fix.
 */
export function perfVerdict(s) {
    const target = (window.__soaHz && window.__soaHz > 70) ? 120 : 60;
    if (s.fps >= target * 0.85) return { level: 'ok', text: 'smooth' };
    // Blocked time is the fork in the road.
    if (s.blockedMsPerSec >= 30) {
        const top = s.parts[0];
        return {
            level: s.blockedMsPerSec >= 80 ? 'bad' : 'warn',
            text: top ? `main thread · ${top.name}` : 'main thread · js',
        };
    }
    if (s.fps < target * 0.5) return { level: 'bad', text: 'paint / gpu' };
    return { level: 'warn', text: 'paint / gpu' };
}
