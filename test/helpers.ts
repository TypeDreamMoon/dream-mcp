import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultTimings, type Timings } from '../src/config.js';
import type { ProcessLauncher, ProjectProcess, SpawnedProcess, SpawnOptions } from '../src/engine/process.js';
import type { EngineLookup } from '../src/workspace/engine.js';
import { loadWorkspace, type Workspace } from '../src/workspace/workspace.js';

/** Repository root (this file runs from build/test). */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(REPO, 'test', 'fixtures');
export const HOST_SCRIPT = path.join(REPO, 'build', 'test', 'fake', 'host.js');
export const ENGINE_GUID = '{11111111-2222-3333-4444-555555555555}';

const TMP_ROOT = process.env.DREAM_MCP_TEST_TMP ? path.resolve(process.env.DREAM_MCP_TEST_TMP) : os.tmpdir();

export async function tempDir(prefix: string): Promise<string> {
    await fs.mkdir(TMP_ROOT, { recursive: true });
    return fs.mkdtemp(path.join(TMP_ROOT, `dmcp-${prefix}-`));
}

export async function rmrf(p: string): Promise<void> {
    await fs.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function copyDir(from: string, to: string): Promise<void> {
    await fs.mkdir(to, { recursive: true });
    for (const e of await fs.readdir(from, { withFileTypes: true })) {
        const a = path.join(from, e.name);
        const b = path.join(to, e.name);
        if (e.isDirectory()) await copyDir(a, b);
        else await fs.copyFile(a, b);
    }
}

export interface TestProject {
    root: string;
    dir: string;
    uproject: string;
    engineRoot: string;
    home: string;
    lookup: EngineLookup;
    cleanup(): Promise<void>;
}

export interface ProjectSpec {
    name?: string;
    /** Plugins copied from test/fixtures (folder names), installed under Plugins/. */
    fixtures?: string[];
    /** Extra plugins written from scratch: Plugins/<name>/<name>.uplugin plus a manifest. */
    plugins?: { name: string; manifest: unknown; uplugin?: Record<string, unknown>; at?: string }[];
    uprojectPlugins?: { Name: string; Enabled: boolean }[];
    association?: string;
}

/** A throwaway project, a fake engine tree and a private DREAM_MCP_HOME. */
export async function makeProject(spec: ProjectSpec = {}): Promise<TestProject> {
    const root = await tempDir('proj');
    const name = spec.name ?? 'Game';
    const dir = path.join(root, name);
    const engineRoot = path.join(root, 'Engine58');
    const home = path.join(root, 'home');
    await fs.mkdir(path.join(engineRoot, 'Engine', 'Build'), { recursive: true });
    await fs.writeFile(path.join(engineRoot, 'Engine', 'Build', 'Build.version'), JSON.stringify({ MajorVersion: 5, MinorVersion: 8, PatchVersion: 1 }));
    const bin = process.platform === 'win32' ? ['Win64', 'UnrealEditor-Cmd.exe'] : process.platform === 'darwin' ? ['Mac', 'UnrealEditor-Cmd'] : ['Linux', 'UnrealEditor-Cmd'];
    await fs.mkdir(path.join(engineRoot, 'Engine', 'Binaries', bin[0]!), { recursive: true });
    await fs.writeFile(path.join(engineRoot, 'Engine', 'Binaries', bin[0]!, bin[1]!), '');
    await fs.mkdir(path.join(dir, 'Plugins'), { recursive: true });
    const uproject = path.join(dir, `${name}.uproject`);
    await fs.writeFile(uproject, JSON.stringify({ FileVersion: 3, EngineAssociation: spec.association ?? ENGINE_GUID, Plugins: spec.uprojectPlugins ?? [] }, null, 2));
    for (const f of spec.fixtures ?? []) await copyDir(path.join(FIXTURES, f), path.join(dir, 'Plugins', f));
    for (const p of spec.plugins ?? []) await writePlugin(dir, p);
    await fs.mkdir(path.join(dir, 'Demo', 'Sub'), { recursive: true });
    await fs.writeFile(path.join(dir, 'Demo', 'a.dmo'), 'Floor 1\n');
    await fs.writeFile(path.join(dir, 'Demo', 'Sub', 'b.dmo'), 'Ceil 2\n');
    const lookup: EngineLookup = {
        sourceBuild: async key => (key.toUpperCase() === ENGINE_GUID.toUpperCase() ? engineRoot : undefined),
        launcherInstall: async () => undefined,
    };
    return { root, dir, uproject, engineRoot, home, lookup, cleanup: () => rmrf(root) };
}

export async function writePlugin(dir: string, p: { name: string; manifest: unknown; uplugin?: Record<string, unknown>; at?: string }): Promise<string> {
    const pdir = path.join(dir, 'Plugins', p.at ?? '', p.name);
    await fs.mkdir(path.join(pdir, 'Resources'), { recursive: true });
    await fs.writeFile(path.join(pdir, `${p.name}.uplugin`), JSON.stringify({ FileVersion: 3, VersionName: '0.1.0', ...(p.uplugin ?? {}) }));
    await fs.writeFile(path.join(pdir, 'Resources', 'DreamMCP.json'), typeof p.manifest === 'string' ? p.manifest : JSON.stringify(p.manifest, null, 2));
    return pdir;
}

export async function demoManifest(): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(path.join(FIXTURES, 'DemoPlugin', 'Resources', 'DreamMCP.json'), 'utf8')) as Record<string, unknown>;
}

