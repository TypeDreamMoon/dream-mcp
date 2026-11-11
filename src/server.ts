import { fromJsonSchema, McpServer, type CallToolResult, type RegisteredResource, type RegisteredTool } from '@modelcontextprotocol/server';
import { defaultTimings, homeDir, SERVER_NAME, SERVER_VERSION, type Timings } from './config.js';
import { EngineManager } from './engine/manager.js';
import { nodeLauncher, type ProcessLauncher } from './engine/process.js';
import type { EngineLookup } from './workspace/engine.js';
import type { FoundPlugin } from './workspace/plugins.js';
import { WorkspaceService, type Workspace } from './workspace/workspace.js';
import { CoreTools, ENGINE_ACTIONS, ENGINE_DESCRIPTION, WORKSPACE_ACTIONS, WORKSPACE_DESCRIPTION } from './tools/core.js';
import { describePluginTool } from './tools/describe.js';
import { Dispatcher, readReference, referenceUri, type CallContext } from './tools/dispatch.js';
import { textResult } from './tools/format.js';

export interface DreamServerOptions {
    home?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    launcher?: ProcessLauncher;
    lookup?: EngineLookup;
    timings?: Partial<Timings>;
    log?: (line: string) => void;
}

const INSTRUCTIONS = [
    'Tools for the Dream Unreal Engine plugins. dream_workspace picks the Unreal project; each installed Dream plugin adds one dream_<plugin> tool.',
    'Every tool takes {"action": "<name>", "args": {...}}; the tool description lists the actions. Call {"action": "help"} on a plugin tool for full arguments.',
    'Plugin tools reuse an open Unreal editor, or start a background engine host on first use (slow once, fast after). Results say what to do next.',
].join('\n');

function actionSchema(actions: readonly string[], argsHelp: string) {
    return fromJsonSchema<{ action: string; args?: Record<string, unknown> }>({
        type: 'object',
        properties: {
            action: { type: 'string', enum: [...actions], description: 'What to do; see the tool description.' },
            args: { type: 'object', description: argsHelp, additionalProperties: true },
        },
        required: ['action'],
        additionalProperties: false,
    });
}

type Ctx = { mcpReq: { signal: AbortSignal; _meta?: { progressToken?: string | number }; notify: (n: { method: string; params?: Record<string, unknown> }) => Promise<void> } };

function callContext(ctx: Ctx | undefined): CallContext {
    const token = ctx?.mcpReq?._meta?.progressToken;
    // MCP requires progress to increase. Engine start-up (seconds) and job progress
    // (percent) are different scales, so keep the value monotonic and drop `total` when
    // it had to be bumped.
    let last = -1;
    return {
        ...(ctx?.mcpReq?.signal ? { signal: ctx.mcpReq.signal } : {}),
        ...(token !== undefined
            ? {
                  progress: (raw, rawTotal, message) => {
                      const progress = raw > last ? raw : last + 0.01;
                      const total = progress === raw ? rawTotal : undefined;
                      last = progress;
                      void ctx!.mcpReq
                          .notify({ method: 'notifications/progress', params: { progressToken: token, progress, ...(total !== undefined ? { total } : {}), ...(message ? { message } : {}) } })
                          .catch(() => undefined);
                  },
              }
            : {}),
    };
}

/** Tools and resources registered on one McpServer instance, kept in step with the current workspace. */
class Surface {
    readonly tools = new Map<string, { handle: RegisteredTool; fingerprint: string }>();
    readonly resources = new Map<string, RegisteredResource>();
    constructor(readonly server: McpServer) {}
}

export class DreamServer {
    readonly workspaces: WorkspaceService;
    readonly engine: EngineManager;
    readonly dispatcher: Dispatcher;
    readonly core: CoreTools;
    private readonly surfaces: Surface[] = [];
    private plugins = new Map<string, FoundPlugin>();
    private syncing: Promise<void> = Promise.resolve();
    private readonly log: (line: string) => void;

