/*
 * A database's structure as DBML can say it, as data.
 *
 * Both front ends (a Drizzle schema, a live Postgres database) produce this
 * one model, and the printer turns it into DBML text; anything that draws a
 * diagram can read the model directly instead of parsing the text back.
 * Names are as the database knows them (`created_at`, not `createdAt`).
 */

/** The database the model describes, DBML's `Project`. */
export type DbmlProject = {
	/** As DBML spells it: `PostgreSQL`, `MySQL`, `SQLite`... */
	databaseType?: string;
	name?: string;
	note?: string;
};

/** A table, a column list or a whole table group's colour, as `#rgb` or
 *  `#rrggbb`. */
export type DbmlColor = `#${string}`;

export type DbmlEnumValue = { name: string; note?: string };

export type DbmlEnum = {
	name: string;
	schema?: string;
	values: DbmlEnumValue[];
};

/** A column's default as written in the database. A function or any SQL
 *  is an expression; the rest are literals. */
export type DbmlDefault =
	| { kind: 'boolean'; value: boolean }
	| { kind: 'expression'; value: string }
	| { kind: 'null' }
	| { kind: 'number'; value: number | string }
	| { kind: 'string'; value: string };

/** Facts about a table or column as key and value, DBML's `Metadata`:
 *  an owner, a row count, a collation. Keys are bare words. */
export type DbmlMetadata = Record<string, boolean | number | string>;

export type DbmlColumn = {
	/** Column-level checks, each a SQL expression. */
	checks?: string[];
	default?: DbmlDefault;
	/** An identity, serial or auto-increment column. */
	increment?: boolean;
	metadata?: DbmlMetadata;
	name: string;
	note?: string;
	notNull?: boolean;
	pk?: boolean;
	/** The type as the database names it (`varchar(255)`, `text[]`), or an
	 *  enum's name. */
	type: string;
	/** The schema of an enum type that lives outside the default one. */
	typeSchema?: string;
	unique?: boolean;
};

export type DbmlIndexPart =
	| { column: string; desc?: boolean; kind: 'column' }
	| { desc?: boolean; expression: string; kind: 'expression' };

export type DbmlIndex = {
	name?: string;
	note?: string;
	parts: DbmlIndexPart[];
	/** A primary key over these parts (how DBML writes a composite one). */
	pk?: boolean;
	/** The access method: `btree`, `hash`, `gin`, `gist`... */
	type?: string;
	unique?: boolean;
};

export type DbmlCheck = { expression: string; name?: string };

/**
 * What a table is and does beyond its columns, as data: what kind of
 * relation it is (with a view's query), how it's partitioned and into
 * what, what it inherits from, its triggers and rules, and row-level
 * security with its policies. DBML has no syntax for these, so the printer
 * writes each as a line of the table's note (see `detailLine`); a diagram
 * can read them here instead of parsing the note.
 */
export type DbmlTableDetail =
	| { kind: 'foreign_table' | 'partitioned_table' }
	| {
			/* Already in the database, its query not known here. */
			existing?: boolean;
			kind: 'materialized_view' | 'view';
			/* Its query. */
			text?: string;
	  }
	| { kind: 'inherits' | 'partitioned_by'; text: string }
	| { kind: 'partition'; name: string; text?: string }
	| {
			disabled?: boolean;
			kind: 'rule' | 'trigger';
			name: string;
			text: string;
	  }
	| { kind: 'policy'; name: string; text: string }
	| { forced?: boolean; kind: 'row_security' };

export type DbmlTable = {
	alias?: string;
	checks: DbmlCheck[];
	columns: DbmlColumn[];
	details?: DbmlTableDetail[];
	headerColor?: DbmlColor;
	indexes: DbmlIndex[];
	metadata?: DbmlMetadata;
	name: string;
	/** The table's own note (its comment); its details print after it. */
	note?: string;
	schema?: string;
};

export type DbmlEndpoint = {
	columns: string[];
	schema?: string;
	table: string;
};

/**
 * How many rows on each side: `>` many-to-one (from many to one), `<`
 * one-to-many, `-` one-to-one, `<>` many-to-many.
 */
export type DbmlRelation = '-' | '<' | '<>' | '>';

export type DbmlReferentialAction =
	| 'cascade'
	| 'no action'
	| 'restrict'
	| 'set default'
	| 'set null';

