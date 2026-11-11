import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { DreamServer } from '../src/server.js';
import { demoBehaviors } from './fake/demo.js';
import { FakeEngine, type FakeManifest } from './fake/endpoint.js';
import { demoManifest, fastTimings, FakeLauncher, makeProject, waitFor, writePlugin, type TestProject } from './helpers.js';

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type ToolResult = { content: Content[]; structuredContent?: Record<string, unknown>; isError?: boolean };

async function connect(p: TestProject, opts: { env?: NodeJS.ProcessEnv; cwd?: string; timings?: Parameters<typeof fastTimings>[0] } = {}) {
    const launcher = new FakeLauncher();
    const dream = new DreamServer({
        home: p.home,
        env: opts.env ?? { DREAM_MCP_PROJECT: p.uproject },
        cwd: opts.cwd ?? p.root,
        launcher,
        lookup: p.lookup,
        timings: fastTimings(opts.timings),
        log: () => {},
    });
    await dream.sync();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await dream.createMcpServer().connect(serverSide);
    const changes: string[][] = [];
    const client = new Client({ name: 'test', version: '1.0.0' }, { listChanged: { tools: { debounceMs: 0, onChanged: (_e, tools) => tools && changes.push(tools.map(t => t.name).sort()) } } });
    await client.connect(clientSide);
    const call = async (name: string, action: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
        (await client.callTool({ name, arguments: { action, args }, ...extra })) as unknown as ToolResult;
    const names = async () => (await client.listTools(undefined, { cacheMode: 'refresh' })).tools.map(t => t.name).sort();
    return {
        dream,
        client,
        launcher,
        call,
        names,
        changes,
        text: (r: ToolResult) => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'),
        async done() {
            await client.close();
            await dream.close('test over');
            await launcher.cleanup();
        },
    };
}

async function openEditor(p: TestProject) {
    const e = new FakeEngine({ projectDir: p.dir, mode: 'editor', render: true, ws: true });
    e.addPlugin((await demoManifest()) as unknown as FakeManifest, demoBehaviors(e));
    return e.start();
}

test('no workspace: only the two core tools, and status says why', async () => {
    const p = await makeProject();
    const c = await connect(p, { env: {}, cwd: p.root });
    try {
        const names = await c.names();
        assert.ok(names.includes('dream_workspace') && names.includes('dream_engine'));
        assert.equal(names.filter(n => n.startsWith('dream_')).length, names.includes('dream_demo') ? 3 : names.length);
        const r = await c.call('dream_workspace', 'status');
        assert.match(c.text(r), /No workspace|Project:/);
    } finally {
        await c.done();
        await p.cleanup();
    }
});

test('a project with a manifest gets dream_<id>, described line by line', async () => {
    const p = await makeProject({ fixtures: ['DemoPlugin'] });
    const c = await connect(p);
    try {
        assert.deepEqual(await c.names(), ['dream_demo', 'dream_engine', 'dream_workspace']);
        const tool = (await c.client.listTools()).tools.find(t => t.name === 'dream_demo')!;
        assert.match(tool.description!, /^Demo\. A stand-in plugin/);
        assert.match(tool.description!, /- build\(file\*: string/);
        const schema = tool.inputSchema as unknown as { properties: { action: { enum: string[] } } };
        assert.deepEqual(schema.properties.action.enum, ['echo', 'fail', 'build', 'snap', 'slow', 'stuck', 'poke', 'lookup', 'files', 'help', 'reference']);

        const status = await c.call('dream_workspace', 'status');
        assert.match(c.text(status), /DemoPlugin 1\.2\.3 \[project\] -> tool dream_demo/);
        assert.match(c.text(status), /Engine: 5\.8\.1/);
    } finally {
        await c.done();
        await p.cleanup();
    }
});

test('help, reference (list, read, paging) and reference resources need no engine', async () => {
    const p = await makeProject({ fixtures: ['DemoPlugin'] });
    const c = await connect(p);
    try {
        assert.match(c.text(await c.call('dream_demo', 'help', { action: 'build' })), /file \(string, required\)/);
        const list = await c.call('dream_demo', 'reference');
        assert.match(c.text(list), /1\. Demo language \(Docs\/language\.md\)/);
        const read = await c.call('dream_demo', 'reference', { doc: 'Demo language' });
        assert.match(c.text(read), /A \.dmo file is a list of nodes/);
        const paged = await c.call('dream_demo', 'reference', { doc: '1', offset: 0, limit: 2 });
        assert.match(c.text(paged), /continue with "offset": 2/);
        const res = await c.client.listResources();
        const uri = res.resources.find(r => r.uri.includes('language.md'))!.uri;
        assert.equal(uri, 'dream://demo/reference/Docs/language.md');
        const content = await c.client.readResource({ uri });
        assert.match(String((content.contents[0] as { text?: string }).text), /Demo language/);
        assert.equal(c.launcher.spawned.length, 0);
    } finally {
        await c.done();
        await p.cleanup();
    }
});

test('offline actions read and list files without an engine, and cannot escape', async () => {
    const p = await makeProject({ fixtures: ['DemoPlugin'] });
    const c = await connect(p);
    try {
        const node = await c.call('dream_demo', 'lookup', { name: 'Floor' });
        assert.match(c.text(node), /Plugins\/DemoPlugin\/Docs\/nodes\/Floor\.md:\n# Floor/);
        const missing = await c.call('dream_demo', 'lookup', { name: 'Nope' });
        assert.equal(missing.isError, true);
        assert.match(c.text(missing), /not-found/);
        const escape = await c.call('dream_demo', 'lookup', { name: '../../../Game' });
        assert.match(c.text(escape), /bad-args/);
        const files = await c.call('dream_demo', 'files');
        assert.match(c.text(files), /2 file\(s\)/);
        assert.match(c.text(files), /Demo\/Sub\/b\.dmo/);
        assert.equal(c.launcher.spawned.length, 0);
    } finally {
        await c.done();
        await p.cleanup();
    }
});

test('argument checking uses the manifest schema before anything is sent', async () => {
    const p = await makeProject({ fixtures: ['DemoPlugin'] });
    const c = await connect(p);
    try {
        const r = await c.call('dream_demo', 'echo', {});
        assert.equal(r.isError, true);
        assert.match(c.text(r), /\[refused: bad-args\]/);
        assert.match(c.text(r), /"action": "help", "args": \{"action": "echo"\}/);
        const t = await c.call('dream_demo', 'echo', { text: 5 });
        assert.match(c.text(t), /bad-args/);
        assert.equal(c.launcher.spawned.length, 0);
    } finally {
        await c.done();
        await p.cleanup();
    }
});

test('through the open editor: short, source-error, long with progress, image', async () => {
    const p = await makeProject({ fixtures: ['DemoPlugin'] });
    const editor = await openEditor(p);
    const c = await connect(p);
    try {
        const echo = await c.call('dream_demo', 'echo', { text: 'hello' });
        assert.equal(echo.isError, undefined);
        assert.match(c.text(echo), /^echo: hello/);
        assert.equal((echo.structuredContent!.engine as { via: string }).via, 'editor');

        const fail = await c.call('dream_demo', 'fail', { file: 'Demo/a.dmo' });
        assert.equal(fail.isError, undefined, 'a source error is a successful check');
        assert.match(c.text(fail), /\[source-error\] One error in the source\./);
        assert.match(c.text(fail), /error DEMO1001 Demo\/a\.dmo:3:7 Unknown node "Flor"\. \(hint: Did you mean "Floor"\?\)/);
        assert.match(c.text(fail), /Next:\n {2}- Fix line 3/);

        const progress: number[] = [];
        const build = (await c.client.callTool(
            { name: 'dream_demo', arguments: { action: 'build', args: { file: 'Demo/a.dmo', steps: 3, stepMs: 30 } } },
            { onprogress: (pr: { progress: number }) => progress.push(pr.progress) } as never,
        )) as unknown as ToolResult;
        assert.match(c.text(build), /Built Demo\/a\.dmo\./);
        assert.match(c.text(build), /Writes: \/Game\/Demo\/a \(saved\)/);
        assert.ok(progress.length >= 1, 'progress notifications');

        const snap = await c.call('dream_demo', 'snap', { file: 'Demo/a.dmo' });
        const img = snap.content.find(x => x.type === 'image');
        assert.equal(img?.mimeType, 'image/png');
        assert.ok(img?.data && img.data.length > 20);
        assert.equal(c.launcher.spawned.length, 0);
    } finally {
        await c.done();
        await editor.stop();
        await p.cleanup();
    }
});

test('cold start: the first call starts a host and says how long it took', async () => {
    const p = await makeProject({ fixtures: ['DemoPlugin'] });
    const c = await connect(p);
    try {
        const r = await c.call('dream_demo', 'echo', { text: 'cold' });
        assert.match(c.text(r), /Note: Started the engine host \(render, a windowless editor, pid \d+\) in [\d.]+ s/);
        assert.equal(c.launcher.spawned.length, 1);
        const status = await c.call('dream_engine', 'status');
        assert.match(c.text(status), /Host started by this server: pid \d+, render/);
        const logs = await c.call('dream_engine', 'logs', { find: 'FakeHost' });
        assert.match(c.text(logs), /FakeHost: listening/);
        const stop = await c.call('dream_engine', 'stop');
        assert.match(c.text(stop), /Stopped the engine host/);
        await waitFor(() => c.launcher.spawned[0]!.proc.exitCode !== undefined);
        assert.deepEqual(c.launcher.killed, []);
    } finally {
        await c.done();
        await p.cleanup();
    }
});

test('a job that outlasts the wait hands back an id; dream_engine job and cancel pick it up', async () => {
    const p = await makeProject({ fixtures: ['DemoPlugin'] });
    const editor = await openEditor(p);
    const c = await connect(p, { timings: { jobWaitMs: 150 } });
    try {
        const r = await c.call('dream_demo', 'build', { file: 'Demo/a.dmo', steps: 10, stepMs: 40 });
        const job = r.structuredContent!.job as string;
        assert.match(c.text(r), /still running \(job job-/);
        assert.match(c.text(r), /"action": "job", "args": \{"job": "job-/);
        let later = await c.call('dream_engine', 'job', { job });
        while (/still running/.test(c.text(later))) later = await c.call('dream_engine', 'job', { job });
        assert.match(c.text(later), /Built Demo\/a\.dmo/);

        const slow = await c.call('dream_demo', 'slow');
        const slowJob = slow.structuredContent!.job as string;
        const cancelled = await c.call('dream_engine', 'cancel', { job: slowJob });
        assert.match(c.text(cancelled), /Cancelled job/);
        const unknown = await c.call('dream_engine', 'job', { job: 'nope' });
        assert.match(c.text(unknown), /unknown-job/);
    } finally {
        await c.done();
        await editor.stop();
        await p.cleanup();
    }
});

test('writes through the tool are serialised per project', async () => {
    const p = await makeProject({ fixtures: ['DemoPlugin'] });
    const editor = await openEditor(p);
    const c = await connect(p);
    try {
        await Promise.all([1, 2, 3].map(() => c.call('dream_demo', 'poke', { ms: 60 })));
        await Promise.all([1, 2].map(() => c.call('dream_demo', 'build', { file: 'Demo/a.dmo', steps: 2, stepMs: 40 })));
        assert.equal(editor.maxConcurrentWrites, 1);
    } finally {
        await c.done();
        await editor.stop();
        await p.cleanup();
    }
});

test('a new manifest becomes a working tool with no server change; switching projects notifies the client', async () => {
    const a = await makeProject({ name: 'Alpha', fixtures: ['DemoPlugin'] });
    const b = await makeProject({ name: 'Beta' });
    const c = await connect(a);
    try {
        assert.deepEqual(await c.names(), ['dream_demo', 'dream_engine', 'dream_workspace']);
        // Install a plugin nobody has heard of into Beta and switch to it.
        const zeta = { ...(await demoManifest()), id: 'zeta', plugin: 'Zeta', title: 'Zeta', route: '/dream/zeta', description: 'Made up on the spot.' };
        await writePlugin(b.dir, { name: 'Zeta', manifest: zeta });
        const used = await c.call('dream_workspace', 'use', { project: b.dir });
        assert.match(c.text(used), /Project: Beta/);
        assert.deepEqual(await c.names(), ['dream_engine', 'dream_workspace', 'dream_zeta']);
        await waitFor(() => c.changes.some(x => x.includes('dream_zeta')), 3000, 'tools/list_changed');

        const e = new FakeEngine({ projectDir: b.dir, mode: 'editor', render: true });
        e.addPlugin(zeta as unknown as FakeManifest, demoBehaviors(e));
        await e.start();
        try {
            const r = await c.call('dream_zeta', 'echo', { text: 'z' });
            assert.match(c.text(r), /^echo: z/);
        } finally {
            await e.stop();
        }

        // Removing the manifest removes the tool after a status refresh.
        await fs.rm(path.join(b.dir, 'Plugins', 'Zeta'), { recursive: true });
        await c.call('dream_workspace', 'status');
        assert.deepEqual(await c.names(), ['dream_engine', 'dream_workspace']);
    } finally {
        await c.done();
        await a.cleanup();
        await b.cleanup();
    }
});

test('workspace add / list / remove and doctor', async () => {
    const p = await makeProject({ fixtures: ['DemoPlugin'] });
    const c = await connect(p);
    try {
        const add = await c.call('dream_workspace', 'add', { project: p.uproject, name: 'Mine', mode: 'headless', idleMinutes: 2 });
        assert.match(c.text(add), /Registered Mine: .*mode headless, idle 2 min/);
        assert.match(c.text(await c.call('dream_workspace', 'list')), /\* Mine .* mode=headless idle=2m/);
        const bad = await c.call('dream_workspace', 'add', { project: p.uproject, mode: 'fast' });
        assert.match(c.text(bad), /bad-args/);
        const doc = await c.call('dream_workspace', 'doctor');
        assert.match(c.text(doc), /ok {3}Manifest DemoPlugin \(dream_demo\)/);
        assert.match(c.text(doc), /ok {3}Endpoint demo: not running/);
        assert.match(c.text(await c.call('dream_workspace', 'remove', { project: 'Mine' })), /Removed Mine/);
        assert.match(c.text(await c.call('dream_workspace', 'list')), /No registered workspaces/);
    } finally {
        await c.done();
        await p.cleanup();
    }
});

test('headless project through the tools: a render action stops the resident host and runs in a temporary rendering editor', async () => {
    const p = await makeProject({ fixtures: ['DemoPlugin'] });
    const c = await connect(p);
    try {
        await c.call('dream_workspace', 'add', { project: p.uproject, mode: 'headless' });
        const echo = await c.call('dream_demo', 'echo', { text: 'warm' });
        assert.match(c.text(echo), /Started the engine host \(headless, pid \d+\)/);
        const resident = c.launcher.spawned[0]!;
        assert.ok(resident.args.includes('-run=DemoHost') && resident.args.includes('-nullrhi'));

        const snap = await c.call('dream_demo', 'snap', { file: 'Demo/a.dmo' });
        assert.equal(snap.isError, undefined, c.text(snap));
        assert.equal(snap.content.find(x => x.type === 'image')?.mimeType, 'image/png');
        assert.match(c.text(snap), /headless, so "snap" ran in a separate rendering process \(a windowless editor\)/);
        assert.equal((snap.structuredContent!.engine as { via: string }).via, 'temp-render');
        const temp = c.launcher.spawned[1]!;
        assert.ok(temp.args.includes('-RenderOffscreen') && !temp.args.some(a => a.startsWith('-run=')));
        await waitFor(() => resident.proc.exitCode !== undefined && temp.proc.exitCode !== undefined, 5000, 'both hosts exit');
        assert.deepEqual(c.launcher.killed, []);
    } finally {
        await c.done();
        await p.cleanup();
    }
});

test('a headless host another dream-mcp started: render actions are refused with the reason and the way out', async () => {
    const p = await makeProject({ fixtures: ['DemoPlugin'] });
    const other = new FakeEngine({ projectDir: p.dir, mode: 'host', render: false });
    other.addPlugin((await demoManifest()) as unknown as FakeManifest, demoBehaviors(other));
    await other.start();
    const c = await connect(p);
    try {
        const r = await c.call('dream_demo', 'snap', { file: 'Demo/a.dmo' });
        assert.equal(r.isError, true);
        assert.match(c.text(r), /\[refused: render-unavailable\]/);
        assert.match(c.text(r), /another dream-mcp process started/);
        assert.match(c.text(r), /call dream_engine stop/);
        assert.equal(c.launcher.spawned.length, 0);
        // Non-rendering actions still use that host.
        assert.match(c.text(await c.call('dream_demo', 'echo', { text: 'x' })), /^echo: x/);
    } finally {
        await c.done();
        await other.stop();
        await p.cleanup();
    }
});

test('a slow engine start keeps sending progress notifications', async () => {
    const p = await makeProject({ fixtures: ['DemoPlugin'] });
    const c = await connect(p);
    try {
        c.launcher.env = { FAKE_HOST_DELAY_MS: '600' };
        const seen: { progress: number; message?: string }[] = [];
        const r = (await c.client.callTool(
            { name: 'dream_demo', arguments: { action: 'echo', args: { text: 'slow' } } },
            { onprogress: (pr: { progress: number; message?: string }) => seen.push(pr) } as never,
        )) as unknown as ToolResult;
        assert.match(c.text(r), /^echo: slow/);
        assert.ok(seen.some(s => /Starting the engine host \(a windowless editor\)/.test(s.message ?? '')), JSON.stringify(seen));
        for (let i = 1; i < seen.length; i++) assert.ok(seen[i]!.progress > seen[i - 1]!.progress, 'progress increases');
    } finally {
        await c.done();
        await p.cleanup();
    }
});

test('status and doctor say when headless falls back to rendering', async () => {
    const demo = await demoManifest();
    const { host: _host, ...noHost } = demo;
    const p = await makeProject({ plugins: [{ name: 'DemoPlugin', manifest: noHost }] });
    const c = await connect(p);
    try {
        await c.call('dream_workspace', 'add', { project: p.uproject, mode: 'headless' });
        assert.match(c.text(await c.call('dream_workspace', 'status')), /Note: No plugin in this project declares a host commandlet/);
        assert.match(c.text(await c.call('dream_workspace', 'doctor')), /note: No plugin in this project declares a host commandlet/);
    } finally {
        await c.done();
        await p.cleanup();
    }
});

test('headless: preview, then a long action straight away, runs on a fresh headless host', async () => {
    const p = await makeProject({ fixtures: ['DemoPlugin'] });
    const c = await connect(p);
    try {
        await c.call('dream_workspace', 'add', { project: p.uproject, mode: 'headless' });
        for (let round = 0; round < 2; round++) {
            const snap = await c.call('dream_demo', 'snap', { file: 'Demo/a.dmo' });
            const tempPid = (snap.structuredContent!.engine as { pid: number }).pid;
            assert.equal((snap.structuredContent!.engine as { via: string }).via, 'temp-render');
            const build = await c.call('dream_demo', 'build', { file: 'Demo/a.dmo', steps: 4, stepMs: 40 });
            assert.equal(build.isError, undefined, c.text(build));
            assert.match(c.text(build), /^Built Demo\/a\.dmo\./);
            const eng = build.structuredContent!.engine as { via: string; pid: number };
            assert.notEqual(eng.pid, tempPid);
            assert.equal(eng.via, 'host');
            assert.equal((build.structuredContent!.data as { render: boolean }).render, false);
        }
        assert.deepEqual(c.launcher.killed, []);
    } finally {
        await c.done();
        await p.cleanup();
    }
});

test('a job whose engine died is reported as failed and does not linger in status', async () => {
    const p = await makeProject({ fixtures: ['DemoPlugin'] });
    const c = await connect(p);
    try {
        await c.call('dream_demo', 'echo', { text: 'warm' });
        const host = c.launcher.spawned[0]!;
        setTimeout(() => process.kill(host.pid, 'SIGKILL'), 200);
        const r = await c.call('dream_demo', 'slow');
        assert.equal(r.isError, true);
        assert.match(c.text(r), /engine-error/);
        const status = c.text(await c.call('dream_engine', 'status'));
        assert.doesNotMatch(status, /Running job/);
        assert.doesNotMatch(status, new RegExp(`Host started by this server: pid ${host.pid}, render, port`));
        // The next call simply works on a new host.
        assert.match(c.text(await c.call('dream_demo', 'echo', { text: 'again' })), /^echo: again/);
    } finally {
        await c.done();
        await p.cleanup();
    }
});
