import { randomUUID } from 'node:crypto';
import { Client, escapeIdentifier } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

export function runPgIndexMetadataContract(api: typeof import('../../src/api')) {
	const databaseUrl = process.env.DRIZZLE_FUNCTION_TEST_DATABASE_URL;
	if (process.env.DRIZZLE_FUNCTION_TEST_REQUIRED === '1' && !databaseUrl) {
		throw new Error('DRIZZLE_FUNCTION_TEST_DATABASE_URL is required for PostgreSQL index contracts');
	}

	describe.skipIf(!databaseUrl)('index column metadata migrations (PostgreSQL)', () => {
		let admin: Client;
		let source: Client;
		let target: Client;
		const suffix = randomUUID().replaceAll('-', '');
		const names = [`index_source_${suffix}`, `index_target_${suffix}`];

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
				await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
				await client.query(
					'CREATE TABLE records (status text, batch_date date, updated_at timestamp, sender_id uuid, sent_at timestamptz, tags text[])',
				);
			}
		});

		async function snapshot(client: Client) {
			const db = { query: async (sql: string, params?: any[]) => (await client.query(sql, params)).rows };
			return { id: api.originUUID, prevId: '', ...await api.introspectPostgres(db, () => true, ['public']) };
		}

		it.each([
			['mixed text/date', '(status, batch_date)', ['text_ops', 'date_ops']],
			['mixed text/timestamp DESC', '(status, updated_at DESC)', ['text_ops', 'timestamp_ops']],
			['mixed uuid/timestamptz', '(sender_id, sent_at)', ['uuid_ops', 'timestamptz_ops']],
			['mixed expression/column', '((lower(status)), batch_date)', ['text_ops', 'date_ops']],
			['explicit opclass and sort', '(status text_pattern_ops DESC NULLS LAST, batch_date ASC NULLS FIRST)', [
				'text_pattern_ops',
				'date_ops',
			]],
			['single DESC', '(updated_at DESC)', ['timestamp_ops']],
			['GIN opclass', 'USING gin (tags array_ops)', ['array_ops']],
		])('preserves %s through execution and an empty follow-up migration', async (_label, definition, opclasses) => {
			await source.query(`CREATE INDEX records_idx ON records ${definition}`);
			const wanted = await snapshot(source);
			const index = wanted.tables['public.records'].indexes.records_idx;
			expect(index.columns.map((column) => column.opclass)).toEqual(opclasses);
			if (definition.includes('lower')) {
				expect(index.columns.map((column) => column.isExpression)).toEqual([true, false]);
			}
			const statements = await api.generateMigration(await snapshot(target), wanted);
			expect(statements).toHaveLength(1);
			for (const statement of statements) await target.query(statement);
			const actual = await snapshot(target);
			expect(actual.tables['public.records'].indexes.records_idx).toEqual(index);
			expect(await api.generateMigration(actual, wanted)).toEqual([]);
		});
	});
}
