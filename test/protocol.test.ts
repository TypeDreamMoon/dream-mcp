import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import WebSocket from 'ws';
import { EndpointClient, EndpointError, type Endpoint } from '../src/protocol/client.js';
import { demoBehaviors } from './fake/demo.js';
import { FakeEngine, type FakeManifest } from './fake/endpoint.js';
import { demoManifest, fastTimings, tempDir, rmrf } from './helpers.js';

async function engineWith(opts: { ws?: boolean } = {}) {
    const dir = await tempDir('proto');
    const engine = new FakeEngine({ projectDir: dir, mode: 'editor', render: true, ws: !!opts.ws });
    engine.addPlugin((await demoManifest()) as unknown as FakeManifest, demoBehaviors(engine));
    await engine.start();
    const ep: Endpoint = { id: 'demo', port: engine.port, token: engine.token, route: '/dream/demo', ws: engine.wsUrl, pid: process.pid, mode: 'editor', render: true };
    const client = new EndpointClient(ep, fastTimings());
    return { dir, engine, ep, client, done: async () => (await engine.stop(), await rmrf(dir)) };
}

function raw(port: number, path: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, res => {
            res.resume();
            resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
    });
}

test('auth: every request needs the token; any Origin is refused; the client sends no Origin', async () => {
    const t = await engineWith();
    try {
        assert.equal(await raw(t.engine.port, '/dream/demo/hello', {}), 401);
        assert.equal(await raw(t.engine.port, '/dream/demo/hello', { 'X-Dream-Token': 'wrong' }), 401);
        assert.equal(await raw(t.engine.port, '/dream/demo/hello', { 'X-Dream-Token': t.engine.token, Origin: 'http://evil.example' }), 403);
        const bad = new EndpointClient({ ...t.ep, token: 'nope' }, fastTimings());
        await assert.rejects(bad.hello(), (e: EndpointError) => e.kind === 'unauthorized');
        const h = await t.client.hello();
        assert.equal(h.protocol, 1);
        assert.equal(h.id, 'demo');
        assert.ok(h.actions.includes('build'));
        assert.equal(t.engine.requests.filter(r => r.origin).length, 1, 'only the hand-made request carried an Origin');
    } finally {
        await t.done();
    }
});

test('short action returns 200 with a result body; unknown action 404 and bad args 400 come back as refusals', async () => {
    const t = await engineWith();
    try {
        const ok = await t.client.call('1', 'echo', { text: 'hi' });
        assert.equal(ok.kind, 'result');
        if (ok.kind === 'result') {
            assert.equal(ok.status, 200);
            assert.equal(ok.result.outcome, 'ok');
            assert.equal(ok.result.summary, 'echo: hi');
            assert.deepEqual(ok.result.writes, []);
        }
        const unknown = await t.client.call('2', 'nope', {});
        assert.ok(unknown.kind === 'result' && unknown.status === 404 && unknown.result.outcome === 'refused' && unknown.result.reason === 'unknown-action');
        const badArgs = await t.client.call('3', 'echo', {});
        assert.ok(badArgs.kind === 'result' && badArgs.status === 400 && badArgs.result.reason === 'bad-args');
    } finally {
        await t.done();
    }
});

test('long action: 202 + job id, polled to done with progress', async () => {
    const t = await engineWith();
    try {
        const r = await t.client.call('4', 'build', { file: 'Demo/a.dmo', steps: 4, stepMs: 20 });
        assert.equal(r.kind, 'job');
        if (r.kind !== 'job') return;
        const seen: unknown[] = [];
        const w = await t.client.waitJob(r.job, { deadlineMs: 5000, onProgress: p => seen.push(p) });
        assert.equal(w.via, 'poll');
        assert.equal(w.timedOut, false);
        assert.equal(w.status.state, 'done');
        assert.deepEqual(w.status.result?.writes, [{ asset: '/Game/Demo/a', state: 'saved' }]);
        assert.ok(seen.length >= 1, 'progress reported');
    } finally {
        await t.done();
    }
});

test('WebSocket: auth frame first, job pushes arrive, and the outcome equals polling', async () => {
    const t = await engineWith({ ws: true });
    try {
        // Without auth the socket is closed.
        const closed = await new Promise<number>(resolve => {
            const ws = new WebSocket(t.engine.wsUrl!);
            ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'bad' })));
            ws.on('close', code => resolve(code));
        });
        assert.equal(closed, 4401);

        const r = await t.client.call('5', 'build', { file: 'Demo/a.dmo', steps: 3, stepMs: 30 });
        assert.equal(r.kind, 'job');
        if (r.kind !== 'job') return;
        const seen: unknown[] = [];
        const viaWs = await t.client.waitJob(r.job, { deadlineMs: 5000, onProgress: p => seen.push(p) });
        assert.equal(viaWs.via, 'ws');
        assert.ok(seen.length >= 1, 'pushed progress');
        const polled = await new EndpointClient({ ...t.ep, ws: null }, fastTimings()).job(r.job);
        assert.deepEqual(viaWs.status.result, polled.result);
        assert.equal(viaWs.status.state, polled.state);
    } finally {
        await t.done();
    }
});

test('cancel: a cancellable job ends cancelled; a non-cancellable one says so and runs on', async () => {
    const t = await engineWith();
    try {
        const slow = await t.client.call('6', 'slow', {});
        assert.equal(slow.kind, 'job');
        if (slow.kind !== 'job') return;
        assert.deepEqual(await t.client.cancel(slow.job), { cancelled: true, state: 'cancelled' });
        assert.equal((await t.client.job(slow.job)).state, 'cancelled');

        const stuck = await t.client.call('7', 'stuck', {});
        if (stuck.kind !== 'job') return assert.fail('expected a job');
        const reply = await t.client.cancel(stuck.job);
        assert.equal(reply.cancelled, false);
        const w = await t.client.waitJob(stuck.job, { deadlineMs: 5000 });
        assert.equal(w.status.state, 'done');
    } finally {
        await t.done();
    }
});

test('a job that outlasts the wait comes back as timed out, not failed', async () => {
    const t = await engineWith();
    try {
        const r = await t.client.call('8', 'slow', {});
        if (r.kind !== 'job') return assert.fail('expected a job');
        const w = await t.client.waitJob(r.job, { deadlineMs: 100 });
        assert.equal(w.timedOut, true);
        assert.equal(w.status.state, 'running');
        await t.client.cancel(r.job);
    } finally {
        await t.done();
    }
});

test('shutdown is refused outside host mode; a dead port is "unreachable"', async () => {
    const t = await engineWith();
    try {
        assert.equal(await t.client.shutdown(), false);
        const port = t.engine.port;
        await t.engine.stop();
        await assert.rejects(new EndpointClient({ ...t.ep, port }, fastTimings()).hello(), (e: EndpointError) => e.kind === 'unreachable');
    } finally {
        await rmrf(t.dir);
    }
});
