import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Timings } from '../src/config.js';
import { effectiveMode, EngineManager, modeFallback, type Acquired } from '../src/engine/manager.js';
import { EndpointClient } from '../src/protocol/client.js';
import { demoBehaviors } from './fake/demo.js';
import { FakeEngine, type FakeManifest } from './fake/endpoint.js';
import { demoManifest, dummyProcess, fastTimings, FakeLauncher, load, makeProject, waitFor, writePlugin, type ProjectSpec } from './helpers.js';

async function setup(opts: { spec?: ProjectSpec; config?: { mode?: 'render' | 'headless'; idleMinutes?: number }; timings?: Partial<Timings>; clock?: { t: number } } = {}) {
    const p = await makeProject({ fixtures: ['DemoPlugin'], ...opts.spec });
    const ws = await load(p, opts.config);
    const launcher = new FakeLauncher();
    const clock = opts.clock;
    const mgr = new EngineManager({ launcher, timings: fastTimings(opts.timings), home: p.home, ...(clock ? { now: () => clock.t } : {}) });
    const plugin = ws.discovery.active.find(x => x.manifest!.id === 'demo')!;
    const action = (name: string) => plugin.manifest!.actions.find(a => a.name === name)!;
    const editors: FakeEngine[] = [];
    const editor = async (o: Partial<ConstructorParameters<typeof FakeEngine>[0]> = {}, manifest?: FakeManifest) => {
        const e = new FakeEngine({ projectDir: p.dir, mode: 'editor', render: true, ...o });
        e.addPlugin(manifest ?? ((await demoManifest()) as unknown as FakeManifest), demoBehaviors(e));
        await e.start();
        editors.push(e);
        return e;
    };
    return {
        p,
        ws,
        launcher,
        mgr,
        plugin,
        action,
        editor,
        async done() {
            await mgr.stopAll('test over');
            for (const e of editors) await e.stop();
            await launcher.cleanup();
            await p.cleanup();
        },
    };
}

function lease(a: Acquired) {
    if ('refusal' in a) assert.fail(`refused: ${a.refusal.reason} ${a.refusal.summary}`);
    return a.lease;
}

function refusal(a: Acquired) {
    if (!('refusal' in a)) assert.fail(`expected a refusal, got a lease via ${a.lease.via}`);
    return a.refusal;
}

test('rule 1: an open editor serves everything and nothing is started', async () => {
    const t = await setup();
    try {
        const e = await t.editor();
        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('build')));
        assert.equal(l.via, 'editor');
        assert.equal(l.endpoint.port, e.port);
        await l.release();
        assert.equal(t.launcher.spawned.length, 0);
    } finally {
        await t.done();
    }
});

test('rule 3: nothing running starts a render host with the documented command line; rule 2: it is reused', async () => {
    const t = await setup();
    try {
        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        assert.equal(l.via, 'host');
        assert.match(l.notes.join(), /Started the engine host \(render, a windowless editor, pid \d+\) in [\d.]+ s/);
        assert.equal(t.launcher.spawned.length, 1);
        const s = t.launcher.spawned[0]!;
        assert.match(s.command.replace(/\\/g, '/'), /Engine\/Binaries\/\w+\/UnrealEditor-Cmd(\.exe)?$/);
        assert.equal(s.args[0], t.ws.uproject);
        // Rendering form: a windowless full editor, never a commandlet.
        assert.ok(!s.args.some(a => a.startsWith('-run=')), s.args.join(' '));
        for (const f of ['-DreamMCPHost', '-RenderOffscreen', '-unattended', '-nosplash', '-nosound']) assert.ok(s.args.includes(f), f);
        for (const f of ['-nullrhi', '-AllowCommandletRendering']) assert.ok(!s.args.includes(f), f);
        assert.ok(s.args.some(a => /^-DreamMCPPort=\d+$/.test(a)));
        assert.ok(s.args.includes(`-DreamMCPParentPid=${process.pid}`));
        assert.equal(l.endpoint.mode, 'host');
        // The token travels in the environment only, never on the command line.
        assert.ok(!s.args.some(a => /DreamMCPToken|[0-9a-f]{48}/.test(a)), s.args.join(' '));
        assert.match(s.env.DREAM_MCP_TOKEN ?? '', /^[0-9a-f]{48}$/);
        await l.release();

        const again = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('build')));
        assert.equal(again.via, 'host');
        assert.equal(again.pid, l.pid);
        assert.deepEqual(again.notes, []);
        await again.release();
        assert.equal(t.launcher.spawned.length, 1);
    } finally {
        await t.done();
    }
});

