import http from 'node:http';
import WebSocket from 'ws';
import { PROTOCOL } from '../config.js';
import { sleep } from '../util/fs.js';
import { normalizeResult, TERMINAL_STATES, type CancelReply, type Hello, type JobStatus, type Progress, type ResultBody } from './types.js';

export interface Endpoint {
    id: string;
    port: number;
    token: string;
    route: string;
    ws: string | null;
    pid: number;
    mode: 'editor' | 'host';
    render: boolean;
}

export type EndpointErrorKind = 'unreachable' | 'timeout' | 'unauthorized' | 'forbidden' | 'bad-response' | 'aborted';

export class EndpointError extends Error {
    constructor(
        readonly kind: EndpointErrorKind,
        message: string,
        readonly status?: number,
    ) {
        super(message);
    }
}

interface RawReply {
    status: number;
    body: unknown;
}

export type CallReply = { kind: 'result'; status: number; result: ResultBody } | { kind: 'job'; job: string };

/** HTTP client for one plugin's routes. Uses node:http so no browser-style headers (Origin) are ever sent. */
export class EndpointClient {
    constructor(
        readonly ep: Endpoint,
        private readonly timeouts: { helloMs: number; callMs: number; pollMs: number },
    ) {}

    request(method: 'GET' | 'POST', sub: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<RawReply> {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(new EndpointError('aborted', 'the request was cancelled'));
            const { port, route } = this.ep;
            const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port: this.ep.port,
                    method,
                    path: this.ep.route + sub,
                    headers: {
                        'X-Dream-Token': this.ep.token,
                        Accept: 'application/json',
                        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
                    },
                    agent: false,
                },
                res => {
                    const chunks: Buffer[] = [];
                    res.on('data', c => chunks.push(c as Buffer));
                    res.on('end', () => {
                        cleanup();
                        const text = Buffer.concat(chunks).toString('utf8');
                        let parsed: unknown;
                        if (text.trim()) {
                            try {
                                parsed = JSON.parse(text);
                            } catch {
                                return reject(new EndpointError('bad-response', `${method} ${sub} returned non-JSON (HTTP ${res.statusCode})`, res.statusCode));
                            }
                        }
                        resolve({ status: res.statusCode ?? 0, body: parsed });
                    });
                    res.on('error', fail);
                },
            );
            const timer = setTimeout(() => {
                req.destroy();
                reject(new EndpointError('timeout', `${method} ${sub} got no answer in ${Math.round(timeoutMs / 1000)} s`));
            }, timeoutMs);
            const onAbort = () => {
                req.destroy();
                reject(new EndpointError('aborted', 'the request was cancelled'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            function cleanup() {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
            }
            function fail(error: Error) {
                cleanup();
                const code = (error as NodeJS.ErrnoException).code;
                reject(new EndpointError('unreachable', `cannot reach 127.0.0.1:${port}${route}${sub}: ${code ?? error.message}`));
            }
            req.on('error', fail);
            if (payload) req.write(payload);
            req.end();
        });
    }

    private check(reply: RawReply, what: string): void {
        if (reply.status === 401) throw new EndpointError('unauthorized', `${what}: the endpoint rejected the token (401)`, 401);
        if (reply.status === 403) throw new EndpointError('forbidden', `${what}: the endpoint refused the request (403)`, 403);
    }

    async hello(): Promise<Hello> {
        const reply = await this.request('GET', '/hello', undefined, this.timeouts.helloMs);
        this.check(reply, 'hello');
        const h = reply.body as Hello;
        if (reply.status !== 200 || typeof h !== 'object' || h === null || typeof h.protocol !== 'number')
            throw new EndpointError('bad-response', `hello returned HTTP ${reply.status} without a protocol number`, reply.status);
        return { ...h, actions: Array.isArray(h.actions) ? h.actions : [], ws: h.ws ?? null, busy: !!h.busy, render: !!h.render };
    }

