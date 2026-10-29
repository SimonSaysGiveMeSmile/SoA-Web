// Shared by the desktop tabs and mobile fleet. Older daemons may still attach
// Claude metadata to Codex tabs; never let that paint a false model/effort badge.
export function sessionMetadata(row = {}, knownAgent = null) {
    const raw = typeof row.model === 'string' ? row.model : '';
    const agent = ['claude', 'codex'].includes(row.agent) ? row.agent
        : ['claude', 'codex'].includes(knownAgent) ? knownAgent
        : /^claude[-.]/i.test(raw) ? 'claude'
        : /^(?:gpt-|codex|o[134](?:-|$))/i.test(raw) ? 'codex' : null;
    const model = agent === 'codex' ? (/^claude[-.]/i.test(raw) ? null : raw || null)
        : agent === 'claude' && /^claude[-.]/i.test(raw) ? raw : null;
    const effort = typeof row.effort === 'string' &&
        /^(?:none|minimal|low|medium|high|xhigh|max|ultra|ultracode)$/.test(row.effort) &&
        (agent !== 'codex' || row.modelSource === 'codex-thread') ? row.effort : null;
    return { agent, model, effort };
}

export function modelBadge(row = {}, knownAgent = null) {
    const { agent, model } = sessionMetadata(row, knownAgent);
    if (!agent) return null;
    const match = agent === 'claude' && model?.match(/(?:opus|sonnet|haiku|fable|mythos)/i);
    const tier = agent === 'codex' ? 'codex' : match ? match[0].toLowerCase().replace('mythos', 'fable') : 'other';
    return {
        agent, tier,
        label: agent === 'codex' ? 'Codex' : match ? tier : 'Claude',
        title: (agent === 'codex' ? 'Codex' : 'Claude') + ' · ' + (model || 'Model not reported'),
    };
}
