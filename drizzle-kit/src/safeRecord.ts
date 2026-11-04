import { NEVER, type output, record, unknown, type ZodString, type ZodTypeAny } from 'zod';

/** Database names are data keys; Zod 3's record parser otherwise discards the legitimate `__proto__` key. */
export function safeRecord<Value extends ZodTypeAny>(keySchema: ZodString, valueSchema: Value) {
	const schema = record(keySchema, valueSchema);
	return unknown().transform<Record<string, output<Value>>>((input, context) => {
		const parsed = schema.safeParse(input);
		if (!parsed.success) {
			for (const issue of parsed.error.issues) context.addIssue(issue);
			return NEVER;
		}
		if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, '__proto__')) {
			const value = valueSchema.safeParse((input as Record<string, unknown>)['__proto__']);
			if (!value.success) {
				for (const issue of value.error.issues) context.addIssue({ ...issue, path: ['__proto__', ...issue.path] });
				return NEVER;
			}
			const entries = Object.entries(parsed.data);
			entries.splice(Object.keys(input).indexOf('__proto__'), 0, ['__proto__', value.data]);
			return Object.fromEntries(entries);
		}
		return parsed.data;
	});
}
