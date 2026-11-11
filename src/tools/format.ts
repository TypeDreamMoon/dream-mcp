import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ResultBody } from '../protocol/types.js';
import { isInside } from '../util/fs.js';

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function textResult(text: string, isError = false, structured?: Record<string, unknown>): CallToolResult {
    return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}), ...(isError ? { isError: true } : {}) };
}

/** One line per diagnostic: `error ABC1234 Source/Dir/File.ext:12:5 message (hint: ...) <doc>` */
export function diagnosticLine(d: ResultBody['diagnostics'][number]): string {
    const where = d.file ? `${d.file}${d.line ? `:${d.line}${d.column ? `:${d.column}` : ''}` : ''}` : '';
    return [d.severity ?? 'error', d.code, where, d.message].filter(Boolean).join(' ') + (d.hint ? ` (hint: ${d.hint})` : '') + (d.doc ? ` <${d.doc}>` : '');
}

/**
 * Turn a result body into tool output: a text block a model can act on without parsing
 * JSON (summary, one line per diagnostic, writes, next steps), the full body as
 * structured content, and any image artifacts as image content.
 */
export async function renderResult(result: ResultBody, opts: { projectDir?: string; header?: string; notes?: string[]; extra?: Record<string, unknown> } = {}): Promise<CallToolResult> {
    const lines: string[] = [];
    if (opts.header) lines.push(opts.header);
    const status = result.outcome === 'ok' ? '' : `[${result.outcome}${result.reason ? `: ${result.reason}` : ''}] `;
    lines.push(status + (result.summary || (result.ok ? 'Done.' : 'Failed.')));
    if (result.diagnostics.length) {
        lines.push(`Diagnostics (${result.diagnostics.length}):`);
        for (const d of result.diagnostics.slice(0, 200)) lines.push('  ' + diagnosticLine(d));
        if (result.diagnostics.length > 200) lines.push(`  ... ${result.diagnostics.length - 200} more in the structured content`);
    }
    if (result.writes.length) lines.push('Writes: ' + result.writes.map(w => `${w.asset} (${w.state})`).join(', '));
    for (const n of opts.notes ?? []) lines.push('Note: ' + n);
    if (result.next.length) {
        lines.push('Next:');
        for (const n of result.next) lines.push('  - ' + n);
    }
    const content: CallToolResult['content'] = [{ type: 'text', text: lines.join('\n') }];
    if (Object.keys(result.data).length) content.push({ type: 'text', text: 'data: ' + JSON.stringify(result.data, null, 2) });

    for (const a of result.artifacts) {
        const ext = path.extname(a.path).toLowerCase();
        const mime = IMAGE_TYPES[ext];
        if (a.kind !== 'image' || !mime || !opts.projectDir) continue;
        const full = path.resolve(opts.projectDir, a.path);
        if (!isInside(opts.projectDir, full)) continue;
        try {
            const stat = await fs.stat(full);
            if (stat.size > MAX_IMAGE_BYTES) {
                content.push({ type: 'text', text: `Image ${a.path} is ${Math.round(stat.size / 1048576)} MB; not inlined.` });
                continue;
            }
            content.push({ type: 'image', data: (await fs.readFile(full)).toString('base64'), mimeType: mime });
        } catch {
            content.push({ type: 'text', text: `Image ${a.path} was reported but cannot be read.` });
        }
    }
    const isError = result.outcome === 'refused' || result.outcome === 'engine-error';
    return { content, structuredContent: { ...result, ...(opts.extra ?? {}) } as Record<string, unknown>, ...(isError ? { isError: true } : {}) };
}
