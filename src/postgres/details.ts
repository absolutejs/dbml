import {
	type DbmlMetadata,
	type DbmlStickyNote,
	type DbmlTableDetail,
	detailWhen
} from '../model';
import type {
	ColumnRow,
	compositeRow,
	definitionRow,
	domainRow,
	eventTriggerRow,
	extensionRow,
	functionRow,
	IndexRow,
	partitionRow,
	RelationRow
} from './rows';

/*
 * What a Postgres database holds beyond tables, keys and indexes, put
 * where DBML can carry it: facts as metadata (an owner, grants, a
 * collation), what a table does as lines of its note (triggers, rules,
 * partitions, inheritance), and what stands apart (functions, domains,
 * extensions) as sticky notes.
 */

type Definition = ReturnType<typeof definitionRow>;

const present = (lines: (string | undefined)[]) =>
	lines.filter((line): line is string => line !== undefined && line !== '');

const withMetadata = (metadata: DbmlMetadata) =>
	Object.keys(metadata).length > 0 ? { metadata } : {};

const DEFAULT_IDENTITY = '1 1';

/** A column's facts: its collation, compression, the domain it's of, and
 *  its identity sequence when it doesn't start at one and count by one. */
export const columnMetadata = (row: ColumnRow) => {
	const [start, increment] = (row.identitySequence ?? '').split(' ');
	const identity: DbmlMetadata =
		row.identitySequence && row.identitySequence !== DEFAULT_IDENTITY
			? {
					identity_increment: Number.parseInt(increment ?? '1', 10),
					identity_start: Number.parseInt(start ?? '1', 10)
				}
			: {};
	const metadata: DbmlMetadata = {
		...(row.collation ? { collation: row.collation } : {}),
		...(row.compression ? { compression: row.compression } : {}),
		...(row.domainBase ? { domain_of: row.domainBase } : {}),
		...identity
	};

	return withMetadata(metadata);
};

/* Postgres sorts nulls last going up and first going down; only the
 * opposite is worth saying. */
const nullsOrdering = (row: IndexRow, part: number, name: string) => {
	const descending = row.descending[part] === true;
	const nullsFirst = row.nullsFirst[part] === true;
	if (descending === nullsFirst) return undefined;

	return `${name} nulls ${nullsFirst ? 'first' : 'last'}`;
};

/** What an index's parts do that DBML has no setting for: nulls ordering,
 *  an operator class or collation that isn't the column's own, and
 *  unique with nulls equal. */
export const indexNotes = (
	row: IndexRow,
	partName: (part: number) => string
) => {
	const parts = Array.from({ length: row.keyCount }, (_, part) => part);
	const nulls = present(
		parts.map((part) => nullsOrdering(row, part, partName(part)))
	);
	const classes = present(
		parts.map((part) =>
			row.opclasses[part]
				? `${partName(part)} ${row.opclasses[part]}`
				: undefined
		)
	);
	const collations = present(
		parts.map((part) =>
			row.collations[part]
				? `${partName(part)} ${row.collations[part]}`
				: undefined
		)
	);

	return present([
		nulls.length > 0 ? `Sorted with ${nulls.join(', ')}` : undefined,
		classes.length > 0
			? `Operator class: ${classes.join(', ')}`
			: undefined,
		collations.length > 0
			? `Collation: ${collations.join(', ')}`
			: undefined,
		row.nullsNotDistinct ? 'Nulls not distinct' : undefined
	]);
};

/** A table's facts: owner, grants, persistence and storage options, a
 *  foreign table's server and options, what it inherits from, and (when
 *  asked) its estimated rows and size. */
export const tableMetadata = (relation: RelationRow, statistics: boolean) => {
	const metadata: DbmlMetadata = {
		...(relation.owner ? { owner: relation.owner } : {}),
		...(relation.grants ? { grants: relation.grants } : {}),
		...(relation.persistence === 'u' ? { unlogged: true } : {}),
		...(relation.options ? { options: relation.options } : {}),
		...(relation.foreignServer
			? { foreign_server: relation.foreignServer }
			: {}),
		...(relation.foreignOptions
			? { foreign_options: relation.foreignOptions }
			: {}),
		...(relation.inherits ? { inherits: relation.inherits } : {}),
		...(statistics && relation.rowEstimate
			? { rows: Number.parseInt(relation.rowEstimate, 10) }
			: {}),
		...(statistics && relation.sizeBytes
			? { size_bytes: Number.parseInt(relation.sizeBytes, 10) }
			: {})
	};

	return withMetadata(metadata);
};

