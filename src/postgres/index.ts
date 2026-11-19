import { Buffer } from 'node:buffer';
import {
	type DbmlColumn,
	type DbmlDefault,
	type DbmlIndex,
	type DbmlIndexPart,
	type DbmlModel,
	type DbmlRecords,
	type DbmlRef,
	type DbmlReferentialAction,
	type DbmlTable,
	emptyModel,
	withDefaultSchema
} from '../model';
import {
	COLUMNS,
	CONSTRAINTS,
	ENUMS,
	INDEXES,
	POLICIES,
	RELATIONS,
	SCHEMA_COMMENTS,
	SCHEMAS,
	SEQUENCES,
	VIEW_SOURCES
} from './queries';
import {
	type ColumnRow,
	columnRow,
	type ConstraintRow,
	constraintRow,
	enumRow,
	type IndexRow,
	indexRow,
	namedRow,
	type PolicyRow,
	policyRow,
	type RelationRow,
	relationRow,
	sequenceRow,
	viewSourceRow
} from './rows';

/*
 * A live Postgres database as a DBML model, read from its own catalogs:
 * whatever made the database (Drizzle, Prisma, hand-written SQL), this
 * draws what is actually there. Comments become notes, and what DBML has
 * no syntax for (row-level security, partitioning, identity, generated
 * columns, deferrable keys, an index's predicate) is said in notes.
 *
 * It only reads, through the `query` it's given, so the caller decides the
 * connection, the role and the transaction (a read-only one is right).
 */

/** Runs one query with positional parameters and returns its rows. */
export type PostgresQuery = (
	text: string,
	params: unknown[]
) => Promise<Record<string, unknown>[]>;

export type FromPostgresOptions = {
	/** Each table's first rows as DBML `Records`, read with the same query. */
	records?: { limit: number };
	project?: { name?: string; note?: string };
	/** The schema whose tables are named without it, as a query run there
	 *  names them: `public` unless the app keeps its tables elsewhere. */
	defaultSchema?: string;
	/** The schemas to read; every schema that isn't Postgres's own by
	 *  default. */
	schemas?: string[];
};

const DEFAULT_SCHEMA = 'public';

/* Every place is read with its schema; the default one is dropped at the
 * end (withDefaultSchema), so two schemas' tables never look alike. */
const inSchema = (schema: string) => ({ schema });

const ACTIONS: Record<string, DbmlReferentialAction | undefined> = {
	a: undefined,
	c: 'cascade',
	d: 'set default',
	n: 'set null',
	r: 'restrict'
};

