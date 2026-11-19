import {
	type DbmlColumn,
	type DbmlDefault,
	type DbmlIndex,
	type DbmlIndexPart,
	type DbmlMetadata,
	type DbmlModel,
	type DbmlRef,
	type DbmlReferentialAction,
	type DbmlTable,
	emptyModel,
	isUniqueSet
} from '../model';
import {
	afterKeyword,
	bracketed,
	checksIn,
	leadingName,
	topLevel,
	unquote
} from './text';

/*
 * A live SQLite database as a DBML model. Its pragmas give the columns,
 * keys, indexes and foreign keys; what they don't (an index's expressions
 * and predicate, checks, generated columns, collations, AUTOINCREMENT) is
 * read from each table's own CREATE statement. Views, with the tables they
 * read, and triggers come along too.
 *
 * It only reads, through the `query` it's given: bun:sqlite's
 * `(text, params) => db.query(text).all(...params)` is enough.
 */

/** Runs one statement with positional parameters and returns its rows. */
export type SqliteQuery = (
	text: string,
	params: unknown[]
) => Promise<Record<string, unknown>[]> | Record<string, unknown>[];

export type FromSqliteOptions = {
	project?: { name?: string; note?: string };
	/** Each table's row count, as metadata. Counting reads every row, so
	 *  it's left out unless asked for. */
	statistics?: boolean;
};

type Raw = Record<string, unknown>;

const text = (value: unknown) => {
	if (value === null || value === undefined) return undefined;

	return typeof value === 'string' ? value : `${value}`;
};
const integer = (value: unknown) =>
	typeof value === 'number' ? value : Number.parseInt(text(value) ?? '0', 10);

const VIEW_COLOR = '#64748b';

const ACTIONS: Record<string, DbmlReferentialAction | undefined> = {
	CASCADE: 'cascade',
	'NO ACTION': undefined,
	RESTRICT: 'restrict',
	'SET DEFAULT': 'set default',
	'SET NULL': 'set null'
};

const NUMBER = /^-?\d+(\.\d+)?$/u;
const QUOTED = /^'((?:[^']|'')*)'$/u;

/* A default as SQLite keeps it: the text after DEFAULT, as written. */
const defaultOf = (raw: string) => {
	if (/^null$/iu.test(raw)) return { kind: 'null' } satisfies DbmlDefault;
	if (/^(true|false)$/iu.test(raw))
		return {
			kind: 'boolean',
			value: raw.toLowerCase() === 'true'
		} satisfies DbmlDefault;
	if (
		NUMBER.test(raw) &&
		Number.isSafeInteger(Math.trunc(Number.parseFloat(raw)))
	)
		return {
			kind: 'number',
			value: Number.parseFloat(raw)
		} satisfies DbmlDefault;
	const [, quoted] = QUOTED.exec(raw) ?? [];
	if (quoted !== undefined)
		return {
			kind: 'string',
			value: quoted.replaceAll("''", "'")
		} satisfies DbmlDefault;
	const inner =
		raw.startsWith('(') && raw.endsWith(')') ? raw.slice(1, -1) : raw;

	return { kind: 'expression', value: inner } satisfies DbmlDefault;
};

/** Each column's own definition in a CREATE TABLE, by its name. */
const definitionsOf = (sql: string) => {
	const open = sql.indexOf('(');
	const body = open === -1 ? undefined : bracketed(sql, open);
	const parts = body ? topLevel(body.inner) : [];
	const constraint = /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/iu;

	return {
		body: body?.inner ?? '',
		columns: new Map(
			parts
				.filter((part) => !constraint.test(part))
				.map((part) => [unquote(leadingName(part)).toLowerCase(), part])
		),
		suffix: body ? sql.slice(body.close + 1) : ''
	};
};

const collationOf = (definition: string) => {
	const name = /\bCOLLATE\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)/iu.exec(
		definition
	)?.[1];

	return name && name.toUpperCase() !== 'BINARY' ? unquote(name) : undefined;
};

type ColumnInfo = {
	cid: number;
	default?: string;
	hidden: number;
	name: string;
	notNull: boolean;
	pk: number;
	type: string;
};

const columnInfo = (row: Raw) => {
	const info: ColumnInfo = {
		cid: integer(row.cid),
		...(text(row.dflt_value) === undefined
			? {}
			: { default: text(row.dflt_value) ?? '' }),
		hidden: integer(row.hidden),
		name: text(row.name) ?? '',
		notNull: integer(row.notnull) === 1,
		pk: integer(row.pk),
		type: text(row.type) ?? ''
	};

	return info;
};

const GENERATED: Record<number, string> = { 2: 'virtual', 3: 'stored' };

