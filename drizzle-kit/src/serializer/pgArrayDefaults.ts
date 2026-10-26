import { parse } from 'postgres-array';

/** Compare literal defaults without rewriting the SQL emitted for a real change. */
export function pgArrayDefaultKey(value: unknown, columnType: string, isEnum = false): unknown {
	if (typeof value !== 'string') return value;
	const normalizeType = (type: string) => {
		const base = isEnum ? type : type
			.replace('character varying', 'varchar')
			.replace('varbit', 'bit varying')
			.replace(' without time zone', '')
			.replace('character', 'char');
		// PostgreSQL uses one array type regardless of the column's declared dimensions.
		return base.replace(/\[\](?:\[\])*/g, '[]');
	};
	const type = normalizeType(columnType);
	const elementType = type.replace(/\([^)]*\)/g, '').replaceAll('[]', '');
	// Nonstandard element types can have another array delimiter (for example box uses ';').
	if (
		!isEnum && ![
			'uuid',
			'text',
			'varchar',
			'char',
			'integer',
			'smallint',
			'bigint',
			'numeric',
			'real',
			'double precision',
			'boolean',
			'date',
			'timestamp',
			'timestamp with time zone',
			'json',
			'jsonb',
			'time',
			'time with time zone',
			'interval',
			'inet',
			'cidr',
			'macaddr',
			'macaddr8',
			'bit',
			'bit varying',
			'bytea',
			'money',
			'point',
			'line',
			'lseg',
			'path',
			'polygon',
			'circle',
			'xml',
			'tsvector',
			'tsquery',
		].includes(elementType)
	) {
		return value;
	}
	const match = /^('(?:[^']|'')*')(?:\s*::\s*(.+))?$/s.exec(value);
	if (!match) return value;
	const cast = match[2] && normalizeType(match[2]);
	// Internal bpchar and quoted "bit" casts preserve the input length; their SQL
	// aliases character and bit instead mean length one when no modifier is supplied.
	const internalLengthCast = !isEnum
		&& ((elementType === 'char' && cast === 'bpchar[]') || (elementType === 'bit' && cast === '"bit"[]'));
	if (cast && cast !== type && cast !== type.replace(/\([^)]*\)/g, '') && !internalLengthCast) return value;
	if (cast && ['char', 'bit'].includes(elementType) && cast !== type && !internalLengthCast) return value;
	const literal = match[1].slice(1, -1).replaceAll("''", "'");
	// postgres-array expects PostgreSQL output syntax: it does not implement unquoted
	// escapes, whitespace trimming, or case-insensitive NULL input. Decline those input
	// forms rather than accidentally treating different values as equal.
	let quoted = false;
	for (let index = 0; index < literal.length; index++) {
		if (literal[index] === '\\') {
			if (!quoted) return value;
			index++;
		} else if (literal[index] === '"') {
			quoted = !quoted;
		} else if (!quoted) {
			if (/\s/.test(literal[index])) return value;
			const token = literal.slice(index, index + 4);
			if (
				['{', ','].includes(literal[index - 1]) && [',', '}'].includes(literal[index + 4])
				&& token.toUpperCase() === 'NULL' && token !== 'NULL'
			) return value;
		}
	}
	if (quoted) return value;
	const bounds = /^(\[[^=]+\])=/.exec(literal)?.[1] ?? '';
	if (!(literal.startsWith('{') || bounds)) return value;
	try {
		const entries = parse(literal, (entry) => {
			if (!isEnum && elementType === 'jsonb') {
				// PostgreSQL formats JSONB whitespace and numbers. Validate JSON, then
				// canonicalize tokens without converting numeric values to JS numbers.
				// json preserves its original text, so it must not use this normalization.
				JSON.parse(entry);
				return entry.replace(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\s+/g, (token) => {
					if (token.startsWith('"')) return token;
					if (/^\s/.test(token)) return '';
					const [mantissa, exponent = '0'] = token.toLowerCase().split('e');
					const fraction = mantissa.split('.')[1] ?? '';
					const decimalPlaces = BigInt(fraction.length) - BigInt(exponent);
					const displayScale = decimalPlaces > 0n ? decimalPlaces : 0n;
					const digits = mantissa.replace('-', '').replace('.', '').replace(/^0+/, '');
					if (!digits) return `0@${displayScale}`;
					const coefficient = digits.replace(/0+$/, '');
					const scale = BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - coefficient.length);
					// JSONB retains decimal scale in ::text, including for zero. Exponent
					// and decimal notation converge only when their stored scale also agrees.
					return `${mantissa.startsWith('-') ? '-' : ''}${coefficient}e${scale}@${displayScale}`;
				});
			}
			if (isEnum || elementType !== 'boolean') return entry;
			if (['t', 'true'].includes(entry.toLowerCase())) return 'true';
			if (['f', 'false'].includes(entry.toLowerCase())) return 'false';
			return entry;
		});
		// Explicit length casts may truncate or pad before assignment. Only compare
		// their literals when every element already fits the declared column length.
		const lengthType = !isEnum && /^(char|varchar|bit|bit varying)\((\d+)\)\[\]$/.exec(type);
		if (lengthType) {
			const width = Number(lengthType[2]);
			const fits = (entry: unknown): boolean => {
				if (Array.isArray(entry)) return entry.every(fits);
				if (entry === null) return true;
				if (typeof entry !== 'string') return false;
				const length = [...entry].length;
				return lengthType[1] === 'bit' ? length === width : length <= width;
			};
			if (!fits(entries)) return value;
		}
		// Quoted "NULL" remains a string; unquoted NULL remains null, and explicit bounds
		// participate in equality. Never evaluate arbitrary SQL expressions to compare them.
		return JSON.stringify([bounds, entries]);
	} catch {
		return value;
	}
}
