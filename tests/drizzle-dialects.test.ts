import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import * as cockroach from 'drizzle-orm/cockroach-core';
import * as mssql from 'drizzle-orm/mssql-core';
import * as mysql from 'drizzle-orm/mysql-core';
import * as singlestore from 'drizzle-orm/singlestore-core';
import * as sqlite from 'drizzle-orm/sqlite-core';
import { fromDrizzle } from '../src/drizzle';
import type { DbmlModel } from '../src/model';
import { roundTrip } from './roundTrip';

const columnOf = (model: DbmlModel, table: string, name: string) =>
	model.tables
		.find((entry) => entry.name === table)
		?.columns.find((entry) => entry.name === name);

describe('MySQL', () => {
	const shop = mysql.mysqlSchema('shop');
	const customers = shop.table('customers', {
		id: mysql.int().primaryKey().autoincrement()
	});
	const orders = mysql.mysqlTable(
		'orders',
		{
			customerId: mysql
				.int('customer_id')
				.references(() => customers.id, { onDelete: 'restrict' }),
			id: mysql
				.bigint({ mode: 'number', unsigned: true })
				.primaryKey()
				.autoincrement(),
			name: mysql.varchar({ length: 50 }).notNull(),
			status: mysql.mysqlEnum(['open', 'paid']).default('open'),
			total: mysql.decimal({ precision: 8, scale: 2 }),
			touched: mysql.timestamp().defaultNow().onUpdateNow(),
			upper: mysql
				.varchar({ length: 50 })
				.generatedAlwaysAs(sql`upper(name)`, { mode: 'virtual' })
		},
		(table) => [
			mysql.index('orders_name').on(table.name).using('hash'),
			mysql
				.uniqueIndex('orders_customer_name')
				.on(table.customerId, table.name),
			mysql.check('total_pos', sql`${table.total} >= ${0}`)
		]
	);
	const model = fromDrizzle({ customers, orders, shop });

	test('reads back from DBML exactly as meant', () => {
		roundTrip(model);
		expect(model.project?.databaseType).toBe('MySQL');
	});

	test('auto increment, unsigned types and a database as the schema', () => {
		expect(columnOf(model, 'orders', 'id')).toMatchObject({
			increment: true,
			pk: true,
			type: 'bigint unsigned'
		});
		expect(model.tables[0]?.schema).toBe('shop');
	});

	test('an inline enum becomes a named one, its stored type noted', () => {
		expect(model.enums).toEqual([
			{
				name: 'orders_status',
				values: [{ name: 'open' }, { name: 'paid' }]
			}
		]);
		expect(columnOf(model, 'orders', 'status')).toMatchObject({
			default: { kind: 'string', value: 'open' },
			note: "Stored as enum('open','paid')",
			type: 'orders_status'
		});
	});

	test('on update now, generated columns, and expressions without backticks', () => {
		expect(columnOf(model, 'orders', 'touched')).toMatchObject({
			default: { kind: 'expression', value: '(now())' },
			note: 'Set to the current time on every update'
		});
		expect(columnOf(model, 'orders', 'upper')?.note).toBe(
			'Generated always as (upper(name)), virtual'
		);
		expect(model.tables[1]?.checks).toEqual([
			{ expression: '"total" >= 0', name: 'total_pos' }
		]);
	});

	test('index methods and foreign keys across schemas', () => {
		expect(
			model.tables[1]?.indexes.map((index) => [
				index.name,
				index.type,
				index.unique === true
			])
		).toEqual([
			['orders_name', 'hash', false],
			['orders_customer_name', undefined, true]
		]);
		expect(model.refs).toEqual([
			{
				from: { columns: ['customer_id'], table: 'orders' },
				onDelete: 'restrict',
				relation: '>',
				to: { columns: ['id'], schema: 'shop', table: 'customers' }
			}
		]);
	});
});