export type DbmlRef = {
	color?: DbmlColor;
	from: DbmlEndpoint;
	/** A link the app relies on that no foreign key enforces. */
	inactive?: boolean;
	name?: string;
	note?: string;
	onDelete?: DbmlReferentialAction;
	onUpdate?: DbmlReferentialAction;
	relation: DbmlRelation;
	to: DbmlEndpoint;
};

/** Lineage: `downstream` is made from `upstream` (a view from its tables). */
export type DbmlDep = {
	downstream: { columns?: string[]; schema?: string; table: string };
	note?: string;
	upstream: { columns?: string[]; schema?: string; table: string };
};

export type DbmlTableGroup = {
	color?: DbmlColor;
	name: string;
	note?: string;
	tables: { schema?: string; table: string }[];
};

export type DbmlStickyNote = {
	color?: DbmlColor;
	content: string;
	name: string;
};

/** A value in a `Records` block: text, a number, true or false, or null. */
export type DbmlRecordValue = boolean | number | string | null;

/** Rows of a table, DBML's `Records`: sample data shown with the table. */
export type DbmlRecords = {
	columns: string[];
	rows: DbmlRecordValue[][];
	schema?: string;
	table: string;
};

export type DbmlModel = {
	deps: DbmlDep[];
	enums: DbmlEnum[];
	notes: DbmlStickyNote[];
	project?: DbmlProject;
	records: DbmlRecords[];
	refs: DbmlRef[];
	tableGroups: DbmlTableGroup[];
	tables: DbmlTable[];
};

/** A model with nothing in it, to build on. */
export const emptyModel = (project?: DbmlProject): DbmlModel => ({
	deps: [],
	enums: [],
	notes: [],
	...(project ? { project } : {}),
	records: [],
	refs: [],
	tableGroups: [],
	tables: []
});

type Placed = { schema?: string };

/* A place without its schema when that schema is the default one. */
const unqualified = <Place extends Placed>(place: Place, schema: string) => {
	if (place.schema !== schema) return place;
	const { schema: dropped, ...rest } = place;
	void dropped;

	return rest;
};

/**
 * The model as read from inside one schema: everything in `schema` loses
 * its qualifier (`"orders"`, not `"app"."orders"`), the way a query run
 * there would name it, and everything elsewhere keeps its own.
 */
export const withDefaultSchema = (model: DbmlModel, schema: string) => {
	const result: DbmlModel = {
		...model,
		deps: model.deps.map((dep) => ({
			...dep,
			downstream: unqualified(dep.downstream, schema),
			upstream: unqualified(dep.upstream, schema)
		})),
		enums: model.enums.map((entry) => unqualified(entry, schema)),
		records: model.records.map((records) => unqualified(records, schema)),
		refs: model.refs.map((ref) => ({
			...ref,
			from: unqualified(ref.from, schema),
			to: unqualified(ref.to, schema)
		})),
		tableGroups: model.tableGroups.map((group) => ({
			...group,
			tables: group.tables.map((entry) => unqualified(entry, schema))
		})),
		tables: model.tables.map((table) => ({
			...unqualified(table, schema),
			columns: table.columns.map((column) => {
				if (column.typeSchema !== schema) return column;
				const { typeSchema: dropped, ...rest } = column;
				void dropped;

				return rest;
			})
		}))
	};

	return result;
};