test('headless config runs the first plugin\'s host commandlet with -nullrhi', async () => {
    const t = await setup({ config: { mode: 'headless' } });
    try {
        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        const args = t.launcher.spawned[0]!.args;
        assert.deepEqual(args.slice(0, 4), [t.ws.uproject, '-run=DemoHost', '-nullrhi', '-DreamMCPHost']);
        for (const f of ['-unattended', '-nosplash', '-nopause', `-DreamMCPParentPid=${process.pid}`]) assert.ok(args.includes(f), f);
        assert.ok(!args.includes('-RenderOffscreen'));
        assert.match(l.notes.join(), /Started the engine host \(headless, pid \d+\)/);
        assert.equal(l.endpoint.render, false);
        await l.release();
    } finally {
        await t.done();
    }
});

test('headless config without any host commandlet falls back to the rendering form', async () => {
    const demo = await demoManifest();
    const { host: _host, ...noHost } = demo;
    const t = await setup({ config: { mode: 'headless' }, spec: { fixtures: [], plugins: [{ name: 'DemoPlugin', manifest: noHost }] } });
    try {
        assert.equal(effectiveMode(t.ws), 'render');
        assert.match(modeFallback(t.ws) ?? '', /falls back to a rendering host/);
        // A render action needs no temporary process: the fallback host renders.
        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('snap')));
        assert.equal(l.via, 'host');
        assert.equal(t.launcher.spawned.length, 1);
        assert.ok(t.launcher.spawned[0]!.args.includes('-RenderOffscreen'));
        await l.release();
    } finally {
        await t.done();
    }
});

test('the host is told which process is its parent', async () => {
    const t = await setup();
    try {
        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        await l.release();
        assert.match(t.mgr.logs(t.ws).lines.join('\n'), new RegExp(`host=true .*parent=${process.pid}`));
    } finally {
        await t.done();
    }
});

test('concurrent first calls share one start', async () => {
    const t = await setup();
    try {
        t.launcher.env = { FAKE_HOST_DELAY_MS: '300' };
        const all = await Promise.all([0, 1, 2, 3].map(() => t.mgr.acquire(t.ws, t.plugin, t.action('echo'))));
        const leases = all.map(lease);
        assert.equal(t.launcher.spawned.length, 1);
        assert.equal(new Set(leases.map(l => l.pid)).size, 1);
        for (const l of leases) await l.release();
    } finally {
        await t.done();
    }
});

test('a host another dream-mcp started is used, not duplicated', async () => {
    const t = await setup();
    try {
        const other = await t.editor({ mode: 'host' });
        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('build')));
        assert.equal(l.via, 'other-host');
        assert.equal(l.endpoint.port, other.port);
        assert.equal(t.launcher.spawned.length, 0);
        await l.release();
    } finally {
        await t.done();
    }
});

test('discovery file + live pid + no hello: refused, nothing started (hung editor)', async () => {
    const t = await setup({ timings: { helloMs: 300 } });
    try {
        await t.editor({ hang: true });
        for (const a of ['build', 'echo']) {
            const r = refusal(await t.mgr.acquire(t.ws, t.plugin, t.action(a)));
            assert.equal(r.reason, 'endpoint-unresponsive');
            assert.equal(r.outcome, 'refused');
        }
        assert.equal(t.launcher.spawned.length, 0);
    } finally {
        await t.done();
    }
});

