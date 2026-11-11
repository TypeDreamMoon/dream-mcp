/**
 * A Node stand-in for the engine's resident host commandlet. Started with the same
 * arguments dream-mcp passes to UnrealEditor-Cmd. It loads every Dream plugin manifest in
 * the project, serves them on one port, writes the discovery files, exits on /shutdown or
 * when its parent goes away, and deletes only the discovery files that still name it.
 *
 * Environment knobs for tests:
 *   FAKE_HOST_DELAY_MS        wait this long before listening (a slow engine boot)
 *   FAKE_HOST_EXIT_CODE       exit at once with this code (a crash on startup)
 *   FAKE_HOST_IGNORE_SHUTDOWN answer /shutdown but keep running (forces a kill)
 *   FAKE_HOST_PORT_SHIFT      bind to the requested port + this (the port was taken)
 *   FAKE_HOST_WS              offer a WebSocket
 *   FAKE_HOST_SKIP            comma-separated plugin ids that do not load in this process
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { discoverPlugins } from '../../src/workspace/plugins.js';
import { parseJson } from '../../src/util/fs.js';
import { demoBehaviors } from './demo.js';
import { FakeEngine, sleep, type FakeManifest } from './endpoint.js';

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const uproject = argv[0]!;
    const flag = (name: string) => argv.find(a => a.startsWith(`-${name}=`))?.slice(name.length + 2);
    const port = Number(flag('DreamMCPPort'));
    // Same order the engine side uses: the environment first, then the command line.
    const token = process.env.DREAM_MCP_TOKEN || flag('DreamMCPToken');
    if (!token) {
        process.stdout.write('FakeHost: no token (DREAM_MCP_TOKEN or -DreamMCPToken)\n');
        process.exit(4);
    }
    const render = !argv.includes('-nullrhi');
    process.stdout.write(`FakeHost: run=${flag('run')} port=${port} render=${render}\n`);

    if (process.env.FAKE_HOST_EXIT_CODE) {
        process.stdout.write('FakeHost: crashing on purpose\n');
        process.exit(Number(process.env.FAKE_HOST_EXIT_CODE));
    }
    await sleep(Number(process.env.FAKE_HOST_DELAY_MS ?? 0));

    const projectDir = path.dirname(uproject);
    const data = parseJson(await fs.readFile(uproject, 'utf8')) as { Plugins?: { Name?: string; Enabled?: boolean }[] };
    const found = await discoverPlugins(projectDir, data.Plugins ?? []);
    const skip = new Set((process.env.FAKE_HOST_SKIP ?? '').split(',').filter(Boolean));

    let engine: FakeEngine;
    const exit = async (why: string) => {
        process.stdout.write(`FakeHost: exiting (${why})\n`);
        await engine.stop();
        process.exit(0);
    };
    engine = new FakeEngine({
        projectDir,
        mode: 'host',
        render,
        port: port + Number(process.env.FAKE_HOST_PORT_SHIFT ?? 0),
        token,
        ws: !!process.env.FAKE_HOST_WS,
        onShutdown: () => {
            if (process.env.FAKE_HOST_IGNORE_SHUTDOWN) process.stdout.write('FakeHost: ignoring shutdown\n');
            else void exit('shutdown');
        },
    });
    for (const p of found.active) {
        if (skip.has(p.manifest!.id)) continue;
        engine.addPlugin(p.manifest as unknown as FakeManifest, demoBehaviors(engine));
    }
    await engine.start();
    process.stdout.write(`FakeHost: listening on ${engine.port} for ${[...engine.plugins.keys()].join(',')}\n`);

    const parent = process.ppid;
    setInterval(() => {
        try {
            process.kill(parent, 0);
        } catch {
            void exit('parent gone');
        }
    }, 500);
}

main().catch(error => {
    process.stderr.write(`FakeHost failed: ${(error as Error).stack}\n`);
    process.exit(3);
});
