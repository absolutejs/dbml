import { is } from 'drizzle-orm';
import * as cockroach from 'drizzle-orm/cockroach-core';
import * as pg from 'drizzle-orm/pg-core';
import {
	type DbmlEnum,
	type DbmlModel,
	type DbmlRef,
	type DbmlReferentialAction,
	type DbmlTable,
	type DbmlTableGroup,
	emptyModel
} from '../model';
import {
	DIALECTS,
	type EnumConfig,
	type SequenceConfig,
	type TableConfig,
	type ViewConfig
} from './dialects';
import {
	applyRelations,
	isRelationsV1,
	isRelationsV2,
	linksFromV1,
	linksFromV2,
	type RelationLink
} from './relations';
import { isUniqueSet, tableOf } from './tables';
import { sourcesOf, viewOf } from './views';

/*
 * A Drizzle schema as a DBML model: every table, view, enum, key, index,
 * check and relation the schema declares, in any of Drizzle's dialects.
 * Hand it the schema module's exports (`import * as schema`), and the
 * `defineRelations` result if it isn't among them.
 */

type TablePlace = { name: string; schema?: string };

export type FromDrizzleOptions = {
	/**
	 * Table groups: `'schema'` groups tables by their schema, or a function
	 * names the group a table belongs in (undefined for none).
	 */
	groups?: 'schema' | ((table: TablePlace) => string | undefined);
	project?: { name?: string; note?: string };
	/** The `defineRelations(...)` result, when it isn't one of the exports. */
	relations?: unknown;
};

type Place = { schema?: string; table: string };

type FoundTable = { config: TableConfig; databaseType: string; object: object };

type FoundView = { config: ViewConfig; materialized: boolean; object: object };

type Found = {
	enums: EnumConfig[];
	links: RelationLink[];
	roles: string[];
	sequences: SequenceConfig[];
	tables: FoundTable[];
	views: FoundView[];
};

const isRole = (value: unknown): value is { name: string } =>
	is(value, pg.PgRole) || is(value, cockroach.CockroachRole);

const isObject = (value: unknown): value is object =>
	typeof value === 'object' && value !== null;

/* What one export is, asked of each dialect in turn; true once it's
 * placed. */
const classifyInDialects = (value: unknown, found: Found) =>
	DIALECTS.some((dialect) => {
		const table = dialect.tableOf(value);
		if (table && isObject(value))
			found.tables.push({
				config: table,
				databaseType: dialect.databaseType,
				object: value
			});
		const enumConfig = dialect.enumOf(value);
		if (enumConfig) found.enums.push(enumConfig);
		const materialized = dialect.materializedViewOf(value);
		const view = materialized ?? dialect.viewOf(value);
		if (view && isObject(value))
			found.views.push({
				config: view,
				materialized: materialized !== undefined,
				object: value
			});
		const sequence = dialect.sequenceOf(value);
		if (sequence) found.sequences.push(sequence);

		return (table ?? enumConfig ?? view ?? sequence) !== undefined;
	});

const classify = (value: unknown, found: Found) => {
	if (isRelationsV2(value)) found.links.push(...linksFromV2(value));
	else if (isRelationsV1(value)) found.links.push(...linksFromV1(value));
	else if (isRole(value)) found.roles.push(value.name);
	else classifyInDialects(value, found);
};

const placeOf = (schema: string | undefined, table: string) => {
	const place: Place = { ...(schema ? { schema } : {}), table };

	return place;
};

const keyOf = (entry: { name: string; schema?: string | undefined }) =>
	`${entry.schema ?? ''}.${entry.name}`;

const ACTIONS: Record<string, DbmlReferentialAction | undefined> = {
	cascade: 'cascade',
	/* "No action" is what a foreign key does unless told otherwise, and
	 * Drizzle fills it in; written out on every ref it says nothing. */
	'no action': undefined,
	restrict: 'restrict',
	'set default': 'set default',
	'set null': 'set null'
};

const actionOf = (action: string | undefined) =>
	action === undefined ? undefined : ACTIONS[action.toLowerCase()];

type Lookup = (table: object) => Place | undefined;

const foreignKeyRefs = (
	entry: FoundTable,
	lookup: Lookup,
	tables: Map<string, DbmlTable>
) =>
	entry.config.foreignKeys.flatMap((key) => {
		const reference = key.reference();
		const target = lookup(reference.foreignTable);
		if (!target) return [];
		const from = placeOf(entry.config.schema, entry.config.name);
		const columns = reference.columns.map((column) => column.name);
		const table = tables.get(
			keyOf({ name: from.table, schema: from.schema })
		);
		const onDelete = actionOf(key.onDelete);
		const onUpdate = actionOf(key.onUpdate);
		const ref: DbmlRef = {
			from: { ...from, columns },
			...(reference.name ? { name: reference.name } : {}),
			...(onDelete ? { onDelete } : {}),
			...(onUpdate ? { onUpdate } : {}),
			relation: table && isUniqueSet(table, columns) ? '-' : '>',
			to: {
				...target,
				columns: reference.foreignColumns.map((column) => column.name)
			}
		};

		return [ref];
	});

