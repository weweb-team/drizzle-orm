import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'vitest';
import { runPgArrayDefaultsContract } from './helpers/pgArrayDefaultsContract';
import { runPgIdentifierContract } from './helpers/pgIdentifierContract';
import { runPgIndexMetadataContract } from './helpers/pgIndexMetadataContract';
import { runPgRoutineContract } from './helpers/pgRoutineContract';

if (process.env.DRIZZLE_FUNCTION_TEST_PACKAGE === '1') {
	const require = createRequire(import.meta.url);
	const directory = resolve(process.env.DRIZZLE_FUNCTION_TEST_PACKAGE_PATH ?? './dist');
	function generateCode(_snapshot: unknown, databaseUrl: string) {
		const temporary = mkdtempSync(join(tmpdir(), 'drizzle-index-codegen-'));
		try {
			const output = join(temporary, 'schema');
			const config = join(temporary, 'drizzle.config.json');
			writeFileSync(
				config,
				JSON.stringify({ dialect: 'postgresql', dbCredentials: { url: databaseUrl }, out: output }),
			);
			execFileSync(process.execPath, [resolve(directory, 'bin.cjs'), 'pull', '--config', config], { stdio: 'pipe' });
			return readFileSync(join(output, 'schema.ts'), 'utf8');
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	}
	describe('built CommonJS API', () => {
		const api = require(resolve(directory, 'api.js'));
		runPgRoutineContract(api);
		runPgArrayDefaultsContract(api);
		runPgIdentifierContract(api, generateCode);
		runPgIndexMetadataContract(api);
	});
	// Node 22+ loads ESM here without Vite rewriting the bundled artifact.
	describe('built ESM API', () => {
		const api = require(resolve(directory, 'api.mjs'));
		runPgRoutineContract(api);
		runPgArrayDefaultsContract(api);
		runPgIdentifierContract(api, generateCode);
		runPgIndexMetadataContract(api);
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
