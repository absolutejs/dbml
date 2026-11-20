import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { appRelationsFromSource, isSchemaSource } from '../src/drizzle-source';
import { emptyModel, withAppRelations, type DbmlModel } from '../src/model';
import { roundTrip } from './roundTrip';

const FIXTURES = join(import.meta.dir, 'fixtures', 'app-schema');
const files = readdirSync(FIXTURES)
	/* In name order: a directory lists in whatever order its filesystem keeps. */
	.sort()
	.map((name) => ({
		path: name,
		text: readFileSync(join(FIXTURES, name), 'utf8')
	}));
const links = appRelationsFromSource(files);
const brief = (link: (typeof links)[number]) =>
	`${link.from.schema ? `${link.from.schema}.` : ''}${link.from.table}(${link.from.columns.join()}) > ${link.to.table}(${link.to.columns.join()}) as ${link.field}${link.where ? ` where ${link.where}` : ''}${link.foreignKey ? ' [fk]' : ''}`;

describe('an app’s relations, read from its source without running it', () => {
	test('every kind of link Drizzle declares, in database names', () => {
		expect(links.map(brief)).toEqual([
			'posts(author_id) > users(id) as posts.author_id [fk]',
			/* legacy.ts, read before relations.ts. */
			'billing.invoices(user_id) > users(id) as invoices.owner',
			'billing.invoices(user_id) > users(id) as invoices.payer',
			'posts(author_id) > users(id) as posts.author',
			'members(user_id) > users(id) as users.groups',
			'members(group_id) > groups(id) as users.groups',
			'posts(reviewer_id) > users(id) as users.reviewing where { published: true }',
			'users(team_id) > teams(id) as users.team'
		]);
		expect(links[0]?.onDelete).toBe('cascade');
	});

	test('only TypeScript that imports Drizzle is read', () => {
		expect(
			isSchemaSource(
				'db/schema.ts',
				"import { pgTable } from 'drizzle-orm/pg-core';"
			)
		).toBe(true);
		expect(
			isSchemaSource(
				'db/schema.d.ts',
				"import { pgTable } from 'drizzle-orm/pg-core';"
			)
		).toBe(false);
		expect(isSchemaSource('notes.md', "from 'drizzle-orm'")).toBe(false);
	});

	test('nothing is run: a schema that would throw is still read', () => {
		const read = appRelationsFromSource([
			{
				path: 'evil.ts',
				text: `import * as pg from 'drizzle-orm/pg-core';
throw new Error('ran');
export const a = pg.pgTable('a', { id: pg.integer().primaryKey(), bId: pg.integer('b_id').references(() => b.id) });
export const b = pg.pgTable('b', { id: pg.integer().primaryKey() });`
			}
		]);
		expect(read.map(brief)).toEqual(['a(b_id) > b(id) as a.b_id [fk]']);
	});

	test('a casing setting names columns as the database does', () => {
		const read = appRelationsFromSource([
			{
				path: 'db.ts',
				text: `import * as pg from 'drizzle-orm/pg-core'; import { drizzle } from 'drizzle-orm/node-postgres';
export const db = drizzle({ casing: 'snake_case' });
export const a = pg.pgTable('a', { id: pg.integer().primaryKey(), ownerId: pg.integer().references(() => b.id) });
export const b = pg.pgTable('b', { id: pg.integer().primaryKey() });`
			}
		]);
		expect(read.map(brief)).toEqual([
			'a(owner_id) > b(id) as a.owner_id [fk]'
		]);
	});
});

describe('the live model with the app’s links', () => {
	const table = (name: string, columns: string[], schema?: string) => ({
		checks: [],
		columns: columns.map((column) => ({
			name: column,
			...(column === 'id' ? { pk: true } : {}),
			type: 'integer'
		})),
		indexes: [],
		name,
		...(schema ? { schema } : {})
	});
	const live: DbmlModel = {
		...emptyModel(),
		refs: [
			{
				from: { columns: ['author_id'], table: 'posts' },
				onDelete: 'cascade',
				relation: '>',
				to: { columns: ['id'], table: 'users' }
			}
		],
		/* No groups or members table: the code is ahead of this database. */
		tables: [
			table('users', ['id', 'team_id', 'email']),
			table('teams', ['id']),
			table('posts', ['id', 'author_id', 'reviewer_id', 'published']),
			table('invoices', ['id', 'user_id'], 'billing')
		]
	};
	const merged = withAppRelations(live, links);

	test('a foreign key gains how the app reads it; the rest are dashed links', () => {
		expect(
			merged.refs.map((ref) => [
				`${ref.from.table}.${ref.from.columns.join()}`,
				ref.inactive === true,
				ref.note
			])
		).toEqual([
			[
				'posts.author_id',
				false,
				'Read in the app as posts.author_id, posts.author'
			],
			[
				'invoices.user_id',
				true,
				"Not a foreign key: the app's relation invoices.owner, invoices.payer"
			],
			[
				'posts.reviewer_id',
				true,
				"Not a foreign key: the app's relation users.reviewing where { published: true }"
			],
			[
				'users.team_id',
				true,
				"Not a foreign key: the app's relation users.team"
			]
		]);
		expect(live.refs[0]?.note).toBeUndefined();
		roundTrip(merged);
	});
});
