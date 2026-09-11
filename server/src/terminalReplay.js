const { MSG, frame } = require('./protocol');

const REPLAY_HIGH_WATER = 512 * 1024;

// Yield between tab snapshots so heartbeats can interleave, and wait for the
// socket to drain before adding another large frame. Until a tab's snapshot
// is sent, Session.sendTerminalData suppresses its live frames on THIS socket.
// Reading scrollback at send time includes those bytes once, in order, without
// an extra unbounded queue. Existing sockets keep streaming normally.
function streamBackgroundReplay(ws, session, tabList, activeId, {
    schedule = setImmediate,
    wait = setTimeout,
} = {}) {
    const ids = tabList.map(t => t.id).filter(id => id !== activeId);
    if (!ids.length) return;
    const pending = new Set(ids);
    ws._pendingReplayTabs = pending;
    let i = 0;
    let stopped = false;

    const finish = () => {
        stopped = true;
        pending.clear();
        if (ws._pendingReplayTabs === pending) delete ws._pendingReplayTabs;
        if (typeof ws.removeListener === 'function') ws.removeListener('close', finish);
    };
    if (typeof ws.once === 'function') ws.once('close', finish);

    const sendNext = () => {
        if (stopped) return;
        if (ws.readyState !== 1 || ws._pendingReplayTabs !== pending) { finish(); return; }
        if (i >= ids.length) { finish(); return; }
        const id = ids[i];
        // A tab can close while another replay is draining. Its SNAPSHOT has
        // already removed it on the client, so skip it without delaying others.
        if (session.tabMgr.get(id)) {
            if (ws.bufferedAmount > REPLAY_HIGH_WATER) { wait(sendNext, 50); return; }
            const data = session.tabMgr.scrollback(id);
            if (data && data.length) {
                try { ws.send(frame(MSG.REPLAY, { id, data })); }
                catch (_) { finish(); return; }
            }
        }
        // Snapshot enqueue and release happen in one event-loop turn: the next
        // PTY callback can only enqueue live bytes after this tab's replay.
        pending.delete(id);
        i++;
        if (i < ids.length) schedule(sendNext); else finish();
    };
    schedule(sendNext);
}

module.exports = { streamBackgroundReplay, REPLAY_HIGH_WATER };
