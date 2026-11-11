import os from 'node:os';
import path from 'node:path';

export const SERVER_NAME = 'dream-mcp';
export const SERVER_VERSION = '2.0.0-dev';

/** The endpoint protocol this server speaks. A manifest or endpoint with another number is refused. */
export const PROTOCOL = 1;
/** The manifest schema this server reads. */
export const MANIFEST_SCHEMA = 1;

export const DEFAULT_PORT = 47800;
/** Environment variable that carries the endpoint token to a host this server starts. */
export const TOKEN_ENV = 'DREAM_MCP_TOKEN';
export const DEFAULT_IDLE_MINUTES = 15;

/** Where the registry, start locks and logs live. `DREAM_MCP_HOME` overrides it (tests use this). */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
    const override = env.DREAM_MCP_HOME;
    return override && override.trim() ? path.resolve(override) : path.join(os.homedir(), '.dream-mcp');
}

export interface Timings {
    /** Timeout for `GET hello`. */
    helloMs: number;
    /** Timeout for a short `/call`. */
    callMs: number;
    /** How long one tool call waits on a long job before handing back a job id. */
    jobWaitMs: number;
    /** Poll interval for jobs when there is no WebSocket. */
    pollMs: number;
    /** How long to wait for a started host to answer `hello`. */
    startMs: number;
    /** How long to wait for a host to exit after `/shutdown` before killing it. */
    stopMs: number;
    /** How often the list of other Unreal processes is refreshed while one of our hosts runs. */
    holderRefreshMs: number;
    /** How long a write waits for an editor that is opening the project to publish its endpoint. */
    editorWaitMs: number;
    /** How often a starting host reports that it is still starting. */
    startNoteMs: number;
    /** Idle check interval. */
    tickMs: number;
}

export function defaultTimings(env: NodeJS.ProcessEnv = process.env): Timings {
    const num = (name: string, fallback: number) => {
        const v = Number(env[name]);
        return Number.isFinite(v) && v > 0 ? v : fallback;
    };
    return {
        helloMs: 3000,
        callMs: num('DREAM_MCP_CALL_TIMEOUT_MS', 120_000),
        jobWaitMs: num('DREAM_MCP_JOB_WAIT_MS', 600_000),
        pollMs: 200,
        startMs: num('DREAM_MCP_START_TIMEOUT_MS', 600_000),
        stopMs: 30_000,
        startNoteMs: 5000,
        holderRefreshMs: 2000,
        editorWaitMs: num('DREAM_MCP_EDITOR_WAIT_MS', 120_000),
        tickMs: 30_000,
    };
}
