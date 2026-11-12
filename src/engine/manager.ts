import { randomBytes } from 'node:crypto';
import { createWriteStream, promises as fs, type WriteStream } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_PORT, PROTOCOL, TOKEN_ENV, type Timings } from '../config.js';
import type { ActionSpec } from '../manifest.js';
import { EndpointClient, type Endpoint } from '../protocol/client.js';
import { isDiscovery, refused, type ResultBody } from '../protocol/types.js';
import { readJsonSettled, sleep } from '../util/fs.js';
import { Mutex } from '../util/mutex.js';
import type { FoundPlugin } from '../workspace/plugins.js';
import type { EngineMode } from '../workspace/registry.js';
import type { Workspace } from '../workspace/workspace.js';
import { discoveryFile, endpointOf, probe, type Probe } from './discovery.js';
import type { ProcessLauncher, ProjectProcess, SpawnedProcess } from './process.js';

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
    /** The headless host commandlet; undefined for the rendering (windowless editor) form. */
    commandlet?: string;
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
    /** Plugins of the project whose endpoint had not answered when the host was declared ready. */
    notReady?: string[];
    /** Background refresh of "who else has this project open" while the host runs. */
    watch?: NodeJS.Timeout;
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

/** Called while a host starts, so a tool call can keep reporting progress during a long engine boot. */
export type StartProgress = (message: string, elapsedMs: number) => void;

export interface HostLaunch {
    /** The form that will actually run (a headless request without a commandlet runs rendering). */
    mode: EngineMode;
    args: string[];
    commandlet?: string;
    /** The plugin whose route answers `hello` and `/shutdown` for the host as a whole. */
    owner?: FoundPlugin;
    /** Set when the headless setting cannot be honoured. */
    fallback?: string;
}

/**
 * The command line for a host process. Both forms carry `-DreamMCPHost`, which makes every
 * Dream endpoint in the process publish `mode: "host"`, accept `/shutdown` and exit when the
 * parent named by `-DreamMCPParentPid` goes away. The token travels in DREAM_MCP_TOKEN.
 *
 * - render: a windowless full editor (`-RenderOffscreen`), because commandlets cannot render
 *   previews; no `-run=`.
 * - headless: the first plugin's `host.commandlet` with `-nullrhi`. Without one, the
 *   rendering form is used instead.
 */
