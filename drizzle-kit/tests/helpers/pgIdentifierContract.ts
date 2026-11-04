import { randomUUID } from 'node:crypto';
import { Client, escapeIdentifier } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

export function runPgIdentifierContract(api: typeof import('../../src/api')) {
	const databaseUrl = process.env.DRIZZLE_FUNCTION_TEST_DATABASE_URL;
	describe.skipIf(!databaseUrl)('reserved PostgreSQL identifier migration contract', () => {
		let admin: Client;
		let source: Client;
		let target: Client;
		const databases: string[] = [];
		const schemas = ['public', '__proto__', 'constructor'];
		const identifiers = [
			'__proto__',
			'constructor',
			'toString',
			'hasOwnProperty',
			'__drizzle_reserved_0__',
			'__drizzle_reserved_0____added',
		];

		beforeAll(async () => {
			admin = new Client({ connectionString: databaseUrl });
			await admin.connect();
			const suffix = randomUUID().replaceAll('-', '');
			for (const side of ['source', 'target']) {
				const name = `identifier_${side}_${suffix}`;
				await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
				databases.push(name);
			}
			const urls = databases.map((name) => {
				const url = new URL(databaseUrl!);
				url.pathname = `/${name}`;
				return url.href;
			});
			source = new Client({ connectionString: urls[0] });
			target = new Client({ connectionString: urls[1] });
			await source.connect();
			await target.connect();
		});

		afterAll(async () => {
			await source?.end();
			await target?.end();
			if (!admin) return;
			for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)}`);
			await admin.end();
		});

		beforeEach(async () => {
			for (const client of [source, target]) {
				for (const schema of schemas) {
					await client.query(
						`DROP SCHEMA IF EXISTS ${escapeIdentifier(schema)} CASCADE; CREATE SCHEMA ${escapeIdentifier(schema)}`,
					);
				}
			}
		});

		async function snapshot(client: Client) {
			return {
				id: api.originUUID,
				prevId: '',
				...await api.introspectPostgres(
					{ query: async (sql, params) => (await client.query(sql, params)).rows },
					() => true,
					schemas,
				),
			};
		}

		async function generate() {
			return api.generateMigration(await snapshot(target), await snapshot(source));
		}

		async function apply() {
			const statements = await generate();
			for (const statement of statements) await target.query(statement);
			expect(await generate()).toEqual([]);
			return statements;
		}

		it('retains reserved columns through introspection and identical-schema validation', async () => {
			const columns = identifiers.map((name) => `${escapeIdentifier(name)} text DEFAULT 'constructor'`).join(', ');
			for (const client of [source, target]) {
				await client.query(`CREATE TABLE public.identifiers (id integer PRIMARY KEY, ${columns})`);
			}
			const schema = await snapshot(source);
			for (const name of identifiers) {
				expect(Object.hasOwn(schema.tables['public.identifiers'].columns, name)).toBe(true);
			}
			expect(await generate()).toEqual([]);
			expect(Object.hasOwn(Object.prototype, 'columns')).toBe(false);
		});

		it('adds, alters and removes reserved columns without losing ordinary data', async () => {
			for (const client of [source, target]) {
				await client.query(
					'CREATE TABLE public.identifiers (id integer PRIMARY KEY); INSERT INTO public.identifiers VALUES (1)',
				);
			}
			for (const name of identifiers) {
				await source.query(
					`ALTER TABLE public.identifiers ADD COLUMN ${escapeIdentifier(name)} text DEFAULT 'constructor'`,
				);
			}
			expect((await apply()).length).toBeGreaterThan(0);
			await source.query(
				`ALTER TABLE public.identifiers ALTER COLUMN "__proto__" SET NOT NULL, ALTER COLUMN "constructor" SET DEFAULT '__proto__'`,
			);
			expect((await apply()).length).toBeGreaterThan(0);
			for (const name of identifiers) {
				await source.query(`ALTER TABLE public.identifiers DROP COLUMN ${escapeIdentifier(name)}`);
			}
			expect((await apply()).length).toBeGreaterThan(0);
			expect((await target.query('SELECT * FROM public.identifiers')).rows).toEqual([{ id: 1 }]);
		});

		it('preserves array/default metadata on reserved table and column names', async () => {
			await source.query(
				`CREATE TABLE public."constructor" (ordinary text[][] DEFAULT ARRAY[['first']], "constructor" text[][] DEFAULT ARRAY[['constructor']], "__proto__" boolean DEFAULT (random() > 0)); CREATE VIEW public."toString" AS SELECT * FROM public."constructor"`,
			);
			const current = await snapshot(source);
			expect(current.internal?.tables['constructor']?.columns['constructor']?.isArray).toBe(true);
			expect(current.tables['public.constructor'].columns['constructor'].type).toBe('text[][]');
			// PostgreSQL views expose attndims = 0, so their array rank matches the existing one-dimensional introspection.
			expect(current.views['public.toString'].columns['constructor'].type).toBe('text[]');
			expect(Object.hasOwn(current.views['public.toString'].columns, '__proto__')).toBe(true);
			expect(current.internal?.tables['constructor']?.columns['__proto__']?.isDefaultAnExpression).toBe(true);
			expect((await apply()).length).toBeGreaterThan(0);
		});

		it('adds, alters and drops reserved indexes, constraints and policies on existing tables', async () => {
			for (const client of [source, target]) {
				await client.query('CREATE TABLE public.identifiers (id integer PRIMARY KEY, value text)');
			}
			await source.query(
				`CREATE INDEX "__proto__" ON public.identifiers (value); ALTER TABLE public.identifiers ADD CONSTRAINT "constructor" UNIQUE (id, value); ALTER TABLE public.identifiers ADD CONSTRAINT "toString" CHECK (value <> 'constructor'); ALTER TABLE public.identifiers ENABLE ROW LEVEL SECURITY; CREATE POLICY first_policy ON public.identifiers USING (id > 0); CREATE POLICY "__proto__" ON public.identifiers USING (value <> 'constructor')`,
			);
			expect((await apply()).length).toBeGreaterThan(0);
			await source.query(
				`DROP INDEX public."__proto__"; CREATE INDEX "__proto__" ON public.identifiers (id); ALTER POLICY "__proto__" ON public.identifiers USING (id > 1)`,
			);
			expect((await apply()).length).toBeGreaterThan(0);
			await source.query(
				`DROP INDEX public."__proto__"; ALTER TABLE public.identifiers DROP CONSTRAINT "constructor", DROP CONSTRAINT "toString"; DROP POLICY "__proto__" ON public.identifiers`,
			);
			expect((await apply()).length).toBeGreaterThan(0);
		});

		it('preserves reserved enum names and labels through create and alter migrations', async () => {
			await source.query(
				`CREATE TYPE "constructor"."__proto__" AS ENUM ('constructor', '__next'); CREATE TABLE public.enum_values (id integer PRIMARY KEY, "__proto__" "constructor"."__proto__" DEFAULT 'constructor')`,
			);
			expect((await apply()).length).toBeGreaterThan(0);
			await source.query(
				`ALTER TYPE "constructor"."__proto__" ADD VALUE '__$!SCALAR1'; ALTER TYPE "constructor"."__proto__" ADD VALUE '__proto__'`,
			);
			expect((await apply()).length).toBeGreaterThan(0);
			await target.query(`INSERT INTO public.enum_values VALUES (1, '__$!SCALAR1'), (2, '__proto__')`);
			expect((await target.query('SELECT "__proto__" AS value FROM public.enum_values ORDER BY id')).rows).toEqual(
				[{ value: '__$!SCALAR1' }, { value: '__proto__' }],
			);
		});

		it('keeps reserved table, schema, view, index and routine names through apply and repeat', async () => {
			await source.query(
				`CREATE TABLE "__proto__"."constructor" (id integer PRIMARY KEY, "__proto__" text); CREATE INDEX "__proto__" ON "__proto__"."constructor" ("__proto__"); CREATE VIEW "constructor"."__proto__" AS SELECT "__proto__" FROM "__proto__"."constructor"; CREATE FUNCTION "constructor"."__proto__"() RETURNS text LANGUAGE sql AS $$ SELECT 'constructor'::text $$;`,
			);
			expect((await apply()).length).toBeGreaterThan(0);
			expect((await target.query('SELECT "constructor"."__proto__"() AS result')).rows).toEqual([{
				result: 'constructor',
			}]);
			await source.query(
				'DROP VIEW "constructor"."__proto__"; DROP FUNCTION "constructor"."__proto__"(); DROP TABLE "__proto__"."constructor"',
			);
			expect((await apply()).length).toBeGreaterThan(0);
			await source.query('DROP SCHEMA "__proto__"');
			expect((await apply()).length).toBeGreaterThan(0);
		});
	});
}
