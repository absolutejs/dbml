import {
	type DbmlColumn,
	type DbmlDefault,
	type DbmlEnum,
	type DbmlIndex,
	type DbmlIndexPart,
	type DbmlMetadata,
	type DbmlModel,
	type DbmlRef,
	type DbmlReferentialAction,
	type DbmlStickyNote,
	type DbmlTable,
	emptyModel,
	groupBySchema,
	isUniqueSet,
	withDefaultSchema
} from '../model';

/*
 * A live MySQL or MariaDB database as a DBML model, from its
 * information_schema: tables and views, columns with their exact types,
 * defaults, generation and collations, enums and sets, keys, indexes (with
 * prefixes, expressions and invisibility), checks, foreign keys, triggers,
 * partitions, routines and scheduled events, and each table's engine and
 * grants. MySQL and MariaDB keep slightly different columns, so every
 * view is read whole and what one of them lacks is simply absent.
 *
 * It only reads, through the `query` it's given (`?` placeholders).
 */

/** Runs one statement with `?` parameters and returns its rows. */
export type MysqlQuery = (
	text: string,
	params: unknown[]
) => Promise<Record<string, unknown>[]>;

export type FromMysqlOptions = {
	/** The database (schema) named without qualifying it; the first one read
	 *  by default. */
	defaultSchema?: string;
	/** `'schema'` groups tables by their database. */
	groups?: 'schema';
	project?: { name?: string; note?: string };
	/** The databases to read; the connection's current one by default. */
	schemas?: string[];
	/** Each table's estimated rows and size, as metadata. */
	statistics?: boolean;
};

type Row = Record<string, unknown>;

/* information_schema's column names are upper case in MySQL and mixed in
 * MariaDB; reading every key lower-cased makes them one. */
const lowered = (row: Row) =>
	Object.fromEntries(
		Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])
	);

const text = (value: unknown) => {
	if (value === null || value === undefined) return undefined;
	if (value instanceof Uint8Array) return new TextDecoder().decode(value);

	return typeof value === 'string' ? value : `${value}`;
};

const integer = (value: unknown) => Number.parseInt(text(value) ?? '0', 10);

const VIEW_COLOR = '#64748b';

const ACTIONS: Record<string, DbmlReferentialAction | undefined> = {
	CASCADE: 'cascade',
	'NO ACTION': undefined,
	RESTRICT: undefined,
	'SET DEFAULT': 'set default',
	'SET NULL': 'set null'
};

const NUMBER = /^-?\d+(\.\d+)?$/u;

/* MySQL's own default for a key action is RESTRICT; only a chosen one is
 * worth saying, so RESTRICT reads like NO ACTION does elsewhere. */
const actionOf = (rule: string | undefined) => ACTIONS[rule ?? ''];

/* A default as information_schema gives it: a literal's text, or an
 * expression when EXTRA says DEFAULT_GENERATED (or it's CURRENT_TIMESTAMP). */
const defaultOf = (
	raw: string | undefined,
	extra: string,
	mariadb: boolean
) => {
	if (raw === undefined) return undefined;
	if (/^NULL$/iu.test(raw))
		return mariadb || extra === ''
			? ({ kind: 'null' } satisfies DbmlDefault)
			: undefined;
	if (
		/DEFAULT_GENERATED/iu.test(extra) ||
		/^(CURRENT_TIMESTAMP|now\(\))/iu.test(raw)
	)
		return {
			kind: 'expression',
			value: raw.replace(/^\((.*)\)$/su, '$1')
		} satisfies DbmlDefault;
	const unquoted =
		mariadb && /^'.*'$/su.test(raw)
			? raw.slice(1, -1).replaceAll("''", "'")
			: raw;
	if (
		NUMBER.test(unquoted) &&
		Number.isSafeInteger(Math.trunc(Number.parseFloat(unquoted)))
	)
		return {
			kind: 'number',
			value: Number.parseFloat(unquoted)
		} satisfies DbmlDefault;
	if (mariadb && !/^'.*'$/su.test(raw))
		return { kind: 'expression', value: raw } satisfies DbmlDefault;

	return { kind: 'string', value: unquoted } satisfies DbmlDefault;
};

