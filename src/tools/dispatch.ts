import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fromJsonSchema, type CallToolResult } from '@modelcontextprotocol/server';
import type { EngineManager, Lease } from '../engine/manager.js';
import type { ActionSpec, Manifest } from '../manifest.js';
import { EndpointClient, EndpointError, type Endpoint } from '../protocol/client.js';
import { makeResult, refused, type JobStatus, type Progress, type ResultBody } from '../protocol/types.js';
import { globFiles, hasGlob, isInside, relTo, toPosix } from '../util/fs.js';
import type { FoundPlugin } from '../workspace/plugins.js';
import type { Workspace } from '../workspace/workspace.js';
import { helpText } from './describe.js';
import { renderResult, textResult } from './format.js';

/** What a tool handler gets from the SDK that matters here. */
export interface CallContext {
    signal?: AbortSignal;
    progress?: (progress: number, total: number | undefined, message: string | undefined) => void;
}

interface TrackedJob {
    job: string;
    tool: string;
    action: string;
    projectDir: string;
    endpoint: Endpoint;
    startedAt: number;
    status?: JobStatus;
    result?: ResultBody;
    notes: string[];
    done: Promise<void>;
}

const MAX_READ_BYTES = 200 * 1024;

/** Generic dispatch for every `dream_<id>` tool. Nothing in here knows any particular plugin. */
export class Dispatcher {
    private readonly jobs = new Map<string, TrackedJob>();

    constructor(private readonly engine: EngineManager) {}

    async call(ws: Workspace, plugin: FoundPlugin, action: string, args: Record<string, unknown>, ctx: CallContext): Promise<CallToolResult> {
        const m = plugin.manifest!;
        const tool = `dream_${m.id}`;
        if (action === 'help') return textResult(helpText(m, typeof args.action === 'string' ? args.action : undefined));
        if (action === 'reference') return this.reference(ws, plugin, args);

        const spec = m.actions.find(a => a.name === action);
        if (!spec)
            return renderResult(
                refused('unknown-action', `${tool} has no action "${action}".`, [`Use one of: ${[...m.actions.map(a => a.name), 'help', 'reference'].join(', ')}.`]),
            );

        const problems = validateArgs(spec, args);
        if (problems.length)
            return renderResult(
                refused('bad-args', `Arguments for ${action} are not valid: ${problems.join('; ')}.`, [`Call ${tool} with {"action": "help", "args": {"action": "${action}"}} to see the arguments.`]),
            );

        if (spec.needs === 'none') return this.offline(ws, plugin, spec, args);

        const work = (finish: (r: CallToolResult) => void) => this.remote(ws, plugin, spec, args, ctx, finish);
        return new Promise<CallToolResult>((resolve, reject) => {
            let sent = false;
            const finish = (r: CallToolResult) => {
                if (!sent) {
                    sent = true;
                    resolve(r);
                }
            };
            const run = spec.writes ? this.engine.writeLock(ws).run(() => work(finish)) : work(finish);
            run.then(
                () => finish(textResult('The action ended without a result.', true)),
                error => (sent ? undefined : reject(error)),
            );
        });
    }

