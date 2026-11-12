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

test('an editor without an endpoint: writes wait for it, then are refused; read-only actions may start a host', async () => {
    const t = await setup();
    const editorProc = dummyProcess();
    try {
        t.launcher.projectProcs = [{ pid: editorProc.pid, name: 'UnrealEditor.exe' }];
        const t0 = Date.now();
        const r = refusal(await t.mgr.acquire(t.ws, t.plugin, t.action('build')));
        assert.ok(Date.now() - t0 >= 500, 'waited for the endpoint first');
        assert.equal(r.reason, 'editor-without-endpoint');
        assert.match(r.summary, new RegExp(`UnrealEditor\\.exe \\(pid ${editorProc.pid}\\) has this project open, or is still opening it`));
        assert.equal(t.launcher.spawned.length, 0);

        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        assert.equal(l.via, 'host');
        await l.release();
    } finally {
        editorProc.kill();
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

test('a temporary rendering process on its way out is never leased again (headless, render then read)', async () => {
    const t = await setup({ config: { mode: 'headless' } });
    try {
        await lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo'))).release();
        const snap = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('snap')));
        const tempPid = snap.pid;
        assert.equal(snap.via, 'temp-render');
        // What the dispatcher does: release, and route the next call straight away.
        const released = snap.release();
        const next = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('build')));
        assert.notEqual(next.pid, tempPid, 'served by the temporary process that is shutting down');
        assert.equal(next.via, 'host');
        assert.equal(next.endpoint.render, false, 'back on a headless host');
        // And a long job on it runs to the end.
        const call = await new EndpointClient(next.endpoint, fastTimings()).call('j', 'build', { file: 'Demo/a.dmo', steps: 3, stepMs: 30 });
        assert.equal(call.kind, 'job');
        if (call.kind === 'job') assert.equal((await new EndpointClient(next.endpoint, fastTimings()).waitJob(call.job, { deadlineMs: 5000 })).status.state, 'done');
        await next.release();
        await released;
        assert.deepEqual(t.launcher.killed, []);
    } finally {
        await t.done();
    }
});

test('a host that just died is restarted, not reported as "plugin not loaded"', async () => {
    const t = await setup();
    try {
        await lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo'))).release();
        const first = t.launcher.spawned[0]!;
        process.kill(first.pid, 'SIGKILL'); // a crash; the exit event has not been seen yet
        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        assert.equal(l.via, 'host');
        assert.notEqual(l.pid, first.pid);
        assert.equal(t.launcher.spawned.length, 2);
        await l.release();
    } finally {
        await t.done();
    }
});

test('an editor opening the project while our host runs: a write waits for its endpoint and goes to it', async () => {
    const t = await setup();
    const editorProc = dummyProcess();
    try {
        await lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo'))).release();
        const host = t.launcher.spawned[0]!;
        // The editor process exists and names the project, but has no endpoint yet.
        t.launcher.projectProcs = [{ pid: editorProc.pid, name: 'UnrealEditor.exe' }];
        await new Promise(r => setTimeout(r, 250)); // let the background refresh see it
        setTimeout(() => void t.editor({ pid: editorProc.pid }), 300);
        const w = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('build')));
        assert.equal(w.via, 'editor');
        assert.equal(w.pid, editorProc.pid);
        assert.match(w.notes.join(), /was opening this project; waited [\d.]+ s for its endpoint/);
        await w.release();
        await waitFor(() => host.proc.exitCode !== undefined, 5000, 'our host retires');
        assert.deepEqual(t.launcher.killed, []);
    } finally {
        editorProc.kill();
        await t.done();
    }
});

test('an editor that never publishes an endpoint: our host refuses writes after the wait, reads still run', async () => {
    const t = await setup({ timings: { editorWaitMs: 400 } });
    const editorProc = dummyProcess();
    try {
        await lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo'))).release();
        t.launcher.projectProcs = [{ pid: editorProc.pid, name: 'UnrealEditor.exe' }];
        await new Promise(r => setTimeout(r, 250));
        const r = refusal(await t.mgr.acquire(t.ws, t.plugin, t.action('poke')));
        assert.equal(r.reason, 'editor-without-endpoint');
        assert.match(r.next.join(' '), /still loading, wait/);
        const read = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        assert.equal(read.via, 'host');
        await read.release();
        // Once that process is gone, writes run on our host again.
        editorProc.kill();
        await waitFor(() => !t.launcher.isAlive(editorProc.pid), 3000);
        const again = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('poke')));
        assert.equal(again.via, 'host');
        await again.release();
    } finally {
        editorProc.kill();
        await t.done();
    }
});

