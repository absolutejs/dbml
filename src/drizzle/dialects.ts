import { is, SQL, sql } from 'drizzle-orm';
import * as cockroach from 'drizzle-orm/cockroach-core';
import * as mssql from 'drizzle-orm/mssql-core';
import * as mysql from 'drizzle-orm/mysql-core';
import * as pg from 'drizzle-orm/pg-core';
import * as singlestore from 'drizzle-orm/singlestore-core';
import * as sqlite from 'drizzle-orm/sqlite-core';

/*
 * What differs between Drizzle's dialects, behind one shape: how to tell
 * a table, view, enum or sequence of that dialect, and how to read its
 * configuration. Each dialect's values are narrowed by Drizzle's own type
 * guards, so every configuration is read with its own types.
 */

/** The column properties this package reads; Drizzle columns carry more,
 *  and each dialect only some of these. */
export type DrizzleColumn = {
	autoIncrement?: boolean;
	columnType: string;
	default?: unknown;
	defaultFn?: unknown;
	dimensions?: number;
	enum?: { enumName: string; schema?: string | undefined };
	enumValues?: readonly string[] | undefined;
	generated?: { as: unknown; mode?: string; type?: string } | undefined;
	generatedIdentity?: { type?: string } | undefined;
	getSQLType: () => string;
	hasOnUpdateNow?: boolean;
	identity?: unknown;
	isUnique: boolean;
	name: string;
	notNull: boolean;
	onUpdateFn?: unknown;
	primary: boolean;
	uniqueType?: string | undefined;
};

export type IndexConfig = {
	algorithm?: string | undefined;
	columns: readonly unknown[];
	concurrently?: boolean | undefined;
	lock?: string | undefined;
	method?: string | undefined;
	name?: string | undefined;
	unique?: boolean | undefined;
	using?: string | SQL | undefined;
	where?: SQL | undefined;
	with?: Record<string, unknown> | undefined;
};

export type PolicyConfig = {
	as?: string | undefined;
	for?: string | undefined;
	name: string;
	to?: unknown;
	using?: SQL | undefined;
	withCheck?: SQL | undefined;
};

type ForeignKeyConfig = {
	onDelete?: string | undefined;
	onUpdate?: string | undefined;
	reference: () => {
		columns: readonly DrizzleColumn[];
		foreignColumns: readonly DrizzleColumn[];
		foreignTable: object;
		name?: string | undefined;
	};
};

/* The parts of a table's configuration every dialect shares. */
export type TableConfig = {
	checks: readonly { name: string; value: SQL }[];
	columns: readonly DrizzleColumn[];
	enableRLS?: boolean;
	foreignKeys: readonly ForeignKeyConfig[];
	indexes: readonly { config: IndexConfig }[];
	name: string;
	policies?: readonly PolicyConfig[];
	primaryKeys: readonly {
		columns: readonly DrizzleColumn[];
		name?: string | undefined;
	}[];
	schema?: string | undefined;
	uniqueConstraints: readonly {
		columns: readonly DrizzleColumn[];
		name?: string | undefined;
		nullsNotDistinct?: boolean;
	}[];
};

export type ViewConfig = {
	isExisting: boolean;
	name: string;
	query?: SQL | undefined;
	schema?: string | undefined;
	selectedFields: Record<string, unknown>;
};

export type EnumConfig = {
	enumName: string;
	enumValues: readonly string[];
	schema?: string | undefined;
};

export type SequenceConfig = {
	schema?: string | undefined;
	seqName?: string | undefined;
	seqOptions?: object | undefined;
};

export type Dialect = {
	databaseType: string;
	enumOf: (value: unknown) => EnumConfig | undefined;
	materializedViewOf: (value: unknown) => ViewConfig | undefined;
	sequenceOf: (value: unknown) => SequenceConfig | undefined;
	tableOf: (value: unknown) => TableConfig | undefined;
	viewOf: (value: unknown) => ViewConfig | undefined;
};

