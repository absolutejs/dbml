import { Parser } from '@dbml/core';
import { expect } from 'bun:test';
import {
	type DbmlColumn,
	type DbmlModel,
	type DbmlRef,
	type DbmlRelation,
	type DbmlTable,
	tableNoteOf
} from '../src/model';
import { printDbml } from '../src/print';

/*
 * The test every model goes through: print it, read it back with the
 * official DBML parser, and check that DBML understood each table, column
 * setting, index, check, ref, dep, enum, group, note and record the way the
 * model meant it. Text that parses but means something else fails here.
 */

const parse = (text: string) => Parser.parse(text, 'dbmlv2');

type Exported = ReturnType<ReturnType<typeof parse>['export']>;
type ParsedSchema = Exported['schemas'][number];
type ParsedTable = ParsedSchema['tables'][number];
type ParsedField = ParsedTable['fields'][number];
type ParsedRef = ParsedSchema['refs'][number];

const ENDS: Record<DbmlRelation, [string, string]> = {
	'-': ['1', '1'],
	'<': ['1', '*'],
	'<>': ['*', '*'],
	'>': ['*', '1']
};

const DEFAULT_SCHEMA = 'public';

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

/* The parser hands back null for "none"; the model leaves it out. */
const absent = (value: unknown) => (value === null ? undefined : value);

/* DBML writes an expression's backticks as double quotes. */
const unticked = (text: string) => text.replaceAll('`', '"');

const checkDefault = (
	field: ParsedField,
	column: DbmlColumn,
	where: string
) => {
	const parsed: unknown = field.dbdefault;
	const read = isRecord(parsed) ? parsed : undefined;
	if (column.default === undefined) {
		expect(read, where).toBeUndefined();

		return;
	}
	/* DBML keeps `default: null` as the word null. */
	if (column.default.kind === 'null') {
		expect(`${read?.value}`, where).toBe('null');

		return;
	}
	if (column.default.kind === 'expression') {
		expect(read?.type, where).toBe('expression');
		expect(read?.value, where).toBe(unticked(column.default.value));

		return;
	}
	expect(`${read?.value}`, where).toBe(`${column.default.value}`);
};

/* Metadata as the parser keeps it: each value with its type and place. */
const metadataOf = (owner: unknown) => {
	const metadata: unknown = isRecord(owner) ? owner.metadata : undefined;
	if (!isRecord(metadata)) return {};

	return Object.fromEntries(
		Object.entries(metadata).map(([key, entry]) => [
			key,
			isRecord(entry) ? entry.value : entry
		])
	);
};

const checkColumn = (
	read: ParsedTable,
	table: DbmlTable,
	column: DbmlColumn
) => {
	const field = read.fields.find((entry) => entry.name === column.name);
	const where = `${table.name}.${column.name}`;
	expect(field, where).toBeDefined();
	if (!field) return;
	const { type } = field;
	const typeName = isRecord(type) ? type.type_name : undefined;
	const typeSchema = isRecord(type) ? absent(type.schemaName) : undefined;
	/* For an array of a schema's type, DBML keeps the schema both apart and
	 * in the type's name (`public.mood[]`), however it's written. */
	const expectedType =
		column.typeSchema && column.type.endsWith('[]')
			? `${column.typeSchema}.${column.type}`
			: column.type;
	expect(typeName, where).toBe(expectedType);
	expect(typeSchema, where).toBe(column.typeSchema);
	expect(field.pk === true, where).toBe(column.pk === true);
	expect(field.unique === true, where).toBe(column.unique === true);
	expect(field.not_null === true, where).toBe(column.notNull === true);
	expect(field.increment === true, where).toBe(column.increment === true);
	expect(absent(field.note), where).toBe(column.note);
	checkDefault(field, column, where);
	expect(metadataOf(field), `${where} metadata`).toEqual(
		column.metadata ?? {}
	);
};

const checkIndexes = (read: ParsedTable, table: DbmlTable) => {
	expect(read.indexes.length, `${table.name} indexes`).toBe(
		table.indexes.length
	);
	table.indexes.forEach((index, position) => {
		const parsed = read.indexes[position];
		const where = `${table.name} index ${position}`;
		const primary: unknown = parsed?.pk;
		expect(
			parsed?.columns.map((part) =>
				isRecord(part) ? part.value : undefined
			),
			where
		).toEqual(
			index.parts.map((part) =>
				part.kind === 'column' ? part.column : unticked(part.expression)
			)
		);
		expect(primary === true, where).toBe(index.pk === true);
		expect(parsed?.unique === true, where).toBe(index.unique === true);
		expect(absent(parsed?.type), where).toBe(index.type);
		expect(absent(parsed?.name), where).toBe(index.name);
		expect(absent(parsed?.note), where).toBe(index.note);
	});
};

type Checking = {
	normalized: ReturnType<ReturnType<typeof parse>['normalize']>;
	schemaOf: (name: string | undefined) => ParsedSchema;
};