test('the expensive command-line scan only runs when the set of Unreal processes changes', async () => {
    const t = await setup({ timings: { holderRefreshMs: 50 } });
    try {
        await lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo'))).release();
        for (let i = 0; i < 5; i++) await (lease(await t.mgr.acquire(t.ws, t.plugin, t.action('poke')))).release();
        await new Promise(r => setTimeout(r, 300)); // several background refreshes
        // Only our own host is running, so there was never anything to scan.
        assert.equal(t.launcher.projectScans, 0);
        const other = dummyProcess();
        try {
            t.launcher.projectProcs = [{ pid: other.pid, name: 'UnrealEditor.exe' }];
            await new Promise(r => setTimeout(r, 300));
            const scans = t.launcher.projectScans;
            assert.ok(scans >= 1, 'a new Unreal process triggers one scan');
            await new Promise(r => setTimeout(r, 300));
            assert.equal(t.launcher.projectScans, scans, 'an unchanged process set is not scanned again');
        } finally {
            other.kill();
        }
    } finally {
        await t.done();
    }
});

test('an editor that has published its endpoint but does not answer yet: reads stay on our host, writes wait and then go to the editor', async () => {
    const t = await setup({ timings: { editorWaitMs: 5000 } });
    try {
        await lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo'))).release();
        const host = t.launcher.spawned[0]!;
        const editor = await t.editor({ hang: true }); // discovery file written, main loop still busy
        const read = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        assert.equal(read.via, 'host');
        assert.equal(read.pid, host.pid);
        assert.match(read.notes.join(), /is starting on this project and does not answer yet/);
        await read.release();
        assert.equal(host.proc.exitCode, undefined, 'our host is not retired while the editor cannot answer');

        setTimeout(() => (editor.opts.hang = false), 400);
        const write = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('build')));
        assert.equal(write.via, 'editor');
        assert.match(write.notes.join(), /Waited [\d.]+ s for the editor \(pid \d+\) to finish starting/);
        await write.release();
        await waitFor(() => host.proc.exitCode !== undefined, 5000, 'our host retires once the editor answers');
        const after = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        assert.equal(after.via, 'editor');
        await after.release();
        assert.deepEqual(t.launcher.killed, []);
    } finally {
        await t.done();
    }
});

test('no host of ours and an editor still starting: the call waits for it instead of being refused', async () => {
    const t = await setup({ timings: { editorWarmupMs: 5000 } });
    try {
        const editor = await t.editor({ hang: true });
        setTimeout(() => (editor.opts.hang = false), 400);
        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        assert.equal(l.via, 'editor');
        await l.release();
        assert.equal(t.launcher.spawned.length, 0);
    } finally {
        await t.done();
    }
});

test('an editor that started long ago and does not answer is hung: refused at once, nothing started', async () => {
    const t = await setup({ timings: { editorWarmupMs: 5000, helloMs: 300 } });
    try {
        await t.editor({ hang: true, startedAt: new Date(Date.now() - 3600_000).toISOString() });
        const t0 = Date.now();
        const r = refusal(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        assert.equal(r.reason, 'endpoint-unresponsive');
        assert.ok(Date.now() - t0 < 2000, 'no warm-up wait for an old process');
        assert.equal(t.launcher.spawned.length, 0);
    } finally {
        await t.done();
    }
});

test('an editor that just started but never answers: refused after the warm-up wait, nothing started', async () => {
    const t = await setup({ timings: { editorWarmupMs: 600, helloMs: 200 } });
    try {
        await t.editor({ hang: true });
        const t0 = Date.now();
        const r = refusal(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        assert.equal(r.reason, 'endpoint-unresponsive');
        assert.match(r.summary, /published its .* endpoint but has not answered for \d+ s since/);
        assert.ok(Date.now() - t0 >= 600);
        assert.equal(t.launcher.spawned.length, 0);
    } finally {
        await t.done();
    }
});

test('an editor still starting (process up, no discovery file yet): a read waits for it instead of starting a second engine', async () => {
    const t = await setup({ timings: { editorWaitMs: 5000 } });
    const editorProc = dummyProcess();
    try {
        t.launcher.projectProcs = [{ pid: editorProc.pid, name: 'UnrealEditor.exe', startedAt: Date.now() - 2000 }];
        setTimeout(() => void t.editor({ pid: editorProc.pid }), 400);
        const seen: string[] = [];
        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo'), m => seen.push(m)));
        assert.equal(l.via, 'editor');
        assert.equal(l.pid, editorProc.pid);
        assert.match(l.notes.join(), /was opening this project; waited [\d.]+ s for its endpoint/);
        assert.equal(t.launcher.spawned.length, 0, 'no engine of ours next to the starting editor');
        await l.release();
        const w = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('build')));
        assert.equal(w.via, 'editor');
        await w.release();
        assert.equal(t.launcher.spawned.length, 0);
    } finally {
        editorProc.kill();
        await t.done();
    }
});

