import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { resolveEngine } from '../src/workspace/engine.js';
import { discoverPlugins } from '../src/workspace/plugins.js';
import { Registry } from '../src/workspace/registry.js';
import { findUProjectUpward, resolveUProject, WorkspaceService } from '../src/workspace/workspace.js';
import { demoManifest, ENGINE_GUID, makeProject, writePlugin } from './helpers.js';

const posix = (p: string) => p.replace(/\\/g, '/');

test('finds the .uproject above a folder, and in a folder', async () => {
    const p = await makeProject();
    try {
        assert.equal(await findUProjectUpward(path.join(p.dir, 'Demo', 'Sub')), posix(p.uproject));
        assert.equal(await resolveUProject(p.dir), posix(p.uproject));
        assert.equal(await resolveUProject(p.uproject), posix(p.uproject));
        assert.equal(await resolveUProject(path.join(p.dir, 'Missing.uproject')), undefined);
    } finally {
        await p.cleanup();
    }
});

test('registry: add, update, find by name or path, remove; lives in the given home', async () => {
    const p = await makeProject();
    try {
        const reg = new Registry(p.home);
        assert.deepEqual(await reg.list(), []);
        await reg.upsert({ name: 'G', project: posix(p.uproject), addedAt: 'x', engine: { mode: 'headless', idleMinutes: 3 } });
        await reg.upsert({ name: 'G2', project: posix(p.uproject), addedAt: 'x', engine: { mode: 'render', idleMinutes: 5 }, port: 48000 });
        const all = await reg.list();
        assert.equal(all.length, 1);
        assert.equal(all[0]!.name, 'G2');
        assert.equal((await reg.find('g2'))?.port, 48000);
        assert.equal((await reg.find(p.uproject))?.name, 'G2');
        assert.ok((await fs.readFile(path.join(p.home, 'workspaces.json'), 'utf8')).includes('"G2"'));
        assert.equal((await reg.remove('G2'))?.name, 'G2');
        assert.deepEqual(await reg.list(), []);
    } finally {
        await p.cleanup();
    }
});

test('current workspace: use > DREAM_MCP_PROJECT > folder the server started in', async () => {
    const a = await makeProject({ name: 'Alpha' });
    const b = await makeProject({ name: 'Beta' });
    try {
        // The temp folder may itself sit inside some Unreal project; all that matters is that
        // a folder above the projects does not pick one of them.
        const none = await new WorkspaceService({ home: a.home, env: {}, cwd: a.root, lookup: a.lookup }).current();
        if (none.workspace) assert.ok(!none.workspace.dir.startsWith(posix(a.root)), none.workspace.dir);
        else assert.match(none.reason ?? '', /no workspace selected/);

        const byCwd = new WorkspaceService({ home: a.home, env: {}, cwd: path.join(a.dir, 'Demo'), lookup: a.lookup });
        assert.equal((await byCwd.current()).workspace?.name, 'Alpha');

        const byEnv = new WorkspaceService({ home: a.home, env: { DREAM_MCP_PROJECT: b.dir }, cwd: a.dir, lookup: a.lookup });
        const w = (await byEnv.current()).workspace!;
        assert.equal(w.name, 'Beta');
        assert.equal(w.chosenBy, 'DREAM_MCP_PROJECT');

        byEnv.use(a.uproject);
        assert.equal((await byEnv.current()).workspace?.name, 'Alpha');

        const bad = new WorkspaceService({ home: a.home, env: { DREAM_MCP_PROJECT: 'nowhere' }, cwd: a.dir, lookup: a.lookup });
        assert.match((await bad.current()).reason ?? '', /DREAM_MCP_PROJECT/);

        // A registered name works in DREAM_MCP_PROJECT too.
        await new Registry(a.home).upsert({ name: 'TheBeta', project: posix(b.uproject), addedAt: '', engine: { mode: 'headless', idleMinutes: 1 } });
        const byName = new WorkspaceService({ home: a.home, env: { DREAM_MCP_PROJECT: 'TheBeta' }, cwd: a.dir, lookup: a.lookup });
        const named = (await byName.current()).workspace!;
        assert.equal(named.name, 'TheBeta');
        assert.equal(named.config.engine.mode, 'headless');
    } finally {
        await a.cleanup();
        await b.cleanup();
    }
});

