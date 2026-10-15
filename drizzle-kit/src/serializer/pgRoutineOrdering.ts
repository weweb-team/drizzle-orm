import type { JsonStatement } from '../jsonStatements';
import { routineKey } from './pgRoutines';
import { type Function as PgFunction, PgSquasher } from './pgSchema';

/** Keep the existing DDL phases, allowing catalog-proven removals to precede routine drops. */
export function orderPgRoutineDrops(statements: JsonStatement[], previous: PgFunction[], current: PgFunction[]) {
	const isDrop = (statement: JsonStatement) =>
		statement.type === 'drop_function' || statement.type === 'drop_procedure';
	const isCreate = (statement: JsonStatement) =>
		statement.type === 'create_function' || statement.type === 'create_procedure';
	const keyOfDrop = (statement: JsonStatement) => {
		if (statement.type !== 'drop_function' && statement.type !== 'drop_procedure') return '';
		return JSON.stringify([statement.schema, statement.name, statement.argumentTypes]);
	};
	const drops = new Map(
		statements.flatMap((statement, index) => isDrop(statement) ? [[keyOfDrop(statement), index] as const] : []),
	);
	if (drops.size === 0) return statements;
	const previousByKey = new Map(previous.map((routine) => [routineKey(routine), routine]));
	const currentByKey = new Map(current.map((routine) => [routineKey(routine), routine]));
	const currentByDefinition = new Map(current.map((routine) => [routine.definition, routine]));
	const creates = new Map<string, number>();
	for (const [index, statement] of statements.entries()) {
		if (statement.type !== 'create_function' && statement.type !== 'create_procedure') continue;
		const routine = currentByDefinition.get(statement.definition);
		if (routine) creates.set(routineKey(routine), index);
	}
	const edges = statements.map(() => new Set<number>());
	const incoming = statements.map(() => 0);
	const edge = (before: number, after: number) => {
		if (before === after || edges[before].has(after)) return;
		edges[before].add(after);
		incoming[after]++;
	};
	const movable = new Set<number>();
	type Dependent = NonNullable<PgFunction['dependentObjects']>[number];
	const removes = (statement: JsonStatement, dependent: Dependent, mayReplace: boolean) => {
		const schema = 'schema' in statement ? statement.schema || 'public' : 'public';
		if (schema !== dependent.schema) return false;
		if (statement.type === 'drop_view') return dependent.kind === 'view' && statement.name === dependent.name;
		if (statement.type === 'create_view') {
			return mayReplace && statement.replace && dependent.kind === 'view' && statement.name === dependent.name;
		}
		if (statement.type === 'drop_table') return statement.tableName === dependent.tableName;
		if (!('tableName' in statement) || statement.tableName !== dependent.tableName) return false;
		if (statement.type === 'alter_table_drop_column') {
			return dependent.kind === 'column' && statement.columnName === dependent.name;
		}
		if (
			statement.type === 'alter_table_alter_column_drop_default'
			|| statement.type === 'alter_table_alter_column_drop_generated'
		) {
			return dependent.kind === 'column' && statement.columnName === dependent.name;
		}
		if (
			statement.type === 'alter_table_alter_column_set_default'
			|| statement.type === 'alter_table_alter_column_alter_generated'
		) {
			return mayReplace && dependent.kind === 'column' && statement.columnName === dependent.name;
		}
		if (statement.type === 'drop_policy') return dependent.kind === 'policy' && statement.data.name === dependent.name;
		if (statement.type === 'alter_policy') {
			return mayReplace && dependent.kind === 'policy'
				&& PgSquasher.unsquashPolicy(statement.oldData).name === dependent.name;
		}
		if (statement.type === 'drop_trigger') return dependent.kind === 'trigger' && statement.name === dependent.name;
		if (statement.type === 'drop_index') {
			return dependent.kind === 'index' && PgSquasher.unsquashIdx(statement.data).name === dependent.name;
		}
		if (statement.type === 'delete_check_constraint') {
			return dependent.kind === 'constraint' && statement.constraintName === dependent.name;
		}
		return false;
	};
	for (const [key, drop] of drops) {
		const routine = previousByKey.get(key);
		const create = creates.get(key);
		if (create !== undefined) edge(drop, create);
		if (!routine) continue;
		for (const dependent of routine.dependentObjects ?? []) {
			const nextRoutine = currentByKey.get(key);
			const mayReplace = !nextRoutine
				|| (nextRoutine.dependentObjects !== undefined
					&& !nextRoutine.dependentObjects.some((object) =>
						object.kind === dependent.kind && object.schema === dependent.schema && object.name === dependent.name
						&& object.tableName === dependent.tableName
					));
			const removal = statements.findIndex((statement) => removes(statement, dependent, mayReplace));
			if (removal < 0) {
				throw new Error(
					`Cannot safely drop ${routine.schema}.${routine.name}: dependent ${dependent.kind} ${dependent.schema}.${dependent.name} is not removed by this migration. Remove/recreate its dependency explicitly and regenerate the migration.`,
				);
			}
			// Replacements can reference newly created relations/routines. Preserve
			// their original creation phase while allowing pure removals to move.
			const removalType = statements[removal].type;
			if (
				removalType !== 'create_view' && removalType !== 'alter_policy'
				&& removalType !== 'alter_table_alter_column_set_default'
				&& removalType !== 'alter_table_alter_column_alter_generated'
			) movable.add(removal);
			edge(removal, drop);
		}
		const relations = [
			...(routine.parameters ?? []).map((parameter) => parameter.type),
			...(routine.returnType ? [routine.returnType] : []),
			...(routine.relationDependencies ?? []),
		];
		for (const [index, statement] of statements.entries()) {
			if (statement.type !== 'drop_table' && statement.type !== 'drop_view') continue;
			const name = statement.type === 'drop_table' ? statement.tableName : statement.name;
			if (relations.some((relation) => relation.schema === (statement.schema || 'public') && relation.name === name)) {
				edge(drop, index);
			}
		}
	}
	for (const routine of current) {
		const callerCreate = creates.get(routineKey(routine));
		if (callerCreate === undefined) continue;
		for (const dependency of routine.routineDependencies ?? []) {
			const calleeKey = JSON.stringify([dependency.schema, dependency.name, dependency.argumentTypes]);
			const calleeCreate = creates.get(calleeKey);
			// Compatible replacements retain their OID and remain callable while
			// mutually dependent existing routines are replaced in place.
			if (calleeCreate !== undefined && (drops.has(calleeKey) || !previousByKey.has(calleeKey))) {
				edge(calleeCreate, callerCreate);
			}
		}
	}
	for (const routine of previous) {
		const callerKey = routineKey(routine);
		for (const dependency of routine.routineDependencies ?? []) {
			const calleeKey = JSON.stringify([dependency.schema, dependency.name, dependency.argumentTypes]);
			const calleeDrop = drops.get(calleeKey);
			if (calleeDrop === undefined || callerKey === calleeKey) continue;
			const callerDrop = drops.get(callerKey);
			if (callerDrop !== undefined) edge(callerDrop, calleeDrop);
			else {
				const callerCreate = creates.get(callerKey);
				const survivingDependency = currentByKey.get(callerKey)?.routineDependencies?.some((dependency) =>
					JSON.stringify([dependency.schema, dependency.name, dependency.argumentTypes]) === calleeKey
				);
				if (callerCreate === undefined || survivingDependency) {
					throw new Error(
						`Cannot safely drop ${dependency.schema}.${dependency.name}: surviving routine ${routine.schema}.${routine.name} depends on it. Remove that dependency and regenerate the migration.`,
					);
				}
				edge(callerCreate, calleeDrop);
			}
		}
	}
	// Preserve the existing ordering of other DDL and routine creation phases.
	// Only removals identified above may move across those phases.
	let previousRegular: number | undefined;
	for (const [index, statement] of statements.entries()) {
		if (isDrop(statement) || isCreate(statement) || movable.has(index)) continue;
		if (previousRegular !== undefined) edge(previousRegular, index);
		previousRegular = index;
	}
	for (const [index, statement] of statements.entries()) {
		if (!isCreate(statement)) continue;
		for (let before = index - 1; before >= 0; before--) {
			if (isDrop(statements[before]) || isCreate(statements[before]) || movable.has(before)) continue;
			edge(before, index);
			break;
		}
		for (let after = index + 1; after < statements.length; after++) {
			if (isDrop(statements[after]) || isCreate(statements[after]) || movable.has(after)) continue;
			edge(index, after);
			break;
		}
	}
	for (const [dropIndex, statement] of statements.entries()) {
		if (!isDrop(statement) && !movable.has(dropIndex)) continue;
		for (const [index, prerequisite] of statements.entries()) {
			if (
				prerequisite.type === 'rename_schema' || prerequisite.type === 'create_schema'
				|| prerequisite.type === 'move_type_enum' || prerequisite.type === 'rename_type_enum'
			) edge(index, dropIndex);
			// Drop signatures may use either side of a resolved relation rename.
			if (
				prerequisite.type === 'rename_table' || prerequisite.type === 'alter_table_set_schema'
				|| prerequisite.type === 'rename_view' || prerequisite.type === 'alter_view_alter_schema'
			) {
				if (index < dropIndex) edge(index, dropIndex);
				else edge(dropIndex, index);
			}
		}
	}
	const ordered: JsonStatement[] = [];
	const emitted = new Set<number>();
	while (ordered.length < statements.length) {
		const next = statements.findIndex((_, index) => !emitted.has(index) && incoming[index] === 0);
		if (next < 0) {
			throw new Error(
				'Cannot safely order PostgreSQL routine dependencies. Remove/recreate the dependent objects explicitly and regenerate the migration; no CASCADE was generated.',
			);
		}
		emitted.add(next);
		ordered.push(statements[next]);
		for (const dependent of edges[next]) incoming[dependent]--;
	}
	return ordered;
}