const ENUMISH = /^(enum|set)\((.*)\)$/isu;

/* `enum('a','b')` as its values. */
const valuesOf = (list: string) =>
	[...list.matchAll(/'((?:[^']|'')*)'/gu)].map((match) =>
		(match[1] ?? '').replaceAll("''", "'")
	);

type Context = { mariadb: boolean; statistics: boolean };

const columnOf = (
	row: Row,
	table: { name: string; schema: string },
	context: Context
) => {
	const type = text(row.column_type) ?? '';
	const extra = text(row.extra) ?? '';
	const enumish = ENUMISH.exec(type);
	const name = text(row.column_name) ?? '';
	const generated = /\b(VIRTUAL|STORED|PERSISTENT) GENERATED\b/iu
		.exec(extra)?.[1]
		?.toLowerCase();
	const fallback = generated
		? undefined
		: defaultOf(text(row.column_default), extra, context.mariadb);
	const metadata: DbmlMetadata = {
		...(text(row.collation_name) &&
		text(row.collation_name) !== text(row.table_collation)
			? { collation: text(row.collation_name) ?? '' }
			: {}),
		...(text(row.srs_id) ? { srid: integer(row.srs_id) } : {})
	};
	const notes = [
		text(row.column_comment) || undefined,
		generated
			? `Generated always as (${text(row.generation_expression) ?? ''}), ${generated}`
			: undefined,
		/on update/iu.test(extra)
			? `Set to ${/on update (.*)$/iu.exec(extra)?.[1] ?? 'the current time'} on every update`
			: undefined,
		/INVISIBLE/iu.test(extra)
			? 'Invisible: SELECT * leaves it out'
			: undefined,
		enumish ? `Stored as ${type}` : undefined,
		enumish?.[1]?.toLowerCase() === 'set'
			? 'A set: any number of these values at once'
			: undefined
	].filter((line) => line !== undefined);
	const enumType: DbmlEnum | undefined = enumish
		? {
				name: `${table.name}_${name}`,
				schema: table.schema,
				values: valuesOf(enumish[2] ?? '').map((value) => ({
					name: value
				}))
			}
		: undefined;
	const column: DbmlColumn = {
		name,
		type: enumType ? enumType.name : type,
		...(enumType ? { typeSchema: table.schema } : {}),
		...(/auto_increment/iu.test(extra) ? { increment: true } : {}),
		...(text(row.is_nullable) === 'NO' ? { notNull: true } : {}),
		...(fallback ? { default: fallback } : {}),
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
		...(notes.length > 0 ? { note: notes.join('\n') } : {})
	};

	return { column, enumType };
};

const keyOf = (schema: unknown, table: unknown) =>
	`${text(schema)}.${text(table)}`;

const group = <Entry>(rows: Entry[], keyFn: (row: Entry) => string) => {
	const groups = new Map<string, Entry[]>();
	rows.forEach((row) =>
		groups.set(keyFn(row), [...(groups.get(keyFn(row)) ?? []), row])
	);

	return groups;
};

/* An index from its STATISTICS rows: columns or expressions, prefix
 * lengths, order, its method and whether it's visible. */