test('engine resolution: override, source GUID, launcher version, inside the engine tree', async () => {
    const p = await makeProject();
    try {
        const viaGuid = await resolveEngine(p.dir, ENGINE_GUID, undefined, p.lookup);
        assert.equal(viaGuid.engine?.version, '5.8.1');
        assert.equal(viaGuid.engine?.editorCmdExists, true);
        assert.match(viaGuid.engine!.via, /source build/);

        const launcher = await resolveEngine(p.dir, '5.8', undefined, { sourceBuild: async () => undefined, launcherInstall: async v => (v === '5.8' ? p.engineRoot : undefined) });
        assert.match(launcher.engine!.via, /launcher install 5\.8/);

        const missing = await resolveEngine(p.dir, '9.9', undefined, { sourceBuild: async () => undefined, launcherInstall: async () => undefined });
        assert.match(missing.problem ?? '', /not installed/);

        const override = await resolveEngine(p.dir, ENGINE_GUID, p.engineRoot, { sourceBuild: async () => undefined, launcherInstall: async () => undefined });
        assert.match(override.engine!.via, /engine\.root/);

        // A project inside an engine tree with an empty association.
        const inner = path.join(p.engineRoot, 'Samples', 'Game');
        await fs.mkdir(inner, { recursive: true });
        const tree = await resolveEngine(inner, '', undefined, p.lookup);
        assert.equal(posix(tree.engine!.root), posix(p.engineRoot));
    } finally {
        await p.cleanup();
    }
});

test('plugin discovery: nested folders, enable rules, broken manifests, duplicate ids, engine Marketplace', async () => {
    const demo = await demoManifest();
    const p = await makeProject({ fixtures: ['DemoPlugin'] });
    try {
        await writePlugin(p.dir, { name: 'Nested', at: 'Group/Sub', manifest: { ...demo, id: 'nested', plugin: 'Nested', route: '/dream/nested' } });
        await writePlugin(p.dir, { name: 'Off', manifest: { ...demo, id: 'off', plugin: 'Off', route: '/dream/off' } });
        await writePlugin(p.dir, { name: 'Lazy', manifest: { ...demo, id: 'lazy', plugin: 'Lazy', route: '/dream/lazy' }, uplugin: { EnabledByDefault: false } });
        await writePlugin(p.dir, { name: 'Broken', manifest: '{ not json' });
        await writePlugin(p.dir, { name: 'Twin', manifest: { ...demo, plugin: 'Twin' } });
        await writePlugin(p.engineRoot, { name: 'Market', at: path.join('..', 'Engine', 'Plugins', 'Marketplace'), manifest: { ...demo, id: 'market', plugin: 'Market', route: '/dream/market' } });
        await fs.mkdir(path.join(p.dir, 'Plugins', 'NoManifest'), { recursive: true });
        await fs.writeFile(path.join(p.dir, 'Plugins', 'NoManifest', 'NoManifest.uplugin'), '{}');

        const refs = [{ Name: 'Off', Enabled: false }, { Name: 'Market', Enabled: true }];
        const d = await discoverPlugins(p.dir, refs, p.engineRoot);
        const by = (n: string) => d.plugins.find(x => x.name === n);
        assert.equal(by('NoManifest'), undefined);
        assert.equal(by('Nested')?.enabled, true);
        assert.equal(by('Off')?.enabled, false);
        assert.match(by('Off')!.disabledBy!, /disables/);
        assert.equal(by('Lazy')?.enabled, false);
        assert.match(by('Broken')!.errors[0]!, /not valid JSON/);
        assert.equal(by('Market')?.source, 'engine');
        assert.equal(by('Market')?.enabled, true);
        assert.equal(by('DemoPlugin')?.version, '1.2.3');
        assert.deepEqual(
            d.active.map(a => a.manifest!.id),
            ['demo', 'nested', 'market'],
        );
        assert.ok(d.problems.some(x => /Twin and DemoPlugin both declare id "demo"/.test(x)), d.problems.join('|'));
    } finally {
        await p.cleanup();
    }
});
