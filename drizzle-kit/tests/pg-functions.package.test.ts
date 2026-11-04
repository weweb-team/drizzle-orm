import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'vitest';
import { runPgArrayDefaultsContract } from './helpers/pgArrayDefaultsContract';
import { runPgIdentifierContract } from './helpers/pgIdentifierContract';
import { runPgRoutineContract } from './helpers/pgRoutineContract';

if (process.env.DRIZZLE_FUNCTION_TEST_PACKAGE === '1') {
	const require = createRequire(import.meta.url);
	const directory = resolve(process.env.DRIZZLE_FUNCTION_TEST_PACKAGE_PATH ?? './dist');
	describe('built CommonJS API', () => {
		const api = require(resolve(directory, 'api.js'));
		runPgRoutineContract(api);
		runPgArrayDefaultsContract(api);
		runPgIdentifierContract(api);
	});
	// Node 22+ loads ESM here without Vite rewriting the bundled artifact.
	describe('built ESM API', () => {
		const api = require(resolve(directory, 'api.mjs'));
		runPgRoutineContract(api);
		runPgArrayDefaultsContract(api);
		runPgIdentifierContract(api);
	});
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
