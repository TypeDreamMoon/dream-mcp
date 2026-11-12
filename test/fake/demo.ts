/** What the demo plugin's actions do inside the fake endpoint. Test code only. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { result, sleep, type Behavior, type FakeEngine } from './endpoint.js';

/** A valid 1x1 PNG. */
export const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

/** An indented layout-style tree: `Panel_3 at (30, 12) size 200x40`, nested two deep. */
export function demoTree(lines: number): string {
    const out: string[] = [];
    for (let i = 0; i < lines; i++) out.push(`${'  '.repeat(i % 3)}${i % 3 === 0 ? 'Panel' : 'Text'}_${i} at (${i * 10}, ${i * 2}) size 200x40`);
    return out.join('\n');
}

export function demoBehaviors(engine: FakeEngine): Record<string, Behavior> {
    return {
        echo: {
            run: args =>
                result('ok', `echo: ${String(args.text)}`, {
                    data: { text: args.text, mode: engine.opts.mode, pid: engine.pid },
                    ...(args.tree ? { text: demoTree(Number(args.tree)) } : {}),
                }),
        },
        fail: {
            run: args =>
                result('source-error', 'One error in the source.', {
                    diagnostics: [
                        { code: 'DEMO1001', severity: 'error', file: String(args.file), line: 3, column: 7, message: 'Unknown node "Flor".', hint: 'Did you mean "Floor"?' },
                    ],
                    next: ['Fix line 3 and run fail again.'],
                }),
        },
        build: {
            async run(args, { job }) {
                const steps = Number(args.steps ?? 3);
                const stepMs = Number(args.stepMs ?? 30);
                for (let i = 1; i <= steps; i++) {
                    await sleep(stepMs);
                    if (job?.cancelled) break;
                    job?.progress({ current: i, total: steps, message: `step ${i}` });
                }
                const name = path.basename(String(args.file)).replace(/\.[^.]+$/, '');
                return result('ok', `Built ${String(args.file)}.`, { writes: [{ asset: `/Game/Demo/${name}`, state: 'saved' }], data: { render: engine.opts.render, pid: engine.pid } });
            },
        },
        snap: {
            async run(_args, { job }) {
                if (!engine.opts.render) return result('refused', 'This process cannot render.', { reason: 'no-render' });
                const rel = `Saved/DreamMCP/artifacts/${job!.id}.png`;
                await fs.mkdir(path.join(engine.opts.projectDir, 'Saved', 'DreamMCP', 'artifacts'), { recursive: true });
                await fs.writeFile(path.join(engine.opts.projectDir, rel), PNG_1X1);
                return result('ok', 'Rendered a preview.', { artifacts: [{ kind: 'image', path: rel, title: 'preview' }], data: { pid: engine.pid } });
            },
        },
        slow: {
            async run(_args, { job }) {
                for (let i = 0; i < 400 && !job?.cancelled; i++) {
                    await sleep(25);
                    job?.progress(i / 400);
                }
                return result('ok', 'Slow finished.');
            },
        },
        stuck: {
            cancellable: false,
            async run(_args, { job }) {
                for (let i = 0; i < 40; i++) {
                    await sleep(25);
                    job?.progress(i / 40);
                }
                return result('ok', 'Stuck finished after all.');
            },
        },
        poke: {
            async run(args) {
                await sleep(Number(args.ms ?? 50));
                return result('ok', 'Poked.');
            },
        },
    };
}
