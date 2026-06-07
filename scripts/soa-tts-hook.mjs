#!/usr/bin/env node
/**
 * SoA-Web — Claude Code "Stop" hook for text-to-speech.
 *
 * Claude Code runs this when it finishes a turn. We read the final assistant
 * message from the transcript and POST it to the local SoA server, which pushes
 * it to the browser to be spoken via the Web Speech API.
 *
 * It is a strict no-op unless SOA_WEB_TTS_URL is set in the environment — that
 * variable is injected only into shells SoA spawns, so running Claude Code in a
 * normal terminal is unaffected. It also never fails loudly: any error exits 0
 * so it can't block or slow down Claude Code.
 *
 * Install: add to ~/.claude/settings.json
 *   { "hooks": { "Stop": [ { "hooks": [
 *       { "type": "command", "command": "node <abs-path>/soa-tts-hook.mjs" }
 *   ] } ] } }
 */

import fs from 'node:fs';

const TTS_URL = process.env.SOA_WEB_TTS_URL;
if (!TTS_URL) process.exit(0); // not running under SoA — do nothing

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        try { process.stdin.setEncoding('utf8'); } catch (_) {}
        process.stdin.on('data', (c) => { data += c; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', () => resolve(data));
        setTimeout(() => resolve(data), 800); // guard against no-EOF stdin
    });
}

function lastAssistantText(transcriptPath) {
    try {
        const raw = fs.readFileSync(transcriptPath, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
            let obj;
            try { obj = JSON.parse(lines[i]); } catch (_) { continue; }
            const msg = (obj && obj.message) || obj;
            const role = (msg && msg.role) || (obj && obj.type);
            if (role !== 'assistant') continue;
            const content = msg && msg.content;
            if (typeof content === 'string' && content.trim()) return content;
            if (Array.isArray(content)) {
                const parts = content
                    .filter((b) => b && b.type === 'text' && b.text)
                    .map((b) => b.text);
                if (parts.length) return parts.join('\n');
            }
        }
    } catch (_) {}
    return '';
}

function cleanForSpeech(t) {
    return String(t)
        .replace(/```[\s\S]*?```/g, ' . ')          // code fences → pause
        .replace(/`([^`]+)`/g, '$1')                  // inline code
        .replace(/^#{1,6}\s+/gm, '')                  // headings
        .replace(/\*\*([^*]+)\*\*/g, '$1')            // bold
        .replace(/\*([^*]+)\*/g, '$1')                // italic
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')      // [text](url) → text
        .replace(/^[-*+]\s+/gm, '')                   // list bullets
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 4000);
}

(async () => {
    let evt = {};
    try { evt = JSON.parse(await readStdin()); } catch (_) {}
    const transcript = evt.transcript_path || evt.transcriptPath;
    if (!transcript) process.exit(0);

    const text = cleanForSpeech(lastAssistantText(transcript));
    if (!text) process.exit(0);

    const tab = process.env.SOA_WEB_TAB ? Number(process.env.SOA_WEB_TAB) : null;
    try {
        await fetch(TTS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, tab }),
        });
    } catch (_) {}
    process.exit(0);
})();
