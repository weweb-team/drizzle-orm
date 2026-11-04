import { diff as jsonDiff } from 'json-diff';

const reservedNames = Object.getOwnPropertyNames(Object.prototype);

function containsPrefix(value: unknown, prefix: string): boolean {
	if (typeof value === 'string') return value.startsWith(prefix);
	if (Array.isArray(value)) return value.some((item) => containsPrefix(item, prefix));
	if (!value || typeof value !== 'object') return false;
	return Object.entries(value).some(([key, item]) => key.startsWith(prefix) || containsPrefix(item, prefix));
}

/** Isolate json-diff's inherited-key lookups and plain-object writes from PostgreSQL identifier strings. */
export function diff(left: unknown, right: unknown) {
	let counter = 0;
	let prefix: string;
	do {
		prefix = `__drizzle_reserved_${counter++}__`;
	} while (containsPrefix(left, prefix) || containsPrefix(right, prefix));
	const names = new Set(reservedNames);
	function collect(value: unknown) {
		if (typeof value === 'string' && (value === '__next' || value.startsWith('__$!SCALAR'))) names.add(value);
		if (Array.isArray(value)) {
			for (const item of value) collect(item);
			return;
		}
		if (value && typeof value === 'object') {
			for (const [key, item] of Object.entries(value)) {
				collect(key);
				collect(item);
			}
		}
	}
	collect(left);
	collect(right);
	const encoded = new Map([...names].map((name, index) => [name, `${prefix}${index}_`]));
	const decoded = new Map([...encoded].map(([name, token]) => [token, name]));
	function map(value: unknown, encode: boolean): unknown {
		const names = encode ? encoded : decoded;
		if (typeof value === 'string') return names.get(value) ?? value;
		if (Array.isArray(value)) return value.map((item) => map(item, encode));
		if (!value || typeof value !== 'object' || value instanceof Date) return value;
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => {
				let mappedKey = names.get(key) ?? key;
				if (!encode && key.startsWith(prefix)) {
					for (const suffix of ['__added', '__deleted']) {
						if (key.endsWith(suffix)) {
							mappedKey = (decoded.get(key.slice(0, -suffix.length)) ?? key.slice(0, -suffix.length)) + suffix;
						}
					}
				}
				return [mappedKey, map(item, encode)];
			}),
		);
	}
	return map(jsonDiff(map(left, true), map(right, true)), false);
}