    /**
     * Run an endpoint action. Resolves only once the action is really over (so a write lock
     * held around it stays held), but hands the tool result to `finish` as soon as there is
     * one -- including a "still running" answer when a long job outlasts the wait.
     */
    private async remote(ws: Workspace, plugin: FoundPlugin, spec: ActionSpec, args: Record<string, unknown>, ctx: CallContext, finish: (r: CallToolResult) => void): Promise<void> {
        const m = plugin.manifest!;
        const tool = `dream_${m.id}`;
        const got = await this.engine.acquire(ws, plugin, spec);
        if ('refusal' in got) return finish(await renderResult(got.refusal));
        const lease = got.lease;
        try {
            const client = new EndpointClient(lease.endpoint, this.engine.timings);
            let reply;
            try {
                reply = await client.call(randomUUID(), spec.name, args, ctx.signal);
            } catch (error) {
                return finish(await renderResult(transportFailure(error as Error, spec.name), { projectDir: ws.dir, notes: lease.notes }));
            }
            if (reply.kind === 'result') return finish(await this.render(ws, reply.result, lease));

            const tracked: TrackedJob = {
                job: reply.job,
                tool,
                action: spec.name,
                projectDir: ws.dir,
                endpoint: lease.endpoint,
                startedAt: Date.now(),
                notes: lease.notes,
                done: Promise.resolve(),
            };
            this.jobs.set(reply.job, tracked);
            const onAbort = () => void client.cancel(reply.job).catch(() => undefined);
            ctx.signal?.addEventListener('abort', onAbort, { once: true });
            const progress = (p: Progress) => reportProgress(ctx, p);
            let waited;
            try {
                waited = await client.waitJob(reply.job, { deadlineMs: this.engine.timings.jobWaitMs, ...(ctx.signal ? { signal: ctx.signal } : {}), onProgress: progress });
            } catch (error) {
                if ((error as EndpointError).kind === 'aborted') {
                    finish(textResult(`Cancelled ${spec.name} (job ${reply.job}).`, true));
                    // Still wait for the endpoint to settle so the lease reflects reality.
                    await this.settle(client, tracked);
                    return;
                }
                return finish(await renderResult(transportFailure(error as Error, spec.name), { projectDir: ws.dir, notes: lease.notes }));
            } finally {
                ctx.signal?.removeEventListener('abort', onAbort);
            }
            tracked.status = waited.status;
            if (!waited.timedOut) {
                tracked.result = jobResult(waited.status, spec.name);
                return finish(await this.render(ws, tracked.result, lease));
            }
            finish(stillRunning(tracked, waited.status));
            await this.settle(client, tracked);
        } finally {
            await lease.release();
        }
    }

    /** Keep watching a job nobody is waiting on any more, so its lease and lock end when it does. */
    private async settle(client: EndpointClient, tracked: TrackedJob): Promise<void> {
        const p = (async () => {
            try {
                const w = await client.waitJob(tracked.job, { deadlineMs: 24 * 3600_000 });
                tracked.status = w.status;
                tracked.result = jobResult(w.status, tracked.action);
            } catch (error) {
                tracked.result = transportFailure(error as Error, tracked.action);
            }
        })();
        tracked.done = p;
        await p;
    }

    private render(ws: Workspace, result: ResultBody, lease: Lease): Promise<CallToolResult> {
        const r = lease.next.length ? { ...result, next: [...lease.next, ...result.next] } : result;
        return renderResult(r, { projectDir: ws.dir, notes: lease.notes, extra: { engine: { via: lease.via, pid: lease.pid } } });
    }

