import { Parser } from '@dbml/core';
import {
	type DbmlCheck,
	type DbmlColor,
	type DbmlColumn,
	type DbmlDefault,
	type DbmlDep,
	type DbmlIndex,
	type DbmlIndexPart,
	type DbmlMetadata,
	type DbmlModel,
	type DbmlRecordValue,
	type DbmlReferentialAction,
	type DbmlRelation,
	type DbmlTable,
	emptyModel
} from '../model';

/*
 * DBML text read back into a model, with the official parser (@dbml/core,
 * an optional peer dependency): so a .dbml file someone wrote, or one this
 * package printed, can be drawn, compared or printed again the same way as
 * a schema read from Drizzle or a database. A table's details come back as
 * lines of its note, since DBML keeps them there.
 */

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
	typeof value === 'object' && value !== null;

const list = (value: unknown) =>
	Array.isArray(value) ? value.filter(isRecord) : [];

const text = (value: unknown) => {
	if (value === null || value === undefined) return undefined;

	return typeof value === 'string' ? value : `${value}`;
};

const DEFAULT_SCHEMA = 'public';

/* DBML's default schema is left unnamed, as the model does. */
const inSchema = (schema: unknown) => {
	const name = text(schema);

	return name && name !== DEFAULT_SCHEMA ? { schema: name } : {};
};

const isColor = (value: unknown): value is DbmlColor =>
	typeof value === 'string' && value.startsWith('#');

const colored = (key: 'color' | 'headerColor', value: unknown) =>
	isColor(value) ? { [key]: value } : {};

const noted = (value: unknown) => {
	const note = text(isRecord(value) ? value.value : value);

	return note === undefined ? {} : { note };
};

const metadataOf = (owner: Raw) => {
	const raw = owner.metadata;
	if (!isRecord(raw)) return {};
	const metadata: DbmlMetadata = {};
	Object.entries(raw).forEach(([key, entry]) => {
		const value: unknown = isRecord(entry) ? entry.value : entry;
		if (
			typeof value === 'string' ||
			typeof value === 'number' ||
			typeof value === 'boolean'
		)
			metadata[key] = value;
	});

	return Object.keys(metadata).length > 0 ? { metadata } : {};
};

const defaultOf = (raw: unknown) => {
	if (!isRecord(raw)) return undefined;
	const { type, value } = raw;
	if (type === 'expression')
		return {
			kind: 'expression',
			value: text(value) ?? ''
		} satisfies DbmlDefault;
	if (type === 'boolean' && (value === 'null' || value === null))
		return { kind: 'null' } satisfies DbmlDefault;
	if (type === 'boolean')
		return {
			kind: 'boolean',
			value: value === true || value === 'true'
		} satisfies DbmlDefault;
	if (type === 'number')
		return {
			kind: 'number',
			value:
				typeof value === 'number'
					? value
					: Number.parseFloat(text(value) ?? '0')
		} satisfies DbmlDefault;

	return { kind: 'string', value: text(value) ?? '' } satisfies DbmlDefault;
};

const columnOf = (field: Raw) => {
	const type = isRecord(field.type) ? field.type : {};
	const typeSchema = text(type.schemaName);
	const typeName = text(type.type_name) ?? '';
	const fallback = defaultOf(field.dbdefault);
	const column: DbmlColumn = {
		name: text(field.name) ?? '',
		/* An array of a schema's type carries the schema in its name too. */
		type:
			typeSchema && typeName.startsWith(`${typeSchema}.`)
				? typeName.slice(typeSchema.length + 1)
				: typeName,
		...(typeSchema ? { typeSchema } : {}),
		...(field.pk === true ? { pk: true } : {}),
		...(field.increment === true ? { increment: true } : {}),
		...(field.unique === true ? { unique: true } : {}),
		...(field.not_null === true ? { notNull: true } : {}),
		...(fallback ? { default: fallback } : {}),
		...metadataOf(field),
		...noted(field.note)
	};

	return column;
};