const indexOf = (rows: Row[]) => {
	const [first] = rows;
	const name = text(first?.index_name) ?? '';
	const sorted = [...rows].sort(
		(left, right) =>
			integer(left.seq_in_index) - integer(right.seq_in_index)
	);
	const prefixes = sorted
		.filter((row) => text(row.sub_part))
		.map((row) => `${text(row.column_name)}(${text(row.sub_part)})`);
	const method = text(first?.index_type)?.toLowerCase();
	const notes = [
		text(first?.index_comment) || undefined,
		prefixes.length > 0 ? `Prefix: ${prefixes.join(', ')}` : undefined,
		text(first?.is_visible) === 'NO' || text(first?.ignored) === 'YES'
			? 'Invisible: the optimizer ignores it'
			: undefined
	].filter((line) => line !== undefined);
	const index: DbmlIndex = {
		parts: sorted.map((row) => {
			const desc = text(row.collation) === 'D' ? { desc: true } : {};
			const column = text(row.column_name);
			const part: DbmlIndexPart = column
				? { column, kind: 'column', ...desc }
				: {
						expression: (text(row.expression) ?? '').replace(
							/^\((.*)\)$/su,
							'$1'
						),
						kind: 'expression',
						...desc
					};

			return part;
		}),
		...(name === 'PRIMARY' ? { pk: true } : { name }),
		...(integer(first?.non_unique) === 0 && name !== 'PRIMARY'
			? { unique: true }
			: {}),
		...(method && method !== 'btree' ? { type: method } : {}),
		...(notes.length > 0 ? { note: notes.join('\n') } : {})
	};

	return index;
};

/* A plain one-column primary or unique key sits on the column. */
const placeIndex = (table: DbmlTable, index: DbmlIndex) => {
	const [part] = index.parts;
	const plain =
		index.parts.length === 1 &&
		part?.kind === 'column' &&
		index.note === undefined;
	const column =
		plain && part?.kind === 'column'
			? table.columns.find((entry) => entry.name === part.column)
			: undefined;
	if (column && index.pk) {
		column.pk = true;
		delete column.notNull;

		return;
	}
	if (column && index.unique && index.name === column.name) {
		column.unique = true;

		return;
	}
	table.indexes.push(index);
};

const tableMetadata = (
	row: Row,
	context: Context,
	grants: string | undefined
) => {
	const metadata: DbmlMetadata = {
		...(text(row.engine) ? { engine: text(row.engine) ?? '' } : {}),
		...(text(row.table_collation)
			? { collation: text(row.table_collation) ?? '' }
			: {}),
		...(text(row.row_format)
			? { row_format: text(row.row_format) ?? '' }
			: {}),
		...(text(row.create_options)
			? { options: text(row.create_options) ?? '' }
			: {}),
		...(grants ? { grants } : {}),
		...(context.statistics && text(row.table_rows)
			? { rows: integer(row.table_rows) }
			: {}),
		...(context.statistics && text(row.data_length)
			? {
					size_bytes:
						integer(row.data_length) + integer(row.index_length)
				}
			: {}),
		...(context.statistics && text(row.auto_increment)
			? { next_id: integer(row.auto_increment) }
			: {})
	};

	return metadata;
};

type Catalog = Record<string, Row[]>;

const VIEWS = [
	'tables',
	'columns',
	'statistics',
	'table_constraints',
	'key_column_usage',
	'referential_constraints',
	'check_constraints',
	'views',
	'triggers',
	'routines',
	'parameters',
	'partitions',
	'events',
	'table_privileges',
	'view_table_usage'
];

/* The schema column each information_schema view filters by. */
const SCHEMA_COLUMN: Record<string, string> = {
	check_constraints: 'constraint_schema',
	events: 'event_schema',
	parameters: 'specific_schema',
	referential_constraints: 'constraint_schema',
	routines: 'routine_schema',
	table_constraints: 'constraint_schema',
	table_privileges: 'table_schema',
	triggers: 'trigger_schema',
	view_table_usage: 'view_schema'
};

/* Every view read whole for the databases asked for; one a server lacks
 * (VIEW_TABLE_USAGE before MySQL 8.0.13, CHECK_CONSTRAINTS before 8.0.16)
 * reads as empty. */