/* A single INTEGER PRIMARY KEY is the row id, which counts up. */
const columnOf = (info: ColumnInfo, definition: string, rowidKey: boolean) => {
	const generated = GENERATED[info.hidden];
	const expression = generated
		? afterKeyword(definition, /\bAS\s*\(/iu)?.inner.trim()
		: undefined;
	const collation = collationOf(definition);
	const metadata: DbmlMetadata = collation ? { collation } : {};
	const notes = [
		generated
			? `Generated always as (${expression ?? '…'}), ${generated}`
			: undefined,
		/\bAUTOINCREMENT\b/iu.test(definition)
			? 'AUTOINCREMENT: ids are never reused'
			: undefined
	].filter((line) => line !== undefined);
	const column: DbmlColumn = {
		name: info.name,
		type: info.type === '' ? 'any' : info.type.toLowerCase(),
		...(info.pk > 0 && rowidKey ? { increment: true, pk: true } : {}),
		...(info.pk > 0 && !rowidKey && !generated ? {} : {}),
		...(info.notNull && info.pk === 0 ? { notNull: true } : {}),
		...(info.default !== undefined && !generated
			? { default: defaultOf(info.default) }
			: {}),
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
		...(notes.length > 0 ? { note: notes.join('\n') } : {})
	};

	return column;
};

/* An index's parts as its CREATE INDEX writes them, for its expressions. */
const NO_PARTS: { parts: string[]; where?: string } = { parts: [] };

const indexPartsText = (sql: string | undefined) => {
	if (!sql) return NO_PARTS;
	const target = /\bON\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|\S+?)\s*\(/iu.exec(sql);
	if (!target) return NO_PARTS;
	const found = bracketed(sql, target.index + target[0].length - 1);
	const where = found
		? /\bWHERE\s+([\s\S]+)$/iu.exec(sql.slice(found.close + 1))?.[1]?.trim()
		: undefined;

	return { parts: found ? topLevel(found.inner) : [], where };
};

type Reader = (statement: string, params?: unknown[]) => Promise<Raw[]>;

const indexesOf = async (
	read: Reader,
	table: string,
	sqlOf: (name: string) => string | undefined,
	/* Each column's own collation, upper-cased; BINARY when it has none. */
	columnCollation: (column: string) => string
) => {
	const list = await read('select * from pragma_index_list(?)', [table]);
	const indexes = await Promise.all(
		list
			.filter((row) => text(row.origin) !== 'pk')
			.map(async (row) => {
				const name = text(row.name) ?? '';
				const parts = (
					await read('select * from pragma_index_xinfo(?)', [name])
				).filter((part) => integer(part.key) === 1);
				const written = indexPartsText(sqlOf(name));
				const collations = parts
					/* Only a collation that isn't the column's own says anything. */
					.filter((part) => {
						const column = text(part.name);
						const collation = text(part.coll)?.toUpperCase();

						return (
							column !== undefined &&
							collation !== undefined &&
							collation !== columnCollation(column)
						);
					})
					.map((part) => `${text(part.name)} ${text(part.coll)}`);
				const index: DbmlIndex = {
					parts: parts.map((part, position) => {
						const desc =
							integer(part.desc) === 1 ? { desc: true } : {};
						const column = text(part.name);
						const entry: DbmlIndexPart =
							integer(part.cid) >= 0 && column
								? { column, kind: 'column', ...desc }
								: {
										expression: (
											written.parts[position] ?? ''
										).replace(/\s+(ASC|DESC)$/iu, ''),
										kind: 'expression',
										...desc
									};

						return entry;
					}),
					...(integer(row.unique) === 1 ? { unique: true } : {}),
					/* An automatic index (a UNIQUE constraint's) has a made-up name. */
					...(name.startsWith('sqlite_autoindex_') ? {} : { name }),
					...(() => {
						const lines = [
							written.where && integer(row.partial) === 1
								? `Where ${written.where}`
								: undefined,
							collations.length > 0
								? `Collation: ${collations.join(', ')}`
								: undefined
						].filter((line) => line !== undefined);

						return lines.length > 0
							? { note: lines.join('\n') }
							: {};
					})()
				};

				return { index, origin: text(row.origin) ?? 'c' };
			})
	);

	return indexes;
};

const foreignKeysOf = async (read: Reader, table: DbmlTable) => {
	const rows = await read('select * from pragma_foreign_key_list(?)', [
		table.name
	]);
	const groups = new Map<number, Raw[]>();
	rows.forEach((row) =>
		groups.set(integer(row.id), [
			...(groups.get(integer(row.id)) ?? []),
			row
		])
	);

	return [...groups.values()].map((group) => {
		const [first] = group;
		const columns = group.map((row) => text(row.from) ?? '');
		const onDelete = ACTIONS[text(first?.on_delete) ?? ''];
		const onUpdate = ACTIONS[text(first?.on_update) ?? ''];
		const ref: DbmlRef = {
			from: { columns, table: table.name },
			...(onDelete ? { onDelete } : {}),
			...(onUpdate ? { onUpdate } : {}),
			relation: isUniqueSet(table, columns) ? '-' : '>',
			to: {
				columns: group.map((row) => text(row.to) ?? ''),
				table: text(first?.table) ?? ''
			}
		};

		return ref;
	});
};

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

type TableContext = {
	listed: Raw[];
	sqlOf: (name: string) => string | undefined;
	statistics: boolean;
	triggers: Raw[];
};

/* A one-column unique constraint sits on its column. */
const placeIndex = (table: DbmlTable, index: DbmlIndex, origin: string) => {
	const [part] = index.parts;
	const single =
		index.parts.length === 1 && part?.kind === 'column' && origin === 'u';
	const column = single
		? table.columns.find((own) => own.name === part.column)
		: undefined;
	if (column) column.unique = true;
	else table.indexes.push(index);
};

const tableOf = async (read: Reader, entry: Raw, context: TableContext) => {
	const name = text(entry.name) ?? '';
	const view = text(entry.type) === 'view';
	const sql = text(entry.sql) ?? '';
	const definitions = definitionsOf(sql);
	const info = (
		await read('select * from pragma_table_xinfo(?)', [name])
	).map(columnInfo);
	const keyed = info
		.filter((column) => column.pk > 0)
		.sort((left, right) => left.pk - right.pk);
	const [onlyKey] = keyed;
	const rowidKey =
		keyed.length === 1 && onlyKey?.type.toUpperCase() === 'INTEGER';
	const tableEntry = context.listed.find((row) => row.name === name);
	const rows =
		context.statistics && !view
			? integer(
					(
						await read(
							`select count(*) as total from ${quoteIdent(name)}`
						)
					)[0]?.total
				)
			: undefined;
	const metadata: DbmlMetadata = {
		...(integer(tableEntry?.strict) === 1 ? { strict: true } : {}),
		...(integer(tableEntry?.wr) === 1 ? { without_rowid: true } : {}),
		...(rows === undefined ? {} : { rows })
	};
	const own = context.triggers.filter((row) => row.tbl_name === name);
	const noteLines = [
		view
			? `View:\n${sql.replace(/^CREATE\s+(TEMP\s+|TEMPORARY\s+)?VIEW\s+\S+\s+AS\s+/iu, '')}`
			: undefined,
		...own.map(
			(row) =>
				`Trigger ${(text(row.sql) ?? '').replace(/^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\s+(IF NOT EXISTS\s+)?/iu, '')}`
		)
	].filter((line) => line !== undefined);
	const table: DbmlTable = {
		checks: view ? [] : checksIn(definitions.body),
		columns: info.map((column) =>
			columnOf(
				column,
				definitions.columns.get(column.name.toLowerCase()) ?? '',
				rowidKey && column.pk > 0
			)
		),
		...(view ? { headerColor: VIEW_COLOR } : {}),
		indexes: [],
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
		name,
		...(noteLines.length > 0 ? { note: noteLines.join('\n') } : {})
	};
	if (keyed.length === 1 && !rowidKey)
		table.columns.forEach((column) => {
			if (column.name === onlyKey?.name) column.pk = true;
		});
	if (keyed.length > 1)
		table.indexes.push({
			parts: keyed.map((column) => ({
				column: column.name,
				kind: 'column'
			})),
			pk: true
		});
	if (view) return table;
	const indexes = await indexesOf(read, name, context.sqlOf, (column) => {
		const collation = table.columns.find(
			(candidate) => candidate.name === column
		)?.metadata?.collation;

		return typeof collation === 'string'
			? collation.toUpperCase()
			: 'BINARY';
	});
	indexes.forEach(({ index, origin }) => placeIndex(table, index, origin));

	return table;
};

/** The database's structure as a DBML model. */
export const fromSqlite = async (
	query: SqliteQuery,
	options: FromSqliteOptions = {}
) => {
	const read: Reader = async (statement, params = []) =>
		query(statement, params);
	const schema = await read(
		`select type, name, tbl_name, sql from sqlite_schema where name not like 'sqlite_%' order by rowid`
	);
	const sqlOf = (name: string) =>
		text(schema.find((row) => row.name === name)?.sql);
	const listed = (await read('select * from pragma_table_list')).filter(
		(row) =>
			text(row.schema) === 'main' &&
			!(text(row.name) ?? '').startsWith('sqlite_')
	);
	const model: DbmlModel = emptyModel({
		databaseType: 'SQLite',
		...options.project
	});
	const ordered = schema.filter(
		(row) => text(row.type) === 'table' || text(row.type) === 'view'
	);

	const context: TableContext = {
		listed,
		sqlOf,
		statistics: options.statistics === true,
		triggers: schema.filter((row) => text(row.type) === 'trigger')
	};
	model.tables.push(
		...(await Promise.all(
			ordered.map((entry) => tableOf(read, entry, context))
		))
	);

	const tables = model.tables.filter((table) => !table.headerColor);
	const refs = await Promise.all(
		tables.map((table) => foreignKeysOf(read, table))
	);
	model.refs.push(...refs.flat());
	/* SQLite keeps no record of what a view reads; the tables its query
	 * names are its sources. */
	model.tables
		.filter((table) => table.headerColor)
		.forEach((view) => {
			const sql = sqlOf(view.name) ?? '';
			tables
				.filter((table) =>
					new RegExp(
						`(^|[^\\w"\`])["\`[]?${table.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}["\`\\]]?($|[^\\w"\`])`,
						'iu'
					).test(sql.replace(/^CREATE\s+\S+\s+\S+/iu, ''))
				)
				.forEach((table) =>
					model.deps.push({
						downstream: { table: view.name },
						upstream: { table: table.name }
					})
				);
		});

	return model;
};
