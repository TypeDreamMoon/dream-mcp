#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { SERVER_VERSION } from './config.js';
import { DreamServer } from './server.js';

const HELP = `dream-mcp ${SERVER_VERSION}
MCP server (stdio) for the Dream Unreal Engine plugins.

Usage: dream-mcp [--project <path to .uproject or its folder>]

Environment:
  DREAM_MCP_PROJECT   project to use when none was picked with dream_workspace use
  DREAM_MCP_HOME      where the registry and logs live (default: ~/.dream-mcp)
`;

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write(HELP);
        return;
    }
    if (argv.includes('--version') || argv.includes('-v')) {
        process.stdout.write(SERVER_VERSION + '\n');
        return;
    }
    const env = { ...process.env };
    const i = argv.indexOf('--project');
    if (i >= 0 && argv[i + 1]) env.DREAM_MCP_PROJECT = argv[i + 1];

    const dream = new DreamServer({ env });
    await dream.sync();
    dream.start();

    let closing = false;
    const handle = serveStdio(() => dream.createMcpServer(), { onerror: e => process.stderr.write(`[dream-mcp] ${e.message}\n`) });
    const exit = async (why: string) => {
        if (closing) return;
        closing = true;
        try {
            await dream.close(why);
            await handle.close();
        } finally {
            process.exit(0);
        }
    };
    process.stdin.on('end', () => void exit('stdin closed'));
    process.stdin.on('close', () => void exit('stdin closed'));
    process.on('SIGINT', () => void exit('SIGINT'));
    process.on('SIGTERM', () => void exit('SIGTERM'));
}

main().catch(error => {
    process.stderr.write(`[dream-mcp] ${(error as Error).stack ?? error}\n`);
    process.exit(1);
});
