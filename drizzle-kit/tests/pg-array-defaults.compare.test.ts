import { expect, it } from 'vitest';
import { pgArrayDefaultKey } from '../src/serializer/pgArrayDefaults';

it('compares safe literal representations while keeping meaningful distinctions', () => {
	const unterminated = "'{\"unterminated}'::text[]";
	expect(pgArrayDefaultKey(unterminated, 'text[]')).toBe(unterminated);
	const jsonDefault = (value: string) => `'{${JSON.stringify(value)}}'::jsonb[]`;
	expect(pgArrayDefaultKey(jsonDefault('1.0'), 'jsonb[]')).not.toBe(pgArrayDefaultKey(jsonDefault('1'), 'jsonb[]'));
	expect(pgArrayDefaultKey(jsonDefault('0.00'), 'jsonb[]')).not.toBe(pgArrayDefaultKey(jsonDefault('0'), 'jsonb[]'));
	expect(pgArrayDefaultKey(jsonDefault('{"a": 1}'), 'jsonb[]')).toBe(
		pgArrayDefaultKey(jsonDefault('{"a":1}'), 'jsonb[]'),
	);
	expect(pgArrayDefaultKey(jsonDefault('{"a":9007199254740992}'), 'jsonb[]')).not.toBe(
		pgArrayDefaultKey(jsonDefault('{"a":9007199254740993}'), 'jsonb[]'),
	);
	expect(pgArrayDefaultKey(String.raw`'{a\,b}'::text[]`, 'text[]')).not.toBe(
		pgArrayDefaultKey(String.raw`'{"a\\",b}'::text[]`, 'text[]'),
	);
	expect(pgArrayDefaultKey("'{a }'::text[]", 'text[]')).not.toBe(pgArrayDefaultKey('\'{"a "}\'::text[]', 'text[]'));
	expect(pgArrayDefaultKey("'{null}'::text[]", 'text[]')).not.toBe(pgArrayDefaultKey('\'{"null"}\'::text[]', 'text[]'));
	expect(pgArrayDefaultKey("'{a,b}'::text[]", 'text[]')).toBe(pgArrayDefaultKey('\'{"a","b"}\'', 'text[]'));
	expect(pgArrayDefaultKey("'{NULL}'::text[]", 'text[]')).not.toBe(pgArrayDefaultKey('\'{"NULL"}\'', 'text[]'));
	expect(pgArrayDefaultKey("'{}'::uuid[]", 'uuid[]')).not.toBe(pgArrayDefaultKey("'{NULL}'::uuid[]", 'uuid[]'));
	expect(pgArrayDefaultKey("'[0:1]={1,2}'::integer[]", 'integer[]')).not.toBe(
		pgArrayDefaultKey("'{1,2}'", 'integer[]'),
	);
	expect(pgArrayDefaultKey("'{1,2}'::bigint[]", 'integer[]')).not.toBe(pgArrayDefaultKey("'{1,2}'", 'integer[]'));
	expect(pgArrayDefaultKey("'{1.234}'::numeric(10,2)[]", 'numeric(10,3)[]')).not.toBe(
		pgArrayDefaultKey("'{1.234}'", 'numeric(10,3)[]'),
	);
	expect(pgArrayDefaultKey('array_append(ARRAY[1], 2)', 'integer[]')).not.toBe(
		pgArrayDefaultKey("'{1,2}'", 'integer[]'),
	);
});