    constructor(opts: DreamServerOptions = {}) {
        const env = opts.env ?? process.env;
        const home = opts.home ?? homeDir(env);
        this.log = opts.log ?? (line => process.stderr.write(`[dream-mcp] ${line}\n`));
        this.workspaces = new WorkspaceService({ home, env, ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.lookup ? { lookup: opts.lookup } : {}) });
        this.engine = new EngineManager({ launcher: opts.launcher ?? nodeLauncher, timings: { ...defaultTimings(env), ...opts.timings }, home, log: this.log });
        this.dispatcher = new Dispatcher(this.engine);
        this.core = new CoreTools(this.workspaces, this.engine, this.dispatcher, () => this.sync());
    }

    /** A new MCP server instance wired to this state. `serveStdio` may ask for more than one. */
    createMcpServer(): McpServer {
        const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: { listChanged: true }, resources: { listChanged: true } }, instructions: INSTRUCTIONS });
        server.registerTool(
            'dream_workspace',
            { description: WORKSPACE_DESCRIPTION, inputSchema: actionSchema(WORKSPACE_ACTIONS, 'Arguments for the action, for example {"project": "<folder>/MyGame/MyGame.uproject"}.') },
            async input => this.guard(() => this.core.workspace(input.action, input.args ?? {})),
        );
        server.registerTool(
            'dream_engine',
            { description: ENGINE_DESCRIPTION, inputSchema: actionSchema(ENGINE_ACTIONS, 'Arguments for the action, for example {"mode": "headless"} or {"job": "<id>"}.') },
            async (input, ctx) => this.guard(() => this.core.engineTool(input.action, input.args ?? {}, callContext(ctx as unknown as Ctx))),
        );
        const surface = new Surface(server);
        this.surfaces.push(surface);
        this.applyTo(surface);
        return server;
    }

    private async guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
        try {
            return await fn();
        } catch (error) {
            this.log(`tool failed: ${(error as Error).stack ?? error}`);
            return textResult(`dream-mcp internal error: ${(error as Error).message}. Next: call dream_workspace doctor.`, true);
        }
    }

    /** Re-read the current workspace and make the plugin tools match it. */
    sync(): Promise<void> {
        this.syncing = this.syncing.then(async () => {
            const { workspace } = await this.workspaces.current();
            const next = new Map<string, FoundPlugin>();
            for (const p of workspace?.discovery.active ?? []) next.set(p.manifest!.id, p);
            this.plugins = next;
            for (const s of this.surfaces) this.applyTo(s);
        });
        return this.syncing;
    }

    private applyTo(surface: Surface): void {
        for (const [name, entry] of [...surface.tools]) {
            const id = name.slice('dream_'.length);
            if (!this.plugins.has(id)) {
                entry.handle.remove();
                surface.tools.delete(name);
            }
        }
        for (const [id, plugin] of this.plugins) {
            const m = plugin.manifest!;
            const name = `dream_${id}`;
            const fingerprint = JSON.stringify(m);
            const description = describePluginTool(m);
            const inputSchema = actionSchema([...m.actions.map(a => a.name), 'help', 'reference'], 'Arguments for the action, as listed in this description.');
            const have = surface.tools.get(name);
            if (have) {
                if (have.fingerprint !== fingerprint) {
                    have.handle.update({ description, inputSchema } as never);
                    have.fingerprint = fingerprint;
                }
                continue;
            }
            const handle = surface.server.registerTool(name, { title: m.title, description, inputSchema }, async (input, ctx) =>
                this.guard(() => this.callPlugin(id, input.action, input.args ?? {}, callContext(ctx as unknown as Ctx))),
            );
            surface.tools.set(name, { handle, fingerprint });
        }

        const wanted = new Map<string, { plugin: FoundPlugin; path: string; title: string }>();
        for (const plugin of this.plugins.values()) for (const d of plugin.manifest!.reference) wanted.set(referenceUri(plugin.manifest!, d.path), { plugin, path: d.path, title: d.title });
        for (const [uri, handle] of [...surface.resources]) {
            if (!wanted.has(uri)) {
                handle.remove();
                surface.resources.delete(uri);
            }
        }
        for (const [uri, doc] of wanted) {
            if (surface.resources.has(uri)) continue;
            const handle = surface.server.registerResource(
                `${doc.plugin.manifest!.id}: ${doc.title}`,
                uri,
                { title: `${doc.plugin.manifest!.title}: ${doc.title}`, description: `Reference doc shipped with ${doc.plugin.name}.`, mimeType: doc.path.endsWith('.md') ? 'text/markdown' : 'text/plain' },
                async u => {
                    const p = this.plugins.get(doc.plugin.manifest!.id) ?? doc.plugin;
                    const text = (await readReference(p, doc.path)) ?? `${doc.path} is missing from the plugin.`;
                    return { contents: [{ uri: u.href, text, mimeType: doc.path.endsWith('.md') ? 'text/markdown' : 'text/plain' }] };
                },
            );
            surface.resources.set(uri, handle);
        }
    }

    private async callPlugin(id: string, action: string, args: Record<string, unknown>, ctx: CallContext): Promise<CallToolResult> {
        // Re-read the manifest on every call so an updated plugin is picked up without a restart.
        const { workspace } = await this.workspaces.current();
        const plugin = workspace?.discovery.active.find(p => p.manifest!.id === id);
        if (!workspace || !plugin) {
            await this.sync();
            return textResult(`dream_${id} is not available in the current workspace any more. Next: call dream_workspace status.`, true);
        }
        if (JSON.stringify(plugin.manifest) !== JSON.stringify(this.plugins.get(id)?.manifest)) void this.sync();
        return this.dispatcher.call(workspace as Workspace, plugin, action, args, ctx);
    }

    toolNames(): string[] {
        return ['dream_workspace', 'dream_engine', ...[...this.plugins.keys()].map(id => `dream_${id}`)];
    }

    /** Start background work (idle shutdown). */
    start(): void {
        this.engine.startTicking();
    }

    async close(reason = 'dream-mcp is exiting'): Promise<void> {
        await this.engine.stopAll(reason);
    }
}
