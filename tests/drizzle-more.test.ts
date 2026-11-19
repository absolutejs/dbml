import { describe, expect, test } from 'bun:test';
import { defineRelations, sql } from 'drizzle-orm';
import * as pg from 'drizzle-orm/pg-core';
import { fromDrizzle } from '../src/drizzle';
import { roundTrip } from './roundTrip';

describe('Drizzle 1.0 casing', () => {
	test('a table made with snake_case casing reads with its database names', () => {
		const snakeTable = pg.pgTableCreator((name) => name, 'snake_case');
		const events = snakeTable(
			'events',
			{
				createdAt: pg.timestamp(),
				explicit: pg.text('Explicit_Name'),
				userId: pg.integer()
			},
			(table) => [
				pg.check('positive_user', sql`${table.userId} > 0`),
				pg.index('events_created').on(table.createdAt)
			]
		);
		const model = fromDrizzle({ events });
		const table = model.tables[0];
		expect(table?.columns.map((column) => column.name)).toEqual([
			'created_at',
			'Explicit_Name',
			'user_id'
		]);
		expect(table?.checks).toEqual([
			{ expression: '"user_id" > 0', name: 'positive_user' }
		]);
		expect(table?.indexes[0]?.parts).toEqual([
			{ column: 'created_at', kind: 'column' }
		]);
		roundTrip(model);
	});
});

describe('enums made from an object', () => {
	test('read like any named enum', () => {
		const status = pg.pgEnum('status', { Done: 'done', Open: 'open' });
		const tasks = pg.pgTable('tasks', { state: status().default('open') });
		const model = fromDrizzle({ status, tasks });
		expect(model.enums).toEqual([
			{ name: 'status', values: [{ name: 'done' }, { name: 'open' }] }
		]);
		expect(model.tables[0]?.columns[0]).toMatchObject({
			default: { kind: 'string', value: 'open' },
			type: 'status'
		});
		roundTrip(model);
	});
});

describe('relations declared on the many side, and filtered ones', () => {
	const users = pg.pgTable('users', { id: pg.integer().primaryKey() });
	const posts = pg.pgTable('posts', {
		authorId: pg.integer('author_id').references(() => users.id),
		id: pg.integer().primaryKey(),
		published: pg.boolean(),
		reviewerId: pg.integer('reviewer_id')
	});
	const relationsV2 = defineRelations({ posts, users }, (r) => ({
		posts: {
			author: r.one.users({
				alias: 'author',
				from: r.posts.authorId,
				to: r.users.id
			})
		},
		users: {
			published: r.many.posts({
				alias: 'published',
				from: r.users.id,
				to: r.posts.authorId,
				where: { published: true }
			}),
			reviewing: r.many.posts({
				alias: 'reviewing',
				from: r.users.id,
				to: r.posts.reviewerId
			})
		}
	}));
	const model = fromDrizzle({ posts, relationsV2, users });

	test('a filtered relation over a foreign key says its filter', () => {
		expect(model.refs[0]).toMatchObject({
			from: { columns: ['author_id'], table: 'posts' },
			note: 'Read in the app as posts.author, users.published where {"published":true}'
		});
	});

	test('a many with its own from and to is a link from the key to the one side', () => {
		expect(model.refs[1]).toEqual({
			from: { columns: ['reviewer_id'], table: 'posts' },
			inactive: true,
			note: "Not a foreign key: the app's relation users.reviewing",
			relation: '>',
			to: { columns: ['id'], table: 'users' }
		});
		roundTrip(model);
	});
});
