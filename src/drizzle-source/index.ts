import ts from 'typescript';

/*
 * The relations an app's Drizzle schema declares, read from its source as
 * text: the files are parsed, never run, so this is safe on code nobody
 * has reviewed (a hosted platform reading a customer's repository). It
 * finds each table's name and its columns' database names, then the links
 * between them: inline `.references()`, `relations()` (Drizzle 0.x) and
 * `defineRelations` (Drizzle 1.0), with junction tables and `where`
 * filters. What can only be known by running the code (a table name built
 * at run time, a column named by a variable) is skipped, not guessed.
 */

export type SourceFile = { path: string; text: string };

/** A link the app declares, in database names. */
export type AppRelation = {
	/** The side holding the key. */
	from: { columns: string[]; schema?: string; table: string };
	/** How the app reads it: `posts.author`. */
	field: string;
	/** A `.references()` (a foreign key), not only a relation. */
	foreignKey: boolean;
	onDelete?: string;
	to: { columns: string[]; schema?: string; table: string };
	/** The relation's `where` filter, as written. */
	where?: string;
};

type TableInfo = {
	columns: Map<string, string>;
	name: string;
	schema?: string;
};

const SNAKE_BOUNDARY = /([a-z0-9])([A-Z])/gu;

const snakeCase = (name: string) =>
	name.replace(SNAKE_BOUNDARY, '$1_$2').toLowerCase();

const camelCase = (name: string) =>
	name.replace(/_([a-z0-9])/gu, (_match, letter: string) =>
		letter.toUpperCase()
	);