/* A default Postgres wrote out, as the literal it is when it's one. */
const QUOTED = /^'((?:[^']|'')*)'(?:::([\w\s."[\]()]+))?$/u;
const NUMBER = /^-?\d+(\.\d+)?$/u;
const NUMBER_CAST = /^\(?(-?\d+(?:\.\d+)?)\)?::[\w\s."]+$/u;
const NULL = /^NULL(::[\w\s."[\]()]+)?$/u;
/* Types whose quoted literal is a number (Postgres writes -1.5 as
 * '-1.5'::double precision). */
const NUMERIC_TYPE =
	/^(smallint|integer|bigint|int[248]?|numeric(\(.*\))?|decimal(\(.*\))?|real|double precision|float[48]?)$/u;

/* A literal number DBML can hold without losing digits. */
const exactNumber = (digits: string) => {
	const value = Number.parseFloat(digits);
	const exact = digits.includes('.') || Number.isSafeInteger(value);

	return exact ? value : undefined;
};

const numberDefault = (digits: string, expression: string) => {
	const value = exactNumber(digits);
	const result: DbmlDefault =
		value === undefined
			? { kind: 'expression', value: expression }
			: { kind: 'number', value };

	return result;
};

const quotedDefault = (inner: string, type: string, expression: string) => {
	if (NUMERIC_TYPE.test(type) && NUMBER.test(inner))
		return numberDefault(inner, expression);
	const result: DbmlDefault = {
		kind: 'string',
		value: inner.replaceAll("''", "'")
	};

	return result;
};

/** A default as Postgres writes it, as a literal when it is one. */
export const parseDefault = (expression: string) => {
	if (NULL.test(expression)) return { kind: 'null' } satisfies DbmlDefault;
	if (expression === 'true' || expression === 'false')
		return {
			kind: 'boolean',
			value: expression === 'true'
		} satisfies DbmlDefault;
	if (NUMBER.test(expression)) return numberDefault(expression, expression);
	const [, castDigits] = NUMBER_CAST.exec(expression) ?? [];
	if (castDigits !== undefined) return numberDefault(castDigits, expression);
	const [, inner, type] = QUOTED.exec(expression) ?? [];
	if (inner !== undefined)
		return quotedDefault(inner, type ?? '', expression);

	return { kind: 'expression', value: expression } satisfies DbmlDefault;
};

const KINDS: Record<string, string> = {
	f: 'Foreign table',
	m: 'Materialized view',
	p: 'Partitioned table',
	v: 'View'
};

const VIEW_COLOR = '#64748b';

const POLICY_COMMANDS: Record<string, string> = {
	'*': 'all',
	a: 'insert',
	d: 'delete',
	r: 'select',
	w: 'update'
};

const joinNotes = (lines: (string | undefined)[]) => {
	const present = lines.filter(
		(line): line is string => line !== undefined && line !== ''
	);

	return present.length > 0 ? present.join('\n') : undefined;
};

const withNote = (note: string | undefined) =>
	note === undefined ? {} : { note };

const identityNote = (identity: string | undefined) => {
	if (identity === 'a') return 'Identity, generated always';
	if (identity === 'd') return 'Identity, generated by default';

	return undefined;
};

const generatedNote = (row: ColumnRow) => {
	if (!row.generated || !row.default) return undefined;
	const mode = row.generated === 'v' ? 'virtual' : 'stored';

	return `Generated always as (${row.default}), ${mode}`;
};

/* A serial column's default is its sequence; the increment says it. */
const isSerial = (row: ColumnRow) =>
	row.serialSequence !== undefined &&
	row.default?.startsWith('nextval(') === true;

const enumSchema = (row: ColumnRow) =>
	row.enumType && row.enumSchema ? { typeSchema: row.enumSchema } : {};

const columnOf = (row: ColumnRow) => {
	const serial = isSerial(row);
	const fallback =
		row.default !== undefined && !serial && !row.generated
			? parseDefault(row.default)
			: undefined;
	const column: DbmlColumn = {
		name: row.name,
		type: row.enumType ?? row.type,
		...enumSchema(row),
		...(serial || row.identity ? { increment: true } : {}),
		...(row.notNull ? { notNull: true } : {}),
		...(fallback ? { default: fallback } : {}),
		...withNote(
			joinNotes([
				row.comment,
				identityNote(row.identity),
				generatedNote(row)
			])
		)
	};

	return column;
};

const constraintNote = (row: ConstraintRow) =>
	joinNotes([
		row.comment,
		row.deferrable
			? `Deferrable${row.deferred ? ', initially deferred' : ''}`
			: undefined,
		row.nullsNotDistinct ? 'Nulls not distinct' : undefined
	]);

/* The name Postgres gives a key, unique or foreign key nobody named. */
const defaultName = (row: ConstraintRow, table: string, columns: string[]) => {
	if (row.kind === 'p') return `${table}_pkey`;
	if (row.kind === 'f') return `${table}_${columns.join('_')}_fkey`;

	return `${table}_${columns.join('_')}_key`;
};

const columnParts = (columns: string[]) =>
	columns.map(
		(column) => ({ column, kind: 'column' }) satisfies DbmlIndexPart
	);

/* A plain single-column key or unique sits on the column. */
const markColumn = (column: DbmlColumn, primary: boolean) => {
	if (!primary) {
		column.unique = true;

		return;
	}
	column.pk = true;
	delete column.notNull;
};

/* A key or unique constraint: on its column when it's one column and
 * plainly named, otherwise an index line that keeps its name. */
const applyKey = (table: DbmlTable, row: ConstraintRow, columns: string[]) => {
	const primary = row.kind === 'p';
	const plain = row.name === defaultName(row, table.name, columns);
	const note = constraintNote(row);
	const [only] = columns;
	const single =
		columns.length === 1
			? table.columns.find((column) => column.name === only)
			: undefined;
	if (single && plain && note === undefined) {
		markColumn(single, primary);

		return;
	}
	const index: DbmlIndex = {
		parts: columnParts(columns),
		...(primary ? { pk: true } : { unique: true }),
		...(plain ? {} : { name: row.name }),
		...withNote(note)
	};
	table.indexes.push(index);
};

const sortedColumns = (index: DbmlIndex) =>
	index.parts
		.map((part) => (part.kind === 'column' ? part.column : ''))
		.sort()
		.join('\0');

/* A unique index with a predicate is unique only over some rows. */
const coversAll = (index: DbmlIndex) =>
	index.pk === true ||
	(index.unique === true && index.note?.includes('Where ') !== true);

const isUniqueSet = (table: DbmlTable, columns: string[]) => {
	const [only] = columns;
	const single =
		columns.length === 1
			? table.columns.find((column) => column.name === only)
			: undefined;
	if (single?.pk === true || single?.unique === true) return true;
	const wanted = [...columns].sort().join('\0');

	return table.indexes.some(
		(index) =>
			coversAll(index) &&
			index.parts.every((part) => part.kind === 'column') &&
			sortedColumns(index) === wanted
	);
};

type Context = {
	columnName: (tableId: number, position: number) => string;
	relations: Map<number, RelationRow>;
	tables: Map<number, DbmlTable>;
};

const refOf = (row: ConstraintRow, context: Context) => {
	const source = context.relations.get(row.tableId);
	const target = context.relations.get(row.foreignTableId);
	const table = context.tables.get(row.tableId);
	if (!source || !target || !table) return undefined;
	const columns = row.columns.map((position) =>
		context.columnName(source.id, position)
	);
	const onDelete = ACTIONS[row.onDelete];
	const onUpdate = ACTIONS[row.onUpdate];
	const ref: DbmlRef = {
		from: { columns, ...inSchema(source.schema), table: source.name },
		...(row.name === defaultName(row, source.name, columns)
			? {}
			: { name: row.name }),
		...(onDelete ? { onDelete } : {}),
		...(onUpdate ? { onUpdate } : {}),
		relation: isUniqueSet(table, columns) ? '-' : '>',
		to: {
			columns: row.foreignColumns.map((position) =>
				context.columnName(target.id, position)
			),
			...inSchema(target.schema),
			table: target.name
		},
		...withNote(constraintNote(row))
	};

	return ref;
};

/* An index part: a plain column is its name, anything else (Postgres
 * writes it) an expression. */
const partOf = (row: IndexRow, index: number, context: Context) => {
	const desc = row.descending[index] === true ? { desc: true } : {};
	const position = row.attnums[index] ?? 0;
	if (position > 0)
		return {
			column: context.columnName(row.tableId, position),
			kind: 'column',
			...desc
		} satisfies DbmlIndexPart;

	return {
		expression: row.parts[index] ?? '',
		kind: 'expression',
		...desc
	} satisfies DbmlIndexPart;
};

const indexOf = (row: IndexRow, context: Context) => {
	const included = row.parts.slice(row.keyCount);
	const index: DbmlIndex = {
		name: row.name,
		parts: row.parts
			.slice(0, row.keyCount)
			.map((_, position) => partOf(row, position, context)),
		...(row.method === 'btree' ? {} : { type: row.method }),
		...(row.unique ? { unique: true } : {}),
		...withNote(
			joinNotes([
				row.comment,
				row.predicate ? `Where ${row.predicate}` : undefined,
				included.length > 0
					? `Includes ${included.join(', ')}`
					: undefined
			])
		)
	};

	return index;
};

const policyLine = (row: PolicyRow) =>
	[
		`Policy ${row.name}`,
		row.permissive ? undefined : 'restrictive',
		`for ${POLICY_COMMANDS[row.command] ?? 'all'}`,
		`to ${row.roles.join(', ')}`,
		row.using ? `using (${row.using})` : undefined,
		row.withCheck ? `with check (${row.withCheck})` : undefined
	]
		.filter((part): part is string => part !== undefined)
		.join(' ');

const MAX_DEFINITION = 600;

const kindLine = (relation: RelationRow) => {
	const kind = KINDS[relation.kind];
	const definition = relation.definition?.trim();
	if (!kind || !definition) return kind;
	const shown =
		definition.length > MAX_DEFINITION
			? `${definition.slice(0, MAX_DEFINITION)}…`
			: definition;

	return `${kind}:\n${shown}`;
};

const tableNote = (relation: RelationRow, policies: PolicyRow[]) =>
	joinNotes([
		relation.comment,
		kindLine(relation),
		relation.partitionKey
			? `Partitioned by ${relation.partitionKey}, ${relation.partitions} partitions`
			: undefined,
		relation.rls
			? `Row-level security is on${relation.forceRls ? ', for the owner too' : ''}`
			: undefined,
		...policies.map(policyLine)
	]);

/* A record value as DBML can hold one. */
const recordValue = (value: unknown) => {
	if (value === null || value === undefined) return null;
	if (typeof value === 'boolean' || typeof value === 'string') return value;
	if (typeof value === 'number')
		return Number.isFinite(value) ? value : `${value}`;
	if (typeof value === 'bigint') return `${value}`;
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Uint8Array)
		return `\\x${Buffer.from(value).toString('hex')}`;

	return JSON.stringify(value);
};

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

const readRecords = (
	query: PostgresQuery,
	tables: DbmlTable[],
	limit: number
) =>
	Promise.all(
		tables.map(async (table) => {
			const columns = table.columns.map((column) => column.name);
			const from = `${quoteIdent(table.schema ?? DEFAULT_SCHEMA)}.${quoteIdent(table.name)}`;
			const rows = await query(
				`select ${columns.map(quoteIdent).join(', ')} from ${from} limit ${Math.max(0, Math.floor(limit))}`,
				[]
			);
			const records: DbmlRecords = {
				columns,
				rows: rows.map((row) =>
					columns.map((column) => recordValue(row[column]))
				),
				...(table.schema ? { schema: table.schema } : {}),
				table: table.name
			};

			return records;
		})
	);

const tableOf = (
	relation: RelationRow,
	columns: ColumnRow[],
	policies: PolicyRow[]
) => {
	const view = relation.kind === 'v' || relation.kind === 'm';
	const table: DbmlTable = {
		checks: [],
		columns: columns
			.filter((row) => row.tableId === relation.id)
			.map(columnOf),
		...(view ? { headerColor: VIEW_COLOR } : {}),
		indexes: [],
		name: relation.name,
		...inSchema(relation.schema),
		...withNote(
			tableNote(
				relation,
				policies.filter((row) => row.tableId === relation.id)
			)
		)
	};

	return table;
};

/* Keys and uniques onto their tables; checks and exclusions too; foreign
 * keys handed back, to become refs once every key is known. */
const applyConstraints = (rows: ConstraintRow[], context: Context) =>
	rows.filter((row) => {
		const table = context.tables.get(row.tableId);
		if (!table || row.kind === 'f') return table !== undefined;
		const columns = row.columns.map((position) =>
			context.columnName(row.tableId, position)
		);
		if (row.kind === 'p' || row.kind === 'u') applyKey(table, row, columns);
		if (row.kind === 'c')
			table.checks.push({
				expression: (row.checkExpression ?? row.definition).replace(
					/^\((.*)\)$/su,
					'$1'
				),
				name: row.name
			});
		if (row.kind === 'x')
			table.indexes.push({
				name: row.name,
				note: `Exclusion constraint: ${row.definition}`,
				parts: columnParts(columns)
			});

		return false;
	});

const sequenceNote = (
	rows: ReturnType<typeof sequenceRow>[],
	defaultSchema: string
) => ({
	content: `Sequences\n${rows
		.map(
			(row) =>
				`${row.schema === defaultSchema ? '' : `${row.schema}.`}${row.name}: start ${row.start}, increment ${row.increment}`
		)
		.join('\n')}`,
	name: 'sequences'
});

const readCatalogs = async (query: PostgresQuery, schemas: string[]) => {
	const read = (sql: string) => query(sql, [schemas]);
	const [
		enums,
		relations,
		columns,
		constraints,
		indexes,
		sources,
		policies,
		sequences,
		comments
	] = await Promise.all([
		read(ENUMS),
		read(RELATIONS),
		read(COLUMNS),
		read(CONSTRAINTS),
		read(INDEXES),
		read(VIEW_SOURCES),
		read(POLICIES),
		read(SEQUENCES),
		read(SCHEMA_COMMENTS)
	]);

	return {
		columns: columns.map(columnRow),
		comments: comments.map(namedRow),
		constraints: constraints.map(constraintRow),
		enums: enums.map(enumRow),
		indexes: indexes.map(indexRow),
		policies: policies.map(policyRow),
		relations: relations.map(relationRow),
		sequences: sequences.map(sequenceRow),
		sources: sources.map(viewSourceRow)
	};
};

type Catalogs = Awaited<ReturnType<typeof readCatalogs>>;

const schemasToRead = async (
	query: PostgresQuery,
	schemas: string[] | undefined
) => schemas ?? (await query(SCHEMAS, [])).map((row) => namedRow(row).name);

const addDeps = (
	model: DbmlModel,
	catalogs: Catalogs,
	relations: Map<number, RelationRow>
) =>
	catalogs.sources.forEach((row) => {
		const view = relations.get(row.viewId);
		const source = relations.get(row.sourceId);
		if (view && source)
			model.deps.push({
				downstream: { ...inSchema(view.schema), table: view.name },
				upstream: { ...inSchema(source.schema), table: source.name }
			});
	});

const addNotes = (
	model: DbmlModel,
	catalogs: Catalogs,
	defaultSchema: string
) => {
	if (catalogs.sequences.length > 0)
		model.notes.push(sequenceNote(catalogs.sequences, defaultSchema));
	const described = catalogs.comments.filter(
		(row) => row.comment !== undefined && row.name !== defaultSchema
	);
	if (described.length > 0)
		model.notes.push({
			content: `Schemas\n${described.map((row) => `${row.name}: ${row.comment}`).join('\n')}`,
			name: 'schemas'
		});
};

/** The database's structure as a DBML model. */
export const fromPostgres = async (
	query: PostgresQuery,
	options: FromPostgresOptions = {}
) => {
	const catalogs = await readCatalogs(
		query,
		await schemasToRead(query, options.schemas)
	);
	const model = emptyModel({
		databaseType: 'PostgreSQL',
		...options.project
	});
	model.enums.push(
		...catalogs.enums.map((row) => ({
			name: row.name,
			...inSchema(row.schema),
			values: row.values.map((name) => ({ name }))
		}))
	);
	const relations = new Map(catalogs.relations.map((row) => [row.id, row]));
	const names = new Map(
		catalogs.columns.map((row) => [
			`${row.tableId}:${row.position}`,
			row.name
		])
	);
	const tables = new Map(
		catalogs.relations.map((row) => [
			row.id,
			tableOf(row, catalogs.columns, catalogs.policies)
		])
	);
	const context: Context = {
		relations,
		tables,
		columnName: (tableId, position) =>
			names.get(`${tableId}:${position}`) ?? `${position}`
	};
	const foreign = applyConstraints(catalogs.constraints, context);
	catalogs.indexes.forEach((row) =>
		tables.get(row.tableId)?.indexes.push(indexOf(row, context))
	);
	model.tables.push(...tables.values());
	model.refs.push(
		...foreign
			.map((row) => refOf(row, context))
			.filter((ref) => ref !== undefined)
	);
	addDeps(model, catalogs, relations);
	const defaultSchema = options.defaultSchema ?? DEFAULT_SCHEMA;
	addNotes(model, catalogs, defaultSchema);
	const limit = options.records?.limit ?? 0;
	if (limit > 0)
		model.records.push(
			...(await readRecords(
				query,
				model.tables.filter((table) => !table.headerColor),
				limit
			))
		);

	return withDefaultSchema(model, defaultSchema);
};
