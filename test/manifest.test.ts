import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkManifest } from '../src/manifest.js';
import { describePluginTool, helpText } from '../src/tools/describe.js';
import { demoManifest } from './helpers.js';

const base = () => ({
    schema: 1,
    protocol: 1,
    id: 'thing',
    plugin: 'Thing',
    description: 'A thing.',
    route: '/dream/thing',
    actions: [{ name: 'go', description: 'Go.', needs: 'engine', args: { type: 'object', properties: {} } }],
});

test('the demo fixture manifest is valid', async () => {
    const r = checkManifest(await demoManifest());
    assert.deepEqual(r.errors, []);
    assert.equal(r.manifest?.id, 'demo');
    const lookup = r.manifest!.actions.find(a => a.name === 'lookup')!;
    assert.deepEqual(lookup.offline, { kind: 'readFile', path: 'Docs/nodes/{name}.md', base: 'plugin' });
    const files = r.manifest!.actions.find(a => a.name === 'files')!;
    assert.equal(files.offline?.base, 'project');
});

test('defaults: writes/long false, title falls back to plugin', () => {
    const r = checkManifest(base());
    assert.deepEqual(r.errors, []);
    const a = r.manifest!.actions[0]!;
    assert.equal(a.writes, false);
    assert.equal(a.long, false);
    assert.equal(r.manifest!.title, 'Thing');
});

test('rejects what would make a wrong tool', () => {
    const cases: [string, (m: ReturnType<typeof base>) => unknown, RegExp][] = [
        ['wrong schema', m => ({ ...m, schema: 2 }), /"schema" must be 1/],
        ['wrong protocol', m => ({ ...m, protocol: 9 }), /"protocol" must be 1/],
        ['bad id', m => ({ ...m, id: 'Dream-Shader' }), /"id" must match/],
        ['bad route', m => ({ ...m, route: 'dream/x/' }), /"route"/],
        ['reserved action', m => ({ ...m, actions: [{ name: 'help', description: 'x', needs: 'engine' }] }), /reserved/],
        ['duplicate action', m => ({ ...m, actions: [m.actions[0], m.actions[0]] }), /declared twice/],
        ['offline missing', m => ({ ...m, actions: [{ name: 'q', description: 'x', needs: 'none' }] }), /requires "offline"/],
        ['offline escapes', m => ({ ...m, actions: [{ name: 'q', description: 'x', needs: 'none', offline: { kind: 'readFile', path: '../x' } }] }), /without "\.\."/],
        ['args not object schema', m => ({ ...m, actions: [{ name: 'q', description: 'x', args: { type: 'string' } }] }), /"type": "object"/],
        ['required not in properties', m => ({ ...m, actions: [{ name: 'q', description: 'x', args: { type: 'object', properties: {}, required: ['f'] } }] }), /required "f"/],
        ['bad needs', m => ({ ...m, actions: [{ name: 'q', description: 'x', needs: 'gpu' }] }), /"needs"/],
        ['absolute reference', m => ({ ...m, reference: [{ title: 't', path: `${'Z'}:/docs/a.md` }] }), /relative/],
    ];
    for (const [what, mutate, re] of cases) {
        const r = checkManifest(mutate(base()));
        assert.equal(r.manifest, undefined, what);
        assert.ok(r.errors.some(e => re.test(e)), `${what}: ${r.errors.join(' | ')}`);
    }
});

test('warns about nested args', () => {
    const r = checkManifest({ ...base(), actions: [{ name: 'q', description: 'x', args: { type: 'object', properties: { o: { type: 'object' }, u: { oneOf: [] } } } }] });
    assert.equal(r.errors.length, 0);
    assert.equal(r.warnings.length, 2);
});

test('the tool description lists every action with its arguments', async () => {
    const m = checkManifest(await demoManifest()).manifest!;
    const d = describePluginTool(m);
    for (const a of m.actions) assert.ok(d.includes(`- ${a.name}(`), a.name);
    assert.match(d, /- build\(file\*: string, steps\?: integer, stepMs\?: integer\): .*\[writes\]$/m);
    assert.match(d, /- lookup\(name\*: string\): .*\[offline\]/);
    assert.match(d, /- snap\(file\*: string\): .*\[renders\]$/m);
    // "long" only means the job model; it is never shown as "slow".
    assert.doesNotMatch(d, /slow =|\[slow|, slow\]/);
    // The title is not repeated when the description already starts with it.
    assert.match(d, /^Demo: A stand-in plugin/);
    assert.match(describePluginTool({ ...m, description: 'Demo turns text into things.' }), /^Demo turns text into things\./);
    assert.match(d, /- help\(action\?: string\)/);
    assert.match(d, /reference\(doc\?: string.*Demo language; Node catalog/);
    assert.match(helpText(m, 'build'), /file \(string, required\)/);
    assert.match(helpText(m, 'build'), /Example: \{"action": "build", "args": \{"file":"<file>"\}\}/);
    assert.match(helpText(m, 'nope'), /Unknown action "nope"/);
});
