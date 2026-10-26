import { integer, pgTable } from 'drizzle-orm/pg-core';
import { transformSync } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import * as api from '../src/api';
import { schemaToTypeScript } from '../src/introspect-pg';
import { runPgArrayDefaultsContract } from './helpers/pgArrayDefaultsContract';

const require = createRequire(import.meta.url);

it('generates executable TypeScript that preserves array expressions as SQL', async () => {
	const schema = api.generateDrizzleJson({ defaults: pgTable('defaults', { value: integer('value').array() }) });
	schema.internal = { tables: { defaults: { columns: { value: { isArray: true, dimensions: 1 } } } } };
	for (
		const expression of [
			"'{1,2}'::integer[]",
			'ARRAY[1, 2]',
			"array_append('{}'::integer[], 1)",
			"'{1,2}' /* ` ${throwIfEvaluated()} */",
		]
	) {
		schema.tables['public.defaults'].columns.value.default = expression;
		const { file } = schemaToTypeScript(schema, 'preserve');
		const module = { exports: {} };
		runInNewContext(transformSync(file, { loader: 'ts', format: 'cjs' }).code, {
			module,
			exports: module.exports,
			require,
		});
		const regenerated = api.generateDrizzleJson(module.exports);
		expect(regenerated.tables['public.defaults'].columns.value.default).toBe(expression);
		expect(await api.generateMigration(schema, regenerated)).toEqual([]);
	}
});

// The common PostgreSQL contract covers application SQL; this file also checks the CLI's
// database-to-code-to-database path by round-tripping the actual introspected snapshot.
runPgArrayDefaultsContract(api, (snapshot) => {
	const { file } = schemaToTypeScript(snapshot, 'preserve');
	const module = { exports: {} };
	runInNewContext(transformSync(file, { loader: 'ts', format: 'cjs' }).code, {
		module,
		exports: module.exports,
		require,
	});
	return api.generateDrizzleJson(module.exports);
});