const indexOf = (raw: Raw) => {
	const index: DbmlIndex = {
		...(text(raw.name) ? { name: text(raw.name) ?? '' } : {}),
		...noted(raw.note),
		parts: list(raw.columns).map((part) => {
			const desc = part.sortOrder === 'desc' ? { desc: true } : {};
			const entry: DbmlIndexPart =
				part.type === 'expression'
					? {
							expression: text(part.value) ?? '',
							kind: 'expression',
							...desc
						}
					: {
							column: text(part.value) ?? '',
							kind: 'column',
							...desc
						};

			return entry;
		}),
		...(raw.pk === true ? { pk: true } : {}),
		...(text(raw.type) ? { type: text(raw.type) ?? '' } : {}),
		...(raw.unique === true ? { unique: true } : {})
	};

	return index;
};

const RELATIONS: Record<string, DbmlRelation> = {
	'*,*': '<>',
	'*,1': '>',
	'1,*': '<',
	'1,1': '-'
};

const ACTIONS = new Set([
	'cascade',
	'no action',
	'restrict',
	'set default',
	'set null'
]);

const actionOf = (value: unknown) => {
	const action = text(value)?.toLowerCase();

	return action && ACTIONS.has(action) ? action : undefined;
};

const isAction = (value: string | undefined): value is DbmlReferentialAction =>
	value !== undefined;

const endpointOf = (raw: Raw) => ({
	columns: Array.isArray(raw.fieldNames)
		? raw.fieldNames.map((name) => text(name) ?? '')
		: [],
	...inSchema(raw.schemaName),
	table: text(raw.tableName) ?? ''
});

const refOf = (raw: Raw) => {
	const [first, second] = list(raw.endpoints);
	if (!first || !second) return [];
	/* One-to-many reads as many-to-one from the other end, the way every
	 * reader here writes it: the side holding the key first. */
	const flipped =
		`${text(first.relation)},${text(second.relation)}` === '1,*';
	const [from, target] = flipped ? [second, first] : [first, second];
	const onDelete = actionOf(raw.onDelete);
	const onUpdate = actionOf(raw.onUpdate);

	return [
		{
			...colored('color', raw.color),
			from: endpointOf(from),
			...(raw.inactive === true ? { inactive: true } : {}),
			...(text(raw.name) ? { name: text(raw.name) ?? '' } : {}),
			...(isAction(onDelete) ? { onDelete } : {}),
			...(isAction(onUpdate) ? { onUpdate } : {}),
			relation:
				RELATIONS[`${text(from.relation)},${text(target.relation)}`] ??
				'>',
			to: endpointOf(target)
		}
	];
};

const depEnd = (raw: unknown) => {
	const end = isRecord(raw) ? raw : {};
	const columns = Array.isArray(end.fieldNames)
		? end.fieldNames.map((name) => text(name) ?? '')
		: [];

	return {
		...(columns.length > 0 ? { columns } : {}),
		...inSchema(end.schemaName),
		table: text(end.tableName) ?? ''
	};
};

/* Each edge of a dep is a dep; edges over the same two tables join up
 * again into one over their columns. */
const depsOf = (schema: Raw) => {
	const merged = new Map<string, DbmlDep>();
	list(schema.deps).forEach((dep) =>
		list(dep.edges).forEach((edge) => {
			const upstream = depEnd(edge.upstream);
			const downstream = depEnd(edge.downstream);
			const key = `${upstream.schema ?? ''}.${upstream.table}>${downstream.schema ?? ''}.${downstream.table}`;
			const known = merged.get(key);
			if (!known) {
				merged.set(key, { downstream, upstream, ...noted(dep.note) });

				return;
			}
			known.upstream.columns = [
				...(known.upstream.columns ?? []),
				...(upstream.columns ?? [])
			];
		})
	);

	return [...merged.values()];
};

const recordValue = (cell: Raw) => {
	const { value } = cell;
	if (
		value === null ||
		typeof value === 'boolean' ||
		typeof value === 'number' ||
		typeof value === 'string'
	) {
		const read: DbmlRecordValue = value;

		return read;
	}

	return text(value) ?? null;
};

