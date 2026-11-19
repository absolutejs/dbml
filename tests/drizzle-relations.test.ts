import { describe, expect, test } from 'bun:test';
import { defineRelations, eq, sql } from 'drizzle-orm';
import { relations } from 'drizzle-orm/_relations';
import * as pg from 'drizzle-orm/pg-core';
import * as sqlite from 'drizzle-orm/sqlite-core';
import { fromDrizzle } from '../src/drizzle';
import { roundTrip } from './roundTrip';

const users = pg.pgTable('users', {
	id: pg.integer().primaryKey(),
	invitedBy: pg.integer('invited_by'),
	name: pg.text()
});
const posts = pg.pgTable('posts', {
	authorId: pg.integer('author_id').references(() => users.id),
	editorId: pg.integer('editor_id'),
	id: pg.integer().primaryKey()
});
const settings = pg.pgTable('settings', {
	userId: pg.integer('user_id').unique()
});
const groups = pg.pgTable('groups', { id: pg.integer().primaryKey() });
const members = pg.pgTable('members', {
	groupId: pg.integer('group_id').notNull(),
	userId: pg.integer('user_id').notNull()
});

describe('defineRelations (Drizzle 1.0)', () => {
	const relationsV2 = defineRelations(
		{ groups, members, posts, settings, users },
		(r) => ({
			posts: {
				author: r.one.users({
					alias: 'author',
					from: r.posts.authorId,
					to: r.users.id
				}),
				editor: r.one.users({
					alias: 'editor',
					from: r.posts.editorId,
					to: r.users.id
				})
			},
			settings: {
				user: r.one.users({ from: r.settings.userId, to: r.users.id })
			},
			users: {
				groups: r.many.groups({
					from: r.users.id.through(r.members.userId),
					to: r.groups.id.through(r.members.groupId)
				}),
				posts: r.many.posts({ alias: 'author' })
			}
		})
	);

	test('passed as an option or exported with the schema, the same refs', () => {
		const passed = fromDrizzle(
			{ groups, members, posts, settings, users },
			{ relations: relationsV2 }
		);
		const exported = fromDrizzle({
			groups,
			members,
			posts,
			relationsV2,
			settings,
			users
		});
		expect(exported.refs).toEqual(passed.refs);
		roundTrip(passed);
	});

	test('a relation over a foreign key names it; the rest are inactive refs', () => {
		const model = fromDrizzle({
			groups,
			members,
			posts,
			relationsV2,
			settings,
			users
		});
		expect(model.refs).toEqual([
			{
				from: { columns: ['author_id'], table: 'posts' },
				note: 'Read in the app as posts.author',
				relation: '>',
				to: { columns: ['id'], table: 'users' }
			},
			{
				from: { columns: ['editor_id'], table: 'posts' },
				inactive: true,
				note: "Not a foreign key: the app's relation posts.editor",
				relation: '>',
				to: { columns: ['id'], table: 'users' }
			},
			{
				from: { columns: ['user_id'], table: 'settings' },
				inactive: true,
				note: "Not a foreign key: the app's relation settings.user",
				relation: '-',
				to: { columns: ['id'], table: 'users' }
			},
			{
				from: { columns: ['id'], table: 'users' },
				inactive: true,
				note: 'Many-to-many through members, read as users.groups',
				relation: '<>',
				to: { columns: ['id'], table: 'groups' }
			}
		]);
	});
});

describe('relations() (the older style)', () => {
	const usersRelations = relations(users, ({ many, one }) => ({
		inviter: one(users, {
			fields: [users.invitedBy],
			references: [users.id],
			relationName: 'invites'
		}),
		posts: many(posts)
	}));
	const postsRelations = relations(posts, ({ one }) => ({
		author: one(users, { fields: [posts.authorId], references: [users.id] })
	}));

	test('read from the schema exports, a self-relation included', () => {
		const model = fromDrizzle({
			posts,
			postsRelations,
			users,
			usersRelations
		});
		expect(model.refs).toEqual([
			{
				from: { columns: ['author_id'], table: 'posts' },
				note: 'Read in the app as posts.author',
				relation: '>',
				to: { columns: ['id'], table: 'users' }
			},
			{
				from: { columns: ['invited_by'], table: 'users' },
				inactive: true,
				note: "Not a foreign key: the app's relation users.inviter",
				relation: '>',
				to: { columns: ['id'], table: 'users' }
			}
		]);
		roundTrip(model);
	});
});

describe('views', () => {
	const active = pg.pgView('active_posts').as((query) =>
		query
			.select({
				author: users.name,
				count: sql<number>`count(*)`.as('count'),
				id: posts.id
			})
			.from(posts)
			.leftJoin(users, eq(users.id, posts.authorId))
	);
	const totals = pg
		.pgMaterializedView('totals', { total: pg.integer() })
		.existing();
	const model = fromDrizzle({ active, posts, totals, users });
	const view = model.tables.find((table) => table.name === 'active_posts');

	test('a view is a table set apart, with lineage from every table it reads', () => {
		roundTrip(model);
		expect(view?.headerColor).toBe('#64748b');
		expect(view?.note).toBe(
			'View:\nselect "users"."name", count(*) as "count", "posts"."id" from "posts" left join "users" on "users"."id" = "posts"."author_id"'
		);
		expect(
			model.deps
				.map(
					(dep) => `${dep.upstream.table} -> ${dep.downstream.table}`
				)
				.sort()
		).toEqual(['posts -> active_posts', 'users -> active_posts']);
	});

	test("its columns: where they came from, and what's computed", () => {
		expect(view?.columns).toEqual([
			{ name: 'author', note: 'From users.name', type: 'text' },
			{ name: 'count', note: 'Computed: count(*)', type: 'unknown' },
			{ name: 'id', type: 'integer' }
		]);
	});

	test('a view that already exists says its query lives in the database', () => {
		expect(
			model.tables.find((table) => table.name === 'totals')?.note
		).toBe(
			'Materialized view that already exists in the database; its query lives there'
		);
	});

	test('SQLite views too', () => {
		const notes = sqlite.sqliteTable('notes', {
			id: sqlite.integer().primaryKey(),
			title: sqlite.text()
		});
		const titles = sqlite
			.sqliteView('titles')
			.as((query) => query.select({ title: notes.title }).from(notes));
		const result = fromDrizzle({ notes, titles });
		expect(result.deps).toEqual([
			{ downstream: { table: 'titles' }, upstream: { table: 'notes' } }
		]);
		roundTrip(result);
	});
});