    async call(id: string, action: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallReply> {
        const reply = await this.request('POST', '/call', { id, action, args }, this.timeouts.callMs, signal);
        this.check(reply, action);
        if (reply.status === 202) {
            const job = (reply.body as { job?: unknown })?.job;
            if (typeof job !== 'string' || !job) throw new EndpointError('bad-response', `${action}: 202 without a job id`, 202);
            return { kind: 'job', job };
        }
        if (typeof reply.body !== 'object' || reply.body === null)
            throw new EndpointError('bad-response', `${action}: HTTP ${reply.status} without a result body`, reply.status);
        return { kind: 'result', status: reply.status, result: normalizeResult(reply.body) };
    }

    async job(job: string, signal?: AbortSignal): Promise<JobStatus> {
        const reply = await this.request('GET', `/jobs/${encodeURIComponent(job)}`, undefined, this.timeouts.callMs, signal);
        this.check(reply, 'jobs');
        const body = reply.body as JobStatus;
        if (reply.status !== 200 || typeof body?.state !== 'string') throw new EndpointError('bad-response', `job ${job}: HTTP ${reply.status}`, reply.status);
        return { state: body.state, ...(body.progress !== undefined ? { progress: body.progress } : {}), ...(body.result ? { result: normalizeResult(body.result) } : {}) };
    }

    async cancel(job: string): Promise<CancelReply> {
        const reply = await this.request('POST', `/jobs/${encodeURIComponent(job)}/cancel`, {}, this.timeouts.callMs);
        this.check(reply, 'cancel');
        const body = (reply.body ?? {}) as CancelReply;
        return { cancelled: body.cancelled === true, ...(body.state ? { state: body.state } : {}) };
    }

    async shutdown(): Promise<boolean> {
        try {
            const reply = await this.request('POST', '/shutdown', {}, this.timeouts.helloMs);
            return reply.status >= 200 && reply.status < 300;
        } catch {
            return false;
        }
    }

    /**
     * Wait for a job to finish. Listens on the WebSocket when the endpoint has one and
     * keeps a slow poll running beside it (a push can be missed between `202` and the
     * subscription); without a socket it polls every `pollMs`. Either way the final
     * state comes from `GET jobs/<job>` unless the push carried the result itself.
     */
    async waitJob(
        job: string,
        opts: { deadlineMs: number; signal?: AbortSignal; onProgress?: (p: Progress, state: string) => void },
    ): Promise<{ status: JobStatus; timedOut: boolean; via: 'ws' | 'poll' }> {
        const deadline = Date.now() + opts.deadlineMs;
        let latest: JobStatus | undefined;
        let wake: (() => void) | undefined;
        const nudge = () => wake?.();
        const socket = this.ep.ws ? await openJobSocket(this.ep.ws, this.ep.token, job, s => {
            latest = s;
            if (s.progress !== undefined) opts.onProgress?.(s.progress, s.state);
            nudge();
        }) : undefined;
        const via = socket ? 'ws' : 'poll';
        const interval = socket ? Math.max(2000, this.timeouts.pollMs) : this.timeouts.pollMs;
        let lastProgress = '';
        try {
            for (;;) {
                if (opts.signal?.aborted) throw new EndpointError('aborted', 'the request was cancelled');
                if (latest && TERMINAL_STATES.includes(latest.state)) {
                    if (latest.result) return { status: latest, timedOut: false, via };
                    return { status: await this.job(job), timedOut: false, via };
                }
                const polled = await this.job(job, opts.signal);
                if (TERMINAL_STATES.includes(polled.state)) return { status: polled, timedOut: false, via };
                const key = JSON.stringify(polled.progress ?? null);
                if (!socket && polled.progress !== undefined && key !== lastProgress) opts.onProgress?.(polled.progress, polled.state);
                lastProgress = key;
                latest = latest && TERMINAL_STATES.includes(latest.state) ? latest : polled;
                if (Date.now() >= deadline) return { status: polled, timedOut: true, via };
                await new Promise<void>(resolve => {
                    const t = setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now())));
                    wake = () => {
                        clearTimeout(t);
                        resolve();
                    };
                    opts.signal?.addEventListener('abort', () => wake?.(), { once: true });
                });
                wake = undefined;
            }
        } finally {
            socket?.close();
        }
    }
}

/** Open the endpoint's WebSocket, authenticate, and forward `job` messages for one job. Resolves undefined when it cannot connect. */
function openJobSocket(url: string, token: string, job: string, onJob: (s: JobStatus) => void): Promise<WebSocket | undefined> {
    return new Promise(resolve => {
        let settled = false;
        const done = (ws: WebSocket | undefined) => {
            if (!settled) {
                settled = true;
                resolve(ws);
            }
        };
        let ws: WebSocket;
        try {
            ws = new WebSocket(url, { handshakeTimeout: 2000 });
        } catch {
            return done(undefined);
        }
        const timer = setTimeout(() => {
            ws.terminate();
            done(undefined);
        }, 2500);
        ws.on('open', () => {
            clearTimeout(timer);
            ws.send(JSON.stringify({ type: 'auth', token }));
            done(ws);
        });
        ws.on('message', data => {
            try {
                const msg = JSON.parse(data.toString()) as { type?: string; job?: string; state?: string; progress?: Progress; result?: unknown };
                if (msg.type === 'job' && msg.job === job && typeof msg.state === 'string')
                    onJob({
                        state: msg.state as JobStatus['state'],
                        ...(msg.progress !== undefined ? { progress: msg.progress } : {}),
                        ...(msg.result ? { result: normalizeResult(msg.result) } : {}),
                    });
            } catch {
                /* not ours to interpret */
            }
        });
        ws.on('error', () => {
            clearTimeout(timer);
            done(undefined);
        });
    });
}

/** Wait until `hello` answers with the right protocol, or the deadline passes. */
export async function waitForHello(client: EndpointClient, deadlineMs: number, alive: () => boolean): Promise<Hello | undefined> {
    const end = Date.now() + deadlineMs;
    while (Date.now() < end && alive()) {
        try {
            const h = await client.hello();
            if (h.protocol === PROTOCOL) return h;
        } catch {
            /* still starting */
        }
        await sleep(250);
    }
    return undefined;
}
