import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeResult } from '../src/protocol/types.js';
import { DATA_ANSWER_LIMIT, DATA_FULL_LIMIT, DATA_SUMMARY_LIMIT, dataText, renderResult, TEXT_LIMIT, textBlock } from '../src/tools/format.js';
import { resultProblems } from './shape.js';

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

test('a text block goes verbatim after the summary and before diagnostics', async () => {
    const tree = 'Root at (0, 0) size 800x600\n  Panel at (10, 10) size 200x40\n    Label at (14, 12) size 80x16';
    const r = makeResult('source-error', 'Layout of W_Menu: 3 widgets, 1 warning.', {
        text: tree + '\n\n',
        diagnostics: [{ severity: 'warning', message: 'Label overflows its panel.', file: 'UI/W_Menu.dui', line: 4 }],
    });
    const first = (await text(r))[0]!;
    const lines = first.split('\n');
    assert.equal(lines[0], '[source-error] Layout of W_Menu: 3 widgets, 1 warning.');
    assert.deepEqual(lines.slice(1, 4), tree.split('\n'), 'indentation and line breaks kept');
    assert.equal(lines[4], 'Diagnostics (1):');
    const out = await renderResult(r);
    assert.equal((out.structuredContent as { text: string }).text, tree + '\n\n', 'structured content carries text unchanged');
});

test('a text block over the limit is cut at a line end, with a note saying how much', () => {
    const lineText = (i: number) => `${'  '.repeat(i % 4)}Node_${i} at (${i}, ${i}) size 100x20`;
    const all = Array.from({ length: 2000 }, (_, i) => lineText(i)).join('\n');
    assert.ok(all.length > TEXT_LIMIT);
    const shown = textBlock(all);
    const body = shown.split('\n');
    const note = body.pop()!;
    assert.match(note, /^\[text cut: showed (\d+) of 2000 lines \(\d+ of \d+ characters\)\. The full text is the "text" field of the structured content; Next says how to ask for less\.\]$/);
    assert.ok(body.join('\n').length <= TEXT_LIMIT);
    body.forEach((l, i) => assert.equal(l, lineText(i), `line ${i} intact`));
    assert.equal(textBlock('short\n  tree\n'), 'short\n  tree');
});

test('a result with a text block does not repeat data in the text; data stays in the structured content', async () => {
    const data = { entries: Array.from({ length: 150 }, (_, i) => ({ name: `UE.Node${i}`, output: 'float' })) };
    const withText = makeResult('ok', '150 matches.', { data, text: 'a\n  b' });
    assert.equal(dataText(withText), undefined);
    const out = await renderResult(withText);
    assert.equal(out.content.length, 1, 'only the text block, no data line');
    assert.deepEqual((out.structuredContent as { data: unknown }).data, data);
    const withDiag = makeResult('ok', 'Layout.', { data, text: 'a\n  b', diagnostics: [{ message: 'w', severity: 'warning' }] });
    assert.equal(dataText(withDiag), undefined);
    // Without text the earlier rules apply.
    assert.equal(dataText(makeResult('ok', '150 matches.', { data })), `data: ${JSON.stringify(data)}`);
});

test('the shape check wants a one-line summary and a string text', () => {
    assert.deepEqual(resultProblems({ ...makeResult('ok', 'one line'), text: 'a\nb' }), []);
    assert.ok(resultProblems({ ...makeResult('ok', 'x'), summary: 'two\nlines' }).some(p => /summary must be one line/.test(p)));
    assert.ok(resultProblems({ ...makeResult('ok', 'x'), text: 42 }).some(p => /text, when present, must be a string/.test(p)));
});