    /** `dream_engine job`: report or keep waiting on a job an earlier call handed back. */
    async job(jobId: string, ctx: CallContext): Promise<CallToolResult> {
        const t = this.jobs.get(jobId);
        if (!t) return renderResult(refused('unknown-job', `No job "${jobId}" was started by this server.`, ['Jobs are only tracked by the dream-mcp process that started them.']));
        if (!t.result) {
            const timeout = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), this.engine.timings.jobWaitMs).unref());
            const client = new EndpointClient(t.endpoint, this.engine.timings);
            const ticker = setInterval(() => void client.job(t.job).then(s => s.progress !== undefined && reportProgress(ctx, s.progress)).catch(() => undefined), 2000);
            try {
                await Promise.race([t.done, timeout]);
            } finally {
                clearInterval(ticker);
            }
        }
        if (!t.result) return stillRunning(t, t.status ?? { state: 'running' });
        return renderResult(t.result, { projectDir: t.projectDir, notes: t.notes });
    }

    async cancel(jobId: string): Promise<CallToolResult> {
        const t = this.jobs.get(jobId);
        if (!t) return renderResult(refused('unknown-job', `No job "${jobId}" was started by this server.`));
        if (t.result) return textResult(`Job ${jobId} already finished (${t.result.outcome}).`);
        try {
            const reply = await new EndpointClient(t.endpoint, this.engine.timings).cancel(jobId);
            return textResult(
                reply.cancelled ? `Cancelled job ${jobId} (${t.tool} ${t.action}).` : `The endpoint could not cancel job ${jobId}${reply.state ? ` (state ${reply.state})` : ''}; it will run to the end.`,
                !reply.cancelled,
                { job: jobId, ...reply },
            );
        } catch (error) {
            return renderResult(transportFailure(error as Error, 'cancel'));
        }
    }

    listJobs(): TrackedJob[] {
        return [...this.jobs.values()];
    }

    // ------------------------------------------------------------------ offline + reference

    private async offline(ws: Workspace, plugin: FoundPlugin, spec: ActionSpec, args: Record<string, unknown>): Promise<CallToolResult> {
        const o = spec.offline!;
        const base = o.base === 'project' ? ws.dir : plugin.root;
        let rel: string;
        try {
            rel = substitute(o.path, args);
        } catch (error) {
            return renderResult(refused('bad-args', (error as Error).message));
        }
        const show = (p: string) => (isInside(ws.dir, p) ? relTo(ws.dir, p) : `${plugin.name}/${relTo(plugin.root, p)}`);
        if (o.kind === 'listFiles' || hasGlob(rel)) {
            const files = (await globFiles(base, rel)).map(f => show(path.join(base, f)));
            if (o.kind === 'listFiles')
                return textResult(files.length ? `${files.length} file(s) match ${rel}:\n${files.join('\n')}` : `No files match ${rel}.`, false, { files });
            if (!files.length) return renderResult(makeResult('refused', `No file matches ${rel}.`, { reason: 'not-found' }));
            rel = relTo(base, path.resolve(ws.dir, files[0]!));
        }
        const full = path.resolve(base, rel);
        if (!isInside(base, full)) return renderResult(refused('bad-args', `${rel} leaves the ${o.base} folder.`));
        let buf: Buffer;
        try {
            buf = await fs.readFile(full);
        } catch {
            return renderResult(refused('not-found', `${show(full)} does not exist.`, [`Call ${`dream_${plugin.manifest!.id}`} help to check the arguments.`]));
        }
        const truncated = buf.length > MAX_READ_BYTES;
        const text = buf.subarray(0, MAX_READ_BYTES).toString('utf8');
        return textResult(`${show(full)}${truncated ? ` (first ${MAX_READ_BYTES / 1024} KB of ${Math.round(buf.length / 1024)} KB)` : ''}:\n${text}`, false, { path: show(full), truncated });
    }

    private async reference(ws: Workspace, plugin: FoundPlugin, args: Record<string, unknown>): Promise<CallToolResult> {
        const m = plugin.manifest!;
        const docs = m.reference;
        const key = args.doc ?? args.name ?? args.title;
        if (key === undefined || key === '') {
            if (!docs.length) return textResult(`${m.title} declares no reference docs.`);
            return textResult(
                [`Reference docs for ${m.title} (read one with {"action": "reference", "args": {"doc": "<title or number>"}}):`, ...docs.map((d, i) => `${i + 1}. ${d.title} (${d.path})`)].join('\n'),
                false,
                { docs: docs.map((d, i) => ({ index: i + 1, title: d.title, path: d.path, uri: referenceUri(m, d.path) })) },
            );
        }
        const k = String(key).toLowerCase();
        const doc = /^\d+$/.test(k) ? docs[Number(k) - 1] : docs.find(d => d.title.toLowerCase() === k || toPosix(d.path).toLowerCase() === k) ?? docs.find(d => d.title.toLowerCase().includes(k));
        if (!doc) return renderResult(refused('not-found', `No reference doc matches "${key}".`, [`Docs: ${docs.map(d => d.title).join('; ') || 'none'}.`]));
        const text = await readReference(plugin, doc.path);
        if (text === undefined) return renderResult(refused('not-found', `${doc.title} (${doc.path}) is listed in the manifest but missing from the plugin.`));
        const lines = text.split(/\r?\n/);
        const offset = Math.max(0, Number(args.offset ?? 0) || 0);
        const limit = Math.max(1, Number(args.limit ?? 400) || 400);
        const slice = lines.slice(offset, offset + limit);
        const more = offset + limit < lines.length ? `\n[lines ${offset + 1}-${offset + slice.length} of ${lines.length}; continue with "offset": ${offset + limit}]` : '';
        return textResult(`${doc.title}:\n${slice.join('\n')}${more}`, false, { doc: doc.title, path: doc.path, offset, lines: lines.length });
    }
}