const checkChecks = (table: DbmlTable, checking: Checking) => {
	const tableId = Object.values(checking.normalized.tables).find(
		(entry) => entry.name === table.name
	)?.id;
	const checks = Object.values(checking.normalized.checks).filter(
		(check) => check.tableId === tableId
	);
	expect(
		checks.map((check) => [check.expression, absent(check.name)]),
		`${table.name} checks`
	).toEqual(
		table.checks.map((check) => [unticked(check.expression), check.name])
	);
};

const checkTable = (table: DbmlTable, checking: Checking) => {
	const read = checking
		.schemaOf(table.schema)
		.tables.find((entry) => entry.name === table.name);
	expect(read, `table ${table.name}`).toBeDefined();
	if (!read) return;
	expect(absent(read.note), `${table.name} note`).toBe(tableNoteOf(table));
	expect(read.fields.map((field) => field.name)).toEqual(
		table.columns.map((column) => column.name)
	);
	table.columns.forEach((column) => checkColumn(read, table, column));
	checkIndexes(read, table);
	checkChecks(table, checking);
	expect(metadataOf(read), `${table.name} metadata`).toEqual(
		table.metadata ?? {}
	);
};

const endsMatch = (parsed: ParsedRef, ref: DbmlRef) => {
	const [first, second] = parsed.endpoints;

	return (
		first?.tableName === ref.from.table &&
		first.fieldNames.join() === ref.from.columns.join() &&
		second?.tableName === ref.to.table &&
		second.fieldNames.join() === ref.to.columns.join()
	);
};

const checkRef = (ref: DbmlRef, refs: ParsedRef[]) => {
	const found = refs.find((entry) => endsMatch(entry, ref));
	const where = `ref ${ref.from.table}.${ref.from.columns.join()} ${ref.relation} ${ref.to.table}`;
	expect(found, where).toBeDefined();
	if (!found) return;
	expect(
		found.endpoints.map((end) => end.relation),
		where
	).toEqual(ENDS[ref.relation]);
	expect(absent(found.onDelete), where).toBe(ref.onDelete);
	expect(absent(found.onUpdate), where).toBe(ref.onUpdate);
	expect('inactive' in found && found.inactive === true, where).toBe(
		ref.inactive === true
	);
	expect(absent(found.name), where).toBe(ref.name);
};

const tableNameOf = (end: unknown) => (isRecord(end) ? `${end.tableName}` : '');

/* Deps aren't in the parser's declared export type, so they're read with
 * guards. */
const depEdges = (schema: ParsedSchema) => {
	const deps: unknown = 'deps' in schema ? schema.deps : [];
	if (!Array.isArray(deps)) return [];

	return deps
		.flatMap((dep) =>
			isRecord(dep) && Array.isArray(dep.edges) ? dep.edges : []
		)
		.map((edge) =>
			isRecord(edge)
				? `${tableNameOf(edge.upstream)}>${tableNameOf(edge.downstream)}`
				: ''
		);
};

/** Prints the model, parses it, and checks every part reads back as meant. */
export const roundTrip = (model: DbmlModel) => {
	const text = printDbml(model);
	const database = parse(text);
	const parsed = database.export();
	const schemaOf = (name: string | undefined) => {
		const found = parsed.schemas.find(
			(entry) => entry.name === (name ?? DEFAULT_SCHEMA)
		);
		if (!found)
			throw new Error(`No schema ${name ?? DEFAULT_SCHEMA} in:\n${text}`);

		return found;
	};
	const checking: Checking = { normalized: database.normalize(), schemaOf };
	model.tables.forEach((table) => checkTable(table, checking));

	model.enums.forEach((entry) =>
		expect(
			schemaOf(entry.schema)
				.enums.find((parsedEnum) => parsedEnum.name === entry.name)
				?.values.map((value) => value.name),
			`enum ${entry.name}`
		).toEqual(entry.values.map((value) => value.name))
	);

	const refs = parsed.schemas.flatMap((entry) => entry.refs);
	expect(refs.length, 'refs').toBe(model.refs.length);
	model.refs.forEach((ref) => checkRef(ref, refs));

	expect(parsed.schemas.flatMap(depEdges).sort()).toEqual(
		model.deps
			/* A dep over several columns prints as an edge per column. */
			.flatMap((dep) =>
				Array.from(
					{ length: Math.max(1, dep.upstream.columns?.length ?? 0) },
					() => `${dep.upstream.table}>${dep.downstream.table}`
				)
			)
			.sort()
	);
	expect(
		parsed.schemas
			.flatMap((entry) => entry.tableGroups)
			.map((group) => [
				group.name,
				group.tables.map((member) => member.tableName)
			])
	).toEqual(
		model.tableGroups.map((group) => [
			group.name,
			group.tables.map((member) => member.table)
		])
	);
	expect(parsed.notes.map((note) => [note.name, note.content])).toEqual(
		model.notes.map((note) => [note.name, note.content])
	);
	expect(
		parsed.records.map((records) => [
			records.tableName,
			records.values.map((row) => row.map((cell) => cell.value))
		])
	).toEqual(
		model.records
			.filter((records) => records.rows.length > 0)
			.map((records) => [records.table, records.rows])
	);

	return text;
};

/** A table's note as DBML prints it: its own note, then its details. */
export const printedNote = (table: DbmlTable | undefined) =>
	table ? tableNoteOf(table) : undefined;
