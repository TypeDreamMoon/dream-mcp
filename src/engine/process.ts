import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { toPosix } from '../util/fs.js';

export interface SpawnedProcess {
    readonly pid: number;
    /** Exit code once the process has exited; `undefined` while it runs. */
    readonly exitCode: number | null | undefined;
    onExit(cb: (code: number | null) => void): void;
    onLine(cb: (line: string) => void): void;
}

/** `env` is added to this process's environment; secrets go here, never on the command line. */
export interface SpawnOptions {
    cwd: string;
    env?: Record<string, string>;
}

export interface ProjectProcess {
    pid: number;
    name: string;
    /** When the process started (ms since the epoch), if the platform tells. */
    startedAt?: number;
}

/**
 * Everything that touches real processes. The engine manager only goes through this, so
 * tests can substitute a launcher that starts a Node stand-in for the engine.
 */
export interface ProcessLauncher {
    /** Start `command` directly (never through a shell). */
    spawn(command: string, args: string[], opts: SpawnOptions): SpawnedProcess;
    isAlive(pid: number): boolean;
    /** Terminate the process with this PID and its children. Only ever called with a PID this server started. */
    kill(pid: number): Promise<void>;
    /** Unreal processes whose command line names this project. `undefined` when the platform cannot tell. */
    projectProcesses(uproject: string): Promise<ProjectProcess[] | undefined>;
    /** PIDs of all running Unreal editor processes, from a cheap process list (no command lines). `undefined` when it cannot tell. */
    unrealPids(): Promise<number[] | undefined>;
    /** The executable name of a running process, or `undefined`. */
    imageName(pid: number): Promise<string | undefined>;
}

function run(cmd: string, args: string[], timeout = 15000): Promise<string | undefined> {
    return new Promise(resolve => {
        execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error ? undefined : stdout));
    });
}

const UNREAL = /^(UnrealEditor|UE4Editor|UE5Editor)/i;

/** Does a process command line refer to this .uproject? */
export function commandLineNamesProject(commandLine: string, uproject: string): boolean {
    const cl = toPosix(commandLine).toLowerCase();
    const full = toPosix(uproject).toLowerCase();
    if (cl.includes(full)) return true;
    // A bare "Name.uproject" (started from the project folder) also counts; a different
    // folder's project of the same name does not.
    const base = path.basename(full);
    const re = new RegExp(`(^|[\\s"'])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    return re.test(cl);
}

export const nodeLauncher: ProcessLauncher = {
    spawn(command, args, opts) {
        const child = spawn(command, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
        const lineHandlers: ((l: string) => void)[] = [];
        const exitHandlers: ((c: number | null) => void)[] = [];
        let exitCode: number | null | undefined;
        let buffer = '';
        const feed = (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            let i: number;
            while ((i = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, i).replace(/\r$/, '');
                buffer = buffer.slice(i + 1);
                for (const h of lineHandlers) h(line);
            }
        };
        child.stdout?.on('data', feed);
        child.stderr?.on('data', feed);
        const finish = (code: number | null) => {
            if (exitCode !== undefined) return;
            exitCode = code;
            for (const h of exitHandlers) h(code);
        };
        child.on('exit', code => finish(code));
        child.on('error', error => {
            for (const h of lineHandlers) h(`[dream-mcp] failed to start: ${error.message}`);
            finish(-1);
        });
        return {
            get pid() {
                return child.pid ?? -1;
            },
            get exitCode() {
                return exitCode;
            },
            onExit(cb) {
                if (exitCode !== undefined) cb(exitCode);
                else exitHandlers.push(cb);
            },
            onLine(cb) {
                lineHandlers.push(cb);
            },
        };
    },

    isAlive(pid) {
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'EPERM';
        }
    },

    async kill(pid) {
        if (process.platform === 'win32') {
            await run('taskkill', ['/PID', String(pid), '/T', '/F']);
            return;
        }
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            /* already gone */
        }
    },

    async projectProcesses(uproject) {
        if (process.platform === 'win32') {
            const script =
                "Get-CimInstance Win32_Process -Filter \"Name LIKE 'UnrealEditor%' OR Name LIKE 'UE4Editor%' OR Name LIKE 'UE5Editor%'\" | " +
                "Select-Object ProcessId,Name,CommandLine,@{n='Started';e={ if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { $null } }} | ConvertTo-Json -Compress";
            const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
            if (out === undefined) return undefined;
            if (!out.trim()) return [];
            try {
                type Row = { ProcessId: number; Name: string; CommandLine: string | null; Started: number | null };
                const parsed = JSON.parse(out) as Row | Row[];
                const list = Array.isArray(parsed) ? parsed : [parsed];
                return list
                    .filter(p => p.CommandLine && commandLineNamesProject(p.CommandLine, uproject))
                    .map(p => ({ pid: p.ProcessId, name: p.Name, ...(typeof p.Started === 'number' ? { startedAt: p.Started } : {}) }));
            } catch {
                return undefined;
            }
        }
        const out = await run('ps', ['-eo', 'pid=,etimes=,args=']);
        if (out === undefined) return undefined;
        const found: ProjectProcess[] = [];
        const now = Date.now();
        for (const line of out.split('\n')) {
            const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
            if (!m) continue;
            const exe = path.basename(m[3]!.split(/\s+/)[0] ?? '');
            if (UNREAL.test(exe) && commandLineNamesProject(m[3]!, uproject)) found.push({ pid: Number(m[1]), name: exe, startedAt: now - Number(m[2]) * 1000 });
        }
        return found;
    },

    async unrealPids() {
        if (process.platform === 'win32') {
            // Filtered by image name: noticeably faster than a full list on a busy machine.
            const out = await run('tasklist', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq UnrealEditor*']);
            if (out === undefined) return undefined;
            const pids: number[] = [];
            for (const line of out.split(/\r?\n/)) {
                const m = /^"([^"]+)","(\d+)"/.exec(line);
                if (m && UNREAL.test(m[1]!)) pids.push(Number(m[2]));
            }
            return pids;
        }
        const out = await run('ps', ['-eo', 'pid=,comm=']);
        if (out === undefined) return undefined;
        const pids: number[] = [];
        for (const line of out.split('\n')) {
            const m = /^\s*(\d+)\s+(.*)$/.exec(line);
            if (m && UNREAL.test(path.basename(m[2]!.trim()))) pids.push(Number(m[1]));
        }
        return pids;
    },

    async imageName(pid) {
        if (process.platform === 'win32') {
            const out = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
            const m = out && /^"([^"]+)"/.exec(out.trim());
            return m ? m[1] : undefined;
        }
        const out = await run('ps', ['-p', String(pid), '-o', 'comm=']);
        return out?.trim() || undefined;
    },
};

export function isUnrealImage(name: string | undefined): boolean {
    return !!name && UNREAL.test(path.basename(name));
}
