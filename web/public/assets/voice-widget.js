/**
 * Voice Control Widget for SoA Sidebar
 * Integrates VoiceControl class with the dashboard
 */

import { t as tr } from '/assets/i18n.js?v=28';

const $el = (tag, props = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') n.className = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (v != null) n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
};

/**
 * Mount the voice control widget
 */
export function mount(parent, ctx) {
    const widget = $el('section', { class: 'widget widget-voice' });

    const header = $el('header', { class: 'widget-head' }, [
        $el('h3', { class: 'widget-title', text: '🎤 Voice Control' }),
        $el('button', {
            class: 'widget-toggle',
            type: 'button',
            'aria-label': 'Toggle voice control',
            title: 'Toggle voice control'
        })
    ]);

    const body = $el('div', { class: 'widget-body' });

    // Status indicator
    const status = $el('div', { class: 'voice-status' }, [
        $el('div', { class: 'voice-indicator voice-indicator--off' }),
        $el('span', { class: 'voice-status-text', text: 'Off' })
    ]);

    // Controls
    const controls = $el('div', { class: 'voice-controls' }, [
        $el('button', {
            class: 'voice-btn voice-btn--start',
            type: 'button',
            text: 'Start Listening'
        }),
        $el('button', {
            class: 'voice-btn voice-btn--stop',
            type: 'button',
            text: 'Stop',
            style: 'display: none;'
        })
    ]);

    // Settings
    const settings = $el('details', { class: 'voice-settings' }, [
        $el('summary', { text: 'Settings' }),
        $el('div', { class: 'voice-settings-body' }, [
            $el('label', { class: 'voice-setting' }, [
                $el('span', { text: 'Verbosity' }),
                $el('select', { class: 'voice-verbosity' }, [
                    $el('option', { value: 'brief', text: 'Brief' }),
                    $el('option', { value: 'detailed', text: 'Detailed' })
                ])
            ]),
            $el('label', { class: 'voice-setting' }, [
                $el('span', { text: 'Speech Rate' }),
                $el('input', {
                    type: 'range',
                    class: 'voice-rate',
                    min: '0.5',
                    max: '2.0',
                    step: '0.1',
                    value: '1.0'
                }),
                $el('span', { class: 'voice-rate-value', text: '1.0x' })
            ])
        ])
    ]);

    // Transcript/feedback
    const transcript = $el('div', { class: 'voice-transcript' }, [
        $el('small', { text: 'Last command will appear here' })
    ]);

    body.appendChild(status);
    body.appendChild(controls);
    body.appendChild(settings);
    body.appendChild(transcript);
    widget.appendChild(header);
    widget.appendChild(body);
    parent.appendChild(widget);

    // Initialize voice control
    const voice = new VoiceControl();

    const startBtn = controls.querySelector('.voice-btn--start');
    const stopBtn = controls.querySelector('.voice-btn--stop');
    const indicator = status.querySelector('.voice-indicator');
    const statusText = status.querySelector('.voice-status-text');
    const transcriptEl = transcript.querySelector('small');
    const verbositySelect = settings.querySelector('.voice-verbosity');
    const rateInput = settings.querySelector('.voice-rate');
    const rateValue = settings.querySelector('.voice-rate-value');

    // Load saved settings
    verbositySelect.value = voice.verbosity;
    rateInput.value = voice.settings.rate;
    rateValue.textContent = `${voice.settings.rate}x`;

    // Event handlers
    startBtn.addEventListener('click', () => {
        if (voice.start()) {
            startBtn.style.display = 'none';
            stopBtn.style.display = 'block';
            indicator.className = 'voice-indicator voice-indicator--listening';
            statusText.textContent = 'Listening...';
            transcriptEl.textContent = 'Speak a command';
        }
    });

    stopBtn.addEventListener('click', () => {
        voice.stop();
        stopBtn.style.display = 'none';
        startBtn.style.display = 'block';
        indicator.className = 'voice-indicator voice-indicator--off';
        statusText.textContent = 'Off';
        transcriptEl.textContent = 'Voice control stopped';
    });

    verbositySelect.addEventListener('change', () => {
        voice.setVerbosity(verbositySelect.value);
    });

    rateInput.addEventListener('input', () => {
        const rate = parseFloat(rateInput.value);
        voice.setRate(rate);
        rateValue.textContent = `${rate.toFixed(1)}x`;
    });

    // Voice control callbacks
    voice.onStatusChange = (s) => {
        if (s.speaking) {
            indicator.className = 'voice-indicator voice-indicator--speaking';
            statusText.textContent = 'Speaking...';
        } else if (s.listening) {
            indicator.className = 'voice-indicator voice-indicator--listening';
            statusText.textContent = 'Listening...';
        } else if (s.enabled) {
            indicator.className = 'voice-indicator voice-indicator--ready';
            statusText.textContent = 'Ready';
        }
    };

    voice.onCommand = (intent, params) => {
        transcriptEl.textContent = `Command: ${intent}`;
        handleVoiceCommand(intent, params, voice, ctx);
    };

    voice.onError = (err) => {
        transcriptEl.textContent = `Error: ${err.message || err.error}`;
        console.error('[Voice Widget]', err);
    };

    return {
        destroy() {
            voice.stop();
            widget.remove();
        }
    };
}

