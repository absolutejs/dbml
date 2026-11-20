import { describe, expect, test } from 'bun:test';
import { diffModels } from '../src/diff';
import { emptyModel, type DbmlModel } from '../src/model';

const base = () => structuredClone(BASE);

const BASE: DbmlModel = {
	...emptyModel(),
	enums: [{ name: 'status', values: [{ name: 'open' }, { name: 'done' }] }],
	notes: [{ content: 'Extensions\npg_trgm 1.6', name: 'extensions' }],
	refs: [
		{
			from: { columns: ['user_id'], table: 'orders' },
			relation: '>',
			to: { columns: ['id'], table: 'users' }
		}
	],
	tables: [
		{
			checks: [{ expression: 'total >= 0', name: 'total_positive' }],
			columns: [
				{ name: 'id', pk: true, type: 'integer' },
				{ name: 'user_id', type: 'integer' },
				{ name: 'total', type: 'numeric(10,2)' }
			],
			details: [
				{
					kind: 'trigger',
					name: 'stamp',
					text: 'BEFORE INSERT ON orders'
				}
			],
			indexes: [
				{
					name: 'orders_user',
					parts: [{ column: 'user_id', kind: 'column' }]
				}
			],
			metadata: { owner: 'app', rows: 10, size_bytes: 8192 },
			name: 'orders'
		},
		{
			checks: [],
			columns: [{ name: 'id', pk: true, type: 'integer' }],
			indexes: [],
			name: 'users'
		}
	]
};

describe('what changed between two schemas', () => {
	test('nothing, when only rows and sizes moved', () => {
		const later = base();
		const [orders] = later.tables;
		if (orders)
			orders.metadata = { owner: 'app', rows: 900, size_bytes: 65_536 };
		expect(diffModels(base(), later)).toEqual([]);
	});

	test('every kind of change, matched by name', () => {
		const later = base();
		const [orders, users] = later.tables;
		if (!orders || !users) throw new Error('fixture');
		orders.columns = [
			{ name: 'id', pk: true, type: 'integer' },
			{ name: 'user_id', notNull: true, type: 'integer' },
			{
				default: { kind: 'expression', value: 'now()' },
				name: 'placed_at',
				type: 'timestamptz'
			}
		];
		orders.indexes = [
			{
				name: 'orders_user',
				parts: [{ column: 'user_id', kind: 'column' }],
				unique: true
			}
		];
		orders.checks = [];
		orders.details = [
			{
				disabled: true,
				kind: 'trigger',
				name: 'stamp',
				text: 'BEFORE INSERT ON orders'
			}
		];
		orders.metadata = { owner: 'admin', rows: 10 };
		later.tables = [
			orders,
			{
				checks: [],
				columns: [{ name: 'id', type: 'uuid' }],
				indexes: [],
				name: 'carts',
				schema: 'shop'
			}
		];
		later.refs = [
			{
				from: { columns: ['user_id'], table: 'orders' },
				onDelete: 'cascade',
				relation: '>',
				to: { columns: ['id'], table: 'users' }
			}
		];
		later.enums = [
			{
				name: 'status',
				values: [{ name: 'open' }, { name: 'done' }, { name: 'void' }]
			}
		];
		later.notes = [];
		expect(
			diffModels(base(), later).map((change) => [
				change.kind,
				change.object,
				change.table ?? '',
				change.name
			])
		).toEqual([
			['removed', 'table', '', 'users'],
			['added', 'table', '', 'shop.carts'],
			['changed', 'column', 'orders', 'user_id'],
			['removed', 'column', 'orders', 'total'],
			['added', 'column', 'orders', 'placed_at'],
			['changed', 'index', 'orders', 'orders_user'],
			['removed', 'check', 'orders', 'total_positive'],
			['changed', 'detail', 'orders', 'trigger stamp'],
			['changed', 'fact', 'orders', 'owner'],
			['changed', 'ref', '', 'orders(user_id) → users(id)'],
			['changed', 'enum', '', 'status'],
			['removed', 'note', '', 'extensions']
		]);
	});

	test('says how a change reads before and after', () => {
		const later = base();
		const column = later.tables[0]?.columns[1];
		if (column) column.notNull = true;
		expect(diffModels(base(), later)).toEqual([
			{
				after: 'integer, not null',
				before: 'integer',
				kind: 'changed',
				name: 'user_id',
				object: 'column',
				table: 'orders'
			}
		]);
	});
});

describe('groups by name prefix', () => {
	test('a prefix three tables share is a group; the rest stay loose', async () => {
		const { groupByPrefix } = await import('../src/model');
		const table = (name: string, schema?: string) => ({
			checks: [],
			columns: [],
			indexes: [],
			name,
			...(schema ? { schema } : {})
		});
		expect(
			groupByPrefix([
				table('commerce_orders'),
				table('commerce'),
				table('commerce_carts'),
				table('billingInvoices'),
				table('billingPayments'),
				table('billingRefunds'),
				table('auth_users'),
				table('auth_sessions'),
				table('users'),
				table('shop_a', 'other'),
				table('shop_b', 'other'),
				table('shop_c')
			])
		).toEqual([
			{
				name: 'commerce',
				tables: [
					{ table: 'commerce' },
					{ table: 'commerce_orders' },
					{ table: 'commerce_carts' }
				]
			},
			{
				name: 'billing',
				tables: [
					{ table: 'billingInvoices' },
					{ table: 'billingPayments' },
					{ table: 'billingRefunds' }
				]
			}
		]);
	});
});
