import { describe, expect, test } from 'bun:test';
import { emptyModel } from '../src/model';
import { printDbml, quoteExpression, quoteName, quoteText } from '../src/print';
import { roundTrip } from './roundTrip';

describe('printing', () => {
	test('names, text and expressions that need escaping', () => {
		expect(quoteName('we"ird')).toBe('"we\\"ird"');
		expect(quoteText("it's")).toBe("'''it's'''");
		expect(quoteText('plain')).toBe("'plain'");
		expect(quoteExpression('`id` > 1')).toBe('`"id" > 1`');
	});

	test('every construct DBML has, read back as meant', () => {
		const model = emptyModel({
			databaseType: 'PostgreSQL',
			name: 'shop "main"',
			note: "Bob's\nshop"
		});
		model.enums.push({
			name: 'mood',
			schema: 'auth',
			values: [{ name: 'happy', note: 'yay' }, { name: "it's" }]
		});
		model.tables.push(
			{
				alias: 'u',
				checks: [{ expression: '"age" > 0', name: 'age_pos' }],
				columns: [
					{ increment: true, name: 'id', pk: true, type: 'integer' },
					{
						default: { kind: 'string', value: 'happy' },
						name: 'mood',
						type: 'mood',
						typeSchema: 'auth'
					},
					{
						default: { kind: 'expression', value: "'{}'::text[]" },
						name: 'tags',
						notNull: true,
						type: 'text[]'
					},
					{
						default: { kind: 'expression', value: 'now()' },
						name: 'at',
						note: "when\nit's made",
						type: 'timestamp with time zone'
					},
					{ name: 'price', type: 'numeric(10, 2)' },
					{
						default: { kind: 'number', value: 1.5 },
						name: 'd',
						type: 'decimal(8,2)'
					},
					{
						default: { kind: 'boolean', value: false },
						name: 'ok',
						type: 'boolean'
					},
					{
						default: { kind: 'null' },
						name: 'n',
						type: 'text',
						unique: true
					},
					{ name: 'we"ird name', type: 'varchar(255)' },
					{ name: 'age', type: 'int' }
				],
				headerColor: '#3498db',
				indexes: [
					{
						name: 'u_mood',
						note: 'where "ok"',
						parts: [
							{ column: 'id', kind: 'column' },
							{ column: 'mood', kind: 'column' }
						],
						type: 'btree',
						unique: true
					},
					{
						parts: [
							{ expression: 'lower("n")', kind: 'expression' }
						],
						type: 'gin'
					},
					{ parts: [{ column: 'at', desc: true, kind: 'column' }] }
				],
				name: 'users',
				note: 'people',
				schema: 'auth'
			},
			{
				checks: [],
				columns: [
					{ name: 'a', type: 'int' },
					{ name: 'b', type: 'int' },
					{ name: 'author', type: 'int' }
				],
				indexes: [
					{
						parts: [
							{ column: 'a', kind: 'column' },
							{ column: 'b', kind: 'column' }
						],
						pk: true
					}
				],
				name: 'posts'
			}
		);
		model.refs.push(
			{
				color: '#f00',
				from: { columns: ['author'], table: 'posts' },
				name: 'posts_author',
				note: 'by',
				onDelete: 'cascade',
				onUpdate: 'restrict',
				relation: '>',
				to: { columns: ['id'], schema: 'auth', table: 'users' }
			},
			{
				from: { columns: ['a', 'b'], table: 'posts' },
				inactive: true,
				relation: '-',
				to: { columns: ['id', 'age'], schema: 'auth', table: 'users' }
			},
			{
				from: { columns: ['a'], table: 'posts' },
				relation: '<>',
				to: { columns: ['age'], schema: 'auth', table: 'users' }
			},
			{
				from: { columns: ['b'], table: 'posts' },
				relation: '<',
				to: { columns: ['d'], schema: 'auth', table: 'users' }
			}
		);
		model.deps.push(
			{
				downstream: { table: 'posts' },
				upstream: { schema: 'auth', table: 'users' }
			},
			{
				downstream: { columns: ['a'], table: 'posts' },
				note: 'copied',
				upstream: { columns: ['id'], schema: 'auth', table: 'users' }
			}
		);
		model.tableGroups.push({
			color: '#0f0',
			name: 'core',
			note: 'main',
			tables: [{ schema: 'auth', table: 'users' }, { table: 'posts' }]
		});
		model.notes.push({
			color: '#ff0',
			content: "Hello\nworld's",
			name: 'readme'
		});
		model.records.push({
			columns: ['id', 'n', 'ok'],
			rows: [
				[1, "it's", true],
				[2, null, false]
			],
			schema: 'auth',
			table: 'users'
		});
		const text = roundTrip(model);
		expect(text.startsWith('Project "shop \\"main\\"" {')).toBe(true);
	});

	test('an empty model prints as an empty document', () => {
		expect(printDbml(emptyModel())).toBe('\n');
	});
});