test('a starting editor that never publishes an endpoint: after the wait a read starts a host and a write is refused', async () => {
    const t = await setup({ timings: { editorWaitMs: 500 } });
    const editorProc = dummyProcess();
    try {
        t.launcher.projectProcs = [{ pid: editorProc.pid, name: 'UnrealEditor.exe', startedAt: Date.now() - 1000 }];
        const t0 = Date.now();
        const read = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        assert.ok(Date.now() - t0 >= 500, 'waited first');
        assert.equal(read.via, 'host');
        await read.release();
        const w = refusal(await t.mgr.acquire(t.ws, t.plugin, t.action('poke')));
        assert.equal(w.reason, 'editor-without-endpoint');
        // The read already waited the full limit for this process, so the write does not wait again.
        assert.match(w.summary, /not waited for again/);
    } finally {
        editorProc.kill();
        await t.done();
    }
});

test('a process that has had the project open for long without an endpoint: no waiting; reads start a host, writes are refused', async () => {
    const t = await setup({ timings: { editorWaitMs: 5000 } });
    const editorProc = dummyProcess();
    try {
        t.launcher.projectProcs = [{ pid: editorProc.pid, name: 'UnrealEditor.exe', startedAt: Date.now() - 3600_000 }];
        const t0 = Date.now();
        const read = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        assert.equal(read.via, 'host');
        assert.ok(Date.now() - t0 < 4000, 'did not wait out editorWaitMs');
        await read.release();
        const t1 = Date.now();
        const w = refusal(await t.mgr.acquire(t.ws, t.plugin, t.action('poke')));
        assert.ok(Date.now() - t1 < 2000, 'refused without waiting');
        assert.equal(w.reason, 'editor-without-endpoint');
        assert.match(w.summary, /has had this project open for 60 min without a DreamMCP endpoint/);
    } finally {
        editorProc.kill();
        await t.done();
    }
});

test('our host already running and an editor starting: reads stay on our host without waiting', async () => {
    const t = await setup({ timings: { editorWaitMs: 5000 } });
    const editorProc = dummyProcess();
    try {
        await lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo'))).release();
        const host = t.launcher.spawned[0]!;
        t.launcher.projectProcs = [{ pid: editorProc.pid, name: 'UnrealEditor.exe', startedAt: Date.now() }];
        await new Promise(r => setTimeout(r, 250));
        const t0 = Date.now();
        const read = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        assert.equal(read.pid, host.pid);
        assert.ok(Date.now() - t0 < 1500, 'reads do not wait');
        await read.release();
        assert.equal(t.launcher.spawned.length, 1);
    } finally {
        editorProc.kill();
        await t.done();
    }
});

test('a process waited for in full once is not waited for again: later writes are refused at once, reads go ahead', async () => {
    const t = await setup({ timings: { editorWaitMs: 2000 } });
    const editorProc = dummyProcess();
    try {
        t.launcher.projectProcs = [{ pid: editorProc.pid, name: 'UnrealEditor.exe', startedAt: Date.now() - 1000 }];
        const t0 = Date.now();
        const first = refusal(await t.mgr.acquire(t.ws, t.plugin, t.action('poke')));
        assert.ok(Date.now() - t0 >= 2000);
        assert.match(first.summary, /did not appear in the \d+ s dream-mcp waited/);
        const t1 = Date.now();
        const second = refusal(await t.mgr.acquire(t.ws, t.plugin, t.action('poke')));
        assert.ok(Date.now() - t1 < 1000, `second write waited ${Date.now() - t1} ms`);
        assert.match(second.summary, /did not publish a DreamMCP endpoint while dream-mcp waited \d+ s for it\. It is not waited for again/);
        const t2 = Date.now();
        const read = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('echo')));
        assert.ok(Date.now() - t2 < 3000, 'the read did not wait again');
        assert.equal(read.via, 'host');
        await read.release();
        // Once that process publishes an endpoint, the verdict is forgotten and calls go to it.
        await t.editor({ pid: editorProc.pid });
        const w = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('poke')));
        assert.equal(w.via, 'editor');
        await w.release();
    } finally {
        editorProc.kill();
        await t.done();
    }
});

test('"waited N s" counts from the start of the check, process scan included', async () => {
    const t = await setup({ timings: { editorWaitMs: 5000 } });
    const editorProc = dummyProcess();
    try {
        t.launcher.scanDelayMs = 400;
        t.launcher.projectProcs = [{ pid: editorProc.pid, name: 'UnrealEditor.exe', startedAt: Date.now() }];
        setTimeout(() => void t.editor({ pid: editorProc.pid }), 600);
        const t0 = Date.now();
        const l = lease(await t.mgr.acquire(t.ws, t.plugin, t.action('poke')));
        const total = (Date.now() - t0) / 1000;
        const waited = Number(/waited ([\d.]+) s/.exec(l.notes.join())![1]);
        // The 0.4 s scan is part of the wait (before this fix it was left out, and waited read ~0).
        assert.ok(waited >= 0.35 && waited <= total + 0.05, `waited ${waited} s of ${total} s`);
        await l.release();
    } finally {
        editorProc.kill();
        await t.done();
    }
});
