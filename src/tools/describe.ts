import type { ActionSpec, JsonPropertySchema, Manifest } from '../manifest.js';

function typeOf(p: JsonPropertySchema): string {
    if (Array.isArray(p.enum) && p.enum.length && p.enum.length <= 8) return p.enum.map(v => String(v)).join('|');
    if (Array.isArray(p.type)) return p.type.join('|');
    if (p.type === 'array') {
        const items = p.items as JsonPropertySchema | undefined;
        return `${items?.type ?? 'any'}[]`;
    }
    return p.type ?? 'any';
}

/** `file*: string, save?: boolean` */
export function argSignature(a: ActionSpec): string {
    const props = a.args.properties ?? {};
    const required = new Set(a.args.required ?? []);
    return Object.entries(props)
        .map(([k, p]) => `${k}${required.has(k) ? '*' : '?'}: ${typeOf(p)}`)
        .join(', ');
}

export function tags(a: ActionSpec): string {
    const t: string[] = [];
    if (a.needs === 'none') t.push('offline');
    if (a.needs === 'render') t.push('renders');
    if (a.writes) t.push('writes');
    return t.length ? ` [${t.join(', ')}]` : '';
}

export function actionLine(a: ActionSpec): string {
    return `- ${a.name}(${argSignature(a)}): ${a.description}${tags(a)}`;
}

/** The tool description: what the plugin is, then one line per action, so a model can call it without `help`. */
export function describePluginTool(m: Manifest): string {
    // Most descriptions already start with the plugin name; do not say it twice.
    const desc = m.description.trim();
    const lines = [desc.toLowerCase().startsWith(m.title.toLowerCase()) ? desc : `${m.title}: ${desc}`];
    if (m.sourceRoots.length || m.extensions.length) {
        const roots = m.sourceRoots.length ? m.sourceRoots.map(r => r.replace(/\/?$/, '/')).join(', ') : 'the project';
        lines.push(`Sources live under ${roots}${m.extensions.length ? ` (${m.extensions.join(', ')})` : ''}.`);
    }
    lines.push('Call with {"action": "<name>", "args": {...}}. Paths are relative to the project root. * = required.');
    lines.push('Actions:');
    for (const a of m.actions) lines.push(actionLine(a));
    lines.push('- help(action?: string): list actions and their full arguments.');
    if (m.reference.length) lines.push(`- reference(doc?: string, offset?: integer, limit?: integer): list or read the docs (${m.reference.map(r => r.title).join('; ')}).`);
    else lines.push('- reference(): list the reference docs (none declared).');
    lines.push('Tags: offline = answered from files, no engine; renders = needs a rendering engine; writes = changes assets.');
    return lines.join('\n');
}

export function helpText(m: Manifest, action?: string): string {
    if (action) {
        const a = m.actions.find(x => x.name === action);
        if (!a) return `Unknown action "${action}". Actions: ${m.actions.map(x => x.name).join(', ')}, help, reference.`;
        const props = a.args.properties ?? {};
        const required = new Set(a.args.required ?? []);
        const lines = [`${a.name}: ${a.description}`, `needs: ${a.needs}; writes assets: ${a.writes ? 'yes' : 'no'}${a.long ? '; runs as a job (the call still waits for the result)' : ''}`];
        if (!Object.keys(props).length) lines.push('No arguments.');
        else {
            lines.push('Arguments:');
            for (const [k, p] of Object.entries(props)) {
                const extra = [p.default !== undefined ? `default ${JSON.stringify(p.default)}` : '', Array.isArray(p.enum) ? `one of ${p.enum.map(v => JSON.stringify(v)).join(', ')}` : '']
                    .filter(Boolean)
                    .join('; ');
                lines.push(`  ${k} (${typeOf(p)}${required.has(k) ? ', required' : ''}): ${p.description ?? ''}${extra ? ` [${extra}]` : ''}`);
            }
        }
        lines.push(`Example: {"action": "${a.name}", "args": ${JSON.stringify(exampleArgs(a))}}`);
        return lines.join('\n');
    }
    return describePluginTool(m);
}

function exampleArgs(a: ActionSpec): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const props = a.args.properties ?? {};
    for (const k of a.args.required ?? []) {
        const p = props[k] ?? {};
        out[k] = Array.isArray(p.enum) && p.enum.length ? p.enum[0] : p.type === 'boolean' ? true : p.type === 'integer' || p.type === 'number' ? 1 : p.type === 'array' ? [] : `<${k}>`;
    }
    return out;
}