export function load(p: TestProject, config?: { mode?: 'render' | 'headless'; idleMinutes?: number }): Promise<Workspace> {
    const entry = config
        ? { name: 'Game', project: p.uproject.replace(/\\/g, '/'), addedAt: '', engine: { mode: config.mode ?? 'render', idleMinutes: config.idleMinutes ?? 15 } }
        : undefined;
    return loadWorkspace(p.uproject.replace(/\\/g, '/'), entry, 'test', p.lookup);
}

export function fastTimings(over: Partial<Timings> = {}): Timings {
    return { ...defaultTimings({}), helloMs: 800, callMs: 5000, jobWaitMs: 10_000, pollMs: 20, startMs: 15_000, stopMs: 3000, tickMs: 60_000, startNoteMs: 100, holderRefreshMs: 100, editorWaitMs: 600, editorWarmupMs: 500, ...over };
}

/**
 * Starts test/fake/host.js wherever dream-mcp asks for UnrealEditor-Cmd, records what it
 * was asked to start and kill, and refuses to kill anything it did not start.
 */
export class FakeLauncher implements ProcessLauncher {
    readonly spawned: { command: string; args: string[]; env: Record<string, string>; pid: number; proc: SpawnedProcess }[] = [];
    readonly killed: number[] = [];
    env: Record<string, string> = {};
    /** What projectProcesses() reports (an editor without an endpoint, say). */
    projectProcs: ProjectProcess[] = [];
    /** imageName() answers; spawned hosts are always Unreal. */
    images = new Map<number, string>();

    spawn(command: string, args: string[], opts: SpawnOptions): SpawnedProcess {
        // A DREAM_MCP_TOKEN in the test runner's own environment must not mask a missing one.
        const inherited = { ...process.env };
        delete inherited.DREAM_MCP_TOKEN;
        const env = opts.env ?? {};
        const child = spawn(process.execPath, [HOST_SCRIPT, ...args], { cwd: opts.cwd, env: { ...inherited, ...this.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const lines: ((l: string) => void)[] = [];
        const exits: ((c: number | null) => void)[] = [];
        let exitCode: number | null | undefined;
        let buf = '';
        const feed = (c: Buffer) => {
            buf += c.toString();
            let i: number;
            while ((i = buf.indexOf('\n')) >= 0) {
                const l = buf.slice(0, i).replace(/\r$/, '');
                buf = buf.slice(i + 1);
                for (const h of lines) h(l);
            }
        };
        child.stdout!.on('data', feed);
        child.stderr!.on('data', feed);
        child.on('exit', code => {
            exitCode = code;
            for (const h of exits) h(code);
        });
        const proc: SpawnedProcess = {
            pid: child.pid!,
            get exitCode() {
                return exitCode;
            },
            onExit: cb => (exitCode !== undefined ? cb(exitCode) : void exits.push(cb)),
            onLine: cb => void lines.push(cb),
        };
        this.spawned.push({ command, args, env, pid: child.pid!, proc });
        return proc;
    }

    isAlive(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch (e) {
            return (e as NodeJS.ErrnoException).code === 'EPERM';
        }
    }

    async kill(pid: number): Promise<void> {
        if (!this.spawned.some(s => s.pid === pid)) throw new Error(`dream-mcp tried to kill pid ${pid}, which it did not start`);
        this.killed.push(pid);
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            /* gone */
        }
    }

    /** How many times the expensive command-line scan ran. */
    projectScans = 0;

    async projectProcesses(): Promise<ProjectProcess[]> {
        this.projectScans++;
        return this.projectProcs;
    }

    /** The cheap list: every Unreal process, including the hosts this launcher started. */
    async unrealPids(): Promise<number[]> {
        const own = this.spawned.filter(s => s.proc.exitCode === undefined).map(s => s.pid);
        return [...own, ...this.projectProcs.map(p => p.pid)];
    }

    async imageName(pid: number): Promise<string | undefined> {
        if (this.spawned.some(s => s.pid === pid)) return 'UnrealEditor-Cmd.exe';
        return this.images.get(pid) ?? 'UnrealEditor.exe';
    }

    /** Kill anything still running at the end of a test. */
    async cleanup(): Promise<void> {
        for (const s of this.spawned) if (s.proc.exitCode === undefined) {
            try {
                process.kill(s.pid, 'SIGKILL');
            } catch {
                /* gone */
            }
        }
    }
}

export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000, what = 'condition'): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await cond()) return;
        await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
}

/** A long-lived child process that is not Unreal and listens on nothing (for pid-reuse cases). */
export function dummyProcess(): { pid: number; kill(): void } {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
    return { pid: child.pid!, kill: () => child.kill('SIGKILL') };
}
