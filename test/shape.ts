/** Strict checks of the wire shapes, shared by the fake-endpoint tests and the contract tests. */

const OUTCOMES = ['ok', 'source-error', 'refused', 'engine-error'];
const STATES = ['queued', 'running', 'done', 'failed', 'cancelled'];
const WRITE_STATES = ['memory', 'saved', 'created', 'deleted'];

const isAbs = (p: string) => /^[a-zA-Z]:/.test(p) || p.startsWith('/') || p.startsWith('\\\\');

/** Problems with a result body; empty when it follows the protocol exactly. */
export function resultProblems(body: unknown): string[] {
    const out: string[] = [];
    const r = body as Record<string, unknown>;
    if (typeof r !== 'object' || r === null) return ['result is not an object'];
    if (typeof r.ok !== 'boolean') out.push('ok must be a boolean');
    if (!OUTCOMES.includes(r.outcome as string)) out.push(`outcome must be one of ${OUTCOMES.join('/')}`);
    if (r.ok === true && r.outcome !== 'ok') out.push('ok is true but outcome is not "ok"');
    if (!(r.reason === null || typeof r.reason === 'string')) out.push('reason must be a string or null');
    if (r.outcome === 'refused' && typeof r.reason !== 'string') out.push('a refusal needs a machine-readable reason');
    if (typeof r.summary !== 'string' || !r.summary) out.push('summary must be a non-empty string');
    for (const k of ['diagnostics', 'writes', 'artifacts', 'next']) if (!Array.isArray(r[k])) out.push(`${k} must be an array`);
    if (typeof r.data !== 'object' || r.data === null || Array.isArray(r.data)) out.push('data must be an object');
    for (const d of (r.diagnostics as Record<string, unknown>[]) ?? []) {
        if (typeof d.message !== 'string') out.push('diagnostic without message');
        if (typeof d.file === 'string' && (isAbs(d.file) || d.file.includes('\\'))) out.push(`diagnostic file "${d.file}" must be project-relative with forward slashes`);
        if (d.line !== undefined && typeof d.line !== 'number') out.push('diagnostic line must be a number');
    }
    for (const w of (r.writes as Record<string, unknown>[]) ?? []) {
        if (typeof w.asset !== 'string') out.push('write without asset');
        if (!WRITE_STATES.includes(w.state as string)) out.push(`write state "${String(w.state)}" is not one of ${WRITE_STATES.join('/')}`);
    }
    for (const a of (r.artifacts as Record<string, unknown>[]) ?? []) {
        if (typeof a.path !== 'string' || isAbs(a.path) || a.path.includes('\\')) out.push(`artifact path "${String(a.path)}" must be project-relative with forward slashes`);
        if (typeof a.kind !== 'string') out.push('artifact without kind');
    }
    for (const n of (r.next as unknown[]) ?? []) if (typeof n !== 'string') out.push('next entries must be strings');
    return out;
}

export function helloProblems(h: unknown, id: string): string[] {
    const out: string[] = [];
    const x = h as Record<string, unknown>;
    if (x?.protocol !== 1) out.push('hello.protocol must be 1');
    if (x?.id !== id) out.push(`hello.id must be "${id}"`);
    if (x?.mode !== 'editor' && x?.mode !== 'host') out.push('hello.mode must be editor or host');
    if (typeof x?.render !== 'boolean') out.push('hello.render must be a boolean');
    if (typeof x?.busy !== 'boolean') out.push('hello.busy must be a boolean');
    if (!(x?.ws === null || (typeof x?.ws === 'string' && /^ws:\/\/127\.0\.0\.1:\d+/.test(x.ws)))) out.push('hello.ws must be null or ws://127.0.0.1:<port>');
    if (!Array.isArray(x?.actions)) out.push('hello.actions must be an array of names');
    return out;
}

export function discoveryProblems(d: unknown, id: string, route: string): string[] {
    const out: string[] = [];
    const x = d as Record<string, unknown>;
    if (x?.protocol !== 1) out.push('protocol must be 1');
    if (x?.id !== id) out.push(`id must be "${id}"`);
    if (x?.route !== route) out.push(`route must be "${route}" (the manifest route)`);
    for (const k of ['pid', 'port']) if (typeof x?.[k] !== 'number') out.push(`${k} must be a number`);
    if (typeof x?.token !== 'string' || !(x.token as string).length) out.push('token must be a non-empty string');
    if (x?.mode !== 'editor' && x?.mode !== 'host') out.push('mode must be editor or host');
    if (typeof x?.render !== 'boolean') out.push('render must be a boolean');
    if (!(x?.ws === null || typeof x?.ws === 'string')) out.push('ws must be a string or null');
    if (typeof x?.startedAt !== 'string' || Number.isNaN(Date.parse(x.startedAt as string))) out.push('startedAt must be an ISO time');
    return out;
}

export function jobProblems(j: unknown): string[] {
    const x = j as Record<string, unknown>;
    const out: string[] = [];
    if (!STATES.includes(x?.state as string)) out.push(`job state must be one of ${STATES.join('/')}`);
    if (x?.result !== undefined) out.push(...resultProblems(x.result).map(p => `job result: ${p}`));
    return out;
}
