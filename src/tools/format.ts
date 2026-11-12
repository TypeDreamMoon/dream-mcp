import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ResultBody } from '../protocol/types.js';
import { isInside } from '../util/fs.js';

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/**
 * How much of a result's `data` object the text repeats (it is always complete in the
 * structured content):
 * - a result with a `text` block does not repeat `data` at all;
 * - a result that is only an answer (no diagnostics, writes or artifacts, as from a lookup)
 *   repeats `data` in full up to DATA_ANSWER_LIMIT characters;
 * - any other result repeats it in full up to DATA_FULL_LIMIT characters, and otherwise
 *   gives a summary of its first fields, at most DATA_SUMMARY_LIMIT characters.
 */
export const DATA_ANSWER_LIMIT = 12_000;
export const DATA_FULL_LIMIT = 1_000;
export const DATA_SUMMARY_LIMIT = 600;

/**
 * A result's optional `text` block is shown verbatim up to this many characters (enough for
 * a layout tree of several hundred nodes), cut at a line boundary beyond that.
 */
export const TEXT_LIMIT = 20_000;

/** The `text` block as shown: verbatim, or cut at a line end with a line saying how much was left out. */
export function textBlock(text: string): string {
    const trimmed = text.replace(/\s+$/, '');
    if (trimmed.length <= TEXT_LIMIT) return trimmed;
    let cut = trimmed.lastIndexOf('\n', TEXT_LIMIT);
    if (cut <= 0) cut = TEXT_LIMIT;
    const shown = trimmed.slice(0, cut).replace(/\s+$/, '');
    const totalLines = trimmed.split('\n').length;
    const shownLines = shown.split('\n').length;
    return `${shown}\n[text cut: showed ${shownLines} of ${totalLines} lines (${shown.length} of ${trimmed.length} characters). The full text is the "text" field of the structured content; Next says how to ask for less.]`;
}

/** `key: value; key: [12 items]; key: {a, b, c}` -- the shape of an object, not its contents. */
function summarize(data: Record<string, unknown>): string {
    const brief = (v: unknown): string => {
        if (v === null || typeof v !== 'object') {
            const s = JSON.stringify(v) ?? String(v);
            return s.length > 80 ? `${s.slice(0, 77)}…"` : s;
        }
        if (Array.isArray(v)) {
            if (v.length && v.length <= 4 && v.every(x => x === null || typeof x !== 'object')) return JSON.stringify(v);
            return `[${v.length} item${v.length === 1 ? '' : 's'}]`;
        }
        const keys = Object.keys(v);
        return `{${keys.slice(0, 6).join(', ')}${keys.length > 6 ? `, … ${keys.length - 6} more` : ''}}`;
    };
    let out = '';
    for (const [k, v] of Object.entries(data)) {
        const part = `${out ? '; ' : ''}${k}: ${brief(v)}`;
        if (out.length + part.length > DATA_SUMMARY_LIMIT) return `${out}; …`;
        out += part;
    }
    return out;
}

export function dataText(result: ResultBody): string | undefined {
    if (!Object.keys(result.data).length) return undefined;
    // A result that brings its own text for the model does not need its data repeated as
    // well; data stays complete in the structured content.
    if (result.text) return undefined;
    const json = JSON.stringify(result.data);
    const answer = !result.diagnostics.length && !result.writes.length && !result.artifacts.length;
    if (json.length <= (answer ? DATA_ANSWER_LIMIT : DATA_FULL_LIMIT)) return `data: ${json}`;
    if (answer)
        return `data (first ${DATA_ANSWER_LIMIT} of ${json.length} characters; the complete object is the "data" field of the structured content): ${json.slice(0, DATA_ANSWER_LIMIT)}…`;
    return `data (summary of ${json.length} characters; the complete object is the "data" field of the structured content): ${summarize(result.data)}`;
}

/**
 * A plain answer. The same words go in the text content and in the structured content's
 * `text`: some clients (code-mode agents) hand the model only the structured content, and
 * it must be able to answer from that alone.
 */
export function textResult(text: string, isError = false, structured?: Record<string, unknown>): CallToolResult {
    return { content: [{ type: 'text', text }], structuredContent: { ...(structured ?? {}), text }, ...(isError ? { isError: true } : {}) };
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
    // Pre-formatted text from the endpoint, after the summary and before diagnostics, as is.
    if (result.text) lines.push(textBlock(result.text));
    if (result.diagnostics.length) {
        lines.push(`Diagnostics (${result.diagnostics.length}):`);
        for (const d of result.diagnostics.slice(0, 200)) lines.push('  ' + diagnosticLine(d));
        if (result.diagnostics.length > 200) lines.push(`  ... ${result.diagnostics.length - 200} more in the structured content`);
    }
    if (result.writes.length) lines.push('Writes: ' + result.writes.map(w => `${w.asset} (${w.state})`).join(', '));
    // Paths in the text too: not every client hands structured content to the model.
    // Once is enough: skip a path the endpoint's summary already names.
    for (const a of result.artifacts) {
        if (lines.some(l => l.includes(a.path))) continue;
        lines.push(`${a.kind === 'image' ? 'Image' : `Artifact (${a.kind})`}: ${a.path}${a.title ? ` (${a.title})` : ''}`);
    }
    for (const n of opts.notes ?? []) lines.push('Note: ' + n);
    if (result.next.length) {
        lines.push('Next:');
        for (const n of result.next) lines.push('  - ' + n);
    }
    const content: CallToolResult['content'] = [{ type: 'text', text: lines.join('\n') }];
    const data = dataText(result);
    if (data) content.push({ type: 'text', text: data });

    const imageNotes: string[] = [];
    for (const a of result.artifacts) {
        const ext = path.extname(a.path).toLowerCase();
        const mime = IMAGE_TYPES[ext];
        if (a.kind !== 'image' || !mime || !opts.projectDir) continue;
        const full = path.resolve(opts.projectDir, a.path);
        if (!isInside(opts.projectDir, full)) continue;
        try {
            const stat = await fs.stat(full);
            if (stat.size > MAX_IMAGE_BYTES) {
                imageNotes.push(`Image ${a.path} is ${Math.round(stat.size / 1048576)} MB; not inlined.`);
                content.push({ type: 'text', text: imageNotes[imageNotes.length - 1]! });
                continue;
            }
            content.push({ type: 'image', data: (await fs.readFile(full)).toString('base64'), mimeType: mime });
        } catch {
            imageNotes.push(`Image ${a.path} was reported but cannot be read.`);
            content.push({ type: 'text', text: imageNotes[imageNotes.length - 1]! });
        }
    }
    const isError = result.outcome === 'refused' || result.outcome === 'engine-error';
    // Everything the text says is also in the structured content (see textResult).
    const notes = [...(opts.header ? [opts.header] : []), ...(opts.notes ?? []), ...imageNotes];
    const structured = { ...result, ...(notes.length ? { notes } : {}), ...(opts.extra ?? {}) };
    return { content, structuredContent: structured as Record<string, unknown>, ...(isError ? { isError: true } : {}) };
}
