import type { DB } from '../utils';
import { escapeSingleQuotes } from '../utils';
import type { Function as PgFunction, RoutineType } from './pgSchema';

export const quoteRoutineIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

function requireRoutineParameters(fn: PgFunction) {
	if (!fn.parameters) {
		throw new Error(
			`Re-introspect both PostgreSQL snapshots before migrating ${fn.schema}.${fn.name}: legacy entries lack argument signatures and extension ownership.`,
		);
	}
	return fn.parameters;
}

export function inputArgumentTypes(fn: PgFunction): RoutineType[] {
	return requireRoutineParameters(fn).filter((parameter) => parameter.mode !== 'o' && parameter.mode !== 't').map((
		parameter,
	) => parameter.type);
}

export function routineKey(fn: PgFunction): string {
	if (!fn.parameters) return `${fn.schema}.${fn.name}`;
	return JSON.stringify([fn.schema, fn.name, inputArgumentTypes(fn)]);
}

export function formatRoutineArguments(types: RoutineType[]): string {
	return types.map((type) =>
		`${quoteRoutineIdentifier(type.schema)}.${quoteRoutineIdentifier(type.name)}${type.isArray ? '[]' : ''}`
	).join(', ');
}

function typeExpression(type: string, namespace: string, element: string, elementNamespace: string): string {
	return `pg_catalog.jsonb_build_object(
		'schema', CASE WHEN ${element}.typarray = ${type}.oid THEN ${elementNamespace}.nspname ELSE ${namespace}.nspname END,
		'name', CASE WHEN ${element}.typarray = ${type}.oid THEN ${element}.typname ELSE ${type}.typname END,
		'isArray', COALESCE(${element}.typarray = ${type}.oid, false))`;
}

export async function introspectPgRoutines(db: DB, schemaFilters: string[]) {
	const filter = schemaFilters.length
		? `AND n.nspname IN (${schemaFilters.map((name) => `'${escapeSingleQuotes(name)}'`).join(', ')})`
		: '';
	const routines = await db.query<PgFunction & { kind: 'f' | 'p' }>(`SELECT
		n.nspname AS schema, p.proname AS name, p.prokind AS kind,
		pg_catalog.pg_get_functiondef(p.oid) AS definition,
		p.proretset AS "returnsSet",
		p.pronargdefaults AS "defaultCount",
		${typeExpression('return_type', 'return_namespace', 'return_element', 'return_element_namespace')} AS "returnType",
		COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
			'name', COALESCE(p.proargnames[argument.position], ''),
			'mode', COALESCE(p.proargmodes[argument.position], 'i'),
			'type', ${typeExpression('argument_type', 'type_namespace', 'element_type', 'element_namespace')}
		) ORDER BY argument.position)
		FROM pg_catalog.unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[])) WITH ORDINALITY AS argument(type_oid, position)
		JOIN pg_catalog.pg_type argument_type ON argument_type.oid = argument.type_oid
		JOIN pg_catalog.pg_namespace type_namespace ON type_namespace.oid = argument_type.typnamespace
		LEFT JOIN pg_catalog.pg_type element_type ON element_type.oid = argument_type.typelem
		LEFT JOIN pg_catalog.pg_namespace element_namespace ON element_namespace.oid = element_type.typnamespace
		), '[]'::jsonb) AS parameters
	FROM pg_catalog.pg_proc p
	JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
	JOIN pg_catalog.pg_type return_type ON return_type.oid = p.prorettype
	JOIN pg_catalog.pg_namespace return_namespace ON return_namespace.oid = return_type.typnamespace
	LEFT JOIN pg_catalog.pg_type return_element ON return_element.oid = return_type.typelem
	LEFT JOIN pg_catalog.pg_namespace return_element_namespace ON return_element_namespace.oid = return_element.typnamespace
	WHERE p.prokind IN ('f', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') ${filter}
		AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend dependency
			WHERE dependency.classid = 'pg_catalog.pg_proc'::regclass AND dependency.objid = p.oid
				AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass AND dependency.deptype = 'e')
	ORDER BY n.nspname, p.proname, parameters`);
	const functions: Record<string, PgFunction> = {};
	const procedures: Record<string, PgFunction> = {};
	for (const { kind, ...fn } of routines) {
		if (!fn.definition) continue;
		const destination = kind === 'f' ? functions : procedures;
		destination[routineKey(fn)] = fn;
	}
	return { functions, procedures };
}

type Rename = { from: { name: string; schema?: string }; to: { name: string; schema?: string } };
type Move = { name: string; schemaFrom: string; schemaTo: string };

export function normalizeRoutineSnapshots(
	previous: Record<string, PgFunction>,
	current: Record<string, PgFunction>,
	renamedSchemas: Rename[],
	renamedEnums: Rename[],
	movedEnums: Move[],
) {
	const schemaAfterRename = (schema: string) =>
		renamedSchemas.find((rename) => rename.from.name === schema)?.to.name ?? schema;
	const typeAfterRename = (type: RoutineType): RoutineType => {
		const schema = schemaAfterRename(type.schema);
		const rename = renamedEnums.find((item) => item.from.schema === schema && item.from.name === type.name);
		if (rename) return { ...type, name: rename.to.name, schema: rename.to.schema ?? 'public' };
		const move = movedEnums.find((item) => item.schemaFrom === schema && item.name === type.name);
		return { ...type, schema: move?.schemaTo ?? schema };
	};
	const remapped: Record<string, PgFunction> = {};
	for (const [key, fn] of Object.entries(previous)) {
		remapped[key] = {
			...fn,
			schema: schemaAfterRename(fn.schema),
			parameters: fn.parameters?.map((parameter) => ({ ...parameter, type: typeAfterRename(parameter.type) })),
			returnType: fn.returnType ? typeAfterRename(fn.returnType) : undefined,
		};
	}
	// Upgrade unchanged legacy entries using an exact definition match. Never guess
	// argument types for a changed/deleted legacy function: that could drop an overload.
	const normalize = (records: Record<string, PgFunction>, reference: Record<string, PgFunction>) => {
		const result: Record<string, PgFunction> = {};
		for (const fn of Object.values(records)) {
			const match = fn.parameters
				? undefined
				: Object.values(reference).find((other) =>
					other.parameters && other.schema === fn.schema && other.name === fn.name && other.definition === fn.definition
				);
			const normalized = match
				? {
					...fn,
					parameters: match.parameters,
					returnType: match.returnType,
					returnsSet: match.returnsSet,
					defaultCount: match.defaultCount,
				}
				: fn;
			result[routineKey(normalized)] = normalized;
		}
		return result;
	};
	return { previous: normalize(remapped, current), current: normalize(current, remapped) };
}

export function routineRequiresDrop(previous: PgFunction, current: PgFunction): boolean {
	// A replacement also needs known signatures; two legacy entries cannot prove compatibility.
	const previousParameters = requireRoutineParameters(previous);
	const currentParameters = requireRoutineParameters(current);
	// CREATE OR REPLACE preserves grants and dependencies for compatible body/default changes.
	return JSON.stringify(previousParameters) !== JSON.stringify(currentParameters)
		|| JSON.stringify(previous.returnType) !== JSON.stringify(current.returnType)
		|| previous.returnsSet !== current.returnsSet
		|| (current.defaultCount ?? 0) < (previous.defaultCount ?? 0);
}