export function hostLaunch(ws: Workspace, requested: EngineMode, port: number, parentPid: number): HostLaunch {
    const withHost = ws.discovery.active.find(p => p.manifest!.host);
    // -stdout is not part of the protocol; it is what `dream_engine logs` reads.
    const tail = [`-DreamMCPPort=${port}`, `-DreamMCPParentPid=${parentPid}`, '-stdout'];
    if (requested === 'headless' && withHost) {
        const commandlet = withHost.manifest!.host!.commandlet;
        return {
            mode: 'headless',
            commandlet,
            owner: withHost,
            args: [ws.uproject, `-run=${commandlet}`, '-nullrhi', '-DreamMCPHost', '-unattended', '-nosplash', '-nopause', ...tail],
        };
    }
    const owner = ws.discovery.active[0];
    return {
        mode: 'render',
        ...(owner ? { owner } : {}),
        args: [ws.uproject, '-DreamMCPHost', '-RenderOffscreen', '-unattended', '-nosplash', '-nosound', ...tail],
        ...(requested === 'headless'
            ? { fallback: 'No plugin in this project declares a host commandlet, so the headless setting falls back to a rendering host (a windowless editor).' }
            : {}),
    };
}

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
    private readonly startListeners = new Map<string, Set<StartProgress>>();
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

    pidAlive(pid: number): boolean {
        return this.launcher.isAlive(pid);
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
    async acquire(ws: Workspace, plugin: FoundPlugin, action: ActionSpec, onProgress?: StartProgress): Promise<Acquired> {
        const id = plugin.manifest!.id;
        const key = EngineManager.key(ws);
        const needRender = action.needs === 'render';

        for (let attempt = 0; attempt < 4; attempt++) {
            const pending = this.starting.get(key);
            if (pending) await pending;
            let own = this.hosts.get(key);
            // A process that has died (its exit event may not have arrived yet) is forgotten,
            // and one that is on its way out is waited for, never leased again. A temporary
            // rendering process only serves rendering actions.
            if (own && !this.isRunning(own)) {
                this.forget(own);
                own = undefined;
            }
            if (own && (own.stopping || own.retire || (own.temporary && !needRender))) {
                await this.whenGone(own);
                continue;
            }
            const p = await this.probe(ws, id);

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
                    if (needRender && own.mode !== 'render') return this.tempRender(ws, plugin, action, onProgress);
                    const guard = await this.guardOthers(ws, plugin, action, onProgress, false);
                    if (guard) return guard;
                    return { lease: this.lease(p.endpoint, own.temporary ? 'temp-render' : 'host', own, []) };
                }
                if (needRender && !p.hello.render)
                    return refuse(
                        'render-unavailable',
                        `"${action.name}" needs rendering, but this project is held by a headless engine host that another dream-mcp process started (pid ${p.disc.pid}). This server may not stop a process it did not start, and starting a render process beside it would put two engines on the same project.`,
                        [
                            'In the session whose dream-mcp started that host, call dream_engine stop (or wait for its idle shutdown), then retry here.',
                            'Or open the project in the editor: an open editor serves every action, including rendering ones.',
                        ],
                        { pid: p.disc.pid },
                    );
                return { lease: this.lease(p.endpoint, 'other-host', undefined, [`Served by an engine host another dream-mcp started (pid ${p.disc.pid}).`]) };
            }

            if (p.state === 'unresponsive') {
                if (own && own.pid === p.disc.pid && !own.readyAt) continue;
                // An editor that published its discovery file a moment ago may not answer
                // `hello` for a few more seconds. Treat it as starting, not hung: reads keep
                // using our own host meanwhile, everything else waits for the editor.
                if (p.disc.mode === 'editor' && !p.answered && this.recentlyStarted(p.disc)) {
                    if (own && !action.writes && !(needRender && own.mode !== 'render')) {
                        const ep = await this.helloOn(own, plugin);
                        if (ep)
                            return {
                                lease: this.lease(ep, own.temporary ? 'temp-render' : 'host', own, [
                                    `An editor (pid ${p.disc.pid}) is starting on this project and does not answer yet; this call was served by the engine host meanwhile.`,
                                ]),
                            };
                    }
                    const waited = await this.waitForEditor(ws, plugin, p.disc.pid, own ? this.timings.editorWaitMs : this.timings.editorWarmupMs, onProgress);
                    if (waited === 'retry') continue;
                    if (waited) return waited;
                    return refuse(
                        'endpoint-unresponsive',
                        `The editor (pid ${p.disc.pid}) published its ${plugin.name} endpoint but has not answered for ${Math.round((own ? this.timings.editorWaitMs : this.timings.editorWarmupMs) / 1000)} s since. dream-mcp will not start a second engine on a project that is open.`,
                        ['If the editor is still loading or busy (compiling, a modal dialog), wait and retry.', 'If it is hung, close it and retry.'],
                        { pid: p.disc.pid, mode: p.disc.mode },
                    );
                }
                return refuse(
                    'endpoint-unresponsive',
                    `A process holds this project but its ${plugin.name} endpoint does not answer: ${p.detail}. dream-mcp will not start a second engine on a project that is still open.`,
                    ['If the editor is busy (compiling, or a modal dialog is open), wait and retry.', 'If it is hung, close it and retry.'],
                    { pid: p.disc.pid, mode: p.disc.mode },
                );
            }

            // Nothing answers for this plugin.
            if (own) {
                const direct = await this.helloOn(own, plugin);
                if (direct) {
                    if (needRender && own.mode !== 'render') return this.tempRender(ws, plugin, action, onProgress);
                    const guard = await this.guardOthers(ws, plugin, action, onProgress, false);
                    if (guard) return guard;
                    return { lease: this.lease(direct, own.temporary ? 'temp-render' : 'host', own, []) };
                }
                // No answer from our own host: most often it has just died and the exit has not
                // been reported yet. Give that a moment, then start a fresh one.
                if (await this.diesSoon(own, 2000)) {
                    this.forget(own);
                    continue;
                }
                // The host is up but this plugin's endpoint came up late (or not yet): wait for
                // it rather than refuse, when the host is new or the plugin was marked not ready.
                const late = own.notReady?.includes(id) || !own.readyAt || this.now() - own.readyAt < this.timings.pluginReadyMs * 2;
                if (late) {
                    const ep = await this.helloOn(own, plugin, this.timings.pluginReadyMs);
                    if (ep) {
                        own.notReady = own.notReady?.filter(x => x !== id);
                        if (needRender && own.mode !== 'render') return this.tempRender(ws, plugin, action, onProgress);
                        const guard = await this.guardOthers(ws, plugin, action, onProgress, false);
                        if (guard) return guard;
                        return { lease: this.lease(ep, own.temporary ? 'temp-render' : 'host', own, []) };
                    }
                }
                return refuse('plugin-not-loaded', `The engine host (pid ${own.pid}) is running but ${plugin.name} has no endpoint in it.`, [
                    `Check that ${plugin.name} is built for this engine and enabled, then call dream_engine restart.`,
                    'dream_engine logs shows the host output.',
                ]);
            }

            const blocker = await this.whoHoldsProject(ws, id, action);
            if (blocker) return { refusal: blocker };

            if (needRender && effectiveMode(ws) === 'headless') return this.tempRender(ws, plugin, action, onProgress);
            const guard = await this.guardOthers(ws, plugin, action, onProgress, true);
            if (guard) return guard;
            const started = await this.ensureHost(ws, needRender ? 'render' : ws.config.engine.mode, false, onProgress);
            if ('refusal' in started) {
                if (started.refusal.reason === 'host-starting-elsewhere') continue;
                return started;
            }
            const host = started.host;
            const ep = await this.helloOn(host, plugin, this.timings.pluginReadyMs);
            if (!ep)
                return refuse('plugin-not-loaded', `The engine host started (pid ${host.pid}) but ${plugin.name} has no endpoint in it.`, [
                    `Check that ${plugin.name} is built for this engine and enabled.`,
                    'dream_engine logs shows the host output.',
                ]);
            const secs = (((host.readyAt ?? this.now()) - host.startedAt) / 1000).toFixed(1);
            return { lease: this.lease(ep, 'host', host, [`Started the engine host (${host.mode === 'render' ? 'render, a windowless editor' : 'headless'}, pid ${host.pid}) in ${secs} s; later calls reuse it.`]) };
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
        // Unreal processes without any endpoint are handled by guardOthers.
        return undefined;
    }

    /**
     * Is some other Unreal process opening this project? Asked before a write runs in a
     * process this server owns, and before this server starts any engine process (`starting`).
     *
     * An editor takes a while after it starts to publish its endpoint, and an engine of ours
     * running in that window would put two processes on the same packages (for a start: a
     * second full editor next to the user's). So for a process that started less than
     * `editorLaunchWindowMs` ago (or whose start time is unknown), wait for its endpoint and
     * hand the call to it. If none appears within `editorWaitMs`, or the process has had the
     * project open for longer than the window: writes are refused, reads go ahead.
     */
    private async guardOthers(ws: Workspace, plugin: FoundPlugin, action: ActionSpec, onProgress: StartProgress | undefined, starting: boolean): Promise<Acquired | undefined> {
        if (!action.writes && !starting) return undefined;
        // Measured from here, so "waited N s" includes the process check.
        const t0 = this.now();
        const holders = await this.foreignHolders(ws);
        if (!holders.length) return undefined;
        await this.forgetGiveUpsWithEndpoint(ws, plugin);
        const young = holders.filter(h => h.startedAt === undefined || Date.now() - h.startedAt < this.timings.editorLaunchWindowMs);
        // A process this server already waited the full limit for is not waited for again.
        const waitable = young.filter(h => !this.gaveUpOn(ws, h.pid));
        const h = waitable[0] ?? young[0] ?? holders[0]!;
        const refuseWrite = (summary: string, next: string[]) => (action.writes ? refuse('editor-without-endpoint', summary, next, { pid: h.pid }) : undefined);
        // An editor that already serves other plugins of this project, but not this one, is
        // not going to publish this endpoint by waiting.
        const others = [...(await this.probeAll(ws)).entries()].filter(([k]) => k !== plugin.manifest!.id).map(([, v]) => v);
        if (others.some(o => o.state === 'alive' && o.disc.mode === 'editor' && o.disc.pid === h.pid))
            return refuseWrite(`The editor (pid ${h.pid}) has this project open but ${plugin.name}'s endpoint is not running in it. Writing from a second process would overwrite the editor's work.`, [
                'Enable the plugin and its DreamMCP endpoint in the editor (or update the plugin), then retry.',
                'Read-only actions still work.',
            ]);
        if (young.length && !waitable.length) {
            const g = this.giveUps.get(EngineManager.key(ws))!.get(h.pid)!;
            return refuseWrite(
                `${h.name} (pid ${h.pid}) has this project open and did not publish a DreamMCP endpoint while dream-mcp waited ${Math.round(g.waitedMs / 1000)} s for it. It is not waited for again until it publishes one (or ${Math.max(1, Math.round((g.until - Date.now()) / 60_000))} min from now).`,
                [
                    'If the editor is still loading, retry once it has finished: when its endpoint appears, the call goes to it.',
                    'If that editor has no DreamMCP endpoint (switched off, or an older plugin), close it or enable the endpoint. Read-only actions still work.',
                ],
            );
        }
        if (!young.length) {
            const mins = h.startedAt ? Math.round((Date.now() - h.startedAt) / 60_000) : undefined;
            return refuseWrite(`${h.name} (pid ${h.pid}) has had this project open${mins !== undefined ? ` for ${mins} min` : ''} without a DreamMCP endpoint. Writing from another engine process could overwrite its work.`, [
                'Close it, or enable the DreamMCP endpoint in it (update the plugin), then retry.',
                'Read-only actions still work.',
            ]);
        }
        const deadline = t0 + this.timings.editorWaitMs;
        let lastNote = t0;
        while (this.now() < deadline) {
            const p = await this.probe(ws, plugin.manifest!.id);
            if (p.state === 'alive' && p.disc.mode === 'editor') {
                this.giveUps.get(EngineManager.key(ws))?.delete(p.disc.pid);
                const own = this.hosts.get(EngineManager.key(ws));
                if (own) this.retireWhenIdle(own, 'the editor opened this project');
                const secs = ((this.now() - t0) / 1000).toFixed(1);
                return { lease: this.lease(p.endpoint, 'editor', undefined, [`An editor (pid ${p.disc.pid}) was opening this project; waited ${secs} s for its endpoint and handed the call to it.`]) };
            }
            if (!this.launcher.isAlive(h.pid)) {
                this.holderCache.delete(EngineManager.key(ws));
                return undefined;
            }
            if (onProgress && this.now() - lastNote >= this.timings.startNoteMs) {
                lastNote = this.now();
                onProgress(`Waiting for ${h.name} (pid ${h.pid}), which is opening this project, to publish its endpoint: ${Math.round((lastNote - t0) / 1000)} s so far.`, lastNote - t0);
            }
            await sleep(250);
        }
        const waitedMs = this.now() - t0;
        this.rememberGiveUp(ws, h, waitedMs);
        return refuseWrite(
            `${h.name} (pid ${h.pid}) has this project open, or is still opening it, and its DreamMCP endpoint did not appear in the ${Math.round(waitedMs / 1000)} s dream-mcp waited. Writing from another engine process now could overwrite what that editor loads or saves.`,
            [
                'If the editor is still loading, wait until it has finished, then retry: it will serve the call.',
                'If that editor has no DreamMCP endpoint (switched off, or an older plugin), close it or enable the endpoint. Read-only actions still work.',
            ],
        );
    }

    /** Processes this server waited the full limit for, per project: pid -> until when the verdict stands. */
    private readonly giveUps = new Map<string, Map<number, { until: number; waitedMs: number }>>();

    private gaveUpOn(ws: Workspace, pid: number): boolean {
        const g = this.giveUps.get(EngineManager.key(ws))?.get(pid);
        if (!g) return false;
        if (Date.now() < g.until && this.launcher.isAlive(pid)) return true;
        this.giveUps.get(EngineManager.key(ws))!.delete(pid);
        return false;
    }

    /** The verdict lasts for the rest of the process's "just started" window. */
    private rememberGiveUp(ws: Workspace, h: ProjectProcess, waitedMs: number): void {
        const key = EngineManager.key(ws);
        let m = this.giveUps.get(key);
        if (!m) this.giveUps.set(key, (m = new Map()));
        m.set(h.pid, { until: (h.startedAt ?? Date.now()) + this.timings.editorLaunchWindowMs, waitedMs });
    }

    /** A discovery file naming the process cancels the verdict: it has an endpoint after all. */
    private async forgetGiveUpsWithEndpoint(ws: Workspace, plugin: FoundPlugin): Promise<void> {
        const m = this.giveUps.get(EngineManager.key(ws));
        if (!m?.size) return;
        for (const p of ws.discovery.active.length ? ws.discovery.active : [plugin]) {
            const disc = await readJsonSettled(discoveryFile(ws.dir, p.manifest!.id), 1, 0);
            if (isDiscovery(disc)) m.delete(disc.pid);
        }
    }

    private readonly holderCache = new Map<string, { sig: string; checkedAt: number; scannedAt: number; holders: ProjectProcess[] }>();

    /**
     * Unreal processes, other than the ones this server started, whose command line names
     * this project. A cheap process list runs first (at most every 2 s); the expensive
     * command-line scan runs only when the set of Unreal processes changed.
     */
    private async foreignHolders(ws: Pick<Workspace, 'uproject'>, maxAgeMs = this.timings.holderRefreshMs * 1.5): Promise<ProjectProcess[]> {
        const key = EngineManager.key(ws);
        const own = this.ownPids();
        const alive = (list: ProjectProcess[]) => list.filter(p => !own.has(p.pid) && this.launcher.isAlive(p.pid));
        const cached = this.holderCache.get(key);
        // While one of our hosts runs, a background refresh keeps this fresh, so a write
        // normally reads the cache instead of waiting for a process list.
        if (cached && this.now() - cached.checkedAt < maxAgeMs) return alive(cached.holders);
        let scan = this.holderScans.get(key);
        if (!scan) {
            scan = this.scanHolders(ws).finally(() => this.holderScans.delete(key));
            this.holderScans.set(key, scan);
        }
        return alive(await scan);
    }

    private readonly holderScans = new Map<string, Promise<ProjectProcess[]>>();

    private async scanHolders(ws: Pick<Workspace, 'uproject'>): Promise<ProjectProcess[]> {
        const key = EngineManager.key(ws);
        const own = this.ownPids();
        const now = this.now();
        const cached = this.holderCache.get(key);
        const pids = await this.launcher.unrealPids();
        const others = pids?.filter(p => !own.has(p)).sort((a, b) => a - b);
        // Without a cheap list, fall back to a time-boxed cache of the expensive scan.
        const sig = others ? others.join(',') : `t${Math.floor(now / 10_000)}`;
        if (cached && cached.sig === sig && now - cached.scannedAt < 60_000) {
            cached.checkedAt = now;
            return cached.holders;
        }
        let holders: ProjectProcess[] = [];
        if (!others || others.length) holders = ((await this.launcher.projectProcesses(ws.uproject)) ?? []).filter(p => !own.has(p.pid));
        this.holderCache.set(key, { sig, checkedAt: now, scannedAt: now, holders });
        return holders;
    }

    private isRunning(host: HostRecord): boolean {
        return host.exitCode === undefined && this.launcher.isAlive(host.pid);
    }

    /** Drop a host whose process is gone. */
    private forget(host: HostRecord): void {
        if (host.watch) clearInterval(host.watch);
        if (host.exitCode === undefined) host.exitCode = null;
        this.lastLogs.set(host.key, host.logs);
        if (this.hosts.get(host.key) === host) this.hosts.delete(host.key);
        this.log(`host pid ${host.pid} is gone`);
    }

    /** True if the host's process exits (or turns out to be gone) within `ms`. */
    private async diesSoon(host: HostRecord, ms: number): Promise<boolean> {
        const end = this.now() + ms;
        for (;;) {
            if (!this.isRunning(host)) return true;
            if (this.now() >= end) return false;
            await sleep(100);
        }
    }

    /** Did this endpoint come up recently enough that "not answering" probably means "still starting"? */
    private recentlyStarted(disc: { startedAt?: string }): boolean {
        const at = disc.startedAt ? Date.parse(disc.startedAt) : NaN;
        return Number.isFinite(at) && Date.now() - at < this.timings.editorStartWindowMs;
    }

    /**
     * Wait for an editor whose discovery file exists to answer `hello`. Returns a lease on it
     * (our own host retires), 'retry' when the picture changed (the file went away or now
     * names another process), or undefined after `ms`.
     */
    private async waitForEditor(ws: Workspace, plugin: FoundPlugin, pid: number, ms: number, onProgress?: StartProgress): Promise<Acquired | 'retry' | undefined> {
        const t0 = this.now();
        let lastNote = t0;
        while (this.now() - t0 < ms) {
            const p = await this.probe(ws, plugin.manifest!.id);
            if (p.state === 'alive' && p.disc.mode === 'editor') {
                const own = this.hosts.get(EngineManager.key(ws));
                if (own) this.retireWhenIdle(own, 'the editor opened this project');
                const secs = ((this.now() - t0) / 1000).toFixed(1);
                return { lease: this.lease(p.endpoint, 'editor', undefined, [`Waited ${secs} s for the editor (pid ${p.disc.pid}) to finish starting, then handed the call to it.`]) };
            }
            if (p.state === 'absent' || p.state === 'stale' || p.disc.pid !== pid) return 'retry';
            if (onProgress && this.now() - lastNote >= this.timings.startNoteMs) {
                lastNote = this.now();
                onProgress(`Waiting for the editor (pid ${pid}) to finish starting: ${Math.round((lastNote - t0) / 1000)} s so far.`, lastNote - t0);
            }
            await sleep(250);
        }
        return undefined;
    }

    /** Wait until a host that is stopping, retiring or temporary is gone. */
    private async whenGone(host: HostRecord): Promise<void> {
        const end = this.now() + this.timings.jobWaitMs + this.timings.stopMs;
        while (this.isRunning(host) && this.hosts.get(host.key) === host && this.now() < end) {
            if (host.stopping) {
                await host.stopping;
                break;
            }
            await sleep(50);
        }
        if (!this.isRunning(host)) this.forget(host);
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
    private async tempRender(ws: Workspace, plugin: FoundPlugin, action: ActionSpec, onProgress?: StartProgress): Promise<Acquired> {
        const key = EngineManager.key(ws);
        let lock = this.renderLocks.get(key);
        if (!lock) this.renderLocks.set(key, (lock = new Mutex()));
        return lock.run(async () => {
            const guard = await this.guardOthers(ws, plugin, action, onProgress, true);
            if (guard) return guard;
            const own = this.hosts.get(key);
            if (own && own.mode === 'render' && this.isRunning(own) && !own.stopping && !own.retire) {
                const ep = await this.helloOn(own, plugin);
                if (ep) return { lease: this.lease(ep, 'temp-render', own, []) };
            }
            if (own) {
                const deadline = this.now() + this.timings.jobWaitMs;
                while (own.inflight > 0 && this.now() < deadline) await sleep(100);
                await this.stopHost(own, 'making room for a render process');
            }
            const started = await this.ensureHost(ws, 'render', true, onProgress);
            if ('refusal' in started) return started;
            const ep = await this.helloOn(started.host, plugin, 15_000);
            if (!ep) {
                await this.stopHost(started.host, 'plugin endpoint missing');
                return refuse('plugin-not-loaded', `The render process started but ${plugin.name} has no endpoint in it.`, ['dream_engine logs shows its output.']);
            }
            const secs = (((started.host.readyAt ?? this.now()) - started.host.startedAt) / 1000).toFixed(1);
            const why = `This project's engine host is headless, so "${action.name}" ran in a separate rendering process (a windowless editor) that took ${secs} s to start and stops afterwards. To keep a rendering host resident, call dream_workspace add with mode "render".`;
            return { lease: this.lease(ep, 'temp-render', started.host, [`Started a temporary render process (pid ${started.host.pid}) in ${secs} s.`], [why]) };
        });
    }

    // ------------------------------------------------------------------ starting

    /** Start this project's host unless one is already starting; concurrent callers share one start. */
    async ensureHost(ws: Workspace, mode: EngineMode, temporary: boolean, onProgress?: StartProgress): Promise<{ host: HostRecord } | { refusal: ResultBody }> {
        const key = EngineManager.key(ws);
        const existing = this.hosts.get(key);
        if (existing && existing.exitCode === undefined && !existing.stopping && existing.readyAt) return { host: existing };
        let listeners = this.startListeners.get(key);
        if (!listeners) this.startListeners.set(key, (listeners = new Set()));
        if (onProgress) listeners.add(onProgress);
        let pending = this.starting.get(key);
        if (!pending) {
            pending = this.startHost(ws, mode, temporary).finally(() => {
                this.starting.delete(key);
                this.startListeners.delete(key);
            });
            this.starting.set(key, pending);
        }
        try {
            const r = await pending;
            return 'pid' in r ? { host: r } : { refusal: r };
        } finally {
            if (onProgress) listeners.delete(onProgress);
        }
    }

    private async startHost(ws: Workspace, requested: EngineMode, temporary: boolean): Promise<HostRecord | ResultBody> {
        if (!ws.engine) return refused('engine-not-found', `Cannot start an engine: ${ws.engineProblem ?? 'the engine was not found'}.`, ['Call dream_workspace add with engineRoot set, or fix EngineAssociation in the .uproject.']);
        if (!ws.engine.editorCmdExists)
            return refused('engine-not-found', `Cannot start an engine: ${ws.engine.editorCmd} does not exist.`, ['Build the editor for this engine, or point engineRoot at an installed engine.']);
        const owner = hostLaunch(ws, requested, 0, 0).owner;
        if (!owner) return refused('no-plugins', 'No Dream plugin with a manifest is active in this project, so there is nothing for an engine host to serve.', ['Call dream_workspace status.']);

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
            const launch = hostLaunch(ws, requested, port, process.pid);
            const { mode, commandlet } = launch;
            if (launch.fallback) this.log(launch.fallback);
            // The token goes in the environment, not on the command line, where any local
            // process could read it from the process list.
            const proc = this.launcher.spawn(ws.engine.editorCmd, launch.args, { cwd: ws.dir, env: { [TOKEN_ENV]: token } });
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
                ...(commandlet ? { commandlet } : {}),
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
                if (host.watch) clearInterval(host.watch);
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

            // A windowless editor's first start (compiling and cache warm-up) can take minutes;
            // keep telling whoever waits that it is still coming.
            const what = mode === 'render' ? 'a windowless editor' : `the ${commandlet} commandlet`;
            const ticker = setInterval(() => {
                const elapsed = this.now() - host.startedAt;
                for (const l of this.startListeners.get(key) ?? []) l(`Starting the engine host (${what}): ${Math.round(elapsed / 1000)} s so far.`, elapsed);
            }, this.timings.startNoteMs);
            ticker.unref();
            let ownerEp: Endpoint | undefined;
            try {
                ownerEp = await this.helloOn(host, owner, this.timings.startMs);
            } finally {
                clearInterval(ticker);
            }
            if (!ownerEp) {
                const tail = host.logs.slice(-20).join('\n');
                const exited = host.exitCode !== undefined;
                if (!exited) await this.stopHost(host, 'did not answer in time');
                return refused(
                    'engine-error',
                    exited
                        ? `The engine host exited with code ${host.exitCode} before its endpoint answered.`
                        : `The engine host (${what}) did not answer within ${Math.round(this.timings.startMs / 1000)} s and was stopped.`,
                    [
                        'dream_engine logs shows the full output.',
                        'dream_workspace doctor checks the engine and manifests.',
                        ...(exited ? [] : ['A first start can take several minutes while the engine compiles and warms its caches; raise DREAM_MCP_START_TIMEOUT_MS, or open the project in the editor once, then retry.']),
                    ],
                    { log: tail },
                );
            }
            host.port = ownerEp.port;
            host.watch = setInterval(() => void this.foreignHolders(host, this.timings.holderRefreshMs * 0.75).catch(() => undefined), this.timings.holderRefreshMs);
            host.watch.unref();
            // Ready means every plugin of the project answers, not just the one whose route
            // answered first: each plugin publishes its endpoint from its own module, a moment
            // apart. One that does not answer in time is marked, not fatal.
            const others = ws.discovery.active.filter(p => p.manifest!.id !== owner.manifest!.id);
            const answered = await Promise.all(others.map(p => this.helloOn(host, p, this.timings.pluginReadyMs)));
            host.notReady = others.filter((_, i) => !answered[i]).map(p => p.manifest!.id);
            if (host.notReady.length) this.log(`host pid ${host.pid}: no endpoint yet for ${host.notReady.join(', ')}`);
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
        if (host) return { lines: host.logs, ...(host.logFile ? { file: host.logFile } : {}), live: this.isRunning(host) && !host.stopping };
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

/** The host form a project's setting really gets: headless needs a plugin with a host commandlet. */
export function effectiveMode(ws: Workspace): EngineMode {
    return hostLaunch(ws, ws.config.engine.mode, 0, 0).mode;
}

/** Why the setting is not honoured, if it is not. */
export function modeFallback(ws: Workspace): string | undefined {
    return hostLaunch(ws, ws.config.engine.mode, 0, 0).fallback;
}
