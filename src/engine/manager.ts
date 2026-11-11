import { randomBytes } from 'node:crypto';
import { createWriteStream, promises as fs, type WriteStream } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_PORT, PROTOCOL, type Timings } from '../config.js';
import type { ActionSpec } from '../manifest.js';
import { EndpointClient, type Endpoint } from '../protocol/client.js';
import { isDiscovery, refused, type ResultBody } from '../protocol/types.js';
import { readJsonSettled, sleep } from '../util/fs.js';
import { Mutex } from '../util/mutex.js';
import type { FoundPlugin } from '../workspace/plugins.js';
import type { EngineMode } from '../workspace/registry.js';
import type { Workspace } from '../workspace/workspace.js';
import { discoveryFile, endpointOf, probe, type Probe } from './discovery.js';
import type { ProcessLauncher, SpawnedProcess } from './process.js';

const LOG_LINES = 2000;

/** A host process this server started. Nothing else is ever stopped by this server. */
export interface HostRecord {
    key: string;
    workspace: string;
    uproject: string;
    dir: string;
    pid: number;
    port: number;
    token: string;
    mode: EngineMode;
    temporary: boolean;
    ownerId: string;
    ownerRoute: string;
    commandlet: string;
    pluginIds: string[];
    idleMinutes: number;
    proc: SpawnedProcess;
    startedAt: number;
    readyAt?: number;
    lastActive: number;
    inflight: number;
    retire: boolean;
    stopping?: Promise<void>;
    logs: string[];
    logFile?: string;
    exitCode?: number | null;
}

export type LeaseVia = 'editor' | 'host' | 'other-host' | 'temp-render';

export interface Lease {
    endpoint: Endpoint;
    via: LeaseVia;
    pid: number;
    /** Plain facts for the model (first start took N s, which process served it). */
    notes: string[];
    /** Hints that belong in the result's `next`. */
    next: string[];
    release(): Promise<void>;
}

export type Acquired = { lease: Lease } | { refusal: ResultBody };

export interface EngineManagerOptions {
    launcher: ProcessLauncher;
    timings: Timings;
    home: string;
    now?: () => number;
    /** Diagnostics for the server's stderr. */
    log?: (line: string) => void;
}

export class EngineManager {
    private readonly hosts = new Map<string, HostRecord>();
    private readonly lastLogs = new Map<string, string[]>();
    private readonly writeLocks = new Map<string, Mutex>();
    private readonly renderLocks = new Map<string, Mutex>();
    private readonly starting = new Map<string, Promise<HostRecord | ResultBody>>();
    private timer?: NodeJS.Timeout;
    private readonly launcher: ProcessLauncher;
    readonly timings: Timings;
    private readonly now: () => number;
    private readonly log: (line: string) => void;

    constructor(private readonly opts: EngineManagerOptions) {
        this.launcher = opts.launcher;
        this.timings = opts.timings;
        this.now = opts.now ?? Date.now;
        this.log = opts.log ?? (() => {});
    }

    static key(ws: Pick<Workspace, 'uproject'>): string {
        return ws.uproject.toLowerCase();
    }

    /** Actions with `writes: true` run one at a time per project. */
    writeLock(ws: Workspace): Mutex {
        const k = EngineManager.key(ws);
        let m = this.writeLocks.get(k);
        if (!m) this.writeLocks.set(k, (m = new Mutex()));
        return m;
    }

    host(ws: Workspace): HostRecord | undefined {
        return this.hosts.get(EngineManager.key(ws));
    }

    allHosts(): HostRecord[] {
        return [...this.hosts.values()];
    }

    ownPids(): Set<number> {
        return new Set([...this.hosts.values()].map(h => h.pid));
    }

