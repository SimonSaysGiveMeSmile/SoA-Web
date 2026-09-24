// Dedicated terminal process: no shell prompt can receive a voice message
// after the agent exits. Used again when TabManager restores this workspace.
const { spawn } = require('node:child_process');
const path = require('node:path');
const hook = path.join(__dirname, 'soa-codex-notify.cjs');
const instructions = 'You are the user’s voice manager in Son of Anton. Keep replies brief and easy to speak. Help coordinate their projects using the installed soa-sessions CLI when asked. Do not start background work or contact other agents without a user request.';
const args = ['--no-alt-screen', '-c', 'notify=' + JSON.stringify([process.execPath, hook]),
    '-c', 'developer_instructions=' + JSON.stringify(instructions)];
const child = spawn('codex', args, { stdio: 'inherit', env: process.env });
child.on('error', err => { console.error('Could not start Codex:', err.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
