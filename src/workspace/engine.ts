import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exists, parseJson, readText, toPosix } from '../util/fs.js';

/** The platform lookups engine resolution needs, so tests can supply their own. */
export interface EngineLookup {
    /** Source builds: the `HKCU\Software\Epic Games\Unreal Engine\Builds` value named `key` (or Install.ini on Linux/macOS). */
    sourceBuild(key: string): Promise<string | undefined>;
    /** Launcher installs: the install directory registered for `version` (for example "5.8"). */
    launcherInstall(version: string): Promise<string | undefined>;
}

export interface EngineInfo {
    root: string;
    /** How the root was found, for status output. */
    via: string;
    version?: string;
    /** The command-line editor executable. */
    editorCmd: string;
    editorCmdExists: boolean;
}

function runReg(args: string[]): Promise<string | undefined> {
    return new Promise(resolve => {
        execFile('reg', args, { windowsHide: true, timeout: 5000 }, (error, stdout) => resolve(error ? undefined : stdout));
    });
}

/** Parse `reg query` output for one value. */
function regValue(stdout: string | undefined, name: string): string | undefined {
    if (!stdout) return undefined;
    for (const line of stdout.split(/\r?\n/)) {
        const m = /^\s+(.+?)\s+REG_\w+\s+(.*)$/.exec(line);
        if (m && m[1]!.toLowerCase() === name.toLowerCase()) return m[2]!.trim();
    }
    return undefined;
}

function launcherDatPath(): string {
    if (process.platform === 'win32') return path.join(process.env.ProgramData ?? process.env.ALLUSERSPROFILE ?? '', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat');
    if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat');
    return path.join(os.homedir(), '.config', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat');
}

async function iniValue(file: string, section: string, key: string): Promise<string | undefined> {
    const text = await readText(file);
    if (!text) return undefined;
    let inSection = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('[')) inSection = line.slice(1, -1).toLowerCase() === section.toLowerCase();
        else if (inSection) {
            const eq = line.indexOf('=');
            if (eq > 0 && line.slice(0, eq).trim().toLowerCase() === key.toLowerCase()) return line.slice(eq + 1).trim();
        }
    }
    return undefined;
}

export const systemEngineLookup: EngineLookup = {
    async sourceBuild(key) {
        if (process.platform === 'win32') return regValue(await runReg(['query', 'HKCU\\Software\\Epic Games\\Unreal Engine\\Builds', '/v', key]), key);
        const ini =
            process.platform === 'darwin'
                ? path.join(os.homedir(), 'Library', 'Application Support', 'Epic', 'UnrealEngine', 'Install.ini')
                : path.join(os.homedir(), '.config', 'Epic', 'UnrealEngine', 'Install.ini');
        return iniValue(ini, 'Installations', key);
    },
    async launcherInstall(version) {
        const text = await readText(launcherDatPath());
        if (text) {
            try {
                const data = parseJson(text) as { InstallationList?: { InstallLocation?: string; AppName?: string; AppVersion?: string }[] };
                for (const item of data.InstallationList ?? []) {
                    if (!item.InstallLocation) continue;
                    if (item.AppName === `UE_${version}` || (item.AppVersion ?? '').startsWith(`${version}.`) || item.AppVersion === version)
                        return item.InstallLocation;
                }
            } catch {
                /* fall through to the registry */
            }
        }
        if (process.platform === 'win32')
            return regValue(await runReg(['query', `HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\${version}`, '/v', 'InstalledDirectory']), 'InstalledDirectory');
        return undefined;
    },
};

export function editorCmdPath(root: string): string {
    if (process.platform === 'win32') return path.join(root, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe');
    if (process.platform === 'darwin') return path.join(root, 'Engine', 'Binaries', 'Mac', 'UnrealEditor-Cmd');
    return path.join(root, 'Engine', 'Binaries', 'Linux', 'UnrealEditor-Cmd');
}

export async function engineVersion(root: string): Promise<string | undefined> {
    const text = await readText(path.join(root, 'Engine', 'Build', 'Build.version'));
    if (!text) return undefined;
    try {
        const v = parseJson(text) as { MajorVersion?: number; MinorVersion?: number; PatchVersion?: number };
        if (v.MajorVersion === undefined) return undefined;
        return `${v.MajorVersion}.${v.MinorVersion ?? 0}.${v.PatchVersion ?? 0}`;
    } catch {
        return undefined;
    }
}

async function describe(root: string, via: string): Promise<EngineInfo> {
    const editorCmd = editorCmdPath(root);
    const version = await engineVersion(root);
    return { root: toPosix(path.resolve(root)), via, ...(version ? { version } : {}), editorCmd: toPosix(editorCmd), editorCmdExists: await exists(editorCmd) };
}

export interface EngineResolution {
    engine?: EngineInfo;
    problem?: string;
}

/**
 * Resolve the engine a project uses: an explicit root wins, then `EngineAssociation`
 * (a GUID is a registered source build, a version is a launcher install, empty means
 * the project sits inside an engine tree).
 */
export async function resolveEngine(projectDir: string, association: string | undefined, override: string | undefined, lookup: EngineLookup): Promise<EngineResolution> {
    if (override) {
        const root = path.resolve(projectDir, override);
        if (!(await exists(path.join(root, 'Engine')))) return { problem: `engine.root "${override}" has no Engine folder` };
        return { engine: await describe(root, 'workspace config engine.root') };
    }
    const assoc = (association ?? '').trim();
    if (!assoc) {
        let dir = path.resolve(projectDir);
        for (;;) {
            if (await exists(path.join(dir, 'Engine', 'Build', 'Build.version'))) return { engine: await describe(dir, 'project is inside the engine tree') };
            const up = path.dirname(dir);
            if (up === dir) break;
            dir = up;
        }
        return { problem: 'EngineAssociation is empty and no engine tree contains the project; set engine.root with dream_workspace add' };
    }
    if (/^\{?[0-9A-Fa-f-]{36}\}?$/.test(assoc) || assoc.startsWith('{')) {
        const root = (await lookup.sourceBuild(assoc)) ?? (await lookup.sourceBuild(assoc.replace(/^\{|\}$/g, '')));
        if (!root) return { problem: `source build ${assoc} is not registered (HKCU\\Software\\Epic Games\\Unreal Engine\\Builds); set engine.root with dream_workspace add` };
        return { engine: await describe(root, `registered source build ${assoc}`) };
    }
    const root = await lookup.launcherInstall(assoc);
    if (root) return { engine: await describe(root, `launcher install ${assoc}`) };
    // Some studios register custom builds under a readable name rather than a GUID.
    const custom = await lookup.sourceBuild(assoc);
    if (custom) return { engine: await describe(custom, `registered build "${assoc}"`) };
    return { problem: `engine ${assoc} is not installed (no launcher entry); set engine.root with dream_workspace add` };
}

export async function isDirectory(p: string): Promise<boolean> {
    try {
        return (await fs.stat(p)).isDirectory();
    } catch {
        return false;
    }
}