    startTicking(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick().catch(e => this.log(`tick: ${(e as Error).message}`)), this.timings.tickMs);
        this.timer.unref();
    }

    stopTicking(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    probe(ws: Workspace, id: string): Promise<Probe> {
        return probe(ws.dir, id, this.launcher, this.timings);
    }

    async probeAll(ws: Workspace): Promise<Map<string, Probe>> {
        const out = new Map<string, Probe>();
        await Promise.all(ws.discovery.active.map(async p => out.set(p.manifest!.id, await this.probe(ws, p.manifest!.id))));
        return out;
    }

    // ------------------------------------------------------------------ routing

    /**
     * Find (or start) the process that serves `action` of `plugin`, following the routing
     * rules: an open editor wins; else a host already running; else start one. Refuses
     * rather than starting a second process whenever something else may hold the project.
     */
    async acquire(ws: Workspace, plugin: FoundPlugin, action: ActionSpec): Promise<Acquired> {
        const id = plugin.manifest!.id;
        const key = EngineManager.key(ws);
        const needRender = action.needs === 'render';

        for (let attempt = 0; attempt < 3; attempt++) {
            const pending = this.starting.get(key);
            if (pending) await pending;
            const p = await this.probe(ws, id);
            const own = this.hosts.get(key);

            if (p.state === 'alive') {
                if (p.disc.mode === 'editor') {
                    if (own) this.retireWhenIdle(own, 'the editor opened this project');
                    if (needRender && !p.hello.render)
                        return refuse('render-unavailable', `The open editor (pid ${p.disc.pid}) reports that it cannot render, and "${action.name}" needs rendering.`, [
                            'Restart the editor with rendering enabled, then retry.',
                        ]);
                    return { lease: this.lease(p.endpoint, 'editor', undefined, [`Served by the open editor (pid ${p.disc.pid}).`]) };
                }
                if (own && own.pid === p.disc.pid) {
                    if (needRender && own.mode !== 'render') return this.tempRender(ws, plugin, action);
                    return { lease: this.lease(p.endpoint, 'host', own, []) };
                }
                if (needRender && !p.hello.render)
                    return refuse('render-unavailable', `A headless engine host started by another dream-mcp (pid ${p.disc.pid}) holds this project and cannot render.`, [
                        'Wait for that host to go idle and exit, or stop it from the dream-mcp that started it, then retry.',
                    ]);
                return { lease: this.lease(p.endpoint, 'other-host', undefined, [`Served by an engine host another dream-mcp started (pid ${p.disc.pid}).`]) };
            }

            if (p.state === 'unresponsive') {
                if (own && own.pid === p.disc.pid && !own.readyAt) continue;
                return refuse(
                    'endpoint-unresponsive',
                    `A process holds this project but its ${plugin.name} endpoint does not answer: ${p.detail}. dream-mcp will not start a second engine on a project that is still open.`,
                    ['If the editor is busy (compiling, or a modal dialog is open), wait and retry.', 'If it is hung, close it and retry.'],
                    { pid: p.disc.pid, mode: p.disc.mode },
                );
            }

            // Nothing answers for this plugin.
            if (own && !own.stopping && own.exitCode === undefined) {
                const direct = await this.helloOn(own, plugin);
                if (direct) {
                    if (needRender && own.mode !== 'render') return this.tempRender(ws, plugin, action);
                    return { lease: this.lease(direct, 'host', own, []) };
                }
                return refuse('plugin-not-loaded', `The engine host (pid ${own.pid}) is running but ${plugin.name} has no endpoint in it.`, [
                    `Check that ${plugin.name} is built for this engine and enabled, then call dream_engine restart.`,
                    'dream_engine logs shows the host output.',
                ]);
            }

            const blocker = await this.whoHoldsProject(ws, id, action);
            if (blocker) return { refusal: blocker };

            if (needRender && ws.config.engine.mode === 'headless') return this.tempRender(ws, plugin, action);
            const started = await this.ensureHost(ws, needRender ? 'render' : ws.config.engine.mode, false);
            if ('refusal' in started) {
                if (started.refusal.reason === 'host-starting-elsewhere') continue;
                return started;
            }
            const host = started.host;
            const ep = await this.helloOn(host, plugin, 15_000);
            if (!ep)
                return refuse('plugin-not-loaded', `The engine host started (pid ${host.pid}) but ${plugin.name} has no endpoint in it.`, [
                    `Check that ${plugin.name} is built for this engine and enabled.`,
                    'dream_engine logs shows the host output.',
                ]);
            const secs = (((host.readyAt ?? this.now()) - host.startedAt) / 1000).toFixed(1);
            return { lease: this.lease(ep, 'host', host, [`Started the engine host (${host.mode}, pid ${host.pid}) in ${secs} s; later calls reuse it.`]) };
        }
        return refuse('endpoint-unresponsive', 'The engine did not settle after several attempts.', ['Call dream_engine status to see what is running, then retry.']);
    }

    /** A refusal when another process may hold the project and this action writes. */
    private async whoHoldsProject(ws: Workspace, id: string, action: ActionSpec): Promise<ResultBody | undefined> {
        const others = [...(await this.probeAll(ws)).entries()].filter(([k]) => k !== id).map(([, v]) => v);
        const editor = others.find(o => o.state === 'alive' && o.disc.mode === 'editor');
        if (editor && editor.state !== 'absent' && action.writes)
            return refused(
                'editor-without-endpoint',
                `The editor (pid ${editor.disc.pid}) has this project open but this plugin's endpoint is not running in it. Writing from a second process would overwrite the editor's work.`,
                ['Enable the plugin and its DreamMCP endpoint in the editor (or update the plugin), then retry.', 'Read-only actions still work.'],
            );
        const host = others.find(o => o.state === 'alive' && o.disc.mode === 'host');
        if (host && host.state !== 'absent')
            return refused('plugin-not-loaded', `An engine host (pid ${host.disc.pid}) is serving other plugins of this project but not this one.`, [
                'Check that the plugin is built and enabled, then restart that host.',
            ]);
        const hung = others.find(o => o.state === 'unresponsive');
        if (hung && action.writes)
            return refused('endpoint-unresponsive', `A process holds this project but does not answer: ${hung.detail}.`, ['Wait for it, or close it, then retry.']);

        if (!action.writes) return undefined;
        const known = new Set<number>(this.ownPids());
        for (const o of others) if (o.state !== 'absent') known.add(o.disc.pid);
        const procs = await this.launcher.projectProcesses(ws.uproject);
        const foreign = (procs ?? []).filter(p => !known.has(p.pid));
        if (foreign.length)
            return refused(
                'editor-without-endpoint',
                `${foreign[0]!.name} (pid ${foreign[0]!.pid}) has this project open and has no DreamMCP endpoint. Writing from a second process would overwrite its work.`,
                ['Close it, or enable the DreamMCP endpoint in it (update the plugin), then retry.', 'Read-only actions still work.'],
                { pid: foreign[0]!.pid },
            );
        return undefined;
    }

    private lease(endpoint: Endpoint, via: LeaseVia, host: HostRecord | undefined, notes: string[], next: string[] = []): Lease {
        if (host) {
            host.inflight++;
            host.lastActive = this.now();
        }
        let released = false;
        return {
            endpoint,
            via,
            pid: endpoint.pid,
            notes,
            next,
            release: async () => {
                if (released || !host) return;
                released = true;
                host.inflight--;
                host.lastActive = this.now();
                if (host.inflight === 0 && (host.retire || host.temporary)) await this.stopHost(host, host.temporary ? 'temporary render process done' : 'retired');
            },
        };
    }

    /** Hello on our own host's port for this plugin's route. */
    private async helloOn(host: HostRecord, plugin: FoundPlugin, waitMs = 0): Promise<Endpoint | undefined> {
        const m = plugin.manifest!;
        const deadline = this.now() + waitMs;
        do {
            // The engine may have moved off the port we asked for; its discovery file says where it went.
            const disc = await readJsonSettled(discoveryFile(host.dir, m.id), 1, 0);
            const port = isDiscovery(disc) && disc.pid === host.pid ? disc.port : host.port;
            const ws = isDiscovery(disc) && disc.pid === host.pid ? disc.ws : null;
            const ep: Endpoint = { id: m.id, port, token: host.token, route: m.route, ws, pid: host.pid, mode: 'host', render: host.mode === 'render' };
            try {
                const h = await new EndpointClient(ep, this.timings).hello();
                if (h.protocol === PROTOCOL) return { ...ep, ws: h.ws ?? ws, render: h.render };
            } catch {
                /* not up yet */
            }
            if (host.exitCode !== undefined) return undefined;
            if (this.now() < deadline) await sleep(250);
        } while (this.now() < deadline);
        return undefined;
    }

    /**
     * Headless project, render-only action: run it in a separate rendering process. The
     * resident headless host is stopped first, because both processes would write the
     * same discovery files and the same packages.
     */
    private async tempRender(ws: Workspace, plugin: FoundPlugin, action: ActionSpec): Promise<Acquired> {
        const key = EngineManager.key(ws);
        let lock = this.renderLocks.get(key);
        if (!lock) this.renderLocks.set(key, (lock = new Mutex()));
        return lock.run(async () => {
            const own = this.hosts.get(key);
            if (own && own.mode === 'render' && own.exitCode === undefined && !own.stopping) {
                const ep = await this.helloOn(own, plugin);
                if (ep) return { lease: this.lease(ep, 'temp-render', own, []) };
            }
            if (own) {
                const deadline = this.now() + this.timings.jobWaitMs;
                while (own.inflight > 0 && this.now() < deadline) await sleep(100);
                await this.stopHost(own, 'making room for a render process');
            }
            const started = await this.ensureHost(ws, 'render', true);
            if ('refusal' in started) return started;
            const ep = await this.helloOn(started.host, plugin, 15_000);
            if (!ep) {
                await this.stopHost(started.host, 'plugin endpoint missing');
                return refuse('plugin-not-loaded', `The render process started but ${plugin.name} has no endpoint in it.`, ['dream_engine logs shows its output.']);
            }
            const secs = (((started.host.readyAt ?? this.now()) - started.host.startedAt) / 1000).toFixed(1);
            const why = `This project's engine host is headless, so "${action.name}" ran in a separate render process that took ${secs} s to start and stops afterwards. To keep a rendering host resident, call dream_workspace add with mode "render".`;
            return { lease: this.lease(ep, 'temp-render', started.host, [`Started a temporary render process (pid ${started.host.pid}) in ${secs} s.`], [why]) };
        });
    }

    // ------------------------------------------------------------------ starting

    /** Start this project's host unless one is already starting; concurrent callers share one start. */
    async ensureHost(ws: Workspace, mode: EngineMode, temporary: boolean): Promise<{ host: HostRecord } | { refusal: ResultBody }> {
        const key = EngineManager.key(ws);
        const existing = this.hosts.get(key);
        if (existing && existing.exitCode === undefined && !existing.stopping && existing.readyAt) return { host: existing };
        let pending = this.starting.get(key);
        if (!pending) {
            pending = this.startHost(ws, mode, temporary).finally(() => this.starting.delete(key));
            this.starting.set(key, pending);
        }
        const r = await pending;
        return 'pid' in r ? { host: r } : { refusal: r };
    }

    private async startHost(ws: Workspace, mode: EngineMode, temporary: boolean): Promise<HostRecord | ResultBody> {
        if (!ws.engine) return refused('engine-not-found', `Cannot start an engine: ${ws.engineProblem ?? 'the engine was not found'}.`, ['Call dream_workspace add with engineRoot set, or fix EngineAssociation in the .uproject.']);
        if (!ws.engine.editorCmdExists)
            return refused('engine-not-found', `Cannot start an engine: ${ws.engine.editorCmd} does not exist.`, ['Build the editor for this engine, or point engineRoot at an installed engine.']);
        const owner = ws.discovery.active.find(p => p.manifest!.host);
        if (!owner)
            return refused('no-host', 'No plugin in this project declares a host commandlet, so dream-mcp cannot start an engine for it.', ['Open the project in the editor and retry.']);

        const lock = await this.takeStartLock(ws);
        if (!lock) {
            // Another dream-mcp is starting a host for this project right now; let the caller re-probe.
            const deadline = this.now() + this.timings.startMs;
            while (this.now() < deadline) {
                const p = await this.probe(ws, owner.manifest!.id);
                if (p.state === 'alive') break;
                if (!(await this.startLockHeld(ws))) break;
                await sleep(500);
            }
            return refused('host-starting-elsewhere', 'Another dream-mcp was starting an engine for this project.', []);
        }
        try {
            const port = ws.config.port ?? (await freePort());
            const token = randomBytes(24).toString('hex');
            const commandlet = owner.manifest!.host!.commandlet;
            const args = [
                ws.uproject,
                `-run=${commandlet}`,
                `-DreamMCPPort=${port}`,
                `-DreamMCPToken=${token}`,
                '-unattended',
                '-nosplash',
                '-nopause',
                '-stdout',
                mode === 'render' ? '-AllowCommandletRendering' : '-nullrhi',
            ];
            const proc = this.launcher.spawn(ws.engine.editorCmd, args, { cwd: ws.dir });
            const key = EngineManager.key(ws);
            const host: HostRecord = {
                key,
                workspace: ws.name,
                uproject: ws.uproject,
                dir: ws.dir,
                pid: proc.pid,
                port,
                token,
                mode,
                temporary,
                ownerId: owner.manifest!.id,
                ownerRoute: owner.manifest!.route,
                commandlet,
                pluginIds: ws.discovery.active.map(p => p.manifest!.id),
                idleMinutes: ws.config.engine.idleMinutes,
                proc,
                startedAt: this.now(),
                lastActive: this.now(),
                inflight: 0,
                retire: false,
                logs: [],
            };
            const stream = await this.openLog(ws, proc.pid);
            if (stream) host.logFile = stream.path as string;
            proc.onLine(line => {
                host.logs.push(line);
                if (host.logs.length > LOG_LINES) host.logs.splice(0, host.logs.length - LOG_LINES);
                stream?.write(line + '\n');
            });
            proc.onExit(code => {
                host.exitCode = code;
                stream?.end();
                this.lastLogs.set(key, host.logs);
                if (this.hosts.get(key) === host) this.hosts.delete(key);
                this.log(`host pid ${host.pid} exited with ${code}`);
            });
            if (proc.pid <= 0 || proc.exitCode !== undefined) {
                return refused('engine-error', `The engine did not start: ${host.logs.slice(-5).join(' | ') || 'spawn failed'}.`, ['Check engineRoot with dream_workspace doctor.']);
            }
            this.hosts.set(key, host);
            this.log(`started ${mode} host pid ${proc.pid} on port ${port} for ${ws.uproject}`);

            const ownerEp = await this.helloOn(host, owner, this.timings.startMs);
            if (!ownerEp) {
                const tail = host.logs.slice(-20).join('\n');
                const exited = host.exitCode !== undefined;
                if (!exited) await this.stopHost(host, 'did not answer in time');
                return refused(
                    'engine-error',
                    exited
                        ? `The engine host exited with code ${host.exitCode} before its endpoint answered.`
                        : `The engine host did not answer within ${Math.round(this.timings.startMs / 1000)} s and was stopped.`,
                    ['dream_engine logs shows the full output.', 'dream_workspace doctor checks the engine and manifests.'],
                    { log: tail },
                );
            }
            host.port = ownerEp.port;
            host.readyAt = this.now();
            return host;
        } finally {
            await lock();
        }
    }

    private lockFile(ws: Workspace): string {
        const hash = createHash('sha1').update(ws.uproject.toLowerCase()).digest('hex').slice(0, 16);
        return path.join(this.opts.home, 'locks', `${hash}.lock`);
    }

    private async startLockHeld(ws: Workspace): Promise<boolean> {
        const raw = await readJsonSettled(this.lockFile(ws), 1, 0);
        const pid = (raw as { pid?: number } | undefined)?.pid;
        return typeof pid === 'number' && pid !== process.pid && this.launcher.isAlive(pid);
    }

    /** One starter per project across dream-mcp processes. Returns a release function, or undefined when another live server holds it. */
    private async takeStartLock(ws: Workspace): Promise<(() => Promise<void>) | undefined> {
        const file = this.lockFile(ws);
        await fs.mkdir(path.dirname(file), { recursive: true });
        for (let i = 0; i < 2; i++) {
            try {
                await fs.writeFile(file, JSON.stringify({ pid: process.pid, project: ws.uproject, at: new Date().toISOString() }), { flag: 'wx' });
                return async () => {
                    await fs.rm(file, { force: true });
                };
            } catch {
                if (await this.startLockHeld(ws)) return undefined;
                await fs.rm(file, { force: true }); // left by a server that died
            }
        }
        return undefined;
    }

    private async openLog(ws: Workspace, pid: number): Promise<WriteStream | undefined> {
        try {
            const dir = path.join(this.opts.home, 'logs');
            await fs.mkdir(dir, { recursive: true });
            const name = ws.name.replace(/[^A-Za-z0-9_.-]/g, '_');
            return createWriteStream(path.join(dir, `${name}-host-${pid}.log`), { flags: 'w' });
        } catch {
            return undefined;
        }
    }

    // ------------------------------------------------------------------ stopping

    private retireWhenIdle(host: HostRecord, why: string): void {
        if (host.retire) return;
        host.retire = true;
        this.log(`host pid ${host.pid} retires: ${why}`);
        if (host.inflight === 0) void this.stopHost(host, why);
    }

    /** Ask our host to exit, then kill it by the PID we recorded if it does not. */
    stopHost(host: HostRecord, reason: string): Promise<void> {
        host.stopping ??= (async () => {
            host.retire = true;
            this.log(`stopping host pid ${host.pid}: ${reason}`);
            const client = new EndpointClient(
                { id: host.ownerId, port: host.port, token: host.token, route: host.ownerRoute, ws: null, pid: host.pid, mode: 'host', render: host.mode === 'render' },
                this.timings,
            );
            const asked = host.exitCode === undefined ? await client.shutdown() : false;
            if (!(await waitExit(host.proc, asked ? this.timings.stopMs : 0))) {
                this.log(`host pid ${host.pid} did not exit; killing it`);
                await this.launcher.kill(host.pid);
                await waitExit(host.proc, 5000);
            }
            if (this.hosts.get(host.key) === host) this.hosts.delete(host.key);
            this.lastLogs.set(host.key, host.logs);
        })();
        return host.stopping;
    }

    async stop(ws: Workspace, reason: string): Promise<HostRecord | undefined> {
        const host = this.hosts.get(EngineManager.key(ws));
        if (!host) return undefined;
        await this.stopHost(host, reason);
        return host;
    }

    async stopAll(reason: string): Promise<void> {
        this.stopTicking();
        await Promise.all([...this.hosts.values()].map(h => this.stopHost(h, reason)));
    }

    /** Idle shutdown and editor takeover. Runs on a timer; tests call it directly. */
    async tick(): Promise<void> {
        for (const host of [...this.hosts.values()]) {
            if (host.stopping || !host.readyAt) continue;
            if (host.exitCode !== undefined) {
                this.hosts.delete(host.key);
                continue;
            }
            for (const id of host.pluginIds) {
                const p = await probe(host.dir, id, this.launcher, this.timings);
                if (p.state === 'alive' && p.disc.mode === 'editor') {
                    this.retireWhenIdle(host, `the editor (pid ${p.disc.pid}) opened this project`);
                    break;
                }
            }
            if (host.stopping) continue;
            const idleMs = this.now() - host.lastActive;
            if (host.inflight === 0 && !host.temporary && idleMs >= host.idleMinutes * 60_000) await this.stopHost(host, `idle for ${Math.round(idleMs / 60000)} min`);
            else if (host.inflight === 0 && host.retire) await this.stopHost(host, 'retired');
        }
    }

    logs(ws: Workspace): { lines: string[]; file?: string; live: boolean } {
        const key = EngineManager.key(ws);
        const host = this.hosts.get(key);
        if (host) return { lines: host.logs, ...(host.logFile ? { file: host.logFile } : {}), live: true };
        return { lines: this.lastLogs.get(key) ?? [], live: false };
    }
}

