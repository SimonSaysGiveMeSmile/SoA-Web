// Codex notify receives one JSON argv. Scoped to the SoA terminal env;
// never posts a reply to an unrelated session or a remote host.
async function relay(event, env = process.env, send = fetch) {
    if (event?.type !== 'agent-turn-complete') return false;
    const text = event['last-assistant-message'];
    const tab = Number(env.SOA_WEB_TAB);
    if (!text || !Number.isInteger(tab) || tab < 1 || !env.SOA_WEB_TTS_URL) return false;
    const url = new URL(env.SOA_WEB_TTS_URL);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return false;
    const res = await send(url, { method: 'POST', signal: AbortSignal.timeout(4000),
        headers: { 'content-type': 'application/json', 'x-soa-local-key': env.SOA_WEB_LOCAL_KEY || '' },
        body: JSON.stringify({ text: String(text).slice(0, 4000), tab }) });
    return res.ok;
}
function parseArgs(args, env = process.env) {
    const scoped = { ...env };
    for (const arg of args.slice(0, -1)) {
        if (arg.startsWith('--tab=')) scoped.SOA_WEB_TAB = arg.slice(6);
        if (arg.startsWith('--url=')) scoped.SOA_WEB_TTS_URL = arg.slice(6);
    }
    return { event: JSON.parse(args.at(-1) || '{}'), env: scoped };
}
if (require.main === module) {
    try { const parsed = parseArgs(process.argv.slice(2)); relay(parsed.event, parsed.env).catch(() => {}); } catch (_) {}
}
module.exports = { relay, parseArgs };
