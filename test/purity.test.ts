import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { demoBehaviors } from './fake/demo.js';
import { FakeEngine, type FakeManifest } from './fake/endpoint.js';
import { demoManifest, makeProject, REPO } from './helpers.js';
import { discoveryProblems, helloProblems, jobProblems, resultProblems } from './shape.js';
import { EndpointClient } from '../src/protocol/client.js';
import { fastTimings } from './helpers.js';

/** Names of real plugins, their languages and diagnostic prefixes. None may appear in the server. */
const PLUGIN_SPECIFIC = /dream ?shader|dream ?fx|dream ?gui|dream ?city|dream ?ui|dream ?anim|dream ?statetree|dream ?loc|\bshader\b|\bfx\b|\bgui\b|\bcity\b|\bniagara\b|\bmaterial\b|\b(dsh|dfx|dui|dss|dsm|dfs)\d*\b/i;

async function sources(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await sources(full)));
        else if (e.name.endsWith('.ts')) out.push(full);
    }
    return out;
}

test('the server has no plugin-specific code', async () => {
    const hits: string[] = [];
    for (const file of await sources(path.join(REPO, 'src'))) {
        const lines = (await fs.readFile(file, 'utf8')).split('\n');
        lines.forEach((l, i) => PLUGIN_SPECIFIC.test(l) && hits.push(`${path.relative(REPO, file)}:${i + 1}: ${l.trim()}`));
    }
    assert.deepEqual(hits, []);
});

test('the fake endpoint itself follows the wire shapes the contract tests demand', async () => {
    const p = await makeProject();
    const e = new FakeEngine({ projectDir: p.dir, mode: 'editor', render: true, ws: true });
    e.addPlugin((await demoManifest()) as unknown as FakeManifest, demoBehaviors(e));
    await e.start();
    try {
        const disc = JSON.parse(await fs.readFile(e.discoveryPath('demo'), 'utf8'));
        assert.deepEqual(discoveryProblems(disc, 'demo', '/dream/demo'), []);
        const c = new EndpointClient({ id: 'demo', port: e.port, token: e.token, route: '/dream/demo', ws: e.wsUrl, pid: process.pid, mode: 'editor', render: true }, fastTimings());
        const hello = await c.request('GET', '/hello', undefined, 2000);
        assert.deepEqual(helloProblems(hello.body, 'demo'), []);
        for (const [action, args] of [
            ['echo', { text: 'x' }],
            ['fail', { file: 'Demo/a.dmo' }],
            ['nope', {}],
            ['echo', {}],
        ] as const) {
            const r = await c.request('POST', '/call', { id: 'x', action, args }, 2000);
            assert.deepEqual(resultProblems(r.body), [], `${action}`);
        }
        const job = await c.call('j', 'snap', { file: 'Demo/a.dmo' });
        if (job.kind !== 'job') return assert.fail('expected a job');
        const w = await c.waitJob(job.job, { deadlineMs: 3000 });
        assert.deepEqual(jobProblems(w.status), []);
    } finally {
        await e.stop();
        await p.cleanup();
    }
});
