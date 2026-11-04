import { describe, expect, it } from 'vitest';
import { diff } from '../src/safeJsonDiff';

describe('catalog diff reserved-name isolation', () => {
	it('retains changed reserved keys and generated added/deleted suffixes', () => {
		const left = Object.fromEntries([['__proto__', { name: 'before' }], ['toString', 'removed']]);
		const right = Object.fromEntries([['__proto__', { name: 'after' }], ['constructor', 'added']]);
		const result = diff(left, right);
		expect(Object.keys(result as object)).toEqual(['toString__deleted', 'constructor__added', '__proto__']);
		expect(result).toEqual(
			Object.fromEntries([['toString__deleted', 'removed'], ['constructor__added', 'added'], ['__proto__', {
				name: { __old: 'before', __new: 'after' },
			}]]),
		);
	});
	it('does not confuse actual prefix-shaped values or nested values with escape tokens', () => {
		const value = Object.fromEntries([['__drizzle_reserved_0__', '__drizzle_reserved_1__'], ['__proto__', [
			'constructor',
			'__drizzle_reserved_0__0___added',
		]]]);
		expect(diff({}, value)).toEqual(
			Object.fromEntries([['__drizzle_reserved_0____added', '__drizzle_reserved_1__'], ['__proto____added', [
				'constructor',
				'__drizzle_reserved_0__0___added',
			]]]),
		);
	});
	it('keeps json-diff scalar-cache names as literal array strings', () => {
		expect(diff([], ['__next'])).toEqual([['+', '__next']]);
		expect(diff([{ x: 1 }], [{ x: 1 }, '__$!SCALAR1'])).toEqual([[' '], ['+', '__$!SCALAR1']]);
	});
});
