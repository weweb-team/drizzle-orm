import { randomUUID } from 'node:crypto';
import { Client, escapeIdentifier } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AllDecisions } from '../../src/migrationState';

export function runPgRoutineContract(api: typeof import('../../src/api')) {
	const { introspectPostgres, generateMigration, ConflictNeedsResolutionError, originUUID } = api;
	const databaseUrl = process.env.DRIZZLE_FUNCTION_TEST_DATABASE_URL;
	if (process.env.CI && !databaseUrl) throw new Error('DRIZZLE_FUNCTION_TEST_DATABASE_URL is required in CI');
	let overloadOrder: string | undefined;

	async function readSnapshot(client: Client, direction = 'ASC') {
		const db = {
			query: async (sql: string, params?: any[]) => {
				if (overloadOrder && sql.includes("p.prokind = 'f'") && sql.includes('ORDER BY schema, name;')) {
					sql = sql.replace('ORDER BY schema, name;', `ORDER BY schema, name, p.oid ${direction};`);
				}
				if (overloadOrder && sql.includes("p.prokind IN ('f', 'p')")) {
					sql = sql.replace(
						'ORDER BY n.nspname, p.proname, parameters',
						`ORDER BY n.nspname, p.proname, p.oid ${direction}`,
					);
				}
				return (await client.query(sql, params)).rows;
			},
		};
		return { id: originUUID, prevId: '', ...await introspectPostgres(db, () => true, ['public', 'auth', 'storage']) };
	}

	describe.skipIf(!databaseUrl)('database function migrations (PostgreSQL + pgvector)', () => {
		let admin: Client;
		let source: Client;
		let target: Client;
		let databaseNames: string[];

		beforeAll(async () => {
			admin = new Client({ connectionString: databaseUrl });
			await admin.connect();
			const suffix = randomUUID().replaceAll('-', '');
			databaseNames = [`migration_source_${suffix}`, `migration_target_${suffix}`];
			for (const name of databaseNames) await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
			const sourceUrl = new URL(databaseUrl!);
			sourceUrl.pathname = `/${databaseNames[0]}`;
			const targetUrl = new URL(databaseUrl);
			targetUrl.pathname = `/${databaseNames[1]}`;
			source = new Client({ connectionString: sourceUrl.href });
			target = new Client({ connectionString: targetUrl.href });
			await source.connect();
			await target.connect();
		});

		afterAll(async () => {
			if (source) await source.end();
			if (target) await target.end();
			if (admin) {
				for (const name of databaseNames || []) await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)}`);
				await admin.end();
			}
		});

		beforeEach(async () => {
			overloadOrder = undefined;
			for (const pool of [source, target]) {
				await pool.query(
					'DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA IF EXISTS storage CASCADE',
				);
			}
		});

		async function generate(decisions?: AllDecisions) {
			return generateMigration(
				await readSnapshot(target),
				await readSnapshot(source, overloadOrder === 'different' ? 'DESC' : 'ASC'),
				decisions,
			);
		}

		async function conflictFor(stage: string) {
			try {
				await generate();
			} catch (error) {
				expect(error).toBeInstanceOf(ConflictNeedsResolutionError);
				expect((error as ConflictNeedsResolutionError).stage).toBe(stage);
				return (error as ConflictNeedsResolutionError).conflict;
			}
			throw new Error(`Expected a ${stage} conflict`);
		}

		async function apply(statements: string[], dryRun = false) {
			await target.query('BEGIN');
			try {
				for (const statement of statements) await target.query(statement);
				await target.query(dryRun ? 'ROLLBACK' : 'COMMIT');
			} catch (error) {
				await target.query('ROLLBACK');
				throw error;
			}
		}

		it('does not migrate pgvector functions when overload row order differs', async () => {
			for (const pool of [source, target]) await pool.query('CREATE EXTENSION vector');
			overloadOrder = 'different';
			const statements = await generate();
			await apply(statements, true);
			expect(statements).toEqual([]);
		});

		it('detects a changed overload even when another unchanged overload is returned last', async () => {
			overloadOrder = 'ascending';
			for (const pool of [source, target]) {
				await pool.query(
					`CREATE FUNCTION public.watch(value integer) RETURNS integer LANGUAGE sql AS 'SELECT value + 1';
                CREATE FUNCTION public.watch(value text) RETURNS text LANGUAGE sql AS 'SELECT value'`,
				);
			}
			await source.query(
				`CREATE OR REPLACE FUNCTION public.watch(value integer) RETURNS integer LANGUAGE sql AS 'SELECT value + 2'`,
			);
			const statements = await generate();
			expect(statements.length).toBeGreaterThan(0);
			await apply(statements);
			expect(
				(await target.query("SELECT public.watch(1) AS integer_result, public.watch('kept'::text) AS text_result"))
					.rows,
			).toEqual([{ integer_result: 3, text_result: 'kept' }]);
			expect(await generate()).toEqual([]);
		});

		it('drops only the removed overload', async () => {
			for (const pool of [source, target]) {
				await pool.query(`CREATE FUNCTION public.watch(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1';
                CREATE FUNCTION public.watch(text) RETURNS text LANGUAGE sql AS 'SELECT $1'`);
			}
			await source.query('DROP FUNCTION public.watch(text)');
			await apply(await generate());
			expect(
				(await target.query("SELECT to_regprocedure('public.watch(text)') IS NULL AS removed, public.watch(7) AS kept"))
					.rows,
			).toEqual([{ removed: true, kept: 7 }]);
			expect(await generate()).toEqual([]);
		});

		it('drops every removed overload despite drizzle deduplicating unsigned DROP statements', async () => {
			await target.query(`CREATE FUNCTION public.watch(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1';
            CREATE FUNCTION public.watch(text) RETURNS text LANGUAGE sql AS 'SELECT $1'`);
			const statements = await generate();
			expect(statements).toHaveLength(2);
			await apply(statements);
			expect(await generate()).toEqual([]);
		});

		it('creates every new overload', async () => {
			await source.query(`CREATE FUNCTION public.watch(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1';
            CREATE FUNCTION public.watch(text) RETURNS text LANGUAGE sql AS 'SELECT $1'`);
			const statements = await generate();
			expect(statements).toHaveLength(2);
			await apply(statements);
			expect(await generate()).toEqual([]);
		});

		it('keeps a customer overload with the same name as an extension function', async () => {
			for (const pool of [source, target]) {
				await pool.query(`CREATE EXTENSION vector;
                CREATE FUNCTION public.l1_distance(integer, integer) RETURNS integer LANGUAGE sql AS 'SELECT abs($1 - $2)'`);
			}
			await source.query(
				`CREATE OR REPLACE FUNCTION public.l1_distance(integer, integer) RETURNS integer LANGUAGE sql AS 'SELECT abs($1 - $2) + 1'`,
			);
			const statements = await generate();
			expect(statements).toHaveLength(1);
			expect(statements[0]).toMatch(/^CREATE OR REPLACE FUNCTION/);
			await apply(statements);
			expect(
				(await target.query(
					"SELECT public.l1_distance(1, 3) AS customer, public.l1_distance('[1,2]'::vector, '[2,4]'::vector) AS extension",
				)).rows,
			).toEqual([{ customer: 3, extension: 3 }]);
			expect(await generate()).toEqual([]);
		});

		it('ignores extension functions that exist in only one environment', async () => {
			await source.query('CREATE EXTENSION vector');
			expect(await generate()).toEqual([]);
			await source.query('DROP EXTENSION vector');
			await target.query('CREATE EXTENSION vector');
			expect(await generate()).toEqual([]);
		});

		it('uses input types rather than parameter names, defaults or OUT arguments as identity', async () => {
			await target.query(
				`CREATE FUNCTION public.watch(value integer DEFAULT 1, OUT result integer) LANGUAGE sql AS 'SELECT value + 1'`,
			);
			await source.query(
				`CREATE FUNCTION public.watch(renamed integer DEFAULT 2, OUT result integer) LANGUAGE sql AS 'SELECT renamed + 2'`,
			);
			const statements = await generate();
			expect(statements).toHaveLength(2);
			await apply(statements);
			expect((await target.query('SELECT public.watch() AS result')).rows).toEqual([{ result: 4 }]);
			expect(await generate()).toEqual([]);
		});

		it('handles zero arguments, arrays, variadic and INOUT arguments with quoted identifiers', async () => {
			const definitions = [
				`CREATE FUNCTION public."watch""quoted"() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
				`CREATE FUNCTION public."watch""quoted"(VARIADIC items integer[]) RETURNS integer LANGUAGE sql AS 'SELECT cardinality(items)'`,
				`CREATE FUNCTION public."watch""quoted"(INOUT value text) LANGUAGE sql AS 'SELECT value'`,
			];
			for (const definition of definitions) await target.query(definition);
			const statements = await generate();
			expect(statements).toHaveLength(3);
			await apply(statements);
			expect(await generate()).toEqual([]);
		});

		it('qualifies domain and composite argument types in storage and auth', async () => {
			for (const pool of [source, target]) {
				await pool.query(`CREATE SCHEMA auth; CREATE SCHEMA storage;
                CREATE DOMAIN auth."Watch Id" AS integer;
                CREATE TYPE storage."Watch Item" AS (value integer);
                CREATE FUNCTION auth.watch(auth."Watch Id") RETURNS integer LANGUAGE sql AS 'SELECT $1::integer';
                CREATE FUNCTION storage.watch(storage."Watch Item"[]) RETURNS integer LANGUAGE sql AS 'SELECT cardinality($1)'`);
			}
			await source.query(
				'DROP FUNCTION auth.watch(auth."Watch Id"); DROP FUNCTION storage.watch(storage."Watch Item"[])',
			);
			const statements = await generate();
			expect(statements).toHaveLength(2);
			await apply(statements);
			expect(await generate()).toEqual([]);
		});

		it('preserves schema filters without imposing application-specific exclusions', async () => {
			await source.query(`CREATE SCHEMA auth; CREATE SCHEMA private;
            CREATE FUNCTION public.jobs_schema_status(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1';
            CREATE FUNCTION auth.jobs_schema_status(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1';
            CREATE FUNCTION private.watch(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1'`);
			await target.query('CREATE SCHEMA auth');
			const statements = await generate();
			expect(statements).toHaveLength(2);
			await apply(statements);
			expect(await generate()).toEqual([]);
		});

		it('retains trigger ordering around function updates', async () => {
			for (const pool of [source, target]) {
				await pool.query(`CREATE TABLE public.events (value integer);
                CREATE FUNCTION public.watch() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
                CREATE FUNCTION public.watch(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1';
                CREATE TRIGGER watch_event BEFORE INSERT ON public.events FOR EACH ROW EXECUTE FUNCTION public.watch()`);
			}
			await source.query(`DROP TRIGGER watch_event ON public.events;
            CREATE OR REPLACE FUNCTION public.watch() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN NEW.value = NEW.value + 1; RETURN NEW; END';
            CREATE TRIGGER watch_event BEFORE INSERT OR UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.watch()`);
			await apply(await generate());
			expect((await target.query('INSERT INTO public.events VALUES (1) RETURNING value')).rows).toEqual([{ value: 2 }]);
			expect(await generate()).toEqual([]);
		});

		it('preserves table conflict decisions alongside overloaded functions', async () => {
			await source.query(`CREATE TABLE public.new_events(value integer);
            CREATE FUNCTION public.watch(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1';
            CREATE FUNCTION public.watch(text) RETURNS text LANGUAGE sql AS 'SELECT $1'`);
			await target.query('CREATE TABLE public.old_events(value integer)');
			const conflict = await conflictFor('tables');
			const resolved = await generate({
				tables: { created: conflict.created, deleted: conflict.deleted, renamed: [], moved: [] },
			});
			await apply(resolved);
			expect(await generate()).toEqual([]);
		});

		it.each(['scalar', 'array'])('drops a function after renaming its %s enum argument type', async (kind) => {
			const arraySuffix = kind === 'array' ? '[]' : '';
			for (const pool of [source, target]) {
				await pool.query(`CREATE TYPE public.old_status AS ENUM ('a');
                CREATE FUNCTION public.watch(public.old_status${arraySuffix}) RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
			}
			await source.query(
				`ALTER TYPE public.old_status RENAME TO new_status; DROP FUNCTION public.watch(public.new_status${arraySuffix})`,
			);
			const conflict = await conflictFor('enums');
			const result = await generate({
				enums: {
					created: [],
					deleted: [],
					renamed: [{ from: conflict.deleted[0], to: conflict.created[0] }],
					moved: [],
				},
			});
			await apply(result);
			expect((await target.query("SELECT count(*)::integer AS remaining FROM pg_proc WHERE proname = 'watch'")).rows)
				.toEqual([{ remaining: 0 }]);
			expect(await generate()).toEqual([]);
		});

		it.each([false, true])('recreates a function after moving its enum argument type (rename: %s)', async (rename) => {
			for (const pool of [source, target]) {
				await pool.query(`CREATE SCHEMA auth; CREATE TYPE public.old_status AS ENUM ('a');
                CREATE FUNCTION public.watch(public.old_status) RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
			}
			const typeName = rename ? 'new_status' : 'old_status';
			await source.query('ALTER TYPE public.old_status SET SCHEMA auth');
			if (rename) await source.query('ALTER TYPE auth.old_status RENAME TO new_status');
			await source.query(`DROP FUNCTION public.watch(auth.${typeName});
            CREATE FUNCTION public.watch(auth.${typeName}) RETURNS text LANGUAGE sql AS $$SELECT 'updated'::text$$`);
			const conflict = await conflictFor('enums');
			const result = await generate({
				enums: {
					created: [],
					deleted: [],
					renamed: rename ? [{ from: conflict.deleted[0], to: conflict.created[0] }] : [],
					moved: [{ name: 'old_status', schemaFrom: 'public', schemaTo: 'auth' }],
				},
			});
			await apply(result);
			expect((await target.query(`SELECT public.watch('a'::auth.${typeName}) AS result`)).rows).toEqual([{
				result: 'updated',
			}]);
			expect(await generate()).toEqual([]);
		});

		it('preserves dependent views and explicit grants for body-only changes', async () => {
			for (const client of [source, target]) {
				await client.query(`CREATE FUNCTION public.watch(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1 + 1';
                CREATE VIEW public.watched AS SELECT public.watch(1) AS result`);
			}
			await target.query(`REVOKE EXECUTE ON FUNCTION public.watch(integer) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION public.watch(integer) TO pg_read_all_data`);
			const before =
				(await target.query("SELECT oid, proacl FROM pg_proc WHERE oid = 'public.watch(integer)'::regprocedure")).rows;
			await source.query(
				`CREATE OR REPLACE FUNCTION public.watch(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1 + 2'`,
			);
			const statements = await generate();
			expect(statements).toHaveLength(1);
			expect(statements[0]).toMatch(/^CREATE OR REPLACE FUNCTION/);
			await apply(statements);
			expect((await target.query('SELECT * FROM public.watched')).rows).toEqual([{ result: 3 }]);
			expect(
				(await target.query("SELECT oid, proacl FROM pg_proc WHERE oid = 'public.watch(integer)'::regprocedure")).rows,
			).toEqual(before);
		});

		it('preserves dependencies when an enum argument is renamed', async () => {
			for (const client of [source, target]) {
				await client.query(`CREATE TYPE public.old_status AS ENUM ('a');
                CREATE FUNCTION public.watch(public.old_status) RETURNS integer LANGUAGE sql AS 'SELECT 1';
                CREATE VIEW public.watched AS SELECT public.watch('a'::public.old_status) AS result`);
			}
			await source.query(`ALTER TYPE public.old_status RENAME TO new_status;
            CREATE OR REPLACE FUNCTION public.watch(public.new_status) RETURNS integer LANGUAGE sql AS 'SELECT 2'`);
			const conflict = await conflictFor('enums');
			const statements = await generate({
				enums: {
					created: [],
					deleted: [],
					renamed: [{ from: conflict.deleted[0], to: conflict.created[0] }],
					moved: [],
				},
			});
			expect(statements.some((statement) => statement.startsWith('DROP FUNCTION'))).toBe(false);
			await apply(statements);
			expect((await target.query('SELECT * FROM public.watched')).rows).toEqual([{ result: 2 }]);
			expect(await generate()).toEqual([]);
		});

		it('recreates a function when its output column types change', async () => {
			for (const client of [source, target]) {
				await client.query(
					`CREATE FUNCTION public.watch(value integer, OUT first integer, OUT second text) LANGUAGE sql AS $$SELECT value, 'old'::text$$`,
				);
			}
			await source.query(`DROP FUNCTION public.watch(integer);
            CREATE FUNCTION public.watch(value integer, OUT first integer, OUT second integer) LANGUAGE sql AS 'SELECT value, value + 1'`);
			await apply(await generate());
			expect((await target.query('SELECT * FROM public.watch(1)')).rows).toEqual([{ first: 1, second: 2 }]);
			expect(await generate()).toEqual([]);
		});

		it('recreates a function when it becomes set-returning', async () => {
			for (const client of [source, target]) {
				await client.query(`CREATE FUNCTION public.watch(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1'`);
			}
			await source.query(`DROP FUNCTION public.watch(integer);
            CREATE FUNCTION public.watch(integer) RETURNS SETOF integer LANGUAGE sql AS 'SELECT $1 UNION ALL SELECT $1 + 1'`);
			await apply(await generate());
			expect((await target.query('SELECT * FROM public.watch(1)')).rows).toEqual([{ watch: 1 }, { watch: 2 }]);
			expect(await generate()).toEqual([]);
		});

		it('migrates procedure overloads without dropping the unchanged signature', async () => {
			for (const client of [source, target]) {
				await client.query(`CREATE PROCEDURE public.watch(integer) LANGUAGE plpgsql AS 'BEGIN NULL; END';
                CREATE PROCEDURE public.watch(text) LANGUAGE plpgsql AS 'BEGIN NULL; END'`);
			}
			await source.query('DROP PROCEDURE public.watch(text)');
			await apply(await generate());
			expect(
				(await target.query(
					"SELECT count(*)::integer AS remaining FROM pg_proc WHERE proname = 'watch' AND prokind = 'p'",
				)).rows,
			).toEqual([{ remaining: 1 }]);
			expect(await generate()).toEqual([]);
		});

		it('excludes extension-owned procedures', async () => {
			await source.query(`CREATE EXTENSION vector;
            CREATE PROCEDURE public.extension_watch(integer) LANGUAGE plpgsql AS 'BEGIN NULL; END';
            ALTER EXTENSION vector ADD PROCEDURE public.extension_watch(integer)`);
			expect(await generate()).toEqual([]);
		});

		it('accepts unchanged legacy snapshots and requests re-introspection before destructive legacy diffs', async () => {
			for (const client of [source, target]) {
				await client.query(`CREATE FUNCTION public.watch(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1'`);
			}
			const previous = await readSnapshot(target);
			const current = await readSnapshot(source);
			previous.functions = Object.fromEntries(
				Object.values(previous.functions).map((fn) => [
					`${fn.schema}.${fn.name}`,
					{ name: fn.name, schema: fn.schema, definition: fn.definition },
				]),
			);
			expect(await generateMigration(previous, current)).toEqual([]);
			await source.query('DROP FUNCTION public.watch(integer)');
			await expect(generateMigration(previous, await readSnapshot(source))).rejects.toThrow('Re-introspect');
		});
	});
}
