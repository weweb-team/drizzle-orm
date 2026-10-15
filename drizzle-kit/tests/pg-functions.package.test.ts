import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'vitest';
import { runPgRoutineContract } from './helpers/pgRoutineContract';

if (process.env.DRIZZLE_FUNCTION_TEST_PACKAGE === '1') {
	const require = createRequire(import.meta.url);
	const directory = resolve(process.env.DRIZZLE_FUNCTION_TEST_PACKAGE_PATH ?? './dist');
	describe('built CommonJS API', () => runPgRoutineContract(require(resolve(directory, 'api.js'))));
	// Node 22+ loads ESM here without Vite rewriting the bundled artifact.
	describe('built ESM API', () => runPgRoutineContract(require(resolve(directory, 'api.mjs'))));
	it('supports native ESM import', () => {
		const url = pathToFileURL(resolve(directory, 'api.mjs')).href;
		execFileSync(process.execPath, [
			'--input-type=module',
			'-e',
			`
			import { strict as assert } from 'node:assert';
			const api = await import(${JSON.stringify(url)});
			for (const name of ['introspectPostgres', 'generateMigration', 'ConflictNeedsResolutionError']) {
				assert.equal(typeof api[name], 'function');
			}
			assert.equal(typeof api.originUUID, 'string');
		`,
		]);
	});
} else {
	describe.skip('built PostgreSQL routine API', () => {
		it('requires DRIZZLE_FUNCTION_TEST_PACKAGE=1 and a built dist directory', () => {});
	});
}