export function referenceUri(m: Manifest, docPath: string): string {
    return `dream://${m.id}/reference/${toPosix(docPath).split('/').map(encodeURIComponent).join('/')}`;
}

export async function readReference(plugin: FoundPlugin, docPath: string): Promise<string | undefined> {
    const full = path.resolve(plugin.root, docPath);
    if (!isInside(plugin.root, full)) return undefined;
    try {
        return await fs.readFile(full, 'utf8');
    } catch {
        return undefined;
    }
}

function validateArgs(spec: ActionSpec, args: Record<string, unknown>): string[] {
    try {
        const r = fromJsonSchema(spec.args as never)['~standard'].validate(args);
        if (r instanceof Promise) return [];
        if ('issues' in r && r.issues) return r.issues.map(i => `${i.path?.length ? i.path.map(p => (typeof p === 'object' ? String(p.key) : String(p))).join('.') + ': ' : ''}${i.message}`);
        return [];
    } catch (error) {
        return [`the manifest's schema for this action cannot be used (${(error as Error).message})`];
    }
}

/** Replace `{name}` with the string argument `name`; refuse values that would escape the base folder. */
export function substitute(template: string, args: Record<string, unknown>): string {
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
        const v = args[name];
        if (v === undefined || v === null || v === '') throw new Error(`argument "${name}" is required here`);
        const s = String(v);
        if (s.includes('..') || path.isAbsolute(s) || /^[a-zA-Z]:/.test(s)) throw new Error(`argument "${name}" must be a plain relative name`);
        return s;
    });
}

function reportProgress(ctx: CallContext, p: Progress): void {
    if (!ctx.progress) return;
    if (typeof p === 'number') ctx.progress(p <= 1 ? p * 100 : p, 100, undefined);
    else if (p && typeof p === 'object') ctx.progress(p.current ?? 0, p.total, p.message);
}

function jobResult(status: JobStatus, action: string): ResultBody {
    if (status.result) return status.result;
    if (status.state === 'done') return makeResult('ok', `${action} finished.`);
    if (status.state === 'cancelled') return refused('cancelled', `${action} was cancelled.`);
    return makeResult('engine-error', `${action} failed without a result body.`);
}

function stillRunning(t: TrackedJob, status: JobStatus): CallToolResult {
    const p = status.progress;
    const pct = typeof p === 'number' ? ` ${Math.round(p <= 1 ? p * 100 : p)}%` : p && typeof p === 'object' && p.total ? ` ${p.current ?? 0}/${p.total}${p.message ? ` ${p.message}` : ''}` : '';
    return textResult(
        [
            `${t.tool} ${t.action} is still running (job ${t.job}, ${status.state}${pct}).`,
            `Next: call dream_engine with {"action": "job", "args": {"job": "${t.job}"}} to keep waiting, or {"action": "cancel", "args": {"job": "${t.job}"}} to stop it.`,
        ].join('\n'),
        false,
        { job: t.job, state: status.state, ...(p !== undefined ? { progress: p } : {}) },
    );
}

function transportFailure(error: Error, action: string): ResultBody {
    const e = error as EndpointError;
    if (e.kind === 'unauthorized')
        return refused('bad-token', `The endpoint rejected this server's token for ${action}; its discovery file is probably stale.`, ['Retry once; if it repeats, restart the editor or call dream_engine restart.']);
    if (e.kind === 'timeout')
        return makeResult('engine-error', `${action}: ${e.message}. The engine may still be working.`, { reason: 'timeout', next: ['Call dream_engine status to see whether the endpoint is busy.'] });
    if (e.kind === 'unreachable')
        return makeResult('engine-error', `${action}: the endpoint went away (${e.message}).`, { reason: 'unreachable', next: ['Call dream_engine status; retry once the engine is back.'] });
    return makeResult('engine-error', `${action}: ${e.message}`, { reason: e.kind ?? 'internal' });
}