/** DBML text as a model. Throws the parser's error when it doesn't parse. */
export const fromDbml = (dbml: string) => {
	const database = Parser.parse(dbml, 'dbmlv2');
	const exported: unknown = database.export();
	const normalized: unknown = database.normalize();
	const root = isRecord(exported) ? exported : {};
	const checksByTable = new Map<string, DbmlCheck[]>();
	const normalizedRoot = isRecord(normalized) ? normalized : {};
	const tablesById = isRecord(normalizedRoot.tables)
		? normalizedRoot.tables
		: {};
	const schemasById = isRecord(normalizedRoot.schemas)
		? normalizedRoot.schemas
		: {};
	Object.values(isRecord(normalizedRoot.checks) ? normalizedRoot.checks : {})
		.filter(isRecord)
		.forEach((check) => {
			const owner = tablesById[`${text(check.tableId)}`];
			if (!isRecord(owner)) return;
			const schema = schemasById[`${text(owner.schemaId)}`];
			const key = `${isRecord(schema) ? text(schema.name) : DEFAULT_SCHEMA}.${text(owner.name)}`;
			const name = text(check.name);
			checksByTable.set(key, [
				...(checksByTable.get(key) ?? []),
				{
					expression: text(check.expression) ?? '',
					...(name ? { name } : {})
				}
			]);
		});
	/* The project lives in the normalized form only. */
	const databases = isRecord(normalizedRoot.database)
		? Object.values(normalizedRoot.database)
		: [];
	const project = databases.find(isRecord) ?? {};
	const databaseType = text(project.databaseType);
	const projectName = text(project.name);
	const model: DbmlModel = emptyModel(
		databaseType || projectName
			? {
					...(databaseType ? { databaseType } : {}),
					...(projectName ? { name: projectName } : {}),
					...noted(project.note)
				}
			: undefined
	);
	list(root.schemas).forEach((schema) => {
		const schemaName = text(schema.name) ?? DEFAULT_SCHEMA;
		list(schema.tables).forEach((table) => {
			const name = text(table.name) ?? '';
			const entry: DbmlTable = {
				...(text(table.alias)
					? { alias: text(table.alias) ?? '' }
					: {}),
				checks: checksByTable.get(`${schemaName}.${name}`) ?? [],
				columns: list(table.fields).map(columnOf),
				...colored('headerColor', table.headerColor),
				indexes: list(table.indexes).map(indexOf),
				...metadataOf(table),
				name,
				...noted(table.note),
				...inSchema(schemaName)
			};
			model.tables.push(entry);
		});
		list(schema.enums).forEach((entry) =>
			model.enums.push({
				name: text(entry.name) ?? '',
				...inSchema(schemaName),
				values: list(entry.values).map((value) => ({
					name: text(value.name) ?? '',
					...noted(value.note)
				}))
			})
		);
		model.refs.push(...list(schema.refs).flatMap(refOf));
		model.deps.push(...depsOf(schema));
		list(schema.tableGroups).forEach((group) =>
			model.tableGroups.push({
				...colored('color', group.color),
				name: text(group.name) ?? '',
				...noted(group.note),
				tables: list(group.tables).map((member) => ({
					...inSchema(member.schemaName),
					table: text(member.tableName) ?? ''
				}))
			})
		);
	});
	list(root.notes).forEach((note) =>
		model.notes.push({
			...colored('color', note.headerColor),
			content: text(note.content) ?? '',
			name: text(note.name) ?? ''
		})
	);
	list(root.records).forEach((records) =>
		model.records.push({
			columns: Array.isArray(records.columns)
				? records.columns.map((column) => text(column) ?? '')
				: [],
			rows: Array.isArray(records.values)
				? records.values.map((row) =>
						Array.isArray(row)
							? row.filter(isRecord).map(recordValue)
							: []
					)
				: [],
			...inSchema(records.schemaName),
			table: text(records.tableName) ?? ''
		})
	);

	/* The parser hands tables back schema by schema; the normalized ids
	 * keep the order they were written in. */
	const order = new Map(
		Object.values(tablesById)
			.filter(isRecord)
			.map((table) => {
				const schema = schemasById[`${text(table.schemaId)}`];
				const schemaName = isRecord(schema)
					? text(schema.name)
					: undefined;

				const entry: [string, number] = [
					`${schemaName ?? DEFAULT_SCHEMA}.${text(table.name)}`,
					typeof table.id === 'number' ? table.id : 0
				];

				return entry;
			})
	);
	const position = (table: DbmlTable) =>
		order.get(`${table.schema ?? DEFAULT_SCHEMA}.${table.name}`) ?? 0;
	model.tables.sort((left, right) => position(left) - position(right));

	return model;
};