const none = () => undefined;

export const DIALECTS: Dialect[] = [
	{
		databaseType: 'PostgreSQL',
		enumOf: (value) => (pg.isPgEnum(value) ? value : undefined),
		materializedViewOf: (value) =>
			pg.isPgMaterializedView(value)
				? pg.getMaterializedViewConfig(value)
				: undefined,
		sequenceOf: (value) => (pg.isPgSequence(value) ? value : undefined),
		tableOf: (value) =>
			is(value, pg.PgTable) ? pg.getTableConfig(value) : undefined,
		viewOf: (value) =>
			pg.isPgView(value) ? pg.getViewConfig(value) : undefined
	},
	{
		databaseType: 'CockroachDB',
		enumOf: (value) =>
			cockroach.isCockroachEnum(value) ? value : undefined,
		materializedViewOf: (value) =>
			cockroach.isCockroachMaterializedView(value)
				? cockroach.getMaterializedViewConfig(value)
				: undefined,
		sequenceOf: (value) =>
			cockroach.isCockroachSequence(value) ? value : undefined,
		tableOf: (value) =>
			is(value, cockroach.CockroachTable)
				? cockroach.getTableConfig(value)
				: undefined,
		viewOf: (value) =>
			cockroach.isCockroachView(value)
				? cockroach.getViewConfig(value)
				: undefined
	},
	{
		databaseType: 'MySQL',
		enumOf: none,
		materializedViewOf: none,
		sequenceOf: none,
		tableOf: (value) =>
			is(value, mysql.MySqlTable)
				? mysql.getTableConfig(value)
				: undefined,
		viewOf: (value) =>
			is(value, mysql.MySqlView) ? mysql.getViewConfig(value) : undefined
	},
	{
		databaseType: 'SingleStore',
		enumOf: none,
		materializedViewOf: none,
		sequenceOf: none,
		viewOf: none /* SingleStore has neither foreign keys nor checks. */,
		tableOf: (value) =>
			is(value, singlestore.SingleStoreTable)
				? {
						checks: [],
						foreignKeys: [],
						...singlestore.getTableConfig(value)
					}
				: undefined
	},
	{
		databaseType: 'SQLite',
		enumOf: none,
		materializedViewOf: none,
		sequenceOf: none,
		tableOf: (value) =>
			is(value, sqlite.SQLiteTable)
				? sqlite.getTableConfig(value)
				: undefined,
		viewOf: (value) =>
			is(value, sqlite.SQLiteView)
				? sqlite.getViewConfig(value)
				: undefined
	},
	{
		databaseType: 'SQL Server',
		enumOf: none,
		materializedViewOf: none,
		sequenceOf: none,
		tableOf: (value) =>
			is(value, mssql.MsSqlTable)
				? mssql.getTableConfig(value)
				: undefined,
		viewOf: (value) =>
			is(value, mssql.MsSqlView) ? mssql.getViewConfig(value) : undefined
	}
];

/* Every dialect's SQL is written out the one way: identifiers in double
 * quotes and values inline. DBML puts an expression in backticks and can't
 * escape one inside it, so MySQL's own backtick quoting can't be used. */
const writer = new pg.PgDialect();

/** A Drizzle SQL fragment as text, its columns by bare name (`"email"`,
 *  not `"users"."email"`) and its values written in. The fragment itself
 *  is left as it was. */
export const sqlText = (fragment: SQL) =>
	writer.sqlToQuery(sql`${fragment}`.inlineParams(), 'indexes').sql;

/** The same, with columns named by their table (`"users"."email"`), for
 *  a query that reads several tables. */
export const sqlTextQualified = (fragment: SQL) =>
	writer.sqlToQuery(sql`${fragment}`.inlineParams()).sql;

export const isSql = (value: unknown): value is SQL => is(value, SQL);
