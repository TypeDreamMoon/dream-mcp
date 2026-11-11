import { MANIFEST_SCHEMA, PROTOCOL } from './config.js';

export type Needs = 'engine' | 'render' | 'none';

export interface OfflineSpec {
    kind: 'readFile' | 'listFiles';
    /** Relative path or glob. `{name}` is replaced by the string argument `name`. */
    path: string;
    /** What `path` is relative to. Defaults to the plugin root. */
    base: 'plugin' | 'project';
}

export interface ActionSpec {
    name: string;
    description: string;
    needs: Needs;
    writes: boolean;
    long: boolean;
    args: JsonObjectSchema;
    offline?: OfflineSpec;
}

export interface JsonObjectSchema {
    type: 'object';
    properties?: Record<string, JsonPropertySchema>;
    required?: string[];
    [key: string]: unknown;
}

export interface JsonPropertySchema {
    type?: string | string[];
    description?: string;
    enum?: unknown[];
    default?: unknown;
    [key: string]: unknown;
}

export interface ReferenceDoc {
    title: string;
    /** Relative to the plugin root. */
    path: string;
}

export interface Manifest {
    schema: number;
    protocol: number;
    id: string;
    plugin: string;
    title: string;
    description: string;
    route: string;
    host?: { commandlet: string };
    extensions: string[];
    sourceRoots: string[];
    reference: ReferenceDoc[];
    actions: ActionSpec[];
}

/** Names the server adds to every plugin tool; a manifest may not declare them. */
export const BUILTIN_ACTIONS = ['help', 'reference'] as const;

const ID = /^[a-z][a-z0-9_]{0,31}$/;
const ACTION = /^[a-z][a-z0-9_-]{0,47}$/;

export interface ManifestCheck {
    manifest?: Manifest;
    errors: string[];
    warnings: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function relativeSafe(p: string): boolean {
    if (/^[a-zA-Z]:/.test(p) || p.startsWith('/') || p.startsWith('\\')) return false;
    return !p.replace(/\\/g, '/').split('/').includes('..');
}

/** Validate a parsed manifest. Everything that would make the generated tool wrong is an error. */
export function checkManifest(raw: unknown): ManifestCheck {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!isObj(raw)) return { errors: ['the manifest is not a JSON object'], warnings };

    if (raw.schema !== MANIFEST_SCHEMA) errors.push(`"schema" must be ${MANIFEST_SCHEMA} (found ${JSON.stringify(raw.schema)})`);
    if (raw.protocol !== PROTOCOL) errors.push(`"protocol" must be ${PROTOCOL} (found ${JSON.stringify(raw.protocol)}); update the plugin or dream-mcp`);
    if (!isStr(raw.id) || !ID.test(raw.id)) errors.push('"id" must match ^[a-z][a-z0-9_]*$ (it becomes the tool name dream_<id>)');
    if (!isStr(raw.plugin)) errors.push('"plugin" (the plugin name) is required');
    if (!isStr(raw.description)) errors.push('"description" is required');
    if (!isStr(raw.route) || !raw.route.startsWith('/') || raw.route.endsWith('/')) errors.push('"route" must start with "/" and not end with "/"');

    let host: Manifest['host'];
    if (raw.host !== undefined) {
        if (!isObj(raw.host) || !isStr(raw.host.commandlet)) errors.push('"host.commandlet" must be a non-empty string');
        else host = { commandlet: raw.host.commandlet };
    }

    const strList = (key: string): string[] => {
        const v = raw[key];
        if (v === undefined) return [];
        if (!Array.isArray(v) || !v.every(isStr)) {
            errors.push(`"${key}" must be an array of strings`);
            return [];
        }
        return v as string[];
    };
    const extensions = strList('extensions');
    const sourceRoots = strList('sourceRoots');

    const reference: ReferenceDoc[] = [];
    if (raw.reference !== undefined) {
        if (!Array.isArray(raw.reference)) errors.push('"reference" must be an array');
        else
            raw.reference.forEach((r, i) => {
                if (!isObj(r) || !isStr(r.title) || !isStr(r.path)) errors.push(`reference[${i}] needs "title" and "path"`);
                else if (!relativeSafe(r.path)) errors.push(`reference[${i}].path must be relative to the plugin root and stay inside it`);
                else reference.push({ title: r.title, path: r.path });
            });
    }