describe('SQLite', () => {
	const notes = sqlite.sqliteTable(
		'notes',
		{
			at: sqlite
				.integer({ mode: 'timestamp' })
				.default(sql`(unixepoch())`),
			body: sqlite.blob(),
			done: sqlite.integer({ mode: 'boolean' }).default(false),
			id: sqlite.integer().primaryKey({ autoIncrement: true }),
			kind: sqlite.text({ enum: ['task', 'idea'] }).notNull(),
			parent: sqlite.integer(),
			score: sqlite.real()
		},
		(table) => [
			sqlite.foreignKey({
				columns: [table.parent],
				foreignColumns: [table.id]
			}),
			sqlite
				.uniqueIndex('notes_kind')
				.on(table.kind)
				.where(sql`${table.kind} is not null`)
		]
	);
	const model = fromDrizzle({ notes });

	test('reads back from DBML exactly as meant', () => {
		roundTrip(model);
		expect(model.project?.databaseType).toBe('SQLite');
	});

	test('autoincrement, text enums and a self-reference', () => {
		expect(columnOf(model, 'notes', 'id')).toMatchObject({
			increment: true,
			pk: true,
			type: 'integer'
		});
		expect(columnOf(model, 'notes', 'kind')).toMatchObject({
			note: 'Stored as text',
			notNull: true,
			type: 'notes_kind'
		});
		expect(columnOf(model, 'notes', 'done')?.default).toEqual({
			kind: 'boolean',
			value: false
		});
		expect(model.refs).toEqual([
			{
				from: { columns: ['parent'], table: 'notes' },
				relation: '>',
				to: { columns: ['id'], table: 'notes' }
			}
		]);
	});

	test('a partial unique index is not a key: its predicate is in its note', () => {
		expect(model.tables[0]?.indexes[0]).toEqual({
			name: 'notes_kind',
			note: 'Where "kind" is not null',
			parts: [{ column: 'kind', kind: 'column' }],
			unique: true
		});
	});
});

describe('SingleStore', () => {
	const items = singlestore.singlestoreTable('items', {
		embedding: singlestore.vector({ dimensions: 3 }),
		id: singlestore.bigint({ mode: 'number' }).primaryKey().autoincrement(),
		state: singlestore.singlestoreEnum(['on', 'off'])
	});
	const model = fromDrizzle({ items });

	test('reads back from DBML exactly as meant', () => {
		roundTrip(model);
		expect(model.project?.databaseType).toBe('SingleStore');
		expect(columnOf(model, 'items', 'id')).toMatchObject({
			increment: true,
			pk: true
		});
		expect(model.enums.map((entry) => entry.name)).toEqual(['items_state']);
	});
});

describe('SQL Server', () => {
	const people = mssql.mssqlTable('people', {
		active: mssql.bit().default(true),
		at: mssql.datetime2().default(sql`getdate()`),
		id: mssql.int().primaryKey().identity({ increment: 1, seed: 1 }),
		name: mssql.nvarchar({ length: 'max' }).notNull()
	});
	const model = fromDrizzle({ people });

	test('reads back from DBML exactly as meant', () => {
		roundTrip(model);
		expect(model.project?.databaseType).toBe('SQL Server');
		expect(columnOf(model, 'people', 'id')).toMatchObject({
			increment: true,
			note: 'Identity',
			pk: true
		});
		expect(columnOf(model, 'people', 'at')?.default).toEqual({
			kind: 'expression',
			value: 'getdate()'
		});
	});
});

describe('CockroachDB', () => {
	const status = cockroach.cockroachEnum('status', ['new', 'done']);
	const jobs = cockroach.cockroachTable('jobs', {
		id: cockroach.uuid().primaryKey().defaultRandom(),
		number: cockroach.int4().generatedByDefaultAsIdentity(),
		state: status().default('new'),
		tags: cockroach.string().array()
	});
	const model = fromDrizzle({ jobs, status });

	test('reads back from DBML exactly as meant', () => {
		roundTrip(model);
		expect(model.project?.databaseType).toBe('CockroachDB');
		expect(model.enums.map((entry) => entry.name)).toEqual(['status']);
		expect(columnOf(model, 'jobs', 'number')).toMatchObject({
			increment: true
		});
		expect(columnOf(model, 'jobs', 'tags')?.type).toMatch(/\[\]$/u);
	});
});

describe('a schema mixing dialects', () => {
	test('names no single database', () => {
		const one = sqlite.sqliteTable('a', { id: sqlite.integer() });
		const two = mysql.mysqlTable('b', { id: mysql.int() });
		const model = fromDrizzle({ one, two });
		expect(model.project?.databaseType).toBeUndefined();
		roundTrip(model);
	});
});
