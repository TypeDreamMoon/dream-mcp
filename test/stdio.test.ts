import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { demoBehaviors } from './fake/demo.js';
import { FakeEngine, type FakeManifest } from './fake/endpoint.js';
import { demoManifest, makeProject, REPO } from './helpers.js';

const CLI = path.join(REPO, 'build', 'src', 'cli.js');

async function start(env: Record<string, string>, cwd: string) {
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    const base = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    delete base.DREAM_MCP_PROJECT;
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI], env: { ...base, ...env }, cwd, stderr: 'ignore' }));
    return client;
}

test('stdio: the built CLI handshakes and lists the core tools', async () => {
    const p = await makeProject();
    const client = await start({ DREAM_MCP_HOME: p.home }, p.root);
    try {
        const names = (await client.listTools()).tools.map(t => t.name);
        assert.ok(names.includes('dream_workspace'));
        assert.ok(names.includes('dream_engine'));
    } finally {
        await client.close();
        await p.cleanup();
    }
});

test('stdio: a project with a manifest adds dream_demo, which works through an open editor', async () => {
    const p = await makeProject({ fixtures: ['DemoPlugin'], association: '' });
    const editor = new FakeEngine({ projectDir: p.dir, mode: 'editor', render: true });
    editor.addPlugin((await demoManifest()) as unknown as FakeManifest, demoBehaviors(editor));
    await editor.start();
    const client = await start({ DREAM_MCP_HOME: p.home, DREAM_MCP_PROJECT: p.uproject }, p.root);
    try {
        const names = (await client.listTools()).tools.map(t => t.name).sort();
        assert.deepEqual(names, ['dream_demo', 'dream_engine', 'dream_workspace']);
        const r = (await client.callTool({ name: 'dream_demo', arguments: { action: 'echo', args: { text: 'over stdio' } } })) as { content: { text?: string }[] };
        assert.match(r.content[0]!.text!, /^echo: over stdio/);
    } finally {
        await client.close();
        await editor.stop();
        await p.cleanup();
    }
});
