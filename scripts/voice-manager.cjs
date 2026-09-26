// Dedicated terminal process: no shell prompt can receive a voice message
// after the agent exits. Used again when TabManager restores this workspace.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const hook = path.join(__dirname, 'soa-codex-notify.cjs');
const instructions = 'You are the user’s voice manager in Son of Anton mobile Chat. Keep replies brief and easy to speak. Ask clarifying questions in a normal final message, not an interactive request_user_input form, so the phone receives the question. Explain when an approval requires the terminal. Help coordinate their projects using the installed soa-sessions CLI when asked. Do not start background work or contact other agents without a user request.';
function buildArgs(sessionId, env = process.env) {
    const notify = [process.execPath, hook];
    // Bind this launch's destination explicitly: a shared CLI daemon may have
    // inherited another terminal's environment before this manager was opened.
    if (env.SOA_WEB_TAB && env.SOA_WEB_TTS_URL) notify.push('--tab=' + env.SOA_WEB_TAB, '--url=' + env.SOA_WEB_TTS_URL);
    return [...(sessionId ? ['resume', sessionId] : []), '--no-alt-screen', '-c', 'notify=' + JSON.stringify(notify),
    '-c', 'developer_instructions=' + JSON.stringify(instructions)];
}
if (require.main === module) {
    let sessionId;
    try { sessionId = require('../server/src/codexSessions').latestSessionByCwd(24 * 365).get(process.cwd())?.sessionId; } catch (_) {}
    const args = buildArgs(sessionId);
    // launchd doesn't read shell startup files; prefer the user's standalone CLI.
    const installed = path.join(os.homedir(), '.local/bin/codex');
    let command = 'codex';
    try { fs.accessSync(installed, fs.constants.X_OK); command = installed; } catch (_) {}
    const child = spawn(command, args, { stdio: 'inherit', env: process.env });
    child.on('error', err => { console.error('Could not start Codex:', err.message); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code || 0; });
    for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
}
module.exports = { buildArgs };
