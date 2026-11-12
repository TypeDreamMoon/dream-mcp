import path from 'node:path';
import { PROTOCOL } from '../config.js';
import { EndpointClient, EndpointError, type Endpoint } from '../protocol/client.js';
import { isDiscovery, type Discovery, type Hello } from '../protocol/types.js';
import { readJsonSettled } from '../util/fs.js';
import { isUnrealImage, type ProcessLauncher } from './process.js';

export function discoveryDir(projectDir: string): string {
    return path.join(projectDir, 'Saved', 'DreamMCP');
}

export function discoveryFile(projectDir: string, id: string): string {
    return path.join(discoveryDir(projectDir), `${id}.json`);
}

export type Probe =
    | { state: 'absent'; detail: string }
    | { state: 'stale'; disc: Discovery; detail: string }
    /** `answered`: hello replied, but with the wrong protocol or id (so it is not merely slow). */
    | { state: 'unresponsive'; disc: Discovery; detail: string; answered: boolean }
    | { state: 'alive'; disc: Discovery; hello: Hello; endpoint: Endpoint; detail: string };

export function endpointOf(disc: Discovery, hello?: Hello): Endpoint {
    return {
        id: disc.id,
        port: disc.port,
        token: disc.token,
        route: disc.route,
        ws: hello?.ws ?? disc.ws ?? null,
        pid: disc.pid,
        mode: hello?.mode ?? disc.mode,
        render: hello?.render ?? disc.render,
    };
}

/**
 * Is plugin `id`'s endpoint alive? All three must hold: the discovery file exists (read
 * with confirmation, see readJsonSettled), its pid is running, and `hello` answers with
 * our protocol. Anything short of that is reported as what it is; only a file whose pid
 * is gone (or now belongs to a non-Unreal program) counts as stale.
 */
export async function probe(projectDir: string, id: string, launcher: ProcessLauncher, timeouts: { helloMs: number; callMs: number; pollMs: number }): Promise<Probe> {
    const raw = await readJsonSettled(discoveryFile(projectDir, id));
    if (raw === undefined) return { state: 'absent', detail: `no discovery file Saved/DreamMCP/${id}.json` };
    if (!isDiscovery(raw)) return { state: 'absent', detail: `Saved/DreamMCP/${id}.json is not a discovery file` };
    const disc = raw;
    if (!launcher.isAlive(disc.pid)) return { state: 'stale', disc, detail: `Saved/DreamMCP/${id}.json names pid ${disc.pid}, which is not running` };
    const client = new EndpointClient(endpointOf(disc), timeouts);
    try {
        const hello = await client.hello();
        if (hello.protocol !== PROTOCOL)
            return { state: 'unresponsive', disc, answered: true, detail: `pid ${disc.pid} speaks protocol ${hello.protocol}, this server speaks ${PROTOCOL}; update the plugin or dream-mcp` };
        if (hello.id && hello.id !== id) return { state: 'unresponsive', disc, answered: true, detail: `port ${disc.port} answers as "${hello.id}", not "${id}"` };
        return { state: 'alive', disc, hello, endpoint: endpointOf(disc, hello), detail: `${disc.mode} pid ${disc.pid} on port ${disc.port}${hello.busy ? ' (busy)' : ''}` };
    } catch (error) {
        const e = error as EndpointError;
        // Nothing listening and the pid is not an Unreal process: the pid was reused after a crash.
        if (e.kind === 'unreachable') {
            const image = await launcher.imageName(disc.pid);
            if (image !== undefined && !isUnrealImage(image)) return { state: 'stale', disc, detail: `pid ${disc.pid} is now ${image}, not an Unreal process` };
        }
        const answered = e.kind !== 'timeout' && e.kind !== 'unreachable';
        return { state: 'unresponsive', disc, answered, detail: `pid ${disc.pid} is running but ${e.message}` };
    }
}
