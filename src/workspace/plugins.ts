import { promises as fs } from 'node:fs';
import path from 'node:path';
import { checkManifest, type Manifest } from '../manifest.js';
import { parseJson, readText, toPosix } from '../util/fs.js';

export interface UProjectPluginRef {
    Name?: string;
    Enabled?: boolean;
}

export interface FoundPlugin {
    /** Plugin name, from the .uplugin file name. */
    name: string;
    /** Plugin folder. */
    root: string;
    /** Where it was found. */
    source: 'project' | 'engine';
    version?: string;
    enabled: boolean;
    /** Why it is disabled, when it is. */
    disabledBy?: string;
    manifestPath: string;
    manifest?: Manifest;
    errors: string[];
    warnings: string[];
}

const SKIP = new Set(['binaries', 'intermediate', 'source', 'content', 'resources', 'saved', 'config', 'shaders', 'docs', 'node_modules', '.git', 'tests', 'extras']);
export const MANIFEST_RELATIVE = path.join('Resources', 'DreamMCP.json');

/** Find .uplugin files below `dir`, no deeper than `depth` folders. */
async function findUPlugins(dir: string, depth: number): Promise<string[]> {
    let entries: import('node:fs').Dirent[];
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const own = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.uplugin')).map(e => path.join(dir, e.name));
    if (own.length) return own; // a plugin folder does not nest other plugins we care about
    if (depth <= 0) return [];
    const out: string[] = [];
    for (const e of entries) {
        if (!e.isDirectory() || SKIP.has(e.name.toLowerCase())) continue;
        out.push(...(await findUPlugins(path.join(dir, e.name), depth - 1)));
    }
    return out;
}

async function inspect(uplugin: string, source: 'project' | 'engine', refs: UProjectPluginRef[]): Promise<FoundPlugin | undefined> {
    const root = path.dirname(uplugin);
    const manifestPath = path.join(root, MANIFEST_RELATIVE);
    const text = await readText(manifestPath);
    if (text === undefined) return undefined;
    const name = path.basename(uplugin, path.extname(uplugin));

    let version: string | undefined;
    let enabledByDefault = source === 'project';
    try {
        const meta = parseJson((await readText(uplugin)) ?? '{}') as { VersionName?: string; EnabledByDefault?: boolean };
        version = meta.VersionName;
        if (typeof meta.EnabledByDefault === 'boolean') enabledByDefault = meta.EnabledByDefault;
    } catch {
        /* a broken .uplugin is the engine's problem to report */
    }
    const ref = refs.find(r => (r.Name ?? '').toLowerCase() === name.toLowerCase());
    let enabled = ref ? ref.Enabled !== false : enabledByDefault;
    let disabledBy: string | undefined;
    if (!enabled) disabledBy = ref ? 'the .uproject disables it' : 'EnabledByDefault is false and the .uproject does not enable it';

    let manifest: Manifest | undefined;
    let errors: string[] = [];
    let warnings: string[] = [];
    try {
        const check = checkManifest(parseJson(text));
        manifest = check.manifest;
        errors = check.errors;
        warnings = check.warnings;
    } catch (error) {
        errors = [`not valid JSON: ${(error as Error).message}`];
    }
    if (manifest && manifest.plugin.toLowerCase() !== name.toLowerCase())
        warnings.push(`manifest "plugin" is "${manifest.plugin}" but the .uplugin is ${name}.uplugin`);
    if (manifest && !manifest.host && manifest.actions.some(a => a.needs !== 'none'))
        warnings.push('no "host.commandlet": a headless setting falls back to a rendering host (a windowless editor)');
    if (!manifest) enabled = false;

    return {
        name,
        root: toPosix(root),
        source,
        ...(version ? { version } : {}),
        enabled,
        ...(disabledBy ? { disabledBy } : {}),
        manifestPath: toPosix(manifestPath),
        ...(manifest ? { manifest } : {}),
        errors,
        warnings,
    };
}

export interface Discovery {
    plugins: FoundPlugin[];
    /** Usable plugins by manifest id, in host-selection order. */
    active: FoundPlugin[];
    problems: string[];
}

/**
 * Scan `<Project>/Plugins` (and, when given, the engine's Marketplace folder) for plugins
 * that carry `Resources/DreamMCP.json`. Order is stable: project plugins by name, then
 * engine plugins by name. The first active plugin with a host commandlet starts the host.
 */
export async function discoverPlugins(projectDir: string, refs: UProjectPluginRef[], engineRoot?: string): Promise<Discovery> {
    const found: FoundPlugin[] = [];
    const byName = (a: string, b: string) => path.basename(a).toLowerCase().localeCompare(path.basename(b).toLowerCase());
    for (const u of (await findUPlugins(path.join(projectDir, 'Plugins'), 3)).sort(byName)) {
        const p = await inspect(u, 'project', refs);
        if (p) found.push(p);
    }
    if (engineRoot) {
        for (const u of (await findUPlugins(path.join(engineRoot, 'Engine', 'Plugins', 'Marketplace'), 3)).sort(byName)) {
            if (found.some(f => f.name.toLowerCase() === path.basename(u, '.uplugin').toLowerCase())) continue; // project copy wins
            const p = await inspect(u, 'engine', refs);
            if (p) found.push(p);
        }
    }
    const problems: string[] = [];
    const active: FoundPlugin[] = [];
    for (const p of found) {
        if (!p.enabled || !p.manifest) continue;
        const clash = active.find(a => a.manifest!.id === p.manifest!.id);
        if (clash) {
            problems.push(`${p.name} and ${clash.name} both declare id "${p.manifest.id}"; using ${clash.name}`);
            continue;
        }
        active.push(p);
    }
    return { plugins: found, active, problems };
}