const readCatalog = async (query: MysqlQuery, schemas: string[]) => {
	const marks = schemas.map(() => '?').join(', ');
	const entries = await Promise.all(
		VIEWS.map(async (view) => {
			const column = SCHEMA_COLUMN[view] ?? 'table_schema';
			const rows = await query(
				`select * from information_schema.${view} where ${column} in (${marks})`,
				schemas
			).catch(() => []);

			const entry: [string, Row[]] = [view, rows.map(lowered)];

			return entry;
		})
	);
	const catalog: Catalog = Object.fromEntries(entries);

	return catalog;
};

const triggerLine = (row: Row) =>
	`Trigger ${text(row.trigger_name)} ${text(row.action_timing)} ${text(row.event_manipulation)}: ${(text(row.action_statement) ?? '').replace(/\s+/gu, ' ')}`;

const partitionLines = (rows: Row[]) => {
	const named = rows.filter((row) => text(row.partition_name));
	const [first] = named;
	if (!first) return [];

	return [
		`Partitioned by ${text(first.partition_method)} (${text(first.partition_expression)})`,
		...named.map(
			(row) =>
				`Partition ${text(row.partition_name)}${text(row.partition_description) ? `: ${text(row.partition_description)}` : ''}`
		)
	];
};

const routineNote = (catalog: Catalog) => {
	const routines = catalog.routines ?? [];
	if (routines.length === 0) return [];
	const parameters = group(catalog.parameters ?? [], (row) =>
		keyOf(row.specific_schema, row.specific_name)
	);
	const lines = routines.map((row) => {
		const args = (
			parameters.get(keyOf(row.routine_schema, row.specific_name)) ?? []
		)
			.filter((parameter) => text(parameter.parameter_name))
			.sort(
				(left, right) =>
					integer(left.ordinal_position) -
					integer(right.ordinal_position)
			)
			.map((parameter) =>
				`${text(parameter.parameter_mode) ?? ''} ${text(parameter.parameter_name)} ${text(parameter.dtd_identifier)}`.trim()
			)
			.join(', ');
		const kind = text(row.routine_type)?.toLowerCase() ?? 'function';
		const result =
			kind === 'function' ? ` → ${text(row.dtd_identifier)}` : '';

		return `${text(row.routine_name)}(${args})${result}, ${kind}`;
	});
	const note: DbmlStickyNote = {
		content: `Functions and procedures\n${lines.join('\n')}`,
		name: 'functions'
	};

	return [note];
};

const eventNote = (catalog: Catalog) => {
	const events = catalog.events ?? [];
	if (events.length === 0) return [];
	const note: DbmlStickyNote = {
		content: `Scheduled events\n${events
			.map(
				(row) =>
					`${text(row.event_name)}: ${text(row.interval_value) ? `every ${text(row.interval_value)} ${text(row.interval_field)}` : `at ${text(row.execute_at)}`}, ${text(row.status)?.toLowerCase()}`
			)
			.join('\n')}`,
		name: 'events'
	};

	return [note];
};

const grantsOf = (catalog: Catalog) =>
	group(catalog.table_privileges ?? [], (row) =>
		keyOf(row.table_schema, row.table_name)
	);

const checksOf = (catalog: Catalog) => {
	/* CHECK_CONSTRAINTS names no table in MySQL; TABLE_CONSTRAINTS does. */
	const tableOfCheck = new Map(
		(catalog.table_constraints ?? [])
			.filter((row) => text(row.constraint_type) === 'CHECK')
			.map((row) => [
				keyOf(row.constraint_schema, row.constraint_name),
				keyOf(row.table_schema, row.table_name)
			])
	);

	return group(catalog.check_constraints ?? [], (row) =>
		text(row.table_name)
			? keyOf(row.constraint_schema, row.table_name)
			: (tableOfCheck.get(
					keyOf(row.constraint_schema, row.constraint_name)
				) ?? '')
	);
};

/* Generated NOT NULL checks MariaDB lists (`col IS NOT NULL` named after a
 * column) aren't the app's. */
