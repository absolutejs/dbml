/*
 * The catalog queries' rows, typed. Drivers hand rows back differently
 * (an int as a number or a string, an array as an array or as `{a,b}`
 * text, a boolean as true or 't'), so every value is read once, here, and
 * the rest of the reader works with these types.
 */

type Raw = Record<string, unknown>;

/** A key that's only there when it has a value. */
const optional = <Key extends string>(key: Key, value: string | undefined) => {
	const entry: Partial<Record<Key, string>> = {};
	if (value !== undefined) entry[key] = value;

	return entry;
};

const text = (value: unknown) => {
	if (value === null || value === undefined) return undefined;

	return typeof value === 'string' ? value : `${value}`;
};

const integer = (value: unknown) => {
	if (typeof value === 'number') return value;
	const parsed = Number.parseInt(text(value) ?? '', 10);

	return Number.isNaN(parsed) ? 0 : parsed;
};

const flag = (value: unknown) =>
	value === true || value === 't' || value === 'true';

/* `{a,"b c"}` as Postgres writes an array it hands over as text. */
const ARRAY_ITEM = /"((?:[^"\\]|\\.)*)"|([^,{}]+)/gu;

const list = (value: unknown) => {
	if (Array.isArray(value)) return value.map((entry) => text(entry) ?? '');
	const raw = text(value);
	if (raw === undefined) return [];

	return [...raw.matchAll(ARRAY_ITEM)].map((match) =>
		match[1] === undefined
			? (match[2] ?? '')
			: match[1].replace(/\\(.)/gu, '$1')
	);
};

const integers = (value: unknown) => list(value).map(integer);

const flags = (value: unknown) => list(value).map(flag);

export type RelationRow = {
	comment?: string;
	definition?: string;
	foreignOptions?: string;
	foreignServer?: string;
	forceRls: boolean;
	grants?: string;
	inherits?: string;
	id: number;
	kind: string;
	name: string;
	options?: string;
	owner?: string;
	partitionKey?: string;
	partitions: number;
	persistence: string;
	rls: boolean;
	rowEstimate?: string;
	schema: string;
	sizeBytes?: string;
};

export const relationRow = (row: Raw) => {
	const result: RelationRow = {
		forceRls: flag(row.force_rls),
		id: integer(row.id),
		kind: text(row.kind) ?? '',
		name: text(row.name) ?? '',
		partitions: integer(row.partitions),
		persistence: text(row.persistence) ?? 'p',
		rls: flag(row.rls),
		schema: text(row.schema) ?? '',
		...optional('comment', text(row.comment)),
		...optional('definition', text(row.definition)),
		...optional('foreignOptions', setting(row.foreign_options)),
		...optional('foreignServer', text(row.foreign_server)),
		...optional('grants', text(row.grants)),
		...optional('inherits', text(row.inherits)),
		...optional('options', setting(row.options)),
		...optional('owner', text(row.owner)),
		...optional('partitionKey', text(row.partition_key)),
		...optional('rowEstimate', text(row.row_estimate)),
		...optional('sizeBytes', text(row.size_bytes))
	};

	return result;
};

export type ColumnRow = {
	collation?: string;
	comment?: string;
	compression?: string;
	default?: string;
	domainBase?: string;
	enumSchema?: string;
	enumType?: string;
	generated?: string;
	identity?: string;
	identitySequence?: string;
	name: string;
	notNull: boolean;
	position: number;
	serialSequence?: string;
	tableId: number;
	type: string;
};

/* Postgres writes "none" for identity and generation as an empty string. */
const setting = (value: unknown) => {
	const raw = text(value);

	return raw === '' ? undefined : raw;
};

export const columnRow = (row: Raw) => {
	const result: ColumnRow = {
		name: text(row.name) ?? '',
		notNull: flag(row.not_null),
		position: integer(row.position),
		tableId: integer(row.table_id),
		type: text(row.type) ?? '',
		...optional('collation', text(row.collation)),
		...optional('comment', text(row.comment)),
		...optional('compression', text(row.compression)),
		...optional('default', text(row.default)),
		...optional('domainBase', text(row.domain_base)),
		...optional('enumSchema', text(row.enum_schema)),
		...optional('enumType', text(row.enum_type)),
		...optional('generated', setting(row.generated)),
		...optional('identity', setting(row.identity)),
		...optional('identitySequence', text(row.identity_sequence)),
		...optional('serialSequence', text(row.serial_sequence))
	};

	return result;
};

export type ConstraintRow = {
	checkExpression?: string;
	columns: number[];
	comment?: string;
	deferrable: boolean;
	deferred: boolean;
	definition: string;
	foreignColumns: number[];
	foreignTableId: number;
	kind: string;
	name: string;
	nullsNotDistinct: boolean;
	onDelete: string;
	onUpdate: string;
	tableId: number;
};

