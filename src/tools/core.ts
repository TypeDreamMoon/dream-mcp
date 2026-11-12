import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { DEFAULT_IDLE_MINUTES, SERVER_VERSION } from '../config.js';
import type { Probe } from '../engine/discovery.js';
import { modeFallback, type EngineManager } from '../engine/manager.js';
import { renderResult, textResult } from './format.js';
import { refused } from '../protocol/types.js';
import { exists } from '../util/fs.js';
import type { EngineMode, WorkspaceEntry } from '../workspace/registry.js';
import { resolveUProject, type Workspace, type WorkspaceService } from '../workspace/workspace.js';
import type { CallContext, Dispatcher } from './dispatch.js';

export const WORKSPACE_ACTIONS = ['status', 'list', 'use', 'add', 'remove', 'doctor'] as const;
export const ENGINE_ACTIONS = ['status', 'start', 'stop', 'restart', 'logs', 'job', 'cancel'] as const;

export const WORKSPACE_DESCRIPTION = [
    'Unreal projects (workspaces) for the Dream plugin tools. The current workspace decides which dream_<plugin> tools exist.',
    'Call with {"action": "<name>", "args": {...}}. * = required.',
    'Actions:',
    '- status(): current project, how it was chosen, engine, Dream plugins found and their tools.',
    '- list(): registered workspaces.',
    '- use(project*: string): switch to a project (.uproject path, its folder, or a registered name) for this session; the plugin tools change to match.',
    '- add(project*: string, name?: string, mode?: render|headless, idleMinutes?: number, engineRoot?: string, port?: integer): register a project or change its settings. mode render (default) keeps a windowless editor that can render previews; headless runs a commandlet without rendering (less memory) and starts a rendering process only for actions that need it.',
    '- remove(project*: string): forget a registered project.',
    '- doctor(): check Node, engine, manifests and endpoints, and say what to fix.',
].join('\n');

export const ENGINE_DESCRIPTION = [
    'The Unreal process that serves the dream_<plugin> tools for the current project. Usually automatic: plugin tools use an open editor, or start a background engine host and stop it when idle.',
    'Call with {"action": "<name>", "args": {...}}. * = required.',
    'Actions:',
    '- status(): which process serves each plugin (editor or host), busy or idle, and the host this server started.',
    '- start(mode?: render|headless): start the engine host now so later calls are fast. Does nothing if the editor is open.',
    '- stop(): stop the engine host this server started. Never touches an editor.',
    '- restart(mode?: render|headless): stop, then start the engine host.',
    '- logs(lines?: integer, find?: string): recent output of the engine host.',
    '- job(job*: string): keep waiting for a long action that returned a job id.',
    '- cancel(job*: string): cancel such a job.',
].join('\n');

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function describeProbe(id: string, p: Probe | undefined): string {
    if (!p) return `${id}: not probed`;
    if (p.state === 'alive') return `${id}: ${p.disc.mode} pid ${p.disc.pid}, port ${p.disc.port}, render ${p.hello.render ? 'yes' : 'no'}${p.hello.busy ? ', busy' : ''}${p.hello.plugin ? `, plugin ${p.hello.plugin}` : ''}`;
    if (p.state === 'unresponsive') return `${id}: NOT ANSWERING (${p.detail})`;
    if (p.state === 'stale') return `${id}: not running (stale discovery file: ${p.detail})`;
    return `${id}: not running`;
}

export class CoreTools {
    constructor(
        private readonly workspaces: WorkspaceService,
        private readonly engine: EngineManager,
        private readonly dispatcher: Dispatcher,
        /** Re-sync the plugin tools after the workspace changed. */
        private readonly sync: () => Promise<void>,
    ) {}

    // ------------------------------------------------------------------ dream_workspace

    async workspace(action: string, args: Record<string, unknown>): Promise<CallToolResult> {
        switch (action) {
            case 'status':
                await this.sync();
                return this.status();
            case 'list':
                return this.list();
            case 'use':
                return this.use(args);
            case 'add':
                return this.add(args);
            case 'remove':
                return this.remove(args);
            case 'doctor':
                await this.sync();
                return this.doctor();
            default:
                return renderResult(refused('unknown-action', `dream_workspace has no action "${action}".`, [`Use one of: ${WORKSPACE_ACTIONS.join(', ')}.`]));
        }
    }