test('protocol mismatch counts as not answering', async () => {
    const t = await setup();
    try {
        await t.editor({ protocol: 2 });
        const r = refusal(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        assert.equal(r.reason, 'endpoint-unresponsive');
        assert.match(r.summary, /protocol 2/);
        assert.equal(t.launcher.spawned.length, 0);
    } finally {
        await t.done();
    }
});

test('a discovery file whose pid is gone, or now belongs to a non-Unreal program, is stale', async () => {
    const t = await setup();
    const dummy = dummyProcess();
    try {
        const dir = path.join(t.p.dir, 'Saved', 'DreamMCP');
        await fs.mkdir(dir, { recursive: true });
        const disc = { protocol: 1, id: 'demo', pid: 999_999, port: 1, token: 'x', route: '/dream/demo', ws: null, mode: 'editor', render: true };
        await fs.writeFile(path.join(dir, 'demo.json'), JSON.stringify(disc));
        assert.equal((await t.mgr.probe(t.ws, 'demo')).state, 'stale');

        t.launcher.images.set(dummy.pid, 'node.exe');
        await fs.writeFile(path.join(dir, 'demo.json'), JSON.stringify({ ...disc, pid: dummy.pid }));
        assert.equal((await t.mgr.probe(t.ws, 'demo')).state, 'stale');

        // The same pid reported as an Unreal process is not guessed away.
        t.launcher.images.set(dummy.pid, 'UnrealEditor.exe');
        assert.equal((await t.mgr.probe(t.ws, 'demo')).state, 'unresponsive');

        t.launcher.images.set(dummy.pid, 'node.exe');
        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('build')));
        assert.equal(l.via, 'host');
        await l.release();
    } finally {
        dummy.kill();
        await t.done();
    }
});

test('an editor without an endpoint: writes refused, read-only actions may start a host', async () => {
    const t = await setup();
    try {
        t.launcher.projectProcs = [{ pid: 424242, name: 'UnrealEditor.exe' }];
        const r = refusal(await t.mgr.acquire(t.ws, t.plugin, t.action('build')));
        assert.equal(r.reason, 'editor-without-endpoint');
        assert.match(r.summary, /UnrealEditor\.exe \(pid 424242\)/);
        assert.equal(t.launcher.spawned.length, 0);

        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        assert.equal(l.via, 'host');
        await l.release();
    } finally {
        await t.done();
    }
});

test('editor serves plugin A but not plugin B: writes through B are refused', async () => {
    const demo = await demoManifest();
    const other = { ...demo, id: 'other', plugin: 'OtherPlugin', route: '/dream/other' };
    const t = await setup({ spec: { plugins: [{ name: 'OtherPlugin', manifest: other }] } });
    try {
        await t.editor({}, other as unknown as FakeManifest);
        const r = refusal(await t.mgr.acquire(t.ws, t.plugin, t.action('build')));
        assert.equal(r.reason, 'editor-without-endpoint');
        assert.equal(t.launcher.spawned.length, 0);
    } finally {
        await t.done();
    }
});

test('the editor opening while our host runs: the host finishes its work, then is shut down (not killed)', async () => {
    const t = await setup();
    try {
        const first = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        const hostPid = first.pid;
        const host = t.launcher.spawned[0]!;
        await t.editor();
        // While our lease is open the host must stay.
        const viaEditor = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('build')));
        assert.equal(viaEditor.via, 'editor');
        await new Promise(r => setTimeout(r, 100));
        assert.equal(host.proc.exitCode, undefined, 'host still running while busy');
        await first.release();
        await waitFor(() => host.proc.exitCode !== undefined, 5000, 'host exit');
        assert.deepEqual(t.launcher.killed, []);
        assert.equal(t.mgr.host(t.ws), undefined);
        await viaEditor.release();
        void hostPid;
    } finally {
        await t.done();
    }
});

