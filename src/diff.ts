import {
	type DbmlColumn,
	type DbmlDefault,
	type DbmlEndpoint,
	type DbmlIndex,
	type DbmlModel,
	type DbmlRef,
	type DbmlTable,
	detailLine
} from './model';

/*
 * What changed between two models of a schema: two environments, or a
 * database before and after a migration. Tables, columns, indexes, checks,
 * a table's details (triggers, rules, partitions, policies, its view
 * query), its facts, links, enums and notes are each matched by name and
 * compared by what they mean. Row estimates and sizes change as an app
 * runs, so they're never a change.
 */

export type DbmlChangeKind = 'added' | 'changed' | 'removed';

export type DbmlChangeObject =
	| 'check'
	| 'column'
	| 'detail'
	| 'enum'
	| 'fact'
	| 'index'
	| 'note'
	| 'ref'
	| 'table';

export type DbmlChange = {
	/** How it reads after, for a change or an addition. */
	after?: string;
	/** How it read before, for a change or a removal. */
	before?: string;
	kind: DbmlChangeKind;
	/** The name it's matched by: a column's name, an index's, a link's
	 *  ends. */
	name: string;
	object: DbmlChangeObject;
	/** The table it belongs to, qualified when it has a schema; absent for
	 *  a table, a link, an enum or a note. */
	table?: string;
};

/* Facts that change as the app runs, not as its schema does. */
const RUNNING_FACTS = new Set(['next_id', 'rows', 'size_bytes']);

const qualified = (entry: {
	name?: string;
	schema?: string;
	table?: string;
}) => {
	const name = entry.table ?? entry.name ?? '';

	return entry.schema ? `${entry.schema}.${name}` : name;
};

const defaultText = (value: DbmlDefault) => {
	if (value.kind === 'null') return 'null';
	if (value.kind === 'string') return `'${value.value}'`;

	return `${value.value}`;
};

/** A column as one line: its type and everything that holds it. */
export const columnText = (column: DbmlColumn) =>
	[
		column.type,
		column.pk ? 'primary key' : undefined,
		column.increment ? 'increment' : undefined,
		column.unique ? 'unique' : undefined,
		column.notNull ? 'not null' : undefined,
		column.default ? `default ${defaultText(column.default)}` : undefined,
		...(column.checks ?? []).map((check) => `check (${check})`),
		...Object.entries(column.metadata ?? {}).map(
			([key, value]) => `${key} ${value}`
		)
	]
		.filter((part) => part !== undefined)
		.join(', ');

const indexParts = (index: DbmlIndex) =>
	index.parts
		.map(
			(part) =>
				`${part.kind === 'column' ? part.column : `(${part.expression})`}${part.desc ? ' desc' : ''}`
		)
		.join(', ');

/** An index as one line: what it covers and how. */
export const indexText = (index: DbmlIndex) =>
	[
		`(${indexParts(index)})`,
		index.pk ? 'primary key' : undefined,
		index.unique ? 'unique' : undefined,
		index.type,
		index.note
	]
		.filter((part) => part !== undefined && part !== '')
		.join(', ');

const endpointText = (endpoint: DbmlEndpoint) =>
	`${qualified(endpoint)}(${endpoint.columns.join(', ')})`;

/** A link's ends, the name it's matched by. */
export const refName = (ref: DbmlRef) =>
	`${endpointText(ref.from)} → ${endpointText(ref.to)}`;

const refText = (ref: DbmlRef) =>
	[
		ref.relation,
		ref.onDelete ? `on delete ${ref.onDelete}` : undefined,
		ref.onUpdate ? `on update ${ref.onUpdate}` : undefined,
		ref.inactive ? 'not enforced' : undefined
	]
		.filter((part) => part !== undefined)
		.join(', ');

type Keyed = { name: string; text: string };

/* Matches two lists by name: what's only after was added, only before
 * removed, in both with different text changed. */
