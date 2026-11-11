/**
 * Contract tests against a real plugin endpoint. Skipped unless DREAM_MCP_E2E_PROJECT is set.
 *
 *   DREAM_MCP_E2E_PROJECT   .uproject (or its folder) whose Dream plugins to test       (required)
 *   DREAM_MCP_E2E_PLUGIN    only this manifest id                                        (default: all)
 *   DREAM_MCP_E2E_MODE      render | headless, for a host this test starts               (default: render)
 *   DREAM_MCP_E2E_NO_START  1 = require an already open editor/host, never start one
 *   DREAM_MCP_E2E_ACTIONS   JSON list of calls to run through the full MCP stack, e.g.
 *                           [{"action":"check","args":{"file":"DShader/M_Test.dss"}}]
 *   DREAM_MCP_E2E_TIMEOUT_MS  per-step wait for long jobs                                (default: 600000)
 *
 * Run: npm run test:contract   (after setting the variables)
 * One DreamServer instance starts the host (with the real launcher, when nothing serves the
 * project yet) and runs the tools, so with DREAM_MCP_E2E_MODE=headless a render action
 * really goes through "stop the resident host, run a temporary rendering editor". Hosts
 * are stopped at the end. Timings, the serving process (`via`) and the tool's notes are
 * printed as test diagnostics.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { test } from 'node:test';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { defaultTimings } from '../src/config.js';
import { discoveryFile } from '../src/engine/discovery.js';
import type { ActionSpec } from '../src/manifest.js';
import { EndpointClient, type Endpoint } from '../src/protocol/client.js';
import { DreamServer } from '../src/server.js';
import { readJsonSettled } from '../src/util/fs.js';
import { resolveUProject } from '../src/workspace/workspace.js';
import { tempDir } from './helpers.js';
import { discoveryProblems, helloProblems, jobProblems, resultProblems } from './shape.js';

const PROJECT = process.env.DREAM_MCP_E2E_PROJECT;
const skip = PROJECT ? false : 'set DREAM_MCP_E2E_PROJECT to run the contract tests against a real endpoint';

function raw(ep: Endpoint, method: string, sub: string, headers: Record<string, string>, body?: unknown, host = '127.0.0.1'): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const req = http.request({ host, port: ep.port, path: ep.route + sub, method, headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) }, timeout: 10_000 }, res => {
            const chunks: Buffer[] = [];
            res.on('data', c => chunks.push(c as Buffer));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                let parsed: unknown;
                try {
                    parsed = text ? JSON.parse(text) : undefined;
                } catch {
                    parsed = text;
                }
                resolve({ status: res.statusCode ?? 0, body: parsed });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function lanAddress(): string | undefined {
    for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
    return undefined;
}

test('contract: real endpoints follow the protocol', { skip, timeout: 3_600_000 }, async t => {
    const uproject = await resolveUProject(PROJECT!);
    assert.ok(uproject, `${PROJECT} is not a .uproject or a folder with one`);
    const home = await tempDir('contract-home');
    const timings = { ...defaultTimings(process.env), jobWaitMs: Number(process.env.DREAM_MCP_E2E_TIMEOUT_MS ?? 600_000) };
    // One server instance starts the host *and* runs the tools, exactly as in real use, so
    // paths that depend on "this server started the host" (stopping a headless host to
    // render, idle shutdown) are really exercised.
    const mode = process.env.DREAM_MCP_E2E_MODE === 'headless' ? 'headless' : 'render';
    const dream = new DreamServer({ home, env: { DREAM_MCP_PROJECT: uproject }, timings, log: l => t.diagnostic(l) });
    await dream.workspaces.registry.upsert({ name: 'contract', project: uproject, addedAt: new Date().toISOString(), engine: { mode, idleMinutes: 60 } });
    await dream.sync();
    const ws = (await dream.workspaces.current()).workspace!;
    assert.ok(ws, 'workspace');
    assert.equal(ws.config.engine.mode, mode);
    const mgr = dream.engine;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await dream.createMcpServer().connect(serverSide);
    const client = new Client({ name: 'contract', version: '1' });
    await client.connect(clientSide);
    const reader: ActionSpec = { name: '_probe', description: '', needs: 'engine', writes: false, long: false, args: { type: 'object' } };
    const only = process.env.DREAM_MCP_E2E_PLUGIN;
    const plugins = ws.discovery.active.filter(p => !only || p.manifest!.id === only);
    assert.ok(plugins.length, `no active Dream plugin manifests in ${uproject}${only ? ` with id ${only}` : ''}`);
    for (const p of ws.discovery.plugins) assert.deepEqual(p.errors, [], `${p.name} manifest`);

    try {
        for (const plugin of plugins) {
            const m = plugin.manifest!;
            await t.test(`dream_${m.id}`, async st => {
                const probe0 = await mgr.probe(ws, m.id);
                let ep: Endpoint;
                if (probe0.state === 'alive') {
                    ep = probe0.endpoint;
                    st.diagnostic(`using the running ${probe0.disc.mode} (pid ${probe0.disc.pid})`);
                } else {
                    assert.notEqual(process.env.DREAM_MCP_E2E_NO_START, '1', `nothing serves ${m.id} (${probe0.detail}) and DREAM_MCP_E2E_NO_START=1`);
                    const t0 = Date.now();
                    const got = await mgr.acquire(ws, plugin, reader);
                    assert.ok(!('refusal' in got), 'refusal' in got ? `${got.refusal.reason}: ${got.refusal.summary}` : '');
                    if ('refusal' in got) return;
                    ep = got.lease.endpoint;
                    await got.lease.release();
                    st.diagnostic(`started a ${ws.config.engine.mode} host in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
                }

                const disc = await readJsonSettled(discoveryFile(ws.dir, m.id));
                assert.deepEqual(discoveryProblems(disc, m.id, m.route), [], 'discovery file');

                const auth = { 'X-Dream-Token': ep.token };
                const hello = await raw(ep, 'GET', '/hello', auth);
                assert.equal(hello.status, 200);
                assert.deepEqual(helloProblems(hello.body, m.id), [], 'hello');
                const offered = (hello.body as { actions: string[] }).actions;
                const missing = m.actions.filter(a => a.needs !== 'none' && !offered.includes(a.name)).map(a => a.name);
                assert.deepEqual(missing, [], 'every endpoint action in the manifest is offered by hello');

                assert.equal((await raw(ep, 'GET', '/hello', {})).status, 401, 'no token -> 401');
                assert.equal((await raw(ep, 'GET', '/hello', { 'X-Dream-Token': 'wrong' })).status, 401, 'wrong token -> 401');
                assert.equal((await raw(ep, 'GET', '/hello', { ...auth, Origin: 'http://example.com' })).status, 403, 'Origin -> 403');
                assert.equal((await raw(ep, 'POST', '/call', {}, { id: 'x', action: 'echo', args: {} })).status, 401, 'call without token -> 401');

                const unknown = await raw(ep, 'POST', '/call', auth, { id: 'c1', action: '__no_such_action__', args: {} });
                assert.equal(unknown.status, 404, 'unknown action -> 404');
                assert.deepEqual(resultProblems(unknown.body), [], 'unknown action body');
                assert.equal((unknown.body as { outcome: string }).outcome, 'refused');

                const needsArgs = m.actions.find(a => a.needs !== 'none' && (a.args.required ?? []).length);
                if (needsArgs) {
                    const bad = await raw(ep, 'POST', '/call', auth, { id: 'c2', action: needsArgs.name, args: {} });
                    assert.equal(bad.status, 400, `${needsArgs.name} without required args -> 400`);
                    assert.deepEqual(resultProblems(bad.body), [], 'bad args body');
                    assert.equal((bad.body as { outcome: string }).outcome, 'refused');
                }
                assert.equal((await raw(ep, 'GET', '/jobs/__no_such_job__', auth)).status, 404, 'unknown job -> 404');
                if (ep.mode === 'editor') assert.ok((await raw(ep, 'POST', '/shutdown', auth, {})).status >= 400, 'shutdown is refused in editor mode');

                const lan = lanAddress();
                if (lan) {
                    const reached = await raw(ep, 'GET', '/hello', auth, undefined, lan).then(
                        () => true,
                        () => false,
                    );
                    assert.equal(reached, false, `the endpoint must listen on 127.0.0.1 only, but answered on ${lan}`);
                }

                if (ep.ws) {
                    const opened = await new Promise<boolean>(resolve => {
                        const s = new WebSocket(ep.ws!);
                        let closed = false;
                        s.on('open', () => {
                            s.send(JSON.stringify({ type: 'auth', token: ep.token }));
                            setTimeout(() => (s.close(), resolve(!closed)), 500);
                        });
                        s.on('close', () => (closed = true));
                        s.on('error', () => resolve(false));
                    });
                    assert.ok(opened, 'WebSocket accepts the auth frame and stays open');
                }

                // Real actions, end to end through the MCP surface of the same server.
                const calls = JSON.parse(process.env.DREAM_MCP_E2E_ACTIONS ?? '[]') as { action: string; args?: Record<string, unknown>; tool?: string }[];
                const mine = calls.filter(c => !c.tool || c.tool === `dream_${m.id}`);
                for (const c of mine) {
                    const t0 = Date.now();
                    const r = (await client.callTool({ name: `dream_${m.id}`, arguments: { action: c.action, args: c.args ?? {} } }, { timeout: timings.jobWaitMs + 60_000 } as never)) as {
                        content: { type: string; text?: string }[];
                        structuredContent?: Record<string, unknown>;
                    };
                    const via = (r.structuredContent?.engine as { via?: string } | undefined)?.via ?? '-';
                    const first = r.content.find(x => x.type === 'text')?.text ?? '';
                    st.diagnostic(`${c.action}: ${((Date.now() - t0) / 1000).toFixed(2)} s via ${via} -> ${first.split('\n')[0]}`);
                    for (const line of first.split('\n').filter(l => l.startsWith('Note:') || l.startsWith('  - '))) st.diagnostic(`  ${line.trim()}`);
                    if (r.structuredContent && 'outcome' in r.structuredContent) {
                        const { engine: _engine, ...body } = r.structuredContent;
                        assert.deepEqual(resultProblems(body), [], `${c.action} result`);
                    }
                    const spec = m.actions.find(x => x.name === c.action);
                    // A headless host this server started must not turn a render action into a refusal.
                    if (spec?.needs === 'render' && mode === 'headless')
                        assert.notEqual(r.structuredContent?.reason, 'render-unavailable', `${c.action} should run in a temporary rendering process: ${first}`);
                    // Long actions: the job endpoint must agree with what the tool returned.
                    // The serving process may have changed (temporary render process), so look again.
                    if (spec?.long) {
                        const now = await mgr.probe(ws, m.id);
                        let cur: Endpoint | undefined = now.state === 'alive' ? now.endpoint : undefined;
                        if (!cur) {
                            const got = await mgr.acquire(ws, plugin, reader);
                            if ('lease' in got) {
                                cur = got.lease.endpoint;
                                await got.lease.release();
                            }
                        }
                        assert.ok(cur, `no endpoint for ${m.id} after ${c.action}`);
                        const call = await new EndpointClient(cur!, timings).call(`contract-${Date.now()}`, c.action, c.args ?? {});
                        if (call.kind === 'job') {
                            const w = await new EndpointClient({ ...cur!, ws: null }, timings).waitJob(call.job, { deadlineMs: timings.jobWaitMs });
                            assert.deepEqual(jobProblems(w.status), [], `${c.action} job status`);
                        } else assert.fail(`${c.action} is long in the manifest but /call did not answer 202`);
                    }
                }
            });
        }
    } finally {
        await client.close();
        await dream.close('contract test over');
    }
});
