import path from 'node:path';
import { DEFAULT_IDLE_MINUTES } from '../config.js';
import { parseJson, readText, samePath, toPosix, writeJsonAtomic } from '../util/fs.js';

export type EngineMode = 'render' | 'headless';

export interface WorkspaceConfig {
    engine: {
        mode: EngineMode;
        idleMinutes: number;
        /** Explicit engine root; overrides EngineAssociation. */
        root?: string;
    };
    /** Fixed port for a host this server starts. Unset means pick a free one. */
    port?: number;
}

export interface WorkspaceEntry extends WorkspaceConfig {
    name: string;
    /** Absolute path of the .uproject, forward slashes. */
    project: string;
    addedAt: string;
}

interface RegistryFile {
    version: 1;
    workspaces: WorkspaceEntry[];
}

export function defaultConfig(): WorkspaceConfig {
    return { engine: { mode: 'render', idleMinutes: DEFAULT_IDLE_MINUTES } };
}

/** `~/.dream-mcp/workspaces.json`. Re-read on every access so two servers see each other's edits. */
export class Registry {
    readonly file: string;

    constructor(home: string) {
        this.file = path.join(home, 'workspaces.json');
    }

    async list(): Promise<WorkspaceEntry[]> {
        const text = await readText(this.file);
        if (!text) return [];
        try {
            const data = parseJson(text) as Partial<RegistryFile>;
            return (data.workspaces ?? []).filter(w => w && typeof w.project === 'string').map(normalize);
        } catch {
            return [];
        }
    }

    async find(key: string): Promise<WorkspaceEntry | undefined> {
        const all = await this.list();
        return all.find(w => w.name.toLowerCase() === key.toLowerCase()) ?? all.find(w => samePath(w.project, key));
    }

    async findByProject(uproject: string): Promise<WorkspaceEntry | undefined> {
        return (await this.list()).find(w => samePath(w.project, uproject));
    }

    async upsert(entry: WorkspaceEntry): Promise<WorkspaceEntry> {
        const all = await this.list();
        const i = all.findIndex(w => samePath(w.project, entry.project));
        if (i >= 0) all[i] = entry;
        else all.push(entry);
        await this.write(all);
        return entry;
    }

    async remove(key: string): Promise<WorkspaceEntry | undefined> {
        const all = await this.list();
        const hit = await this.find(key);
        if (!hit) return undefined;
        await this.write(all.filter(w => !samePath(w.project, hit.project)));
        return hit;
    }

    private async write(workspaces: WorkspaceEntry[]): Promise<void> {
        const data: RegistryFile = { version: 1, workspaces };
        await writeJsonAtomic(this.file, data);
    }
}

function normalize(w: WorkspaceEntry): WorkspaceEntry {
    const base = defaultConfig();
    const mode = w.engine?.mode === 'headless' ? 'headless' : 'render';
    const idle = Number(w.engine?.idleMinutes);
    return {
        name: w.name || path.basename(w.project, '.uproject'),
        project: toPosix(w.project),
        addedAt: w.addedAt ?? new Date(0).toISOString(),
        engine: {
            mode,
            idleMinutes: Number.isFinite(idle) && idle >= 0 ? idle : base.engine.idleMinutes,
            ...(w.engine?.root ? { root: w.engine.root } : {}),
        },
        ...(typeof w.port === 'number' && w.port > 0 ? { port: w.port } : {}),
    };
}
