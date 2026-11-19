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

export type DbmlTable = {
	alias?: string;
	checks: DbmlCheck[];
	columns: DbmlColumn[];
	headerColor?: DbmlColor;
	indexes: DbmlIndex[];
	metadata?: DbmlMetadata;
	name: string;
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