export const constraintRow = (row: Raw) => {
	const result: ConstraintRow = {
		columns: integers(row.columns),
		deferrable: flag(row.deferrable),
		deferred: flag(row.deferred),
		definition: text(row.definition) ?? '',
		foreignColumns: integers(row.foreign_columns),
		foreignTableId: integer(row.foreign_table_id),
		kind: text(row.kind) ?? '',
		name: text(row.name) ?? '',
		nullsNotDistinct: flag(row.nulls_not_distinct),
		onDelete: text(row.on_delete) ?? 'a',
		onUpdate: text(row.on_update) ?? 'a',
		tableId: integer(row.table_id),
		...optional('checkExpression', text(row.check_expression)),
		...optional('comment', text(row.comment))
	};

	return result;
};

export type IndexRow = {
	attnums: number[];
	collations: string[];
	comment?: string;
	descending: boolean[];
	keyCount: number;
	method: string;
	name: string;
	nullsFirst: boolean[];
	nullsNotDistinct: boolean;
	opclasses: string[];
	parts: string[];
	predicate?: string;
	tableId: number;
	unique: boolean;
};

export const indexRow = (row: Raw) => {
	const result: IndexRow = {
		attnums: integers(row.attnums),
		collations: list(row.collations),
		descending: flags(row.descending),
		keyCount: integer(row.key_count),
		method: text(row.method) ?? 'btree',
		name: text(row.name) ?? '',
		nullsFirst: flags(row.nulls_first),
		nullsNotDistinct: flag(row.nulls_not_distinct),
		opclasses: list(row.opclasses),
		parts: list(row.parts),
		tableId: integer(row.table_id),
		unique: flag(row.is_unique),
		...optional('comment', text(row.comment)),
		...optional('predicate', text(row.predicate))
	};

	return result;
};

export type PolicyRow = {
	command: string;
	name: string;
	permissive: boolean;
	roles: string[];
	tableId: number;
	using?: string;
	withCheck?: string;
};

export const policyRow = (row: Raw) => {
	const result: PolicyRow = {
		command: text(row.command) ?? '*',
		name: text(row.name) ?? '',
		permissive: flag(row.permissive),
		roles: list(row.roles),
		tableId: integer(row.table_id),
		...optional('using', text(row.using)),
		...optional('withCheck', text(row.with_check))
	};

	return result;
};

export type NamedRow = { comment?: string; name: string; schema: string };

export const namedRow = (row: Raw) => {
	const result: NamedRow = {
		name: text(row.name) ?? '',
		schema: text(row.schema) ?? '',
		...optional('comment', text(row.comment))
	};

	return result;
};

export const enumRow = (row: Raw) => ({
	name: text(row.name) ?? '',
	schema: text(row.schema) ?? '',
	values: list(row.values)
});

export const sequenceRow = (row: Raw) => ({
	increment: text(row.increment) ?? '1',
	name: text(row.name) ?? '',
	schema: text(row.schema) ?? '',
	start: text(row.start) ?? '1'
});

export const viewSourceRow = (row: Raw) => ({
	sourceId: integer(row.source_id),
	viewId: integer(row.view_id)
});

/** A row of a table-scoped definition (a trigger, a rule). */
export const definitionRow = (row: Raw) => ({
	definition: text(row.definition) ?? '',
	enabled: text(row.enabled) ?? 'O',
	name: text(row.name) ?? '',
	tableId: integer(row.table_id)
});

export const functionRow = (row: Raw) => ({
	arguments: text(row.arguments) ?? '',
	kind: text(row.kind) ?? 'f',
	language: text(row.language) ?? '',
	name: text(row.name) ?? '',
	result: text(row.result) ?? '',
	schema: text(row.schema) ?? ''
});

export const domainRow = (row: Raw) => ({
	base: text(row.base) ?? '',
	constraints: text(row.constraints),
	default: text(row.default),
	name: text(row.name) ?? '',
	notNull: flag(row.not_null),
	schema: text(row.schema) ?? ''
});

export const compositeRow = (row: Raw) => ({
	fields: text(row.fields) ?? '',
	name: text(row.name) ?? '',
	schema: text(row.schema) ?? ''
});

export const extensionRow = (row: Raw) => ({
	name: text(row.name) ?? '',
	schema: text(row.schema) ?? '',
	version: text(row.version) ?? ''
});

export const eventTriggerRow = (row: Raw) => ({
	enabled: text(row.enabled) ?? 'O',
	event: text(row.event) ?? '',
	function: text(row.function) ?? '',
	name: text(row.name) ?? ''
});

export const partitionRow = (row: Raw) => ({
	bound: text(row.bound) ?? '',
	name: text(row.name) ?? '',
	tableId: integer(row.table_id)
});

export const viewColumnRow = (row: Raw) => ({
	name: text(row.name) ?? '',
	sourceId: integer(row.source_id),
	viewId: integer(row.view_id)
});