const stringOf = (node: ts.Node | undefined) =>
	node &&
	(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
		? node.text
		: undefined;

const propertyName = (node: ts.PropertyName) => {
	if (
		ts.isIdentifier(node) ||
		ts.isStringLiteral(node) ||
		ts.isNumericLiteral(node)
	)
		return node.text;

	return undefined;
};

/* The innermost call of a chain: `text('a').notNull().unique()` →
 * `text('a')`; with every call met on the way. */
const chainOf = (expression: ts.Expression) => {
	const calls: ts.CallExpression[] = [];
	let current: ts.Expression = expression;
	while (ts.isCallExpression(current)) {
		calls.unshift(current);
		const callee = current.expression;
		current = ts.isPropertyAccessExpression(callee)
			? callee.expression
			: callee;
	}

	return calls;
};

const calleeName = (call: ts.CallExpression) => {
	const callee = call.expression;
	if (ts.isIdentifier(callee)) return callee.text;

	return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
};

/* `pgTable`, `mysqlTable`, `sqliteTable`, a `pgSchema(...).table` or a
 * creator's table, called with a name and a column object. */
const isTableCall = (call: ts.CallExpression) => {
	const name = calleeName(call);
	const [first, second] = call.arguments;

	return (
		name !== undefined &&
		/(^table$|Table$)/u.test(name) &&
		stringOf(first) !== undefined &&
		second !== undefined &&
		(ts.isObjectLiteralExpression(second) || ts.isArrowFunction(second))
	);
};

/* The schema a `pgSchema('billing').table(...)` call or a `billing.table`
 * names, when it's written there. */
const schemaOfCall = (
	call: ts.CallExpression,
	schemas: Map<string, string>
) => {
	const callee = call.expression;
	if (!ts.isPropertyAccessExpression(callee)) return undefined;
	const owner = callee.expression;
	if (ts.isIdentifier(owner)) return schemas.get(owner.text);
	if (ts.isCallExpression(owner) && calleeName(owner) === 'pgSchema')
		return stringOf(owner.arguments[0]);

	return undefined;
};

const columnsObject = (argument: ts.Expression | undefined) => {
	if (!argument) return undefined;
	if (ts.isObjectLiteralExpression(argument)) return argument;
	if (ts.isArrowFunction(argument)) {
		const { body } = argument;
		const inner = ts.isParenthesizedExpression(body)
			? body.expression
			: body;

		return ts.isObjectLiteralExpression(inner) ? inner : undefined;
	}

	return undefined;
};

type Casing = 'camelCase' | 'snake_case' | undefined;

/* A column's database name: the string its builder is called with, or its
 * key under the project's casing. */
const columnName = (
	key: string,
	initializer: ts.Expression,
	casing: Casing
) => {
	const [builder] = chainOf(initializer);
	const written = stringOf(builder?.arguments[0]);
	if (written !== undefined) return written;
	if (casing === 'snake_case') return snakeCase(key);
	if (casing === 'camelCase') return camelCase(key);

	return key;
};

type Reference = {
	column: string;
	onDelete?: string;
	target: ts.Expression;
	variable: string;
};

/* `.references(() => users.id, { onDelete: 'cascade' })` on a column. */
const referencesOf = (
	variable: string,
	column: string,
	initializer: ts.Expression
) =>
	chainOf(initializer).flatMap((call) => {
		if (calleeName(call) !== 'references') return [];
		const [target, options] = call.arguments;
		const body =
			target && ts.isArrowFunction(target) ? target.body : undefined;
		if (!body || !ts.isExpression(body)) return [];
		const onDelete =
			options && ts.isObjectLiteralExpression(options)
				? options.properties
						.filter(ts.isPropertyAssignment)
						.find(
							(property) =>
								propertyName(property.name) === 'onDelete'
						)
				: undefined;
		const action = onDelete ? stringOf(onDelete.initializer) : undefined;
		const reference: Reference = {
			column,
			target: body,
			variable,
			...(action ? { onDelete: action } : {})
		};

		return [reference];
	});

type Collected = {
	casing: Casing;
	files: ts.SourceFile[];
	references: Reference[];
	/* By the identifier the code uses for the table. */
	tables: Map<string, TableInfo>;
};

const collectSchemas = (file: ts.SourceFile, schemas: Map<string, string>) => {
	const visit = (node: ts.Node) => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			ts.isCallExpression(node.initializer) &&
			calleeName(node.initializer) === 'pgSchema'
		) {
			const name = stringOf(node.initializer.arguments[0]);
			if (name) schemas.set(node.name.text, name);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
};

/* A `const x = pgTable('x', {...})` declaration, recorded with its
 * columns and any `.references()` among them. */
const recordTable = (
	node: ts.VariableDeclaration,
	collected: Collected,
	schemas: Map<string, string>
) => {
	if (!ts.isIdentifier(node.name) || !node.initializer) return;
	const table = chainOf(node.initializer).find(isTableCall);
	const object = table ? columnsObject(table.arguments[1]) : undefined;
	const name = table ? stringOf(table.arguments[0]) : undefined;
	if (!table || !object || name === undefined) return;
	const variable = node.name.text;
	const columns = new Map<string, string>();
	object.properties.filter(ts.isPropertyAssignment).forEach((property) => {
		const key = propertyName(property.name);
		if (key === undefined) return;
		const column = columnName(key, property.initializer, collected.casing);
		columns.set(key, column);
		collected.references.push(
			...referencesOf(variable, column, property.initializer)
		);
	});
	const schema = schemaOfCall(table, schemas);
	collected.tables.set(variable, {
		columns,
		name,
		...(schema ? { schema } : {})
	});
};

const collectTables = (
	file: ts.SourceFile,
	collected: Collected,
	schemas: Map<string, string>
) => {
	const visit = (node: ts.Node) => {
		if (ts.isVariableDeclaration(node))
			recordTable(node, collected, schemas);
		ts.forEachChild(node, visit);
	};
	visit(file);
};

/* `users.id`, `r.users.id` or `t.users.id`: a table's column by the
 * identifiers the code uses. */
const columnAt = (
	expression: ts.Expression,
	tables: Map<string, TableInfo>,
	viaRoot: boolean
) => {
	if (!ts.isPropertyAccessExpression(expression)) return undefined;
	const columnKey = expression.name.text;
	const owner = expression.expression;
	const rooted = ts.isPropertyAccessExpression(owner)
		? owner.name.text
		: undefined;
	const direct = ts.isIdentifier(owner) ? owner.text : undefined;
	const tableKey = viaRoot ? rooted : direct;
	const table = tableKey === undefined ? undefined : tables.get(tableKey);
	const column = table?.columns.get(columnKey);

	return table && column !== undefined ? { column, table } : undefined;
};

const endOf = (table: TableInfo, columns: string[]) => ({
	columns,
	...(table.schema ? { schema: table.schema } : {}),
	table: table.name
});

/* Columns from a single column or an array of them, all of one table. */
const columnsAt = (
	expression: ts.Expression | undefined,
	tables: Map<string, TableInfo>,
	viaRoot: boolean
) => {
	if (!expression) return undefined;
	const items = ts.isArrayLiteralExpression(expression)
		? [...expression.elements]
		: [expression];
	const found = items.map((item) => columnAt(item, tables, viaRoot));
	const [first] = found;
	if (!first || found.some((entry) => entry?.table !== first.table))
		return undefined;

	return {
		columns: found.map((entry) => entry?.column ?? ''),
		table: first.table
	};
};

const optionsOf = (call: ts.CallExpression) => {
	const options = call.arguments.find(ts.isObjectLiteralExpression);
	const read = (key: string) =>
		options?.properties
			.filter(ts.isPropertyAssignment)
			.find((property) => propertyName(property.name) === key)
			?.initializer;

	return read;
};

/* Drizzle 0.x: `relations(posts, ({ one }) => ({ author: one(users,
 * { fields: [posts.authorId], references: [users.id] }) }))`. */
const relationsV1 = (
	call: ts.CallExpression,
	tables: Map<string, TableInfo>
) => {
	const [owner, builder] = call.arguments;
	const ownerTable =
		owner && ts.isIdentifier(owner) ? tables.get(owner.text) : undefined;
	const object = columnsObject(builder);
	if (!ownerTable || !object) return [];

	return object.properties
		.filter(ts.isPropertyAssignment)
		.flatMap((property) => {
			const field = propertyName(property.name);
			const relation = property.initializer;
			if (
				field === undefined ||
				!ts.isCallExpression(relation) ||
				calleeName(relation) !== 'one'
			)
				return [];
			const read = optionsOf(relation);
			const from = columnsAt(read('fields'), tables, false);
			const target = columnsAt(read('references'), tables, false);
			if (!from || !target) return [];
			const link: AppRelation = {
				field: `${ownerTable.name}.${field}`,
				foreignKey: false,
				from: endOf(from.table, from.columns),
				to: endOf(target.table, target.columns)
			};

			return [link];
		});
};

/* `r.users.id.through(r.members.userId)`: the junction's column. */
const throughOf = (expression: ts.Expression | undefined) => {
	if (!expression || !ts.isCallExpression(expression)) return undefined;
	const callee = expression.expression;
	if (
		!ts.isPropertyAccessExpression(callee) ||
		callee.name.text !== 'through'
	)
		return undefined;
	const [junction] = expression.arguments;

	return junction ? { column: callee.expression, junction } : undefined;
};

type V2Context = { owner: TableInfo; tables: Map<string, TableInfo> };

/* One `r.one.x({...})` or `r.many.x({...})` of Drizzle 1.0. */
const relationV2 = (
	field: string,
	relation: ts.CallExpression,
	context: V2Context
) => {
	const callee = relation.expression;
	const kind =
		ts.isPropertyAccessExpression(callee) &&
		ts.isPropertyAccessExpression(callee.expression)
			? callee.expression.name.text
			: undefined;
	if (kind !== 'one' && kind !== 'many') return [];
	const read = optionsOf(relation);
	const where = read('where');
	const filter = where ? { where: where.getText() } : {};
	const name = `${context.owner.name}.${field}`;
	const fromThrough = throughOf(read('from'));
	const toThrough = throughOf(read('to'));
	if (fromThrough && toThrough) {
		const ends = [fromThrough, toThrough].flatMap((end) => {
			const key = columnsAt(end.junction, context.tables, true);
			const target = columnsAt(end.column, context.tables, true);
			if (!key || !target) return [];
			const link: AppRelation = {
				field: name,
				foreignKey: false,
				from: endOf(key.table, key.columns),
				to: endOf(target.table, target.columns),
				...filter
			};

			return [link];
		});

		return ends;
	}
	const from = columnsAt(read('from'), context.tables, true);
	const to = columnsAt(read('to'), context.tables, true);
	if (!from || !to) return [];
	/* A one holds the key on its own side; a many on the other. */
	const [holder, target] = kind === 'one' ? [from, to] : [to, from];
	const link: AppRelation = {
		field: name,
		foreignKey: false,
		from: endOf(holder.table, holder.columns),
		to: endOf(target.table, target.columns),
		...filter
	};

	return [link];
};

/* Drizzle 1.0: `defineRelations(schema, (r) => ({ posts: { author:
 * r.one.users({ from: r.posts.authorId, to: r.users.id }) } }))`; its
 * table keys are the schema's export names, the identifiers here. */
const relationsV2 = (
	call: ts.CallExpression,
	tables: Map<string, TableInfo>
) => {
	const object = columnsObject(call.arguments.find(ts.isArrowFunction));
	if (!object) return [];

	return object.properties
		.filter(ts.isPropertyAssignment)
		.flatMap((property) => {
			const tableKey = propertyName(property.name);
			const owner =
				tableKey === undefined ? undefined : tables.get(tableKey);
			const fields = property.initializer;
			if (!owner || !ts.isObjectLiteralExpression(fields)) return [];

			return fields.properties
				.filter(ts.isPropertyAssignment)
				.flatMap((entry) => {
					const field = propertyName(entry.name);
					if (
						field === undefined ||
						!ts.isCallExpression(entry.initializer)
					)
						return [];

					return relationV2(field, entry.initializer, {
						owner,
						tables
					});
				});
		});
};

const collectRelations = (
	file: ts.SourceFile,
	tables: Map<string, TableInfo>
) => {
	const links: AppRelation[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node)) {
			const name = calleeName(node);
			if (name === 'relations') links.push(...relationsV1(node, tables));
			if (name === 'defineRelations' || name === 'defineRelationsPart')
				links.push(...relationsV2(node, tables));
		}
		ts.forEachChild(node, visit);
	};
	visit(file);

	return links;
};

