import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exists, parseJson, readText, samePath, toPosix } from '../util/fs.js';
import { resolveEngine, systemEngineLookup, type EngineInfo, type EngineLookup } from './engine.js';
import { discoverPlugins, type Discovery, type UProjectPluginRef } from './plugins.js';
import { defaultConfig, Registry, type WorkspaceConfig, type WorkspaceEntry } from './registry.js';

export interface Workspace {
    name: string;
    /** Absolute .uproject path, forward slashes. */
    uproject: string;
    /** Project root, forward slashes. */
    dir: string;
    /** How this workspace became the current one. */
    chosenBy: string;
    registered: boolean;
    config: WorkspaceConfig;
    association?: string;
    engine?: EngineInfo;
    engineProblem?: string;
    discovery: Discovery;
}

/** Accept a .uproject path or a folder holding exactly one; return the .uproject. */
export async function resolveUProject(input: string, base = process.cwd()): Promise<string | undefined> {
    const p = path.resolve(base, input);
    if (p.toLowerCase().endsWith('.uproject')) return (await exists(p)) ? toPosix(p) : undefined;
    return findUProjectIn(p);
}

async function findUProjectIn(dir: string): Promise<string | undefined> {
    let names: string[];
    try {
        names = (await fs.readdir(dir)).filter(n => n.toLowerCase().endsWith('.uproject')).sort();
    } catch {
        return undefined;
    }
    if (!names.length) return undefined;
    const match = names.find(n => path.basename(n, '.uproject').toLowerCase() === path.basename(dir).toLowerCase());
    return toPosix(path.join(dir, match ?? names[0]!));
}

/** Walk up from `start` to the first folder holding a .uproject. */
export async function findUProjectUpward(start: string): Promise<string | undefined> {
    let dir = path.resolve(start);
    for (;;) {
        const hit = await findUProjectIn(dir);
        if (hit) return hit;
        const up = path.dirname(dir);
        if (up === dir) return undefined;
        dir = up;
    }
}

export async function loadWorkspace(uproject: string, entry: WorkspaceEntry | undefined, chosenBy: string, lookup: EngineLookup): Promise<Workspace> {
    const dir = toPosix(path.dirname(uproject));
    const config = entry ? { engine: { ...entry.engine }, ...(entry.port ? { port: entry.port } : {}) } : defaultConfig();
    let association: string | undefined;
    let refs: UProjectPluginRef[] = [];
    try {
        const data = parseJson((await readText(uproject)) ?? '{}') as { EngineAssociation?: string; Plugins?: UProjectPluginRef[] };
        association = data.EngineAssociation;
        refs = Array.isArray(data.Plugins) ? data.Plugins : [];
    } catch {
        /* reported through engineProblem below */
    }
    const resolved = await resolveEngine(dir, association, config.engine.root, lookup);
    const discovery = await discoverPlugins(dir, refs, resolved.engine?.root);
    return {
        name: entry?.name ?? path.basename(uproject, '.uproject'),
        uproject: toPosix(uproject),
        dir,
        chosenBy,
        registered: !!entry,
        config,
        ...(association !== undefined ? { association } : {}),
        ...(resolved.engine ? { engine: resolved.engine } : {}),
        ...(resolved.problem ? { engineProblem: resolved.problem } : {}),
        discovery,
    };
}

export interface WorkspaceServiceOptions {
    home: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    lookup?: EngineLookup;
}

/**
 * Decides which project is current: the one picked with `dream_workspace use` (for the
 * life of this server), else `DREAM_MCP_PROJECT`, else the nearest .uproject above the
 * directory the server was started in.
 */
export class WorkspaceService {
    readonly registry: Registry;
    readonly lookup: EngineLookup;
    private readonly env: NodeJS.ProcessEnv;
    private readonly cwd: string;
    private used?: string;
    private cached?: Workspace;

    constructor(opts: WorkspaceServiceOptions) {
        this.registry = new Registry(opts.home);
        this.env = opts.env ?? process.env;
        this.cwd = opts.cwd ?? process.cwd();
        this.lookup = opts.lookup ?? systemEngineLookup;
    }

    /** The current workspace, re-scanned. `undefined` with a reason when there is none. */
    async current(): Promise<{ workspace?: Workspace; reason?: string }> {
        let uproject: string | undefined;
        let chosenBy = '';
        if (this.used) {
            uproject = this.used;
            chosenBy = 'dream_workspace use';
        } else if (this.env.DREAM_MCP_PROJECT) {
            const fromEnv = this.env.DREAM_MCP_PROJECT;
            const entry = await this.registry.find(fromEnv);
            uproject = entry?.project ?? (await resolveUProject(fromEnv, this.cwd));
            if (!uproject) return { reason: `DREAM_MCP_PROJECT="${fromEnv}" is not a .uproject, a folder holding one, or a registered workspace name` };
            chosenBy = 'DREAM_MCP_PROJECT';
        } else {
            uproject = await findUProjectUpward(this.cwd);
            chosenBy = 'found above the server start folder';
            if (!uproject) return { reason: 'no workspace selected: the server was not started inside an Unreal project, DREAM_MCP_PROJECT is unset, and dream_workspace use was not called' };
        }
        if (!(await exists(uproject))) return { reason: `${uproject} does not exist` };
        const entry = await this.registry.findByProject(uproject);
        this.cached = await loadWorkspace(uproject, entry, chosenBy, this.lookup);
        return { workspace: this.cached };
    }

    /** The last workspace `current()` produced, without touching the disk. */
    get last(): Workspace | undefined {
        return this.cached;
    }

    use(uproject: string): void {
        this.used = toPosix(uproject);
    }

    isUsed(uproject: string): boolean {
        return !!this.used && samePath(this.used, uproject);
    }
}