/** Table groups, one per schema, in the order tables first appear. */
export const groupBySchema = (
	tables: DbmlTable[],
	defaultSchema = 'public'
) => {
	const byName = new Map<string, DbmlTableGroup['tables']>();
	tables.forEach((table) => {
		const name = table.schema ?? defaultSchema;
		byName.set(name, [
			...(byName.get(name) ?? []),
			{
				...(table.schema ? { schema: table.schema } : {}),
				table: table.name
			}
		]);
	});

	return [...byName].map(([name, members]) => {
		const group: DbmlTableGroup = { name, tables: members };

		return group;
	});
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

/** Whether these columns alone are unique in the table: a one-to-one link
 *  rather than many-to-one when they're what a foreign key holds. */
export const isUniqueSet = (table: DbmlTable, columns: string[]) => {
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

const VIEW_LABEL: Record<'materialized_view' | 'view', string> = {
	materialized_view: 'Materialized view',
	view: 'View'
};

/** A table detail as the line of its note DBML carries it in. */
export const detailLine = (detail: DbmlTableDetail) => {
	switch (detail.kind) {
		case 'foreign_table':
			return 'Foreign table';
		case 'partitioned_table':
			return 'Partitioned table';
		case 'materialized_view':
		case 'view': {
			const label = VIEW_LABEL[detail.kind];
			if (detail.existing)
				return `${label} that already exists in the database; its query lives there`;

			return detail.text ? `${label}:\n${detail.text}` : label;
		}
		case 'inherits':
			return `Inherits from ${detail.text}`;
		case 'partitioned_by':
			return `Partitioned by ${detail.text}`;
		case 'partition':
			return `Partition ${detail.name}${detail.text ? `: ${detail.text}` : ''}`;
		case 'rule':
		case 'trigger':
			return `${detail.kind === 'rule' ? 'Rule' : 'Trigger'} ${detail.name}: ${detail.text}${detail.disabled ? ' (disabled)' : ''}`;
		case 'policy':
			return `Policy ${detail.name} ${detail.text}`;
		case 'row_security':
			return `Row-level security is on${detail.forced ? ', for the owner too' : ''}`;
		default:
			return '';
	}
};

/** The note a table prints with: its own note, then a line per detail. */
export const tableNoteOf = (table: Pick<DbmlTable, 'details' | 'note'>) => {
	const lines = [table.note, ...(table.details ?? []).map(detailLine)].filter(
		(line): line is string => line !== undefined && line !== ''
	);

	return lines.length > 0 ? lines.join('\n') : undefined;
};

/** A detail when its condition holds, none otherwise: for building a
 *  table's details in order. */
export const detailWhen = (condition: unknown, detail: DbmlTableDetail) =>
	condition ? [detail] : [];

const PREFIX_GROUP_MIN = 3;
/* A group holding more of the tables than this is split further. */
const PREFIX_GROUP_SHARE = 0.4;

/* A name's words: `commerce_inventory_levels` and
 * `commerceInventoryLevels` are both commerce, inventory, levels. */
const wordsOf = (name: string) =>
	name
		.replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
		.toLowerCase()
		.split(/[_-]+/u)
		.filter((word) => word !== '');

/* The first `depth` words of a name, when it has more than that. */
const prefixAt = (name: string, depth: number) => {
	const words = wordsOf(name);

	return words.length > depth ? words.slice(0, depth).join('_') : undefined;
};

type Grouping = { minimum: number; share: number; total: number };

const groupOf = (name: string, members: DbmlTable[]) => {
	const group: DbmlTableGroup = {
		name,
		tables: members.map((table) => ({
			...(table.schema ? { schema: table.schema } : {}),
			table: table.name
		}))
	};

	return group;
};

/* Groups the tables by their first `depth` words; a group too big to
 * help (more than `share` of every table) is split by the next word, and
 * what fits no smaller group stays in it. */
const groupsAt: (
	tables: DbmlTable[],
	depth: number,
	grouping: Grouping
) => DbmlTableGroup[] = (tables, depth, grouping) => {
	const byPrefix = new Map<string, DbmlTable[]>();
	tables.forEach((table) => {
		const prefix = prefixAt(table.name, depth);
		if (!prefix) return;
		const key = `${table.schema ?? ''}.${prefix}`;
		byPrefix.set(key, [...(byPrefix.get(key) ?? []), table]);
	});
	/* A table named just the prefix (`commerce`) belongs with it. */
	tables.forEach((table) => {
		const key = `${table.schema ?? ''}.${wordsOf(table.name).join('_')}`;
		const members = byPrefix.get(key);
		if (members && !members.includes(table)) members.unshift(table);
	});

	return [...byPrefix]
		.filter(([, members]) => members.length >= grouping.minimum)
		.flatMap(([key, members]) => {
			const name = key.slice(key.indexOf('.') + 1);
			const tooBig =
				members.length > grouping.total * grouping.share &&
				members.length >= grouping.minimum * 2;
			if (!tooBig) return [groupOf(name, members)];
			const smaller = groupsAt(members, depth + 1, grouping);
			if (smaller.length === 0) return [groupOf(name, members)];
			const placed = new Set(
				smaller.flatMap((group) =>
					group.tables.map((member) => member.table)
				)
			);
			const rest = members.filter((table) => !placed.has(table.name));

			return [
				...smaller,
				...(rest.length > 0 ? [groupOf(name, rest)] : [])
			];
		});
};

/** Table groups for tables that share a name prefix, the way an app names
 *  its modules (`commerce_orders`, `commerce_carts`, ...). A prefix needs
 *  `minimum` tables (three by default) to make a group; a table whose
 *  whole name is a group's prefix joins it. A group holding more than 40%
 *  of the tables is split by the next word (`commerce_inventory`,
 *  `commerce_purchase`), what fits no smaller group staying in it. Within a
 *  schema only. */
export const groupByPrefix = (
	tables: DbmlTable[],
	minimum = PREFIX_GROUP_MIN
) =>
	groupsAt(tables, 1, {
		minimum,
		share: PREFIX_GROUP_SHARE,
		total: tables.length
	});

/** A link an app declares, in database names (see
 *  `appRelationsFromSource`). */
export type DbmlAppLink = {
	field: string;
	/** Declared as a foreign key (`.references()`), not only a relation. */
	foreignKey?: boolean;
	from: DbmlEndpoint;
	to: DbmlEndpoint;
	where?: string;
};

/* The model's table an app's endpoint names: by name, then by schema when
 * two schemas share it. */
const tableFor = (tables: DbmlTable[], end: DbmlEndpoint) => {
	const named = tables.filter((table) => table.name === end.table);
	if (named.length <= 1) return named[0];

	return named.find(
		(table) => (table.schema ?? 'public') === (end.schema ?? 'public')
	);
};

const endKey = (end: DbmlEndpoint) =>
	`${end.schema ?? ''}.${end.table}(${end.columns.join(',')})`;

/** The live model with the links its app declares: a link a foreign key
 *  already makes gains how the app reads it; one no foreign key enforces
 *  is added as an inactive ref, drawn dashed. A link to a table or column
 *  the database doesn't have (code ahead of or behind it) is left out. */
export const withAppRelations = (model: DbmlModel, links: DbmlAppLink[]) => {
	const refs = model.refs.map((ref) => ({ ...ref }));
	const byKey = new Map<
		string,
		{ fields: string[]; link: DbmlAppLink; ref?: DbmlRef }
	>();
	links.forEach((link) => {
		const holder = tableFor(model.tables, link.from);
		const target = tableFor(model.tables, link.to);
		const has = (table: DbmlTable | undefined, columns: string[]) =>
			table !== undefined &&
			columns.every((column) =>
				table.columns.some((entry) => entry.name === column)
			);
		if (
			!holder ||
			!target ||
			!has(holder, link.from.columns) ||
			!has(target, link.to.columns)
		)
			return;
		const from: DbmlEndpoint = {
			columns: link.from.columns,
			...(holder.schema ? { schema: holder.schema } : {}),
			table: holder.name
		};
		const into: DbmlEndpoint = {
			columns: link.to.columns,
			...(target.schema ? { schema: target.schema } : {}),
			table: target.name
		};
		const key = `${endKey(from)}>${endKey(into)}`;
		const field = link.where
			? `${link.field} where ${link.where}`
			: link.field;
		const known = byKey.get(key);
		if (known) {
			if (!known.fields.includes(field)) known.fields.push(field);
			if (link.foreignKey) known.link.foreignKey = true;

			return;
		}
		const ref = refs.find(
			(entry) =>
				(endKey(entry.from) === endKey(from) &&
					endKey(entry.to) === endKey(into)) ||
				(endKey(entry.from) === endKey(into) &&
					endKey(entry.to) === endKey(from))
		);
		byKey.set(key, {
			fields: [field],
			link: { ...link, from, to: into },
			...(ref ? { ref } : {})
		});
	});
	byKey.forEach(({ fields, link, ref }) => {
		const reading = `Read in the app as ${fields.join(', ')}`;
		if (ref) {
			ref.note = ref.note ? `${ref.note}\n${reading}` : reading;

			return;
		}
		const holder = tableFor(model.tables, link.from);
		refs.push({
			from: link.from,
			inactive: true,
			/* A key the code declares and the database lacks means its
			 * migrations are behind; say so rather than call it a relation. */
			note: link.foreignKey
				? `The app declares this foreign key (${fields.join(', ')}); the database doesn't have it`
				: `Not a foreign key: the app's relation ${fields.join(', ')}`,
			relation:
				holder && isUniqueSet(holder, link.from.columns) ? '-' : '>',
			to: link.to
		});
	});
	const result: DbmlModel = { ...model, refs };

	return result;
};
