import {
	type DbmlCheck,
	type DbmlColumn,
	type DbmlDefault,
	type DbmlDep,
	type DbmlEndpoint,
	type DbmlEnum,
	type DbmlIndex,
	type DbmlIndexPart,
	type DbmlMetadata,
	type DbmlModel,
	type DbmlRecords,
	type DbmlRecordValue,
	type DbmlRef,
	type DbmlStickyNote,
	type DbmlTable,
	type DbmlTableGroup,
	tableNoteOf
} from './model';

/*
 * The model as DBML text, in the order the official exporter writes it:
 * the project, then enums, tables, table groups, refs and deps, then
 * sticky notes and records. Every name is quoted, so any name the database
 * allows prints as itself.
 */

const INDENT = '  ';

/** A name in double quotes, a quote inside it escaped. */
export const quoteName = (name: string) =>
	`"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

const qualified = (schema: string | undefined, name: string) =>
	schema ? `${quoteName(schema)}.${quoteName(name)}` : quoteName(name);

/** Text in single quotes, or triple quotes when it runs over lines. */
export const quoteText = (text: string) => {
	const escaped = text.replaceAll('\\', '\\\\').replaceAll('\r\n', '\n');
	if (/[\n']/u.test(escaped))
		return `'''${escaped.replaceAll("'''", "\\'''")}'''`;

	return `'${escaped}'`;
};

/** An expression in backticks. DBML has no escape for a backtick inside
 *  one, so a stray one becomes a double quote, which is what an
 *  identifier quoted the other way means. */
export const quoteExpression = (expression: string) =>
	`\`${expression.replaceAll('`', '"')}\``;

/* A type stays bare when DBML reads it as one word (`varchar(255)`,
 * `decimal(8,2)`); otherwise it's quoted. */
const BARE_TYPE = /^[A-Za-z_][\w]*(\([\w,]*\))?$/u;

const printType = (column: DbmlColumn) => {
	const type = BARE_TYPE.test(column.type)
		? column.type
		: quoteName(column.type);

	return column.typeSchema ? `${quoteName(column.typeSchema)}.${type}` : type;
};

const printDefault = (value: DbmlDefault) => {
	if (value.kind === 'null') return 'null';
	if (value.kind === 'boolean') return `${value.value}`;
	if (value.kind === 'number') return `${value.value}`;
	if (value.kind === 'string') return quoteText(value.value);

	return quoteExpression(value.value);
};

const settings = (entries: (string | false | undefined)[]) => {
	const present = entries.filter(
		(entry): entry is string => typeof entry === 'string'
	);

	return present.length > 0 ? ` [${present.join(', ')}]` : '';
};

const printColumn = (column: DbmlColumn) =>
	`${quoteName(column.name)} ${printType(column)}${settings([
		column.pk && 'pk',
		column.increment && 'increment',
		column.unique && 'unique',
		column.notNull && 'not null',
		column.default && `default: ${printDefault(column.default)}`,
		...(column.checks ?? []).map(
			(check) => `check: ${quoteExpression(check)}`
		),
		column.note !== undefined && `note: ${quoteText(column.note)}`
	])}`;

const printIndexPart = (part: DbmlIndexPart) => {
	const target =
		part.kind === 'column'
			? quoteName(part.column)
			: quoteExpression(part.expression);

	return part.desc ? `${target} [desc]` : target;
};

const printIndex = (index: DbmlIndex) => {
	const parts = index.parts.map(printIndexPart);
	const grouped =
		parts.length === 1 && !index.parts[0]?.desc
			? (parts[0] ?? '')
			: `(${parts.join(', ')})`;

	return `${grouped}${settings([
		index.pk && 'pk',
		index.unique && 'unique',
		index.type !== undefined && `type: ${index.type}`,
		index.name !== undefined && `name: ${quoteName(index.name)}`,
		index.note !== undefined && `note: ${quoteText(index.note)}`
	])}`;
};

const printCheck = (check: DbmlCheck) =>
	`${quoteExpression(check.expression)}${settings([
		check.name !== undefined && `name: ${quoteText(check.name)}`
	])}`;

const block = (title: string, lines: string[], depth = 1) => {
	const pad = INDENT.repeat(depth);

	return `${INDENT.repeat(depth - 1)}${title} {\n${lines
		.map((line) => `${pad}${line}`)
		.join('\n')}\n${INDENT.repeat(depth - 1)}}`;
};

const printTable = (table: DbmlTable) => {
	const head = `Table ${qualified(table.schema, table.name)}${
		table.alias ? ` as ${quoteName(table.alias)}` : ''
	}${settings([
		table.headerColor !== undefined && `headerColor: ${table.headerColor}`
	])}`;
	const body = table.columns.map(printColumn);
	const sections: string[] = [];
	if (table.checks.length > 0)
		sections.push(block('Checks', table.checks.map(printCheck), 2));
	if (table.indexes.length > 0)
		sections.push(block('Indexes', table.indexes.map(printIndex), 2));
	const note = tableNoteOf(table);
	if (note !== undefined) sections.push(`${INDENT}Note: ${quoteText(note)}`);
	const lines = body.map((line) => `${INDENT}${line}`);

	return `${head} {\n${[lines.join('\n'), ...sections].join('\n\n')}\n}`;
};

const printEnum = (entry: DbmlEnum) =>
	block(
		`Enum ${qualified(entry.schema, entry.name)}`,
		entry.values.map(
			(value) =>
				`${quoteName(value.name)}${settings([
					value.note !== undefined && `note: ${quoteText(value.note)}`
				])}`
		)
	);

