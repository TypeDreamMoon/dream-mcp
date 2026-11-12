/** Wire shapes of the plugin endpoint protocol (protocol 1). See docs/protocol.md. */

export type Outcome = 'ok' | 'source-error' | 'refused' | 'engine-error';
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export const TERMINAL_STATES: readonly JobState[] = ['done', 'failed', 'cancelled'];

export interface Diagnostic {
    code?: string;
    severity?: 'error' | 'warning' | 'info' | string;
    file?: string;
    line?: number;
    column?: number;
    message: string;
    hint?: string;
    doc?: string;
}

export interface WriteRecord {
    asset: string;
    state: 'memory' | 'saved' | 'created' | 'deleted' | string;
}

export interface ArtifactRecord {
    kind: 'image' | string;
    path: string;
    title?: string;
}

export interface ResultBody {
    ok: boolean;
    outcome: Outcome;
    reason: string | null;
    summary: string;
    diagnostics: Diagnostic[];
    writes: WriteRecord[];
    artifacts: ArtifactRecord[];
    data: Record<string, unknown>;
    next: string[];
    /**
     * Optional (protocol 1 extension): a pre-formatted, multi-line plain-text block for the
     * model, shown verbatim after the summary. Endpoints that do not send it are valid.
     */
    text?: string;
}

export interface Discovery {
    protocol: number;
    id: string;
    pid: number;
    port: number;
    token: string;
    route: string;
    ws: string | null;
    mode: 'editor' | 'host';
    render: boolean;
    engine?: string;
    plugin?: string;
    startedAt?: string;
}

export interface Hello {
    protocol: number;
    id: string;
    plugin?: string;
    engine?: string;
    mode: 'editor' | 'host';
    render: boolean;
    busy: boolean;
    ws: string | null;
    actions: string[];
}

/** `progress` is either a fraction in [0, 1] or `{ current, total?, message? }`. */
export type Progress = number | { current?: number; total?: number; message?: string };

export interface JobStatus {
    state: JobState;
    progress?: Progress;
    result?: ResultBody;
}

export interface CancelReply {
    cancelled: boolean;
    state?: JobState;
}

const OUTCOMES: readonly string[] = ['ok', 'source-error', 'refused', 'engine-error'];

/** Fill in what an endpoint left out, so callers can rely on the full shape. */
export function normalizeResult(raw: unknown): ResultBody {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<ResultBody>;
    const outcome = (OUTCOMES.includes(r.outcome as string) ? r.outcome : r.ok === true ? 'ok' : 'engine-error') as Outcome;
    const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    return {
        ok: typeof r.ok === 'boolean' ? r.ok : outcome === 'ok',
        outcome,
        reason: typeof r.reason === 'string' ? r.reason : null,
        summary: typeof r.summary === 'string' ? r.summary : '',
        diagnostics: arr<Diagnostic>(r.diagnostics).filter(d => d && typeof d.message === 'string'),
        writes: arr<WriteRecord>(r.writes),
        artifacts: arr<ArtifactRecord>(r.artifacts).filter(a => a && typeof a.path === 'string'),
        data: typeof r.data === 'object' && r.data !== null && !Array.isArray(r.data) ? r.data : {},
        next: arr<string>(r.next).filter(s => typeof s === 'string'),
        ...(typeof r.text === 'string' && r.text.length ? { text: r.text } : {}),
    };
}

/** Build a result the server itself produces (refusals, offline actions, errors). */
export function makeResult(outcome: Outcome, summary: string, extra: Partial<ResultBody> = {}): ResultBody {
    return normalizeResult({ ok: outcome === 'ok', outcome, reason: null, summary, ...extra });
}

export function refused(reason: string, summary: string, next: string[] = [], data: Record<string, unknown> = {}): ResultBody {
    return makeResult('refused', summary, { reason, next, data });
}

export function isDiscovery(v: unknown): v is Discovery {
    const d = v as Discovery;
    return (
        typeof d === 'object' &&
        d !== null &&
        typeof d.id === 'string' &&
        typeof d.pid === 'number' &&
        typeof d.port === 'number' &&
        typeof d.token === 'string' &&
        typeof d.route === 'string'
    );
}