const CASING = /casing\s*:\s*['"](snake_case|camelCase)['"]/u;

/** Every link an app's Drizzle schema declares, from its source files. */
export const appRelationsFromSource = (files: SourceFile[]) => {
	const parsed = files.map((file) =>
		ts.createSourceFile(
			file.path,
			file.text,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX
		)
	);
	const casing = files
		.map((file) => CASING.exec(file.text)?.[1])
		.find((found) => found !== undefined);
	const collected: Collected = {
		casing:
			casing === 'snake_case' || casing === 'camelCase'
				? casing
				: undefined,
		files: parsed,
		references: [],
		tables: new Map()
	};
	const schemas = new Map<string, string>();
	parsed.forEach((file) => collectSchemas(file, schemas));
	parsed.forEach((file) => collectTables(file, collected, schemas));
	const foreignKeys = collected.references.flatMap((reference) => {
		const holder = collected.tables.get(reference.variable);
		const target = columnAt(reference.target, collected.tables, false);
		if (!holder || !target) return [];
		const link: AppRelation = {
			field: `${holder.name}.${reference.column}`,
			foreignKey: true,
			from: endOf(holder, [reference.column]),
			...(reference.onDelete ? { onDelete: reference.onDelete } : {}),
			to: endOf(target.table, [target.column])
		};

		return [link];
	});

	return [
		...foreignKeys,
		...parsed.flatMap((file) => collectRelations(file, collected.tables))
	];
};

/** Files worth reading for a schema: TypeScript that imports Drizzle. */
export const isSchemaSource = (path: string, text: string) =>
	/\.(ts|tsx|mts|cts)$/u.test(path) &&
	!/\.d\.ts$/u.test(path) &&
	/from\s+['"]drizzle-orm/u.test(text);