const compare = (
	before: Keyed[],
	after: Keyed[],
	object: DbmlChangeObject,
	table?: string
) => {
	const earlier = new Map(before.map((entry) => [entry.name, entry.text]));
	const later = new Map(after.map((entry) => [entry.name, entry.text]));
	const where = table === undefined ? {} : { table };
	const changes: DbmlChange[] = [];
	earlier.forEach((text, name) => {
		const now = later.get(name);
		if (now === undefined)
			changes.push({
				before: text,
				kind: 'removed',
				name,
				object,
				...where
			});
		else if (now !== text)
			changes.push({
				after: now,
				before: text,
				kind: 'changed',
				name,
				object,
				...where
			});
	});
	later.forEach((text, name) => {
		if (!earlier.has(name))
			changes.push({
				after: text,
				kind: 'added',
				name,
				object,
				...where
			});
	});

	return changes;
};

const keyedColumns = (table: DbmlTable) =>
	table.columns.map((column) => ({
		name: column.name,
		text: columnText(column)
	}));

const keyedIndexes = (table: DbmlTable) =>
	table.indexes.map((index) => ({
		name: index.name ?? `(${indexParts(index)})`,
		text: indexText(index)
	}));

const keyedChecks = (table: DbmlTable) =>
	table.checks.map((check) => ({
		name: check.name ?? check.expression,
		text: check.expression
	}));

/* Details are matched by what they are and their name; one without a
 * name (a view's query, partitioning) by its kind. */
const keyedDetails = (table: DbmlTable) =>
	(table.details ?? []).map((detail) => ({
		name: 'name' in detail ? `${detail.kind} ${detail.name}` : detail.kind,
		text: detailLine(detail)
	}));

const keyedFacts = (table: DbmlTable) =>
	Object.entries(table.metadata ?? {})
		.filter(([key]) => !RUNNING_FACTS.has(key))
		.map(([key, value]) => ({ name: key, text: `${value}` }));

const tableChanges = (before: DbmlTable, after: DbmlTable) => {
	const table = qualified(after);

	return [
		...compare(keyedColumns(before), keyedColumns(after), 'column', table),
		...compare(keyedIndexes(before), keyedIndexes(after), 'index', table),
		...compare(keyedChecks(before), keyedChecks(after), 'check', table),
		...compare(keyedDetails(before), keyedDetails(after), 'detail', table),
		...compare(keyedFacts(before), keyedFacts(after), 'fact', table),
		...compare(
			before.note === undefined
				? []
				: [{ name: 'note', text: before.note }],
			after.note === undefined
				? []
				: [{ name: 'note', text: after.note }],
			'note',
			table
		)
	];
};

const tableSummary = (table: DbmlTable) =>
	`${table.columns.length} column${table.columns.length === 1 ? '' : 's'}`;

/** Every difference between two models, tables first, then links, enums
 *  and notes. */
export const diffModels = (
	before: Pick<DbmlModel, 'enums' | 'notes' | 'refs' | 'tables'>,
	after: Pick<DbmlModel, 'enums' | 'notes' | 'refs' | 'tables'>
) => {
	const earlier = new Map(
		before.tables.map((table) => [qualified(table), table])
	);
	const later = new Map(
		after.tables.map((table) => [qualified(table), table])
	);
	const tables = compare(
		before.tables.map((table) => ({
			name: qualified(table),
			text: tableSummary(table)
		})),
		after.tables.map((table) => ({
			name: qualified(table),
			text: tableSummary(table)
		})),
		'table'
	).filter((change) => change.kind !== 'changed');
	const inside = [...later].flatMap(([key, table]) => {
		const previous = earlier.get(key);

		return previous ? tableChanges(previous, table) : [];
	});
	const keyedRefs = (refs: DbmlRef[]) =>
		refs.map((ref) => ({ name: refName(ref), text: refText(ref) }));
	const keyedEnums = (model: Pick<DbmlModel, 'enums'>) =>
		model.enums.map((entry) => ({
			name: qualified(entry),
			text: entry.values.map((value) => value.name).join(', ')
		}));
	const keyedNotes = (model: Pick<DbmlModel, 'notes'>) =>
		model.notes.map((note) => ({ name: note.name, text: note.content }));
	const changes: DbmlChange[] = [
		...tables,
		...inside,
		...compare(keyedRefs(before.refs), keyedRefs(after.refs), 'ref'),
		...compare(keyedEnums(before), keyedEnums(after), 'enum'),
		...compare(keyedNotes(before), keyedNotes(after), 'note')
	];

	return changes;
};
