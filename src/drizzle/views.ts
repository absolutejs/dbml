import {
	Column,
	getColumnTable,
	is,
	SQL,
	Subquery,
	Table,
	View
} from 'drizzle-orm';
import type { DbmlColumn, DbmlTable } from '../model';
import { sqlText, sqlTextQualified, type ViewConfig } from './dialects';

/*
 * A view as DBML can show one: DBML has no view, so it's a table with its
 * own header colour and a note saying what it is, and `Dep` edges (DBML's
 * lineage) from each table or view its query reads.
 */

/** The header colour views are drawn with, to set them apart. */
export const VIEW_COLOR = '#64748b';

type Aliased = { fieldAlias: string; sql: SQL };

const isAliased = (value: unknown): value is Aliased =>
	typeof value === 'object' &&
	value !== null &&
	'fieldAlias' in value &&
	'sql' in value &&
	is(value.sql, SQL);

/* The next things to look inside: a fragment's pieces, an aliased
 * expression's SQL, a subquery's query. */
const childrenOf = (chunk: unknown) => {
	if (Array.isArray(chunk)) return chunk;
	if (isAliased(chunk)) return [chunk.sql];
	if (is(chunk, SQL)) return chunk.queryChunks;
	if (is(chunk, Subquery)) return [chunk._.sql];

	return [];
};

const sourceOf = (chunk: unknown) => {
	if (is(chunk, Table) || is(chunk, View)) return chunk;
	if (is(chunk, Column)) return getColumnTable(chunk);

	return undefined;
};

/** Every table and view a query reads, found by walking it: a view's own
 *  record of what it uses leaves out the tables it joins. */
export const sourcesOf = (fragment: unknown) => {
	const found = new Set<object>();
	const pending: unknown[] = [fragment];
	while (pending.length > 0) {
		const chunk = pending.pop();
		const source = sourceOf(chunk);
		if (source) found.add(source);
		else pending.push(...childrenOf(chunk));
	}

	return found;
};

/* A serial column read through a view is the integer it holds: the
 * sequence belongs to the table. */
const SERIALS: Record<string, string> = {
	bigserial: 'bigint',
	serial: 'integer',
	smallserial: 'smallint'
};

const readType = (type: string) => SERIALS[type] ?? type;

/** A table the view reads, with its columns' names. */
export type ViewSource = { columns: string[]; table: string };

/* Drizzle hands a view its columns re-parented to the view, so the table a
 * column came from is found by name among the ones the view reads, and
 * only said when exactly one of them has it. */
const originOf = (column: string, sources: ViewSource[]) => {
	const owners = sources.filter((source) => source.columns.includes(column));
	const [owner] = owners;

	return owners.length === 1 && owner ? `${owner.table}.${column}` : column;
};

const columnOfField = (name: string, field: unknown, sources: ViewSource[]) => {
	if (is(field, Column)) {
		const origin = originOf(field.name, sources);
		/* A bare name that is the column's own says nothing. */
		const picked: DbmlColumn = {
			name,
			...(origin === name ? {} : { note: `From ${origin}` }),
			type: readType(field.getSQLType())
		};

		return picked;
	}
	const expression = isAliased(field) ? field.sql : field;
	const computed: DbmlColumn = {
		name,
		...(is(expression, SQL)
			? { note: `Computed: ${sqlText(expression)}` }
			: {}),
		type: 'unknown'
	};

	return computed;
};

const MAX_QUERY = 600;

const shortened = (query: string) =>
	query.length > MAX_QUERY ? `${query.slice(0, MAX_QUERY)}…` : query;

const viewNote = (config: ViewConfig, kind: string) => {
	if (config.isExisting)
		return `${kind} that already exists in the database; its query lives there`;
	if (!config.query) return kind;

	return `${kind}:\n${shortened(sqlTextQualified(config.query))}`;
};

export const viewOf = (
	config: ViewConfig,
	materialized: boolean,
	sources: ViewSource[]
) => {
	const view: DbmlTable = {
		checks: [],
		columns: Object.entries(config.selectedFields).map(([name, field]) =>
			columnOfField(name, field, sources)
		),
		headerColor: VIEW_COLOR,
		indexes: [],
		name: config.name,
		note: viewNote(config, materialized ? 'Materialized view' : 'View'),
		...(config.schema ? { schema: config.schema } : {})
	};

	return view;
};