const isOwnCheck = (row: Row) =>
	!/^`?\w+`? IS NOT NULL$/iu.test(text(row.check_clause) ?? '') ||
	text(row.level) !== 'Column';

const foreignKeys = (catalog: Catalog, tables: Map<string, DbmlTable>) => {
	const rules = new Map(
		(catalog.referential_constraints ?? []).map((row) => [
			keyOf(row.constraint_schema, row.constraint_name),
			row
		])
	);
	const usage = group(
		(catalog.key_column_usage ?? []).filter((row) =>
			text(row.referenced_table_name)
		),
		(row) =>
			`${keyOf(row.constraint_schema, row.table_name)}.${text(row.constraint_name)}`
	);

	return [...usage.values()].flatMap((rows) => {
		const sorted = [...rows].sort(
			(left, right) =>
				integer(left.ordinal_position) - integer(right.ordinal_position)
		);
		const [first] = sorted;
		if (!first) return [];
		const table = tables.get(keyOf(first.table_schema, first.table_name));
		const rule = rules.get(
			keyOf(first.constraint_schema, first.constraint_name)
		);
		const columns = sorted.map((row) => text(row.column_name) ?? '');
		const onDelete = actionOf(text(rule?.delete_rule));
		const onUpdate = actionOf(text(rule?.update_rule));
		const name = text(first.constraint_name) ?? '';
		const ref: DbmlRef = {
			from: {
				columns,
				schema: text(first.table_schema) ?? '',
				table: text(first.table_name) ?? ''
			},
			/* MySQL names an unnamed key table_ibfk_N; that says nothing. */
			...(/_ibfk_\d+$/u.test(name) ? {} : { name }),
			...(onDelete ? { onDelete } : {}),
			...(onUpdate ? { onUpdate } : {}),
			relation: table && isUniqueSet(table, columns) ? '-' : '>',
			to: {
				columns: sorted.map(
					(row) => text(row.referenced_column_name) ?? ''
				),
				schema: text(first.referenced_table_schema) ?? '',
				table: text(first.referenced_table_name) ?? ''
			}
		};

		return [ref];
	});
};

const viewDeps = (
	catalog: Catalog,
	views: DbmlTable[],
	tables: DbmlTable[]
) => {
	const usage = catalog.view_table_usage ?? [];
	if (usage.length > 0)
		return usage.map((row) => ({
			downstream: {
				schema: text(row.view_schema) ?? '',
				table: text(row.view_name) ?? ''
			},
			upstream: {
				schema: text(row.table_schema) ?? '',
				table: text(row.table_name) ?? ''
			}
		}));
	/* Without VIEW_TABLE_USAGE, the tables a view's query names. */
	const definitions = new Map(
		(catalog.views ?? []).map((row) => [
			keyOf(row.table_schema, row.table_name),
			text(row.view_definition) ?? ''
		])
	);

	return views.flatMap((view) => {
		const sql = definitions.get(keyOf(view.schema, view.name)) ?? '';

		return tables
			.filter((table) => sql.includes(`\`${table.name}\``))
			.map((table) => ({
				downstream: { schema: view.schema ?? '', table: view.name },
				upstream: { schema: table.schema ?? '', table: table.name }
			}));
	});
};