test('tick also notices the editor and retires an idle host', async () => {
    const t = await setup();
    try {
        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        await l.release();
        const host = t.launcher.spawned[0]!;
        // Simulate the editor appearing: it overwrites the discovery file with its own.
        await t.editor();
        await t.mgr.tick();
        await waitFor(() => host.proc.exitCode !== undefined, 5000, 'host exit');
        assert.deepEqual(t.launcher.killed, []);
    } finally {
        await t.done();
    }
});

test('idle shutdown after engine.idleMinutes, through /shutdown', async () => {
    const clock = { t: 1_000_000 };
    const t = await setup({ config: { idleMinutes: 15 }, clock });
    try {
        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        await l.release();
        const host = t.launcher.spawned[0]!;
        clock.t += 14 * 60_000;
        await t.mgr.tick();
        assert.equal(host.proc.exitCode, undefined);
        assert.ok(t.mgr.host(t.ws));
        clock.t += 2 * 60_000;
        await t.mgr.tick();
        await waitFor(() => host.proc.exitCode !== undefined, 5000, 'host exit');
        assert.equal(t.mgr.host(t.ws), undefined);
        assert.deepEqual(t.launcher.killed, []);
    } finally {
        await t.done();
    }
});

test('a host that ignores /shutdown is killed by the PID dream-mcp recorded, and only that PID', async () => {
    const t = await setup({ timings: { stopMs: 400 } });
    try {
        t.launcher.env = { FAKE_HOST_IGNORE_SHUTDOWN: '1' };
        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        await l.release();
        const pid = t.launcher.spawned[0]!.pid;
        await t.mgr.stop(t.ws, 'test');
        assert.deepEqual(t.launcher.killed, [pid]);
        assert.notEqual(pid, process.pid);
    } finally {
        await t.done();
    }
});

test('a host that crashes on startup is reported with its log, not retried silently', async () => {
    const t = await setup();
    try {
        t.launcher.env = { FAKE_HOST_EXIT_CODE: '7' };
        const r = refusal(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        assert.equal(r.reason, 'engine-error');
        assert.match(r.summary, /exited with code 7/);
        assert.match(String(r.data.log), /crashing on purpose/);
        assert.equal(t.launcher.spawned.length, 1);
        assert.match(t.mgr.logs(t.ws).lines.join('\n'), /crashing on purpose/);
    } finally {
        await t.done();
    }
});

test('a host that moved to another port is found through its discovery file', async () => {
    const t = await setup();
    try {
        t.launcher.env = { FAKE_HOST_PORT_SHIFT: '1' };
        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        const asked = Number(t.launcher.spawned[0]!.args.find(a => a.startsWith('-DreamMCPPort='))!.split('=')[1]);
        assert.equal(l.endpoint.port, asked + 1);
        await l.release();
    } finally {
        await t.done();
    }
});

test('a plugin missing from our host is refused with a fix, not routed elsewhere', async () => {
    const demo = await demoManifest();
    const t = await setup({ spec: { plugins: [{ name: 'ZOther', manifest: { ...demo, id: 'zother', plugin: 'ZOther', route: '/dream/zother', host: undefined } }] } });
    try {
        t.launcher.env = { FAKE_HOST_SKIP: 'zother' };
        const zother = t.ws.discovery.active.find(x => x.manifest!.id === 'zother')!;
        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        await l.release();
        const r = refusal(await t.mgr.acquire(t.ws, zother, zother.manifest!.actions.find(a => a.name === 'echo')!));
        assert.equal(r.reason, 'plugin-not-loaded');
        assert.equal(t.launcher.spawned.length, 1);
    } finally {
        await t.done();
    }
});

test('headless project, render action: resident host stops, a temporary render process does the work and exits', async () => {
    const t = await setup({ config: { mode: 'headless' } });
    try {
        const l1 = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        await l1.release();
        const resident = t.launcher.spawned[0]!;
        const l2 = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('snap')));
        assert.equal(l2.via, 'temp-render');
        assert.match(l2.next.join(), /headless.*separate rendering process \(a windowless editor\)/);
        await waitFor(() => resident.proc.exitCode !== undefined, 5000, 'resident exit');
        const temp = t.launcher.spawned[1]!;
        assert.ok(temp.args.includes('-RenderOffscreen') && !temp.args.some(a => a.startsWith('-run=')), temp.args.join(' '));
        assert.equal(l2.endpoint.render, true);
        await l2.release();
        await waitFor(() => temp.proc.exitCode !== undefined, 5000, 'temp exit');
        assert.deepEqual(t.launcher.killed, []);
        // The next ordinary call brings the headless host back.
        const l3 = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        assert.ok(t.launcher.spawned[2]!.args.includes('-nullrhi') && t.launcher.spawned[2]!.args.includes('-run=DemoHost'));
        await l3.release();
    } finally {
        await t.done();
    }
});

