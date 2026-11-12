// Runs the compiled tests with node:test. Kept as a script because `node --test <dir>`
// and glob arguments behave differently across the Node versions this package supports.
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'test');
const only = process.argv[2];

function collect(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...collect(full));
        else if (name.endsWith('.test.js')) out.push(full);
    }
    return out;
}

const files = collect(root)
    .filter(f => (only ? f.includes(only) : !f.includes('contract')))
    .sort();
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
