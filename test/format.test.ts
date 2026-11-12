import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeResult } from '../src/protocol/types.js';
import { DATA_ANSWER_LIMIT, DATA_FULL_LIMIT, DATA_SUMMARY_LIMIT, dataText, renderResult } from '../src/tools/format.js';

const text = async (r: ReturnType<typeof makeResult>) => (await renderResult(r)).content.filter(c => c.type === 'text').map(c => (c as { text: string }).text);

test('an artifact path the summary already names is not repeated', async () => {
    const path = 'Saved/DreamMCP/artifacts/abc-1.png';
    const named = await text(makeResult('ok', `Rendered on a sphere. Image: ${path} (sphere, 512x512).`, { artifacts: [{ kind: 'image', path, title: 'preview' }] }));
    assert.equal(named.join('\n').split(path).length - 1, 1);
    const unnamed = await text(makeResult('ok', 'Rendered on a sphere.', { artifacts: [{ kind: 'image', path, title: 'preview' }] }));
    assert.match(unnamed[0]!, new RegExp(`^Image: ${path.replace(/[.]/g, '\\.')} \\(preview\\)$`, 'm'));
});

test('long data on a result with artifacts, writes or diagnostics is summarised', async () => {
    const frames = Array.from({ length: 16 }, (_, i) => ({ index: i, mean: '#B48677', name: 'red', luminance: [0.52, 0.59], coverage: 0.61 }));
    const r = makeResult('ok', 'Rendered 16 frames.', {
        artifacts: [{ kind: 'image', path: 'Saved/DreamMCP/artifacts/a.png' }],
        data: { exact: true, mean: '#9F8070', frames, changes: { max: 61.5, frameOfMax: 3 }, note: 'y'.repeat(300) },
    });
    const d = dataText(r)!;
    assert.ok(JSON.stringify(r.data).length > DATA_FULL_LIMIT);
    assert.match(d, /^data \(summary of \d+ characters; the complete object is the "data" field of the structured content\): /);
    assert.match(d, /exact: true; mean: "#9F8070"; frames: \[16 items\]; changes: \{max, frameOfMax\}/);
    assert.ok(d.length < DATA_SUMMARY_LIMIT + 200, `${d.length}`);
    // Short data is still repeated in full.
    assert.equal(dataText(makeResult('ok', 's', { writes: [{ asset: '/Game/A', state: 'saved' }], data: { products: [{ asset: '/Game/A' }] } })), 'data: {"products":[{"asset":"/Game/A"}]}');
});

test('data that is the answer (lookup-style) is kept in full up to the answer limit', () => {
    const entries = Array.from({ length: 150 }, (_, i) => ({ name: `UE.Node${i}`, inputs: ['A', 'B'], output: 'float' }));
    const answer = makeResult('ok', '150 matches.', { data: { entries } });
    const json = JSON.stringify(answer.data);
    assert.ok(json.length > DATA_FULL_LIMIT && json.length < DATA_ANSWER_LIMIT);
    assert.equal(dataText(answer), `data: ${json}`);
    const huge = makeResult('ok', 'many', { data: { text: 'z'.repeat(DATA_ANSWER_LIMIT + 500) } });
    assert.match(dataText(huge)!, new RegExp(`^data \\(first ${DATA_ANSWER_LIMIT} of \\d+ characters; the complete object is the "data" field`));
    assert.equal(dataText(makeResult('ok', 'nothing')), undefined);
});
