import { describe, expect, it } from 'vitest';
import { object, string } from 'zod';
import { safeRecord } from '../src/safeRecord';

describe('database catalog record validation', () => {
	const schema = safeRecord(string(), object({ name: string(), type: string().default('text') }).strict());
	it('preserves reserved own keys and normal defaults without changing the output prototype', () => {
		const input = Object.fromEntries(['__proto__', 'constructor', 'toString'].map((name) => [name, { name }]));
		const output = schema.parse(input);
		expect(Object.keys(output)).toEqual(Object.keys(input));
		expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
		expect(output['__proto__']).toEqual({ name: '__proto__', type: 'text' });
	});
	it('keeps exact validation paths for invalid reserved entries', () => {
		const result = schema.safeParse(Object.fromEntries([['__proto__', { name: 42 }]]));
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.issues[0].path).toEqual(['__proto__', 'name']);
	});
	it.each([null, [], 'not a record'])('continues to reject invalid record %j', (input) => {
		expect(schema.safeParse(input).success).toBe(false);
	});
});