    private async status(): Promise<CallToolResult> {
        const { workspace: ws, reason } = await this.workspaces.current();
        if (!ws)
            return textResult(
                [`No workspace: ${reason}.`, 'Only dream_workspace and dream_engine are available.', 'Next: call dream_workspace with {"action": "use", "args": {"project": "<path to .uproject>"}}.'].join('\n'),
                false,
                { workspace: null, reason },
            );
        const lines = [`Project: ${ws.name} (${ws.uproject})`, `Chosen by: ${ws.chosenBy}${ws.registered ? '' : ' (not registered; defaults apply)'}`];
        if (ws.engine) lines.push(`Engine: ${ws.engine.version ?? 'unknown version'} at ${ws.engine.root} (${ws.engine.via})${ws.engine.editorCmdExists ? '' : ' -- UnrealEditor-Cmd is missing'}`);
        else lines.push(`Engine: not found -- ${ws.engineProblem}`);
        lines.push(`Engine host: mode ${ws.config.engine.mode} (${ws.config.engine.mode === 'render' ? 'a windowless editor' : 'a commandlet without rendering'}), idle shutdown after ${ws.config.engine.idleMinutes} min${ws.config.port ? `, port ${ws.config.port}` : ''}`);
        const fallback = modeFallback(ws);
        if (fallback) lines.push(`Note: ${fallback}`);
        const tools: string[] = [];
        if (!ws.discovery.plugins.length) lines.push('Dream plugins: none with a Resources/DreamMCP.json manifest, so there are no plugin tools.');
        else {
            lines.push('Dream plugins:');
            for (const p of ws.discovery.plugins) {
                const active = ws.discovery.active.includes(p);
                const id = p.manifest?.id;
                if (active) tools.push(`dream_${id}`);
                const state = active ? `tool dream_${id}` : !p.manifest ? 'manifest invalid' : !p.enabled ? `disabled (${p.disabledBy})` : 'not used (duplicate id)';
                lines.push(`  ${p.name} ${p.version ?? ''} [${p.source}] -> ${state}`.replace(/ +/g, ' '));
                for (const e of p.errors) lines.push(`    error: ${e}`);
            }
        }
        for (const prob of ws.discovery.problems) lines.push(`Problem: ${prob}`);
        return textResult(lines.join('\n'), false, {
            workspace: { name: ws.name, project: ws.uproject, chosenBy: ws.chosenBy, config: ws.config },
            engine: ws.engine ?? null,
            plugins: ws.discovery.plugins.map(p => ({ name: p.name, version: p.version ?? null, source: p.source, id: p.manifest?.id ?? null, enabled: p.enabled, errors: p.errors, warnings: p.warnings })),
            tools,
        });
    }

    private async list(): Promise<CallToolResult> {
        const all = await this.workspaces.registry.list();
        const cur = this.workspaces.last;
        if (!all.length) return textResult(`No registered workspaces${cur ? `; current is ${cur.uproject} (unregistered)` : ''}. Register one with {"action": "add", "args": {"project": "<path>"}}.`, false, { workspaces: [] });
        const lines = all.map(w => `${cur && cur.uproject.toLowerCase() === w.project.toLowerCase() ? '*' : ' '} ${w.name}  ${w.project}  mode=${w.engine.mode} idle=${w.engine.idleMinutes}m${w.engine.root ? ` engineRoot=${w.engine.root}` : ''}${w.port ? ` port=${w.port}` : ''}`);
        return textResult(['Registered workspaces (* = current):', ...lines].join('\n'), false, { workspaces: all });
    }

    private async lookupProject(input: string): Promise<string | undefined> {
        const entry = await this.workspaces.registry.find(input);
        if (entry && (await exists(entry.project))) return entry.project;
        return resolveUProject(input);
    }

    private async use(args: Record<string, unknown>): Promise<CallToolResult> {
        const input = str(args.project) ?? str(args.name);
        if (!input) return renderResult(refused('bad-args', 'use needs "project": a .uproject path, its folder, or a registered name.'));
        const uproject = await this.lookupProject(input);
        if (!uproject) return renderResult(refused('not-found', `"${input}" is not a .uproject, a folder with one, or a registered workspace.`, ['Call dream_workspace list to see registered names.']));
        this.workspaces.use(uproject);
        await this.sync();
        return this.status();
    }