const printEndpoint = (endpoint: DbmlEndpoint) => {
	const columns =
		endpoint.columns.length === 1
			? quoteName(endpoint.columns[0] ?? '')
			: `(${endpoint.columns.map(quoteName).join(', ')})`;

	return `${qualified(endpoint.schema, endpoint.table)}.${columns}`;
};

const printRef = (ref: DbmlRef) =>
	`Ref${ref.name === undefined ? '' : ` ${quoteName(ref.name)}`}: ${printEndpoint(
		ref.from
	)} ${ref.relation} ${printEndpoint(ref.to)}${settings([
		ref.onDelete !== undefined && `delete: ${ref.onDelete}`,
		ref.onUpdate !== undefined && `update: ${ref.onUpdate}`,
		ref.color !== undefined && `color: ${ref.color}`,
		ref.inactive && 'inactive',
		ref.note !== undefined && `note: ${quoteText(ref.note)}`
	])}`;

const printDepEnd = (end: DbmlDep['upstream'], column?: string) => {
	const table = qualified(end.schema, end.table);

	return column === undefined ? table : `${table}.${quoteName(column)}`;
};

/* One edge per column: DBML's parser refuses a schema-qualified column
 * list in a dep, and an edge each says the same thing. */
const depEdges = (dep: DbmlDep) => {
	const upstream = dep.upstream.columns ?? [];
	const downstream = dep.downstream.columns ?? [];
	if (upstream.length <= 1 && downstream.length <= 1)
		return [
			`${printDepEnd(dep.upstream, upstream[0])} -> ${printDepEnd(dep.downstream, downstream[0])}`
		];

	return upstream.map(
		(column, index) =>
			`${printDepEnd(dep.upstream, column)} -> ${printDepEnd(dep.downstream, downstream[index])}`
	);
};

const printDep = (dep: DbmlDep) => {
	const edges = depEdges(dep);
	if (dep.note === undefined && edges.length === 1)
		return `Dep: ${edges[0] ?? ''}`;

	return block('Dep', [
		...edges,
		...(dep.note === undefined ? [] : ['', `note: ${quoteText(dep.note)}`])
	]);
};

const printGroup = (group: TableGroupLike) =>
	block(
		`TableGroup ${quoteName(group.name)}${settings([
			group.color !== undefined && `color: ${group.color}`
		])}`,
		[
			...group.tables.map((entry) =>
				qualified(entry.schema, entry.table)
			),
			...(group.note === undefined
				? []
				: [`Note: ${quoteText(group.note)}`])
		]
	);

type TableGroupLike = DbmlTableGroup;

const printNote = (note: DbmlStickyNote) =>
	block(
		`Note ${quoteName(note.name)}${settings([
			note.color !== undefined && `color: ${note.color}`
		])}`,
		[quoteText(note.content)]
	);

const printValue = (value: DbmlRecordValue) => {
	if (value === null) return 'null';
	if (typeof value === 'boolean' || typeof value === 'number')
		return `${value}`;

	return quoteText(value);
};

const printRecords = (records: DbmlRecords) =>
	block(
		`Records ${qualified(records.schema, records.table)}(${records.columns
			.map(quoteName)
			.join(', ')})`,
		records.rows.map((row) => row.map(printValue).join(', '))
	);

const printProject = (project: NonNullable<DbmlModel['project']>) =>
	block(`Project${project.name ? ` ${quoteName(project.name)}` : ''}`, [
		...(project.databaseType === undefined
			? []
			: [`database_type: ${quoteText(project.databaseType)}`]),
		...(project.note === undefined
			? []
			: [`Note: ${quoteText(project.note)}`])
	]);

const printMetadataValue = (value: boolean | number | string) =>
	typeof value === 'string' ? quoteText(value) : `${value}`;

/* A key DBML reads as one word: letters, digits and underscores. */
const metadataKey = (key: string) => key.replace(/[^A-Za-z0-9_]/gu, '_');

const metadataBlock = (title: string, metadata: DbmlMetadata | undefined) => {
	const entries = Object.entries(metadata ?? {});
	if (entries.length === 0) return [];

	return [
		block(
			`Metadata ${title}`,
			entries.map(
				([key, value]) =>
					`${metadataKey(key)}: ${printMetadataValue(value)}`
			)
		)
	];
};

const printMetadata = (tables: DbmlTable[]) =>
	tables.flatMap((table) => {
		const name = qualified(table.schema, table.name);

		return [
			...metadataBlock(`Table ${name}`, table.metadata),
			...table.columns.flatMap((column) =>
				metadataBlock(
					`Column ${name}.${quoteName(column.name)}`,
					column.metadata
				)
			)
		];
	});

/** The model as DBML text. */
export const printDbml = (model: DbmlModel) => {
	const { project } = model;
	const hasProject =
		project !== undefined &&
		(project.name !== undefined ||
			project.databaseType !== undefined ||
			project.note !== undefined);
	const sections = [
		...(hasProject && project ? [printProject(project)] : []),
		...model.enums.map(printEnum),
		...model.tables.map(printTable),
		...model.tableGroups.map(printGroup),
		...(model.refs.length > 0 ? [model.refs.map(printRef).join('\n')] : []),
		...(model.deps.length > 0 ? [model.deps.map(printDep).join('\n')] : []),
		...model.notes.map(printNote),
		...model.records
			.filter((records) => records.rows.length > 0)
			.map(printRecords),
		...printMetadata(model.tables)
	];

	return `${sections.join('\n\n')}\n`;
};
