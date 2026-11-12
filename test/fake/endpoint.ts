/**
 * A fake plugin endpoint that implements the endpoint protocol (docs/protocol.md) the way
 * an engine plugin must: loopback only, token on every request, Origin refused, short and
 * long actions, job polling, cancel, refusals with a result body, optional WebSocket push,
 * and a discovery file per plugin. Several plugins share one port, each on its own route.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

export type Json = Record<string, unknown>;

export interface FakeAction {
    name: string;
    needs?: string;
    writes?: boolean;
    long?: boolean;
    args?: { type: 'object'; properties?: Record<string, { type?: string }>; required?: string[] };
}

export interface FakeManifest {
    id: string;
    route: string;
    plugin?: string;
    actions: FakeAction[];
    [k: string]: unknown;
}

export interface JobControl {
    readonly id: string;
    readonly cancelled: boolean;
    progress(p: unknown): void;
}

export interface Behavior {
    /** Short actions: the result body. Long actions: run as a job, calling `job.progress` as it goes. */
    run(args: Json, ctx: { job?: JobControl; engine: FakeEngine; action: string }): Promise<Json> | Json;
    /** Long actions only: whether cancel works. Default true. */
    cancellable?: boolean;
}

export interface FakeEngineOptions {
    projectDir: string;
    mode: 'editor' | 'host';
    render: boolean;
    port?: number;
    token?: string;
    ws?: boolean;
    /** pid written to discovery files; defaults to this process. */
    pid?: number;
    /** Protocol number `hello` reports. */
    protocol?: number;
    /** `hello` never answers (a hung editor). */
    hang?: boolean;
    /** `startedAt` written to discovery files (default: now). */
    startedAt?: string;
    writeDiscovery?: boolean;
    onShutdown?: () => void;
}

interface Job {
    id: string;
    state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
    progress?: unknown;
    result?: Json;
    cancelRequested: boolean;
    cancellable: boolean;
}