    private async add(args: Record<string, unknown>): Promise<CallToolResult> {
        const input = str(args.project);
        if (!input) return renderResult(refused('bad-args', 'add needs "project": a .uproject path or its folder.'));
        const uproject = await this.lookupProject(input);
        if (!uproject) return renderResult(refused('not-found', `"${input}" is not a .uproject or a folder with one.`));
        const prev = await this.workspaces.registry.findByProject(uproject);
        const mode = args.mode === undefined ? prev?.engine.mode ?? 'render' : args.mode;
        if (mode !== 'render' && mode !== 'headless') return renderResult(refused('bad-args', 'mode must be "render" or "headless".'));
        const idle = args.idleMinutes === undefined ? prev?.engine.idleMinutes ?? DEFAULT_IDLE_MINUTES : Number(args.idleMinutes);
        if (!Number.isFinite(idle) || idle < 0) return renderResult(refused('bad-args', 'idleMinutes must be a number >= 0.'));
        const port = args.port === undefined ? prev?.port : Number(args.port) || undefined;
        if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) return renderResult(refused('bad-args', 'port must be an integer between 1024 and 65535.'));
        const root = args.engineRoot === undefined ? prev?.engine.root : str(args.engineRoot);
        const entry: WorkspaceEntry = {
            name: str(args.name) ?? prev?.name ?? path.basename(uproject, '.uproject'),
            project: uproject,
            addedAt: prev?.addedAt ?? new Date().toISOString(),
            engine: { mode: mode as EngineMode, idleMinutes: idle, ...(root ? { root } : {}) },
            ...(port ? { port } : {}),
        };
        await this.workspaces.registry.upsert(entry);
        await this.sync();
        const changedMode = prev && prev.engine.mode !== entry.engine.mode && this.engine.allHosts().some(h => h.uproject.toLowerCase() === uproject.toLowerCase());
        return textResult(
            `${prev ? 'Updated' : 'Registered'} ${entry.name}: ${entry.project}, mode ${entry.engine.mode}, idle ${entry.engine.idleMinutes} min${root ? `, engine ${root}` : ''}${port ? `, port ${port}` : ''}.${changedMode ? ' The running host keeps its old mode until dream_engine restart.' : ''}`,
            false,
            { workspace: entry },
        );
    }

    private async remove(args: Record<string, unknown>): Promise<CallToolResult> {
        const input = str(args.project) ?? str(args.name);
        if (!input) return renderResult(refused('bad-args', 'remove needs "project": a registered name or .uproject path.'));
        const hit = await this.workspaces.registry.remove(input);
        if (!hit) return renderResult(refused('not-found', `"${input}" is not registered.`, ['Call dream_workspace list.']));
        await this.sync();
        return textResult(`Removed ${hit.name} (${hit.project}) from the registry. Project files are untouched.`);
    }

    private async doctor(): Promise<CallToolResult> {
        const checks: { ok: boolean; what: string; fix?: string }[] = [];
        const major = Number(process.versions.node.split('.')[0]);
        checks.push({ ok: major >= 20, what: `Node ${process.versions.node}`, fix: 'Install Node 20 or newer.' });
        checks.push({ ok: true, what: `dream-mcp ${SERVER_VERSION}; registry ${this.workspaces.registry.file}` });
        const { workspace: ws, reason } = await this.workspaces.current();
        if (!ws) {
            checks.push({ ok: false, what: `No workspace: ${reason}`, fix: 'Call dream_workspace use with a .uproject path, or set DREAM_MCP_PROJECT.' });
        } else {
            checks.push({ ok: true, what: `Project ${ws.uproject}` });
            if (!ws.engine) checks.push({ ok: false, what: `Engine not found: ${ws.engineProblem}`, fix: 'Call dream_workspace add with engineRoot.' });
            else {
                checks.push({ ok: true, what: `Engine ${ws.engine.version ?? '?'} at ${ws.engine.root} (${ws.engine.via})` });
                const fallback = modeFallback(ws);
                if (fallback) checks.push({ ok: true, what: `  note: ${fallback}` });
                checks.push({ ok: ws.engine.editorCmdExists, what: `UnrealEditor-Cmd at ${ws.engine.editorCmd}`, fix: 'Build the editor target or use an installed engine.' });
            }
            if (!ws.discovery.plugins.length) checks.push({ ok: false, what: 'No Dream plugin manifests (Plugins/**/Resources/DreamMCP.json)', fix: 'Install a Dream plugin that ships a manifest.' });
            for (const p of ws.discovery.plugins) {
                checks.push({ ok: !p.errors.length, what: `Manifest ${p.name}${p.manifest ? ` (dream_${p.manifest.id})` : ''}${p.errors.length ? ': ' + p.errors.join('; ') : ''}`, fix: 'Fix the manifest or update the plugin.' });
                for (const w of p.warnings) checks.push({ ok: true, what: `  warning: ${w}` });
                if (!p.enabled && p.manifest) checks.push({ ok: true, what: `  ${p.name} is disabled: ${p.disabledBy}` });
            }
            for (const prob of ws.discovery.problems) checks.push({ ok: false, what: prob, fix: 'Give each plugin a unique id.' });
            const probes = await this.engine.probeAll(ws);
            for (const p of ws.discovery.active) {
                const id = p.manifest!.id;
                const pr = probes.get(id);
                const bad = pr?.state === 'unresponsive';
                checks.push({ ok: !bad, what: `Endpoint ${describeProbe(id, pr)}`, ...(bad ? { fix: 'The process holding the project does not answer; close or restart it.' } : {}) });
                if (pr?.state === 'alive') {
                    const missing = p.manifest!.actions.filter(a => a.needs !== 'none' && !pr.hello.actions.includes(a.name)).map(a => a.name);
                    if (missing.length) checks.push({ ok: false, what: `  ${id} endpoint does not offer: ${missing.join(', ')}`, fix: 'The manifest and the running plugin build differ; rebuild the plugin.' });
                }
            }
        }
        const failed = checks.filter(c => !c.ok);
        const lines = checks.map(c => `${c.ok ? 'ok  ' : 'FAIL'} ${c.what}${!c.ok && c.fix ? `\n     fix: ${c.fix}` : ''}`);
        lines.unshift(failed.length ? `${failed.length} problem(s) found.` : 'All checks passed.');
        return textResult(lines.join('\n'), false, { checks });
    }

    // ------------------------------------------------------------------ dream_engine

    async engineTool(action: string, args: Record<string, unknown>, ctx: CallContext): Promise<CallToolResult> {
        if (action === 'job' || action === 'cancel') {
            const job = str(args.job);
            if (!job) return renderResult(refused('bad-args', `${action} needs "job": the job id a long action returned.`));
            return action === 'job' ? this.dispatcher.job(job, ctx) : this.dispatcher.cancel(job);
        }
        if (!(ENGINE_ACTIONS as readonly string[]).includes(action))
            return renderResult(refused('unknown-action', `dream_engine has no action "${action}".`, [`Use one of: ${ENGINE_ACTIONS.join(', ')}.`]));
        const { workspace: ws, reason } = await this.workspaces.current();
        if (!ws) return renderResult(refused('no-workspace', `No workspace: ${reason}.`, ['Call dream_workspace use first.']));
        switch (action) {
            case 'status':
                return this.engineStatus(ws);
            case 'start':
                return this.start(ws, args, ctx);
            case 'stop': {
                const h = await this.engine.stop(ws, 'dream_engine stop');
                return textResult(h ? `Stopped the engine host (pid ${h.pid}).` : 'This server has no engine host running for this project. (An open editor is never stopped.)');
            }
            case 'restart': {
                const h = await this.engine.stop(ws, 'dream_engine restart');
                const r = await this.start(ws, args, ctx);
                return h ? { ...r, content: [{ type: 'text', text: `Stopped pid ${h.pid}.` }, ...r.content] } : r;
            }
            case 'logs': {
                const { lines, file, live } = this.engine.logs(ws);
                const n = Math.max(1, Math.min(2000, Number(args.lines ?? 100) || 100));
                const find = str(args.find)?.toLowerCase();
                const pick = (find ? lines.filter(l => l.toLowerCase().includes(find)) : lines).slice(-n);
                if (!lines.length) return textResult('No engine host output yet. Logs exist only for hosts this server started.');
                return textResult(`${live ? 'Running host' : 'Last host (no longer running)'} output, ${pick.length} line(s)${file ? ` (full log: ${file})` : ''}:\n${pick.join('\n')}`);
            }
        }
        return textResult('unreachable');
    }

    private async engineStatus(ws: Workspace): Promise<CallToolResult> {
        const probes = await this.engine.probeAll(ws);
        const lines = [`Project: ${ws.name}`];
        if (!ws.discovery.active.length) lines.push('No Dream plugins with manifests, so nothing to serve.');
        for (const p of ws.discovery.active) lines.push('  ' + describeProbe(p.manifest!.id, probes.get(p.manifest!.id)));
        const own = this.engine.host(ws);
        const gone = own && (own.exitCode !== undefined || !this.engine.pidAlive(own.pid));
        if (own && gone) lines.push(`The host this server started (pid ${own.pid}) has exited. The next call starts a new one in ${ws.config.engine.mode} mode unless the editor is open.`);
        else if (own && own.stopping)
            lines.push(`Host started by this server: pid ${own.pid}, ${own.mode}${own.temporary ? ' (temporary)' : ''}, shutting down${own.inflight ? ` after ${own.inflight} call(s) in flight` : ''}. The next call starts a new one if needed.`);
        else if (own) {
            const idle = Math.round((Date.now() - own.lastActive) / 1000);
            lines.push(
                `Host started by this server: pid ${own.pid}, ${own.mode}${own.temporary ? ' (temporary)' : ''}, port ${own.port}, ${own.readyAt ? `up ${Math.round((Date.now() - own.startedAt) / 1000)} s` : 'starting'}, ${own.inflight} in flight, idle ${idle} s of ${own.idleMinutes * 60} s${own.retire ? ', retiring' : ''}`,
            );
        } else lines.push(`No host started by this server. Next call starts one in ${ws.config.engine.mode} mode unless the editor is open.`);
        const jobs = this.dispatcher.listJobs().filter(j => !j.result);
        for (const j of jobs) lines.push(`Running job ${j.job}: ${j.tool} ${j.action}, ${j.status?.state ?? 'running'}`);
        return textResult(lines.join('\n'), false, {
            endpoints: Object.fromEntries([...probes.entries()].map(([k, v]) => [k, v.state === 'alive' ? { state: v.state, mode: v.disc.mode, pid: v.disc.pid, port: v.disc.port, render: v.hello.render, busy: v.hello.busy } : { state: v.state, detail: v.detail }])),
            host: own ? { pid: own.pid, mode: own.mode, port: own.port, state: gone ? 'exited' : own.stopping ? 'stopping' : own.readyAt ? 'running' : 'starting', inflight: own.inflight, temporary: own.temporary } : null,
        });
    }

    private async start(ws: Workspace, args: Record<string, unknown>, ctx: CallContext): Promise<CallToolResult> {
        const mode = args.mode === undefined ? ws.config.engine.mode : args.mode;
        if (mode !== 'render' && mode !== 'headless') return renderResult(refused('bad-args', 'mode must be "render" or "headless".'));
        const probes = await this.engine.probeAll(ws);
        const editor = [...probes.values()].find(p => p.state === 'alive' && p.disc.mode === 'editor');
        if (editor && editor.state === 'alive') return textResult(`The editor (pid ${editor.disc.pid}) is open and serves this project; no host needed.`);
        const hung = [...probes.values()].find(p => p.state === 'unresponsive');
        if (hung && hung.state === 'unresponsive') return renderResult(refused('endpoint-unresponsive', `A process holds this project but does not answer: ${hung.detail}.`, ['Close it, then retry.']));
        const other = [...probes.values()].find(p => p.state === 'alive' && p.disc.mode === 'host');
        const own = this.engine.host(ws);
        if (other && other.state === 'alive' && (!own || own.pid !== other.disc.pid)) return textResult(`An engine host started by another dream-mcp (pid ${other.disc.pid}) already serves this project.`);
        const t0 = Date.now();
        const r = await this.engine.ensureHost(ws, mode, false, ctx.progress ? (message, ms) => ctx.progress!(Math.round(ms / 1000), undefined, message) : undefined);
        if ('refusal' in r) return renderResult(r.refusal);
        const h = r.host;
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        return textResult(own && own.pid === h.pid ? `The engine host is already running (pid ${h.pid}, ${h.mode}).` : `Started the engine host (pid ${h.pid}, ${h.mode}, port ${h.port}) in ${secs} s.`, false, {
            pid: h.pid,
            mode: h.mode,
            port: h.port,
        });
    }
}