/**
 * Handle voice commands by interacting with the terminal
 */
function handleVoiceCommand(intent, params, voice, ctx) {
    const bridge = ctx.bridge;
    const activeTab = ctx.getActiveTab ? ctx.getActiveTab() : null;

    switch (intent) {
        case 'read_output': {
            if (!activeTab) {
                voice.speak('No active terminal.');
                return;
            }
            const output = getTerminalOutput(activeTab, params.lines);
            const formatted = SpeechUtils.formatForSpeech(output, voice.verbosity);
            voice.speak(formatted);
            break;
        }

        case 'check_status': {
            if (!activeTab) {
                voice.speak('No active terminal.');
                return;
            }
            const output = getTerminalOutput(activeTab, 10);
            if (/error|failed|fatal/i.test(output)) {
                voice.speak('There are errors in the terminal.');
            } else if (/working|processing|running/i.test(output)) {
                voice.speak('The terminal is working.');
            } else {
                voice.speak('The terminal appears idle.');
            }
            break;
        }

        case 'check_progress': {
            if (!activeTab) {
                voice.speak('No active terminal.');
                return;
            }
            const output = getTerminalOutput(activeTab, 5);
            if (/done|complete|finished/i.test(output)) {
                voice.speak('Task is complete.');
            } else if (/\d+%/.test(output)) {
                const match = output.match(/(\d+)%/);
                voice.speak(`Progress: ${match[1]} percent`);
            } else {
                voice.speak('Still working on it.');
            }
            break;
        }

        case 'switch_tab': {
            if (ctx.switchToTab) {
                ctx.switchToTab(params.tabId);
                voice.speak(`Switched to tab ${params.tabId}.`);
            }
            break;
        }

        case 'next_tab': {
            if (ctx.nextTab) {
                ctx.nextTab();
                voice.speak('Next tab.');
            }
            break;
        }

        case 'prev_tab': {
            if (ctx.prevTab) {
                ctx.prevTab();
                voice.speak('Previous tab.');
            }
            break;
        }

        case 'type_text': {
            if (activeTab && bridge) {
                bridge.send({ kind: 'TERM_INPUT', id: activeTab.id, data: params.text });
                voice.speak('Typed.');
            }
            break;
        }

        case 'run_command': {
            if (activeTab && bridge) {
                bridge.send({ kind: 'TERM_INPUT', id: activeTab.id, data: params.command + '\r' });
                voice.speak(`Running ${params.command}.`);
            }
            break;
        }

        case 'send_key': {
            if (activeTab && bridge) {
                const keymap = { enter: '\r', tab: '\t', escape: '\x1b' };
                const key = keymap[params.key] || params.key;
                bridge.send({ kind: 'TERM_INPUT', id: activeTab.id, data: key });
                voice.speak('Sent.');
            }
            break;
        }

        case 'interrupt': {
            if (activeTab && bridge) {
                bridge.send({ kind: 'TERM_INPUT', id: activeTab.id, data: '\x03' });
                voice.speak('Interrupted.');
            }
            break;
        }

        case 'clear_screen': {
            if (activeTab && bridge) {
                bridge.send({ kind: 'TERM_INPUT', id: activeTab.id, data: 'clear\r' });
                voice.speak('Screen cleared.');
            }
            break;
        }

        case 'continue_session': {
            if (activeTab && bridge) {
                bridge.send({ kind: 'TERM_INPUT', id: activeTab.id, data: 'continue\r' });
                voice.speak('Continuing session.');
            }
            break;
        }

        case 'scroll': {
            if (activeTab && activeTab.term) {
                const amount = params.amount || 10;
                if (params.direction === 'up') {
                    activeTab.term.scrollLines(-amount);
                } else {
                    activeTab.term.scrollLines(amount);
                }
                voice.speak(`Scrolled ${params.direction}.`);
            }
            break;
        }

        case 'help': {
            voice.speak(SpeechUtils.getHelpText());
            break;
        }

        default:
            voice.speak("I don't know how to do that yet.");
    }
}

/**
 * Extract terminal output from active tab
 */
function getTerminalOutput(tab, lines = 20) {
    if (!tab || !tab.term) return '';

    const buffer = tab.term.buffer.active;
    const endLine = buffer.baseY + buffer.cursorY;
    const startLine = Math.max(0, endLine - lines);

    let text = '';
    for (let i = startLine; i <= endLine; i++) {
        const line = buffer.getLine(i);
        if (line) {
            text += line.translateToString(true) + '\n';
        }
    }

    return text;
}
