import { promises as fs } from 'node:fs';
import path from 'node:path';

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Forward slashes, no trailing slash. */
export function toPosix(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Case-insensitive on Windows, where the file system is. */
export function samePath(a: string, b: string): boolean {
    const na = toPosix(path.resolve(a));
    const nb = toPosix(path.resolve(b));
    return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** True when `child` is `parent` or lies below it. */
export function isInside(parent: string, child: string): boolean {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** `child` relative to `root`, with forward slashes. Absolute input outside `root` is returned unchanged. */
export function relTo(root: string, child: string): string {
    if (!path.isAbsolute(child)) return toPosix(child);
    if (!isInside(root, child)) return toPosix(child);
    return toPosix(path.relative(root, child)) || '.';
}

export async function exists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

export async function readText(p: string): Promise<string | undefined> {
    try {
        return await fs.readFile(p, 'utf8');
    } catch {
        return undefined;
    }
}

/** JSON with a leading BOM tolerated, since Unreal writes some files with one. */
export function parseJson(text: string): unknown {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/**
 * Read a JSON file that another process replaces by rename.
 *
 * On Windows a rename over an existing file is not atomic for readers: for a moment the
 * name resolves to nothing, or to a file that is still being written. A single "missing"
 * or torn read is therefore not proof that the file is gone. Look again a few times before
 * believing it, because "gone" is the verdict that can send work to a second process.
 */
export async function readJsonSettled(p: string, attempts = 3, gapMs = 60): Promise<unknown | undefined> {
    for (let i = 0; i < attempts; i++) {
        try {
            return parseJson(await fs.readFile(p, 'utf8'));
        } catch {
            if (i + 1 < attempts) await sleep(gapMs);
        }
    }
    return undefined;
}

/** Write to a sibling temporary and rename over the target, retrying the transient EPERM Windows gives. */
export async function writeJsonAtomic(p: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    for (let i = 0; ; i++) {
        try {
            await fs.rename(tmp, p);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (i < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
                await sleep(30 * (i + 1));
                continue;
            }
            await fs.rm(tmp, { force: true });
            throw error;
        }
    }
}

/** Minimal glob: `**` spans directories, `*` and `?` stay inside one segment. */
export function globToRegExp(glob: string): RegExp {
    const g = toPosix(glob);
    let re = '';
    for (let i = 0; i < g.length; i++) {
        const c = g[i]!;
        if (c === '*') {
            if (g[i + 1] === '*') {
                const slash = g[i + 2] === '/';
                re += slash ? '(?:.*/)?' : '.*';
                i += slash ? 2 : 1;
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else {
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

export function hasGlob(p: string): boolean {
    return /[*?]/.test(p);
}

/** Walk below `root` and return the relative (posix) paths of files matching `glob`. */
export async function globFiles(root: string, glob: string, limit = 2000): Promise<string[]> {
    const pattern = globToRegExp(glob);
    // Only descend as far as the fixed prefix lets us skip.
    const fixed = toPosix(glob).split('/');
    const prefix: string[] = [];
    for (const seg of fixed) {
        if (hasGlob(seg)) break;
        prefix.push(seg);
    }
    if (prefix.length === fixed.length) prefix.pop();
    const start = path.join(root, ...prefix);
    const out: string[] = [];
    async function walk(dir: string): Promise<void> {
        if (out.length >= limit) return;
        let entries: import('node:fs').Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (out.length >= limit) return;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === '.git' || entry.name === 'node_modules') continue;
                await walk(full);
            } else if (entry.isFile()) {
                const rel = toPosix(path.relative(root, full));
                if (pattern.test(rel)) out.push(rel);
            }
        }
    }
    await walk(start);
    return out.sort();
}
