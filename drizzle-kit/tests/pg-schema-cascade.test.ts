import { pgSchema } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { Client, escapeIdentifier } from 'pg';
import { expect, it } from 'vitest';
import { generateDrizzleJson, generateMigration } from '../src/api';

it.each([undefined, false])('keeps schema deletion restrictive by default (cascade=%s)', async (cascadeDropSchemas) => {
	const before = generateDrizzleJson({ managed: pgSchema('managed') });
	const after = generateDrizzleJson({});
	const statements = await generateMigration(before, after, undefined, { cascadeDropSchemas });
	expect(statements).toHaveLength(1);
	expect(statements[0].trim()).toBe('DROP SCHEMA "managed";');
});

it('enables schema CASCADE only through an explicit API option', async () => {
	const before = generateDrizzleJson({ managed: pgSchema('managed') });
	const after = generateDrizzleJson({});
	const statements = await generateMigration(before, after, undefined, { cascadeDropSchemas: true });
	expect(statements).toHaveLength(1);
	expect(statements[0].trim()).toBe('DROP SCHEMA "managed" CASCADE;');
});

it.skipIf(!process.env.DRIZZLE_FUNCTION_TEST_DATABASE_URL)(
	'preserves untracked objects by default and removes them only with explicit CASCADE',
	async () => {
		const name = `cascade_${randomUUID().replaceAll('-', '')}`;
		const client = new Client({ connectionString: process.env.DRIZZLE_FUNCTION_TEST_DATABASE_URL });
		await client.connect();
		try {
			await client.query(`CREATE SCHEMA ${escapeIdentifier(name)}`);
			await client.query(`CREATE TABLE ${escapeIdentifier(name)}.untracked (id integer)`);
			const before = generateDrizzleJson({ managed: pgSchema(name) });
			const after = generateDrizzleJson({});
			const restrictive = await generateMigration(before, after);
			await expect(client.query(restrictive[0])).rejects.toMatchObject({ code: '2BP01' });
			expect((await client.query('SELECT to_regclass($1) AS name', [`${name}.untracked`])).rows[0].name).not.toBeNull();
			const cascade = await generateMigration(before, after, undefined, { cascadeDropSchemas: true });
			await client.query(cascade[0]);
			expect((await client.query('SELECT to_regclass($1) AS name', [`${name}.untracked`])).rows[0].name).toBeNull();
		} finally {
			await client.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(name)} CASCADE`);
			await client.end();
		}
	},
);