const DISABLED = 'D';

/* A trigger or rule as Postgres would create it, without the CREATE, its
 * name or (a rule's) AS, on one line. */
const definitionDetail = (kind: 'rule' | 'trigger', entry: Definition) => {
	const body = entry.definition
		.replace(
			/^CREATE (?:OR REPLACE )?(?:CONSTRAINT )?(?:TRIGGER|RULE) (?:"(?:[^"]|"")+"|\S+)\s+(?:AS\s+)?/u,
			''
		)
		.replace(/\s+/gu, ' ')
		.trim();
	const detail: DbmlTableDetail = {
		...(entry.enabled === DISABLED ? { disabled: true } : {}),
		kind,
		name: entry.name,
		text: body
	};

	return detail;
};

/** A table's details: what it inherits from, its partitions, triggers
 *  and rules. */
export const tableDetails = (input: {
	inherits?: string;
	partitions: ReturnType<typeof partitionRow>[];
	rules: Definition[];
	triggers: Definition[];
}) => {
	const details: DbmlTableDetail[] = [
		...detailWhen(input.inherits, {
			kind: 'inherits',
			text: input.inherits ?? ''
		}),
		...input.partitions.map((partition) => {
			const detail: DbmlTableDetail = {
				kind: 'partition',
				name: partition.name,
				text: partition.bound
			};

			return detail;
		}),
		...input.triggers.map((trigger) =>
			definitionDetail('trigger', trigger)
		),
		...input.rules.map((rule) => definitionDetail('rule', rule))
	];

	return details;
};

const KINDS: Record<string, string> = {
	a: 'aggregate',
	f: 'function',
	p: 'procedure',
	w: 'window function'
};

const qualified = (schema: string, name: string, defaultSchema: string) =>
	schema === defaultSchema ? name : `${schema}.${name}`;

const sticky = (name: string, title: string, lines: string[]) => {
	if (lines.length === 0) return [];
	const note: DbmlStickyNote = {
		content: `${title}\n${lines.join('\n')}`,
		name
	};

	return [note];
};

type Extras = {
	composites: ReturnType<typeof compositeRow>[];
	domains: ReturnType<typeof domainRow>[];
	eventTriggers: ReturnType<typeof eventTriggerRow>[];
	extensions: ReturnType<typeof extensionRow>[];
	functions: ReturnType<typeof functionRow>[];
};

const domainLine = (
	domain: ReturnType<typeof domainRow>,
	defaultSchema: string
) =>
	[
		`${qualified(domain.schema, domain.name, defaultSchema)}: ${domain.base}`,
		domain.notNull ? 'not null' : undefined,
		domain.default ? `default ${domain.default}` : undefined,
		domain.constraints
	]
		.filter((part) => part !== undefined)
		.join(', ');

/** Sticky notes for what stands apart from the tables. */
export const extraNotes = (extras: Extras, defaultSchema: string) => [
	...sticky(
		'functions',
		'Functions and procedures',
		extras.functions.map(
			(entry) =>
				`${qualified(entry.schema, entry.name, defaultSchema)}(${entry.arguments})${entry.kind === 'p' ? '' : ` → ${entry.result}`}, ${KINDS[entry.kind] ?? 'function'} in ${entry.language}`
		)
	),
	...sticky(
		'domains',
		'Domains',
		extras.domains.map((domain) => domainLine(domain, defaultSchema))
	),
	...sticky(
		'composite_types',
		'Composite types',
		extras.composites.map(
			(entry) =>
				`${qualified(entry.schema, entry.name, defaultSchema)}: ${entry.fields}`
		)
	),
	...sticky(
		'extensions',
		'Extensions',
		extras.extensions.map(
			(entry) => `${entry.name} ${entry.version}, in ${entry.schema}`
		)
	),
	...sticky(
		'event_triggers',
		'Event triggers',
		extras.eventTriggers.map(
			(entry) =>
				`${entry.name}: on ${entry.event}, runs ${entry.function}${entry.enabled === DISABLED ? ' (disabled)' : ''}`
		)
	)
];