    const actions: ActionSpec[] = [];
    if (!Array.isArray(raw.actions)) errors.push('"actions" must be an array');
    else {
        const seen = new Set<string>();
        raw.actions.forEach((a, i) => {
            const where = `actions[${i}]`;
            if (!isObj(a)) {
                errors.push(`${where} is not an object`);
                return;
            }
            const name = a.name;
            if (!isStr(name) || !ACTION.test(name)) {
                errors.push(`${where}.name must match ^[a-z][a-z0-9_-]*$`);
                return;
            }
            const at = `action "${name}"`;
            if ((BUILTIN_ACTIONS as readonly string[]).includes(name)) errors.push(`${at}: "${name}" is reserved (dream-mcp adds it to every tool)`);
            if (seen.has(name)) errors.push(`${at} is declared twice`);
            seen.add(name);
            if (!isStr(a.description)) errors.push(`${at}: "description" is required`);
            const needs = a.needs ?? 'engine';
            if (needs !== 'engine' && needs !== 'render' && needs !== 'none') errors.push(`${at}: "needs" must be engine, render or none`);
            if (a.writes !== undefined && typeof a.writes !== 'boolean') errors.push(`${at}: "writes" must be a boolean`);
            if (a.long !== undefined && typeof a.long !== 'boolean') errors.push(`${at}: "long" must be a boolean`);

            let args: JsonObjectSchema = { type: 'object', properties: {} };
            if (a.args !== undefined) {
                if (!isObj(a.args) || a.args.type !== 'object') errors.push(`${at}: "args" must be a JSON Schema with "type": "object"`);
                else {
                    args = a.args as JsonObjectSchema;
                    if (args.properties !== undefined && !isObj(args.properties)) errors.push(`${at}: "args.properties" must be an object`);
                    if (args.required !== undefined && (!Array.isArray(args.required) || !args.required.every(isStr)))
                        errors.push(`${at}: "args.required" must be an array of names`);
                    for (const r of args.required ?? []) if (!args.properties || !(r in args.properties)) errors.push(`${at}: required "${r}" is not in properties`);
                    for (const [k, p] of Object.entries(args.properties ?? {})) {
                        if (isObj(p) && (p.oneOf || p.anyOf || p.allOf)) warnings.push(`${at}: argument "${k}" uses oneOf/anyOf/allOf; keep args flat for weaker models`);
                        if (isObj(p) && p.type === 'object') warnings.push(`${at}: argument "${k}" is a nested object; keep args flat`);
                    }
                }
            }

            let offline: OfflineSpec | undefined;
            if (needs === 'none') {
                const o = a.offline;
                if (!isObj(o)) errors.push(`${at}: needs "none" requires "offline": { "kind", "path" }`);
                else if (o.kind !== 'readFile' && o.kind !== 'listFiles') errors.push(`${at}: offline.kind must be readFile or listFiles`);
                else if (!isStr(o.path) || !relativeSafe(o.path)) errors.push(`${at}: offline.path must be a relative path without ".."`);
                else if (o.base !== undefined && o.base !== 'plugin' && o.base !== 'project') errors.push(`${at}: offline.base must be plugin or project`);
                else offline = { kind: o.kind, path: o.path, base: (o.base as 'plugin' | 'project') ?? 'plugin' };
            } else if (a.offline !== undefined) {
                warnings.push(`${at}: "offline" is ignored unless needs is "none"`);
            }

            if (isStr(name) && isStr(a.description))
                actions.push({
                    name,
                    description: a.description,
                    needs: needs as Needs,
                    writes: a.writes === true,
                    long: a.long === true,
                    args,
                    ...(offline ? { offline } : {}),
                });
        });
        if (raw.actions.length === 0) warnings.push('the manifest declares no actions');
    }

    if (errors.length) return { errors, warnings };
    return {
        manifest: {
            schema: raw.schema as number,
            protocol: raw.protocol as number,
            id: raw.id as string,
            plugin: raw.plugin as string,
            title: isStr(raw.title) ? raw.title : (raw.plugin as string),
            description: raw.description as string,
            route: raw.route as string,
            ...(host ? { host } : {}),
            extensions,
            sourceRoots,
            reference,
            actions,
        },
        errors,
        warnings,
    };
}