function refuse(reason: string, summary: string, next: string[] = [], data: Record<string, unknown> = {}): { refusal: ResultBody } {
    return { refusal: refused(reason, summary, next, data) };
}

function waitExit(proc: SpawnedProcess, ms: number): Promise<boolean> {
    if (proc.exitCode !== undefined) return Promise.resolve(true);
    if (ms <= 0) return Promise.resolve(false);
    return new Promise(resolve => {
        const t = setTimeout(() => resolve(false), ms);
        proc.onExit(() => {
            clearTimeout(t);
            resolve(true);
        });
    });
}

/** A port nothing is listening on right now. The engine moves on if it is taken by the time it binds. */
export async function freePort(preferred = DEFAULT_PORT): Promise<number> {
    const tryPort = (port: number) =>
        new Promise<number | undefined>(resolve => {
            const srv = net.createServer();
            srv.once('error', () => resolve(undefined));
            srv.listen(port, '127.0.0.1', () => {
                const a = srv.address();
                srv.close(() => resolve(typeof a === 'object' && a ? a.port : undefined));
            });
        });
    for (let p = preferred + 50; p < preferred + 100; p++) {
        const ok = await tryPort(p);
        if (ok) return ok;
    }
    return (await tryPort(0)) ?? preferred + 50;
}

export { endpointOf };