const sequenceLine = (sequence: SequenceConfig) => {
	const options = Object.entries(sequence.seqOptions ?? {})
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key} ${value}`);
	const name = `${sequence.schema ? `${sequence.schema}.` : ''}${sequence.seqName ?? 'sequence'}`;

	return options.length > 0 ? `${name}: ${options.join(', ')}` : name;
};

const groupNamer = (groups: NonNullable<FromDrizzleOptions['groups']>) => {
	if (groups === 'schema')
		return (table: DbmlTable) => table.schema ?? 'public';

	return (table: DbmlTable) =>
		groups({
			name: table.name,
			...(table.schema ? { schema: table.schema } : {})
		});
};

const groupsOf = (
	tables: DbmlTable[],
	groups: NonNullable<FromDrizzleOptions['groups']>
) => {
	const nameOf = groupNamer(groups);
	const byName = new Map<string, Place[]>();
	tables.forEach((table) => {
		const name = nameOf(table);
		if (name !== undefined)
			byName.set(name, [
				...(byName.get(name) ?? []),
				placeOf(table.schema, table.name)
			]);
	});

	return [...byName].map(([name, members]) => {
		const group: DbmlTableGroup = { name, tables: members };

		return group;
	});
};

const enumOf = (config: EnumConfig) => {
	const entry: DbmlEnum = {
		name: config.enumName,
		...(config.schema ? { schema: config.schema } : {}),
		values: config.enumValues.map((name) => ({ name }))
	};

	return entry;
};

const viewSources = (view: FoundView, lookup: Lookup) =>
	[
		...sourcesOf([
			view.config.query,
			Object.values(view.config.selectedFields)
		])
	].filter(
		(source) => source !== view.object && lookup(source) !== undefined
	);

const addViews = (
	model: DbmlModel,
	found: Found,
	lookup: Lookup,
	columnsOf: (table: object) => string[]
) =>
	found.views.forEach((view) => {
		const downstream = placeOf(view.config.schema, view.config.name);
		const sources = viewSources(view, lookup);
		model.tables.push(
			viewOf(
				view.config,
				view.materialized,
				sources.map((source) => ({
					columns: columnsOf(source),
					table: lookup(source)?.table ?? ''
				}))
			)
		);
		sources.forEach((source) => {
			const upstream = lookup(source);
			if (upstream) model.deps.push({ downstream, upstream });
		});
	});

const addNotes = (model: DbmlModel, found: Found) => {
	if (found.sequences.length > 0)
		model.notes.push({
			content: `Sequences\n${found.sequences.map(sequenceLine).join('\n')}`,
			name: 'sequences'
		});
	if (found.roles.length > 0)
		model.notes.push({
			content: `Roles\n${found.roles.join('\n')}`,
			name: 'roles'
		});
};

const collect = (
	schema: Record<string, unknown> | unknown[],
	relations: unknown
) => {
	const found: Found = {
		enums: [],
		links: [],
		roles: [],
		sequences: [],
		tables: [],
		views: []
	};
	const values = new Set(
		Array.isArray(schema) ? schema : Object.values(schema)
	);
	if (relations !== undefined) values.add(relations);
	values.forEach((value) => classify(value, found));

	return found;
};

/** The schema's exports as a DBML model. */
export const fromDrizzle = (
	schema: Record<string, unknown> | unknown[],
	options: FromDrizzleOptions = {}
) => {
	const found = collect(schema, options.relations);
	const places = new Map<object, Place>();
	[...found.tables, ...found.views].forEach((entry) =>
		places.set(
			entry.object,
			placeOf(entry.config.schema, entry.config.name)
		)
	);
	const lookup: Lookup = (table) => places.get(table);

	const enums = new Map(
		found.enums.map((entry) => [
			keyOf({ name: entry.enumName, schema: entry.schema }),
			enumOf(entry)
		])
	);
	const built = found.tables.map((entry) => tableOf(entry.config));
	built
		.flatMap((result) => result.enums)
		.forEach((entry) => {
			if (!enums.has(keyOf(entry))) enums.set(keyOf(entry), entry);
		});
	const tables = built.map((result) => result.table);
	const byPlace = new Map(tables.map((table) => [keyOf(table), table]));
	const byObject = new Map(
		found.tables.map((entry, index) => [entry.object, tables[index]])
	);
	const types = new Set(found.tables.map((entry) => entry.databaseType));
	const [databaseType] = types;

	const model = emptyModel({
		...options.project,
		...(types.size === 1 && databaseType ? { databaseType } : {})
	});
	model.enums.push(...enums.values());
	model.tables.push(...tables);
	model.refs.push(
		...found.tables.flatMap((entry) =>
			foreignKeyRefs(entry, lookup, byPlace)
		)
	);
	applyRelations({
		links: found.links,
		lookup,
		refs: model.refs,
		isUnique: (end) => {
			const table = byPlace.get(
				keyOf({ name: end.table, schema: end.schema })
			);

			return table ? isUniqueSet(table, end.columns) : false;
		}
	});
	addViews(
		model,
		found,
		lookup,
		(table) =>
			byObject.get(table)?.columns.map((column) => column.name) ?? []
	);
	addNotes(model, found);
	if (options.groups)
		model.tableGroups.push(...groupsOf(model.tables, options.groups));

	return model;
};