export const result = (outcome: string, summary: string, extra: Json = {}): Json => ({
    ok: outcome === 'ok',
    outcome,
    reason: null,
    summary,
    diagnostics: [],
    writes: [],
    artifacts: [],
    data: {},
    next: [],
    ...extra,
});

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class FakeEngine {
    readonly token: string;
    port = 0;
    wsUrl: string | null = null;
    readonly plugins = new Map<string, { manifest: FakeManifest; behaviors: Record<string, Behavior> }>();
    readonly calls: { plugin: string; action: string; args: Json; id: string }[] = [];
    readonly jobs = new Map<string, Job>();
    readonly requests: { method: string; url: string; token?: string; origin?: string }[] = [];
    busy = 0;
    maxConcurrentWrites = 0;
    private writing = 0;
    private server?: http.Server;
    private wss?: WebSocketServer;
    private sockets = new Set<WebSocket>();

    constructor(readonly opts: FakeEngineOptions) {
        this.token = opts.token ?? randomBytes(16).toString('hex');
    }

    addPlugin(manifest: FakeManifest, behaviors: Record<string, Behavior> = {}): this {
        this.plugins.set(manifest.id, { manifest, behaviors });
        return this;
    }

    get pid(): number {
        return this.opts.pid ?? process.pid;
    }

    async start(): Promise<this> {
        this.server = http.createServer((req, res) => void this.handle(req, res));
        await new Promise<void>((resolve, reject) => {
            this.server!.once('error', reject);
            this.server!.listen(this.opts.port ?? 0, '127.0.0.1', () => resolve());
        });
        this.port = (this.server.address() as { port: number }).port;
        if (this.opts.ws) {
            this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
            await new Promise<void>(r => this.wss!.once('listening', () => r()));
            this.wsUrl = `ws://127.0.0.1:${(this.wss.address() as { port: number }).port}`;
            this.wss.on('connection', socket => {
                let authed = false;
                const t = setTimeout(() => !authed && socket.close(4401, 'auth required'), 5000);
                socket.on('message', data => {
                    try {
                        const msg = JSON.parse(data.toString()) as { type?: string; token?: string };
                        if (!authed && msg.type === 'auth' && msg.token === this.token) {
                            authed = true;
                            clearTimeout(t);
                            this.sockets.add(socket);
                        } else if (!authed) socket.close(4401, 'bad token');
                    } catch {
                        socket.close(4400, 'bad frame');
                    }
                });
                socket.on('close', () => this.sockets.delete(socket));
            });
        }
        if (this.opts.writeDiscovery !== false) await this.writeDiscovery();
        return this;
    }

    discoveryPath(id: string): string {
        return path.join(this.opts.projectDir, 'Saved', 'DreamMCP', `${id}.json`);
    }

    async writeDiscovery(): Promise<void> {
        await fs.mkdir(path.join(this.opts.projectDir, 'Saved', 'DreamMCP'), { recursive: true });
        for (const { manifest } of this.plugins.values()) {
            const body = {
                protocol: 1,
                id: manifest.id,
                pid: this.pid,
                port: this.port,
                token: this.token,
                route: manifest.route,
                ws: this.wsUrl,
                mode: this.opts.mode,
                render: this.opts.render,
                engine: '5.8.0',
                plugin: '1.0.0',
                startedAt: this.opts.startedAt ?? new Date().toISOString(),
            };
            await fs.writeFile(this.discoveryPath(manifest.id), JSON.stringify(body));
        }
    }

    /** Close listeners and delete only the discovery files that still name this process. */
    async stop(): Promise<void> {
        for (const s of this.sockets) s.terminate();
        await new Promise<void>(r => (this.wss ? this.wss.close(() => r()) : r()));
        await new Promise<void>(r => (this.server ? this.server.close(() => r()) : r()));
        this.server?.closeAllConnections?.();
        if (this.opts.writeDiscovery === false) return;
        for (const id of this.plugins.keys()) {
            try {
                const d = JSON.parse(await fs.readFile(this.discoveryPath(id), 'utf8')) as { pid?: number; port?: number };
                if (d.pid === this.pid && d.port === this.port) await fs.rm(this.discoveryPath(id), { force: true });
            } catch {
                /* already gone */
            }
        }
    }

    push(msg: Json): void {
        const text = JSON.stringify(msg);
        for (const s of this.sockets) s.send(text);
    }

    private send(res: http.ServerResponse, status: number, body?: unknown): void {
        const text = body === undefined ? '' : JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
    }

    private async body(req: http.IncomingMessage): Promise<Json | undefined> {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trim()) return {};
        try {
            return JSON.parse(text) as Json;
        } catch {
            return undefined;
        }
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = req.url ?? '';
        const token = req.headers['x-dream-token'] as string | undefined;
        const origin = req.headers.origin;
        this.requests.push({ method: req.method ?? '', url, ...(token ? { token } : {}), ...(origin ? { origin } : {}) });
        if (origin) return this.send(res, 403, result('refused', 'Browser requests are not accepted.', { reason: 'origin' }));
        if (token !== this.token) return this.send(res, 401, result('refused', 'Missing or wrong X-Dream-Token.', { reason: 'unauthorized' }));

        const plugin = [...this.plugins.values()].find(p => url === p.manifest.route || url.startsWith(p.manifest.route + '/'));
        if (!plugin) return this.send(res, 404, result('refused', `No route ${url}.`, { reason: 'unknown-route' }));
        const sub = url.slice(plugin.manifest.route.length);
        const m = plugin.manifest;

        if (req.method === 'GET' && sub === '/hello') {
            if (this.opts.hang) return; // never answer
            return this.send(res, 200, {
                protocol: this.opts.protocol ?? 1,
                id: m.id,
                plugin: '1.0.0',
                engine: '5.8.0',
                mode: this.opts.mode,
                render: this.opts.render,
                busy: this.busy > 0,
                ws: this.wsUrl,
                actions: m.actions.map(a => a.name),
            });
        }
        if (req.method === 'POST' && sub === '/shutdown') {
            if (this.opts.mode !== 'host') return this.send(res, 409, result('refused', 'Only a host process can be shut down.', { reason: 'not-host' }));
            this.send(res, 200, { ok: true });
            setTimeout(() => this.opts.onShutdown?.(), 10);
            return;
        }
        const jobMatch = /^\/jobs\/([^/]+)(\/cancel)?$/.exec(sub);
        if (jobMatch) {
            const job = this.jobs.get(decodeURIComponent(jobMatch[1]!));
            if (!job) return this.send(res, 404, result('refused', 'No such job.', { reason: 'unknown-job' }));
            if (jobMatch[2] && req.method === 'POST') {
                if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return this.send(res, 200, { cancelled: false, state: job.state });
                if (!job.cancellable) return this.send(res, 200, { cancelled: false, state: job.state });
                job.cancelRequested = true;
                this.setJob(job, 'cancelled', undefined, result('refused', 'Cancelled.', { reason: 'cancelled' }));
                return this.send(res, 200, { cancelled: true, state: 'cancelled' });
            }
            if (req.method === 'GET')
                return this.send(res, 200, { state: job.state, ...(job.progress !== undefined ? { progress: job.progress } : {}), ...(job.result ? { result: job.result } : {}) });
        }
        if (req.method === 'POST' && sub === '/call') {
            const body = await this.body(req);
            if (!body) return this.send(res, 400, result('refused', 'Body is not JSON.', { reason: 'bad-request' }));
            const action = m.actions.find(a => a.name === body.action);
            if (!action) return this.send(res, 404, result('refused', `Unknown action ${String(body.action)}.`, { reason: 'unknown-action' }));
            const args = (body.args ?? {}) as Json;
            for (const r of action.args?.required ?? []) if (args[r] === undefined) return this.send(res, 400, result('refused', `Missing argument ${r}.`, { reason: 'bad-args' }));
            this.calls.push({ plugin: m.id, action: action.name, args, id: String(body.id) });
            const behavior = plugin.behaviors[action.name] ?? defaultBehavior;
            if (!action.long) {
                const done = this.enterWrite(action);
                try {
                    return this.send(res, 200, await behavior.run(args, { engine: this, action: action.name }));
                } finally {
                    done();
                }
            }
            const job: Job = { id: `job-${randomBytes(6).toString('hex')}`, state: 'queued', cancelRequested: false, cancellable: behavior.cancellable !== false };
            this.jobs.set(job.id, job);
            this.send(res, 202, { id: body.id, job: job.id });
            void this.runJob(job, behavior, action, args);
            return;
        }
        return this.send(res, 404, result('refused', `No route ${req.method} ${url}.`, { reason: 'unknown-route' }));
    }

    private enterWrite(action: FakeAction): () => void {
        this.busy++;
        if (action.writes) {
            this.writing++;
            this.maxConcurrentWrites = Math.max(this.maxConcurrentWrites, this.writing);
        }
        return () => {
            this.busy--;
            if (action.writes) this.writing--;
        };
    }

    private setJob(job: Job, state: Job['state'], progress?: unknown, res?: Json): void {
        job.state = state;
        if (progress !== undefined) job.progress = progress;
        if (res) job.result = res;
        this.push({ type: 'job', job: job.id, state, ...(job.progress !== undefined ? { progress: job.progress } : {}), ...(res ? { result: res } : {}) });
    }

    private async runJob(job: Job, behavior: Behavior, action: FakeAction, args: Json): Promise<void> {
        await sleep(5);
        if (job.cancelRequested) return;
        this.setJob(job, 'running');
        const done = this.enterWrite(action);
        const ctl: JobControl = {
            id: job.id,
            get cancelled() {
                return job.cancelRequested;
            },
            progress: p => {
                if (!job.cancelRequested) this.setJob(job, 'running', p);
            },
        };
        try {
            const r = await behavior.run(args, { job: ctl, engine: this, action: action.name });
            if (!job.cancelRequested) this.setJob(job, (r.outcome === 'engine-error' ? 'failed' : 'done') as Job['state'], undefined, r);
        } catch (error) {
            if (!job.cancelRequested) this.setJob(job, 'failed', undefined, result('engine-error', (error as Error).message));
        } finally {
            done();
        }
    }
}

const defaultBehavior: Behavior = {
    async run(args, { job, action }) {
        if (job) {
            for (let i = 1; i <= 3; i++) {
                await sleep(20);
                if (job.cancelled) break;
                job.progress({ current: i, total: 3, message: `step ${i}` });
            }
        }
        return result('ok', `${action} done.`, { data: { args } });
    },
};