/** The database's structure as a DBML model. */
export const fromMysql = async (
	query: MysqlQuery,
	options: FromMysqlOptions = {}
) => {
	const [version] = await query('select version() as version', []);
	const mariadb = /mariadb/iu.test(text(version?.version) ?? '');
	const schemas = options.schemas ?? [
		text((await query('select database() as name', []))[0]?.name) ?? ''
	];
	const catalog = await readCatalog(query, schemas);
	const context: Context = {
		mariadb,
		statistics: options.statistics === true
	};
	const model: DbmlModel = emptyModel({
		databaseType: mariadb ? 'MariaDB' : 'MySQL',
		...options.project
	});
	const columns = group(catalog.columns ?? [], (row) =>
		keyOf(row.table_schema, row.table_name)
	);
	const indexes = group(
		catalog.statistics ?? [],
		(row) =>
			`${keyOf(row.table_schema, row.table_name)}.${text(row.index_name)}`
	);
	const checks = checksOf(catalog);
	const grants = grantsOf(catalog);
	const triggers = group(catalog.triggers ?? [], (row) =>
		keyOf(row.event_object_schema, row.event_object_table)
	);
	const partitions = group(catalog.partitions ?? [], (row) =>
		keyOf(row.table_schema, row.table_name)
	);
	const views = new Map(
		(catalog.views ?? []).map((row) => [
			keyOf(row.table_schema, row.table_name),
			row
		])
	);
	const tables = new Map<string, DbmlTable>();
	const enums: DbmlEnum[] = [];

	(catalog.tables ?? []).forEach((row) => {
		const schema = text(row.table_schema) ?? '';
		const name = text(row.table_name) ?? '';
		const key = keyOf(schema, name);
		const view = views.get(key);
		const built = (columns.get(key) ?? [])
			.sort(
				(left, right) =>
					integer(left.ordinal_position) -
					integer(right.ordinal_position)
			)
			.map((column) =>
				columnOf(
					{ ...column, table_collation: row.table_collation },
					{ name, schema },
					context
				)
			);
		enums.push(
			...built.flatMap((entry) =>
				entry.enumType ? [entry.enumType] : []
			)
		);
		const grantLine = (grants.get(key) ?? [])
			.map(
				(grant) =>
					`${text(grant.privilege_type)} to ${text(grant.grantee)}`
			)
			.join(', ');
		const metadata = view
			? {
					...(text(view.check_option) &&
					text(view.check_option) !== 'NONE'
						? { check_option: text(view.check_option) ?? '' }
						: {}),
					...(text(view.security_type)
						? { security: text(view.security_type) ?? '' }
						: {})
				}
			: tableMetadata(row, context, grantLine || undefined);
		const notes = [
			text(row.table_comment) && text(row.table_comment) !== 'VIEW'
				? text(row.table_comment)
				: undefined,
			view ? `View:\n${text(view.view_definition) ?? ''}` : undefined,
			...partitionLines(partitions.get(key) ?? []),
			...(triggers.get(key) ?? []).map(triggerLine)
		].filter((line) => line !== undefined && line !== '');
		const table: DbmlTable = {
			checks: (checks.get(key) ?? []).filter(isOwnCheck).map((check) => ({
				expression: (text(check.check_clause) ?? '').replace(
					/^\((.*)\)$/su,
					'$1'
				),
				name: text(check.constraint_name) ?? ''
			})),
			columns: built.map((entry) => entry.column),
			...(view ? { headerColor: VIEW_COLOR } : {}),
			indexes: [],
			...(Object.keys(metadata).length > 0 ? { metadata } : {}),
			name,
			...(notes.length > 0 ? { note: notes.join('\n') } : {}),
			schema
		};
		[...indexes.entries()]
			.filter(([indexKey]) => indexKey.startsWith(`${key}.`))
			.forEach(([, rows]) => placeIndex(table, indexOf(rows)));
		tables.set(key, table);
	});

	model.enums.push(...enums);
	model.tables.push(...tables.values());
	model.refs.push(...foreignKeys(catalog, tables));
	model.deps.push(
		...viewDeps(
			catalog,
			model.tables.filter((table) => table.headerColor),
			model.tables.filter((table) => !table.headerColor)
		)
	);
	model.notes.push(...routineNote(catalog), ...eventNote(catalog));
	const defaultSchema = options.defaultSchema ?? schemas[0] ?? '';
	const result = withDefaultSchema(model, defaultSchema);
	if (options.groups === 'schema')
		result.tableGroups.push(...groupBySchema(result.tables, defaultSchema));

	return result;
};
