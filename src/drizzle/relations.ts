import {
	type Column,
	getColumnTable,
	is,
	Many,
	One,
	type Relation
} from 'drizzle-orm';
import {
	createTableRelationsHelpers,
	One as OneV1,
	Relations
} from 'drizzle-orm/_relations';
import type { DbmlEndpoint, DbmlRef } from '../model';

/*
 * Drizzle's relations as refs. A foreign key is a ref already; a relation
 * over the same columns only names it (its note says which fields the app
 * reads it through). A relation with no foreign key under it is a link the
 * app relies on that the database doesn't enforce, which is exactly what
 * DBML's `inactive` ref means. A many-to-many relation through a junction
 * table is a `<>` ref between the two ends.
 *
 * Both of Drizzle's styles are read: `defineRelations` (1.0) and the
 * older `relations()` per table, which 1.0 still ships.
 */

/** Where a table object sits: its schema and name, as the model has them. */
export type TableLookup = (
	table: object
) => { schema?: string; table: string } | undefined;

/** A relation as both styles reduce to it. */
export type RelationLink = {
	field: string;
	from: readonly Column[];
	kind: 'many-through' | 'one';
	owner: object;
	through?: object;
	target: readonly Column[];
	/* A filter the relation reads rows through (Drizzle 1.0's `where`). */
	where?: unknown;
};

type RelationsV2 = Record<string, { relations: Record<string, Relation> }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

const isTableRelations = (
	entry: unknown
): entry is { relations: Record<string, Relation> } =>
	isRecord(entry) && isRecord(entry.relations) && 'table' in entry;

/** Whether a value is what `defineRelations` returns. */
export const isRelationsV2 = (value: unknown): value is RelationsV2 =>
	isRecord(value) &&
	!is(value, Relations) &&
	Object.keys(value).length > 0 &&
	Object.values(value).every(isTableRelations);

const throughOf = (relation: Relation) =>
	'throughTable' in relation && isRecord(relation.throughTable)
		? relation.throughTable
		: undefined;

const filterOf = (relation: Relation) =>
	'where' in relation && relation.where !== undefined
		? { where: relation.where }
		: {};

/* A many declared with its own from and to (not the mirror of a one):
 * the link runs from the many side's key to the one side, as a foreign
 * key would. */
const declaredMany = (field: string, relation: Relation) => {
	if ('isReversed' in relation && relation.isReversed === true)
		return undefined;
	const link: RelationLink = {
		field,
		from: relation.targetColumns,
		kind: 'one',
		owner: relation.sourceTable,
		target: relation.sourceColumns,
		...filterOf(relation)
	};

	return link;
};

const v2Link = (field: string, relation: Relation) => {
	const from = relation.sourceColumns;
	const target = relation.targetColumns;
	if (from.length === 0 || target.length === 0) return undefined;
	const owner = relation.sourceTable;
	if (is(relation, One)) {
		const link: RelationLink = {
			field,
			from,
			kind: 'one',
			owner,
			target,
			...filterOf(relation)
		};

		return link;
	}
	const through = throughOf(relation);
	if (is(relation, Many) && !through) return declaredMany(field, relation);
	if (!is(relation, Many) || !through) return undefined;
	/* A plain many is the other side of a one, which carries the link; one
	 * through a junction table is a many-to-many of its own. */
	const link: RelationLink = {
		field,
		from,
		kind: 'many-through',
		owner,
		target,
		through
	};

	return link;
};

export const linksFromV2 = (relations: RelationsV2) =>
	Object.values(relations).flatMap((config) =>
		Object.entries(config.relations)
			.map(([field, relation]) => v2Link(field, relation))
			.filter((link): link is RelationLink => link !== undefined)
	);

/** Whether a schema export is an older `relations(table, ...)` value. */
export const isRelationsV1 = (value: unknown): value is Relations =>
	is(value, Relations);

/* Only one() with fields and references says which columns link; a
 * many() is the other side of one, which says it. */
export const linksFromV1 = (relations: Relations) =>
	Object.entries(
		relations.config(createTableRelationsHelpers(relations.table))
	)
		.map(([field, relation]) => {
			if (!is(relation, OneV1)) return undefined;
			const from = relation.config?.fields ?? [];
			const target = relation.config?.references ?? [];
			if (from.length === 0 || target.length === 0) return undefined;
			const link: RelationLink = {
				field,
				from,
				kind: 'one',
				owner: relations.table,
				target
			};

			return link;
		})
		.filter((link): link is RelationLink => link !== undefined);

const endpointOf = (lookup: TableLookup, columns: readonly Column[]) => {
	const [first] = columns;
	if (!first) return undefined;
	const place = lookup(getColumnTable(first));
	if (!place) return undefined;
	const endpoint: DbmlEndpoint = {
		...place,
		columns: columns.map((column) => column.name)
	};

	return endpoint;
};

const side = (end: DbmlEndpoint) =>
	`${end.schema ?? ''}.${end.table}(${end.columns.join(',')})`;

/** A ref's identity whichever way round it was written. */
export const refKey = (ref: Pick<DbmlRef, 'from' | 'to'>) =>
	[side(ref.from), side(ref.to)].sort().join('|');

type Applying = {
	isUnique: (end: DbmlEndpoint) => boolean;
	links: RelationLink[];
	lookup: TableLookup;
	refs: DbmlRef[];
};

const newRef = (
	link: RelationLink,
	ends: { from: DbmlEndpoint; to: DbmlEndpoint },
	field: string,
	options: Applying
) => {
	if (link.kind === 'many-through') {
		const through = link.through ? options.lookup(link.through) : undefined;
		const ref: DbmlRef = {
			...ends,
			inactive: true,
			note: `Many-to-many through ${through?.table ?? 'a junction table'}, read as ${field}`,
			relation: '<>'
		};

		return ref;
	}
	const ref: DbmlRef = {
		...ends,
		inactive: true,
		note: `Not a foreign key: the app's relation ${field}`,
		relation: options.isUnique(ends.from) ? '-' : '>'
	};

	return ref;
};

/**
 * Adds relations to the refs the foreign keys made: names the ones they
 * match, and adds the rest as inactive refs (or `<>` for many-to-many).
 */
export const applyRelations = (options: Applying) => {
	const byKey = new Map(options.refs.map((ref) => [refKey(ref), ref]));
	const named = new Map<DbmlRef, string[]>();
	for (const link of options.links) {
		const from = endpointOf(options.lookup, link.from);
		const target = endpointOf(options.lookup, link.target);
		if (!from || !target) continue;
		const filter =
			link.where === undefined
				? ''
				: ` where ${JSON.stringify(link.where)}`;
		const field = `${options.lookup(link.owner)?.table ?? from.table}.${link.field}${filter}`;
		const key = refKey({ from, to: target });
		const existing = byKey.get(key);
		if (existing)
			named.set(existing, [...(named.get(existing) ?? []), field]);
		if (existing) continue;
		const ref = newRef(link, { from, to: target }, field, options);
		byKey.set(key, ref);
		options.refs.push(ref);
	}
	named.forEach((fields, ref) => {
		const line = `Read in the app as ${[...new Set(fields)].join(', ')}`;
		ref.note = ref.note ? `${ref.note}\n${line}` : line;
	});
};