test('another dream-mcp holding the start lock: no second host is spawned', async () => {
    const t = await setup({ timings: { startMs: 1500 } });
    const dummy = dummyProcess();
    try {
        const { createHash } = await import('node:crypto');
        const hash = createHash('sha1').update(t.ws.uproject.toLowerCase()).digest('hex').slice(0, 16);
        await fs.mkdir(path.join(t.p.home, 'locks'), { recursive: true });
        await fs.writeFile(path.join(t.p.home, 'locks', `${hash}.lock`), JSON.stringify({ pid: dummy.pid }));
        // The other server finishes starting its host a moment later.
        setTimeout(() => void t.editor({ mode: 'host' }), 300);
        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        assert.equal(l.via, 'other-host');
        assert.equal(t.launcher.spawned.length, 0);
        await l.release();
    } finally {
        dummy.kill();
        await t.done();
    }
});

test('stopAll stops only hosts this server started; an editor is never asked to shut down', async () => {
    const t = await setup();
    try {
        const e = await t.editor({ writeDiscovery: false });
        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        await l.release();
        await t.mgr.stopAll('exit');
        await waitFor(() => t.launcher.spawned[0]!.proc.exitCode !== undefined, 5000);
        assert.equal(e.requests.filter(r => r.url.endsWith('/shutdown')).length, 0);
        assert.deepEqual(t.launcher.killed, []);
        // And our own endpoint client cannot be talked into stopping an editor either.
        assert.equal(await new EndpointClient({ id: 'demo', port: e.port, token: e.token, route: '/dream/demo', ws: null, pid: process.pid, mode: 'editor', render: true }, fastTimings()).shutdown(), false);
    } finally {
        await t.done();
    }
});

test('the write lock serialises writes per project', async () => {
    const t = await setup();
    try {
        const e = await t.editor();
        const lock = t.mgr.writeLock(t.ws);
        const run = () =>
            lock.run(async () => {
                const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('poke')));
                await new EndpointClient(l.endpoint, fastTimings()).call('x', 'poke', { ms: 80 });
                await l.release();
            });
        await Promise.all([run(), run(), run()]);
        assert.equal(e.maxConcurrentWrites, 1);
        assert.equal(e.calls.length, 3);
    } finally {
        await t.done();
    }
});

void writePlugin;

test('the real launcher hands secrets to the child through the environment', async () => {
    const { nodeLauncher } = await import('../src/engine/process.js');
    const proc = nodeLauncher.spawn(process.execPath, ['-e', 'console.log("token=" + process.env.DREAM_MCP_TOKEN + " argv=" + process.argv.length)'], {
        cwd: process.cwd(),
        env: { DREAM_MCP_TOKEN: 'abc123' },
    });
    const lines: string[] = [];
    proc.onLine(l => lines.push(l));
    await new Promise<void>(r => proc.onExit(() => r()));
    await waitFor(() => lines.some(l => l.startsWith('token=')), 5000, 'child output');
    assert.ok(lines.includes('token=abc123 argv=1'), lines.join('|'));
});
