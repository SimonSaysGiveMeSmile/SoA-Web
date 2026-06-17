/**
 * Mobile agent-status detector.
 *
 * Agent status (the tab colours) is computed client-side by watching the
 * terminal stream for tell-tale patterns — the desktop does this in
 * web/public/assets/app.js (_detectAgentFromStream). The server never sends a
 * status field, so the phone has to derive it the same way from the term-data
 * it already receives. This is a focused port of those heuristics; keep it
 * roughly in sync with the desktop patterns.
 *
 * Returns one of: 'working' | 'attention' | 'done' | 'idle' | null
 * (null = no confident change; keep the current status).
 */

const WORKING = [
    /esc to interrupt/i,
    /\(esc\s+to\s+cancel\)/i,
    /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
    /✳/,
    /\b(?:Thinking|Pondering|Crafting|Running|Executing|Processing|Working|Reading|Writing|Editing|Searching|Fetching|Analyzing|Wrangling|Brewing|Planning|Compiling|Installing|Building|Testing|Formatting|Linting|Deploying|Pushing|Pulling|Cloning|Downloading|Uploading|Generating|Updating|Checking|Scanning|Indexing|Resolving|Compacting|Streaming|Connecting|Waiting|Loading|Preparing|Initializing|Starting|Applying|Committing|Merging|Rebasing|Diffing|Nucleating|Forming|Roosting)\b[.…]/i,
];

const ATTENTION = [
    /❯\s*(?:Yes|No|Allow once|Allow always|Deny|Accept|Reject)/i,
    /Do you want to (?:proceed|continue|make this change|accept)/i,
    /\(y\/n\)/i,
    /\[Y\/n\]/i,
    /\(Y\)es\s*\/\s*\(N\)o/i,
    /waiting\s+for\s+(?:your\s+)?input/i,
    /Allow\s+(?:Read|Write|Edit|Bash|Execute|NotebookEdit|WebFetch|WebSearch|Agent|LSP|Monitor)\b/i,
    /\bPermission\s+(?:required|needed)\b/i,
    /press\s+.*\s+to\s+(?:allow|approve|confirm)/i,
];

// done = finished, waiting for the user (orange). Legacy boxed prompt + modern
// Claude Code footer, matched whitespace-flexibly (\s*) so the cursor-positioned,
// space-collapsed status line ("bypasspermissionson") still registers — else a
// waiting agent falls through to the idle shell-prompt and shows blue.
const DONE = [
    /╭─+╮/,
    /│\s*>\s*│/,
    /╰─+╯/,
    /│\s*>\s*$/m,
    /bypass\s*permissions\s*on/i,
    /accept\s*edits\s*on/i,
    /plan\s*mode\s*on/i,
    /shift\s*\+?\s*tab\s*to\s*cycle/i,
    /⏵⏵/,
];

const SHELL_PROMPT = /(?:^|\n)[^\n]{0,80}?(?:[➜❯▶►»](?:\s|$)|[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+[^\n]*[$#%]\s*$)/m;

// Strip ANSI so the patterns match plain text.
function strip(s) {
    return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')
            .replace(/\x1b[()][AB012]/g, '');
}

export function classifyAgent(recent, current) {
    const tail = strip(recent).slice(-600);
    if (WORKING.some(p => p.test(tail)))   return 'working';
    if (ATTENTION.some(p => p.test(tail))) return 'attention';
    if (DONE.some(p => p.test(tail)))      return 'done';
    if (SHELL_PROMPT.test(tail.slice(-200))) {
        return (current && current !== 'idle') ? 'idle' : null;
    }
    return null;
}

// Map detector status → the data-status values the mobile CSS already styles
// (green / orange / muted / blue).
export function cssStatus(status) {
    return { working: 'running', attention: 'input', done: 'completed', idle: 'idle' }[status] || null;
}
