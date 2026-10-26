import { sql } from 'drizzle-orm';
import {
	boolean,
	char,
	cidr,
	customType,
	inet,
	integer,
	json,
	jsonb,
	macaddr,
	macaddr8,
	numeric,
	pgEnum,
	pgTable,
	text,
	time,
	timestamp,
	uuid,
	varchar,
} from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { Client, escapeIdentifier } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

export function runPgArrayDefaultsContract(
	api: typeof import('../../src/api'),
	transformSnapshot?: (
		snapshot: ReturnType<typeof api.generateDrizzleJson>,
	) => ReturnType<typeof api.generateDrizzleJson>,
) {
	const databaseUrl = process.env.DRIZZLE_FUNCTION_TEST_DATABASE_URL;
	if (process.env.DRIZZLE_FUNCTION_TEST_REQUIRED === '1' && !databaseUrl) {
		throw new Error('DRIZZLE_FUNCTION_TEST_DATABASE_URL is required for PostgreSQL array contracts');
	}

	describe.skipIf(!databaseUrl)('array default migrations (PostgreSQL)', () => {
		let admin: Client;
		let source: Client;
		let target: Client;
		const suffix = randomUUID().replaceAll('-', '');
		const names = [`array_source_${suffix}`, `array_target_${suffix}`];

		beforeAll(async () => {
			admin = new Client({ connectionString: databaseUrl });
			await admin.connect();
			for (const name of names) await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
			const url = new URL(databaseUrl!);
			url.pathname = `/${names[0]}`;
			source = new Client({ connectionString: url.href });
			url.pathname = `/${names[1]}`;
			target = new Client({ connectionString: url.href });
			await source.connect();
			await target.connect();
		});

		afterAll(async () => {
			await source?.end();
			await target?.end();
			if (!admin) return;
			for (const name of names) await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`);
			await admin.end();
		});

		beforeEach(async () => {
			for (const client of [source, target]) {
				await client.query('DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public');
			}
		});

		async function snapshot(client: Client) {
			const db = { query: async (sql: string, params?: any[]) => (await client.query(sql, params)).rows };
			return { id: api.originUUID, prevId: '', ...await api.introspectPostgres(db, () => true, ['public', 'auth']) };
		}

		async function generate() {
			const current = await snapshot(source);
			return api.generateMigration(await snapshot(target), transformSnapshot ? transformSnapshot(current) : current);
		}

		async function apply(statements: string[]) {
			await target.query('BEGIN');
			try {
				for (const statement of statements) await target.query(statement);
				await target.query('COMMIT');
			} catch (error) {
				await target.query('ROLLBACK');
				throw error;
			}
		}

		it.each([
			['empty UUID', 'uuid[]', "'{}'::uuid[]"],
			['nonempty UUID', 'uuid[]', "ARRAY['11111111-1111-4111-8111-111111111111'::uuid]"],
			['text constructor', 'text[]', "ARRAY['1'::text, '2'::text, '3'::text, '4'::text, '5'::text]"],
			['escaped text', 'text[]', String.raw`ARRAY['a,b', 'can''t', '"quoted"', E'back\\slash', '', 'NULL']`],
			['boolean and null elements', 'boolean[]', 'ARRAY[true, false, NULL]'],
			['multidimensional', 'integer[][]', 'ARRAY[[1,2],[3,4]]'],
			['numeric', 'numeric[]', 'ARRAY[1.25, 200.50]'],
			['date', 'date[]', "ARRAY['2026-10-26'::date]"],
			['timestamp', 'timestamp[]', "ARRAY['2026-10-26 12:34:56'::timestamp]"],
			['JSON with commas and apostrophes', 'jsonb[]', `ARRAY['{"a":[1,2],"b":"can''t"}'::jsonb, 'null'::jsonb]`],
			['function expression', 'text[]', "array_append(ARRAY['first'], 'last')"],
			['explicit bounds', 'integer[]', "'[0:1]={1,2}'::integer[]"],
		])('round-trips %s defaults through generated SQL and real default insertion', async (_name, type, expression) => {
			await source.query(`CREATE TABLE defaults (value ${type} DEFAULT ${expression})`);
			const original = (await source.query(
				"SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='defaults'",
			)).rows[0].column_default;
			expect((await snapshot(source)).tables['public.defaults'].columns.value.default).toBe(original);
			await apply(await generate());
			const originalRow = (await source.query('INSERT INTO defaults DEFAULT VALUES RETURNING value::text')).rows[0];
			expect((await target.query('INSERT INTO defaults DEFAULT VALUES RETURNING value::text')).rows[0]).toEqual(
				originalRow,
			);
			expect(await generate()).toEqual([]);
		});

		it('changes and removes defaults without modifying existing rows', async () => {
			for (const client of [source, target]) {
				await client.query(
					"CREATE TABLE defaults (ids uuid[] DEFAULT '{}'::uuid[], days text[] DEFAULT ARRAY['old']); INSERT INTO defaults DEFAULT VALUES",
				);
			}
			await source.query(
				"ALTER TABLE defaults ALTER COLUMN days SET DEFAULT ARRAY['new', 'a,b']; ALTER TABLE defaults ALTER COLUMN ids DROP DEFAULT",
			);
			await apply(await generate());
			expect((await target.query('SELECT * FROM defaults')).rows).toEqual([{ ids: [], days: ['old'] }]);
			expect((await target.query('INSERT INTO defaults DEFAULT VALUES RETURNING *')).rows).toEqual([{
				ids: null,
				days: ['new', 'a,b'],
			}]);
			expect(await generate()).toEqual([]);
		});

		it('preserves absent and explicit null defaults', async () => {
			await source.query('CREATE TABLE defaults (absent uuid[], explicit_null text[] DEFAULT NULL::text[])');
			await apply(await generate());
			expect((await target.query('INSERT INTO defaults DEFAULT VALUES RETURNING *')).rows).toEqual([{
				absent: null,
				explicit_null: null,
			}]);
			expect(await generate()).toEqual([]);
		});

		it('converges code-defined literal defaults without suppressing actual changes', async () => {
			await target.query("CREATE TABLE defaults (value integer[] DEFAULT '{1,2}'::integer[])");
			const declared = (values: number[]) =>
				api.generateDrizzleJson({ defaults: pgTable('defaults', { value: integer('value').array().default(values) }) });
			expect(await api.generateMigration(await snapshot(target), declared([1, 2]))).toEqual([]);
			const changed = await api.generateMigration(await snapshot(target), declared([3, 4]));
			expect(changed).toHaveLength(1);
			await apply(changed);
			expect((await target.query('INSERT INTO defaults DEFAULT VALUES RETURNING *')).rows).toEqual([{ value: [3, 4] }]);
			expect(await api.generateMigration(await snapshot(target), declared([3, 4]))).toEqual([]);
		});

		it('converges code-defined UUID, text, boolean and modified-type literal defaults', async () => {
			await target.query(`CREATE TABLE defaults (
				ids uuid[] DEFAULT '{}'::uuid[],
				words text[] DEFAULT '{a,b}'::text[],
				flags boolean[] DEFAULT '{t,f}'::boolean[],
				labels varchar(20)[] DEFAULT '{a,b}'::varchar[],
				amounts numeric(10,2)[] DEFAULT '{1.25,2.50}'::numeric[]
			)`);
			const declared = api.generateDrizzleJson({
				defaults: pgTable('defaults', {
					ids: uuid('ids').array().default([]),
					words: text('words').array().default(['a', 'b']),
					flags: boolean('flags').array().default([true, false]),
					labels: varchar('labels', { length: 20 }).array().default(['a', 'b']),
					amounts: numeric('amounts', { precision: 10, scale: 2 }).array().default(['1.25', '2.50']),
				}),
			});
			expect(await api.generateMigration(await snapshot(target), declared)).toEqual([]);
		});

		it('converges multidimensional code-defined defaults with PostgreSQL array casts', async () => {
			await target.query("CREATE TABLE defaults (value integer[][] DEFAULT '{{1,2},{3,4}}'::integer[])");
			const declared = api.generateDrizzleJson({
				defaults: pgTable('defaults', { value: integer('value').array().array().default([[1, 2], [3, 4]]) }),
			});
			expect(await api.generateMigration(await snapshot(target), declared)).toEqual([]);
		});

		it('converges code-defined enum array defaults and applies actual changes', async () => {
			await target.query(
				"CREATE TYPE mood AS ENUM ('a', 'b'); CREATE TABLE defaults (value mood[] DEFAULT '{a,b}'::mood[])",
			);
			const mood = pgEnum('mood', ['a', 'b']);
			const declared = (values: ('a' | 'b')[]) =>
				api.generateDrizzleJson({
					mood,
					defaults: pgTable('defaults', { value: mood('value').array().default(values) }),
				});
			expect(await api.generateMigration(await snapshot(target), declared(['a', 'b']))).toEqual([]);
			const changed = await api.generateMigration(await snapshot(target), declared(['b']));
			expect(changed).toHaveLength(1);
			await apply(changed);
			expect((await target.query('INSERT INTO defaults DEFAULT VALUES RETURNING value::text')).rows).toEqual([{
				value: '{b}',
			}]);
			expect(await api.generateMigration(await snapshot(target), declared(['b']))).toEqual([]);
		});

		it.each([
			[String.raw`'{"a\\",b}'`, String.raw`'{a\,b}'`, ['a,b']],
			['\'{"a "}\'', "'{a }'", ['a']],
			['\'{"null"}\'', "'{null}'", [null]],
		])('does not suppress a real change from %s to %s', async (previous, next, expected) => {
			await target.query(`CREATE TABLE defaults (value text[] DEFAULT ${previous}::text[])`);
			const declared = api.generateDrizzleJson({
				defaults: pgTable('defaults', { value: text('value').array().default(sql.raw(`${next}::text[]`)) }),
			});
			const changed = await api.generateMigration(await snapshot(target), declared);
			expect(changed).toHaveLength(1);
			await apply(changed);
			expect((await target.query('INSERT INTO defaults DEFAULT VALUES RETURNING *')).rows).toEqual([{
				value: expected,
			}]);
		});

		it.each([1, 1e-7, 1e21])(
			'converges code-defined JSONB array defaults (%s) without suppressing changes',
			async (value) => {
				const declared = (a: number) =>
					api.generateDrizzleJson({
						defaults: pgTable('defaults', { value: jsonb('value').array().default([{ a }]) }),
					});
				await apply(await api.generateMigration(await snapshot(target), declared(value)));
				expect(await api.generateMigration(await snapshot(target), declared(value))).toEqual([]);
				const changed = await api.generateMigration(await snapshot(target), declared(value * 2));
				expect(changed).toHaveLength(1);
				await apply(changed);
				expect((await target.query('INSERT INTO defaults DEFAULT VALUES RETURNING *')).rows).toEqual([{
					value: [{ a: value * 2 }],
				}]);
				expect(await api.generateMigration(await snapshot(target), declared(value * 2))).toEqual([]);
			},
		);

		it('converges code-defined timestamp array defaults with precision modifiers', async () => {
			const declared = (value: string) =>
				api.generateDrizzleJson({
					defaults: pgTable('defaults', {
						value: timestamp('value', { precision: 3, mode: 'string' }).array().default([value]),
					}),
				});
			await apply(await api.generateMigration(await snapshot(target), declared('2026-10-26 12:34:56')));
			expect(await api.generateMigration(await snapshot(target), declared('2026-10-26 12:34:56'))).toEqual([]);
			const changed = await api.generateMigration(await snapshot(target), declared('2026-10-27 12:34:56'));
			expect(changed).toHaveLength(1);
			await apply(changed);
			expect(await api.generateMigration(await snapshot(target), declared('2026-10-27 12:34:56'))).toEqual([]);
		});

		it.each([
			['char', pgTable('defaults', { value: char('value', { length: 3 }).array().default(['abc']) })],
			['inet', pgTable('defaults', { value: inet('value').array().default(['127.0.0.1']) })],
			['cidr', pgTable('defaults', { value: cidr('value').array().default(['127.0.0.0/8']) })],
			['macaddr', pgTable('defaults', { value: macaddr('value').array().default(['08:00:2b:01:02:03']) })],
			['macaddr8', pgTable('defaults', { value: macaddr8('value').array().default(['08:00:2b:01:02:03:04:05']) })],
			['time', pgTable('defaults', { value: time('value').array().default(['12:34:56']) })],
			[
				'timetz',
				pgTable('defaults', { value: time('value', { withTimezone: true }).array().default(['12:34:56+00']) }),
			],
		])('converges code-defined %s array defaults', async (_name, table) => {
			const declared = api.generateDrizzleJson({ defaults: table });
			await apply(await api.generateMigration(await snapshot(target), declared));
			expect(await api.generateMigration(await snapshot(target), declared)).toEqual([]);
		});

		it.each([
			['varchar(3)', 'varchar[]', 'abcd'],
			['bit varying(3)', 'bit varying[]', '1010'],
			['bit(3)', 'bit[]', '101'],
		])('preserves explicit %s array cast changes', async (type, cast, value) => {
			await target.query(`CREATE TABLE defaults (value ${type}[] DEFAULT '{${value}}'::${type}[])`);
			const column = customType<{ data: string }>({ dataType: () => type });
			const declared = api.generateDrizzleJson({
				defaults: pgTable('defaults', { value: column('value').array().default(sql.raw(`'{${value}}'::${cast}`)) }),
			});
			const changed = await api.generateMigration(await snapshot(target), declared);
			expect(changed).toHaveLength(1);
			await apply(changed);
			await expect(target.query('INSERT INTO defaults DEFAULT VALUES')).rejects.toThrow(/length|too long/);
		});

		it('converges ordinary bit array defaults through the quoted internal type', async () => {
			const bit = customType<{ data: string }>({ dataType: () => 'bit(3)' });
			const declared = api.generateDrizzleJson({
				defaults: pgTable('defaults', { value: bit('value').array().default(['101']) }),
			});
			await apply(await api.generateMigration(await snapshot(target), declared));
			expect(await api.generateMigration(await snapshot(target), declared)).toEqual([]);
		});

		it('preserves explicit char array cast changes that truncate values', async () => {
			await target.query("CREATE TABLE defaults (value char(3)[] DEFAULT '{abc}'::char(3)[])");
			const declared = api.generateDrizzleJson({
				defaults: pgTable('defaults', {
					value: char('value', { length: 3 }).array().default(sql.raw("'{abc}'::character[]")),
				}),
			});
			const changed = await api.generateMigration(await snapshot(target), declared);
			expect(changed).toHaveLength(1);
			await apply(changed);
			expect((await target.query('INSERT INTO defaults DEFAULT VALUES RETURNING value::text')).rows).toEqual([{
				value: '{"a  "}',
			}]);
		});

		it.each([
			['{"a": 1}', '{"a":1}'],
			['1e3', '1000'],
		])('preserves textual JSON array changes from %s to %s', async (previous, next) => {
			const literal = (value: string) => `'{${JSON.stringify(value)}}'::json[]`;
			await target.query(`CREATE TABLE defaults (value json[] DEFAULT ${literal(previous)})`);
			const declared = api.generateDrizzleJson({
				defaults: pgTable('defaults', { value: json('value').array().default(sql.raw(literal(next))) }),
			});
			const changed = await api.generateMigration(await snapshot(target), declared);
			expect(changed).toHaveLength(1);
			await apply(changed);
			expect((await target.query('INSERT INTO defaults DEFAULT VALUES RETURNING value[1]::text')).rows).toEqual([{
				value: next,
			}]);
			expect(await api.generateMigration(await snapshot(target), declared)).toEqual([]);
		});

		it.each([
			['1.0', '1'],
			['0.00', '0'],
			['1.2300e2', '123.0'],
		])('preserves JSONB numeric scale changes from %s to %s', async (previous, next) => {
			const literal = (value: string) => `'{${JSON.stringify(value)}}'::jsonb[]`;
			await target.query(`CREATE TABLE defaults (value jsonb[] DEFAULT ${literal(previous)})`);
			const declared = api.generateDrizzleJson({
				defaults: pgTable('defaults', { value: jsonb('value').array().default(sql.raw(literal(next))) }),
			});
			const changed = await api.generateMigration(await snapshot(target), declared);
			expect(changed).toHaveLength(1);
			await apply(changed);
			expect((await target.query('INSERT INTO defaults DEFAULT VALUES RETURNING value[1]::text')).rows).toEqual([{
				value: next,
			}]);
			expect(await api.generateMigration(await snapshot(target), declared)).toEqual([]);
		});

		it('keeps identically named array columns in different schemas separate', async () => {
			await source.query(
				"CREATE SCHEMA auth; CREATE TABLE public.defaults (ids uuid[] DEFAULT '{}'::uuid[]); CREATE TABLE auth.defaults (ids text[] DEFAULT ARRAY['auth', 'a,b'])",
			);
			await apply(await generate());
			expect((await target.query('INSERT INTO public.defaults DEFAULT VALUES RETURNING *')).rows).toEqual([{
				ids: [],
			}]);
			expect((await target.query('INSERT INTO auth.defaults DEFAULT VALUES RETURNING *')).rows).toEqual([{
				ids: ['auth', 'a,b'],
			}]);
			expect(await generate()).toEqual([]);
		});
	});
}
