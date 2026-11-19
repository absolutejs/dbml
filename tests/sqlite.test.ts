import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { fromSqlite } from '../src/sqlite';
import { printedNote, roundTrip } from './roundTrip';

/* A real SQLite database (bun:sqlite, in memory), built by hand-written
 * SQL. */
const database = new Database(':memory:');
database.exec(`
create table users (
	id integer primary key autoincrement,
	email text not null unique collate nocase,
	score real default 0 check (score >= 0),
	label text default 'it''s',
	joined text default (datetime('now')),
	shout text generated always as (upper(email)) virtual,
	constraint email_shape check (email like '%@%')
);
create table posts (
	id integer primary key,
	author_id integer references users (id) on delete cascade,
	slug text,
	lang text,
	unique (slug, lang)
) strict;
create table tags (post_id integer references posts (id), tag text, primary key (post_id, tag)) without rowid;
create table profiles (user_id integer primary key references users (id), bio text);
create index posts_lower on posts (lower(slug)) where slug is not null;
create index posts_lang_desc on posts (lang desc);
create index users_email_nocase on users (email collate nocase);
create index posts_slug_nocase on posts (slug collate nocase);
create view author_posts as select users.email, posts.slug from posts join users on users.id = posts.author_id;
create trigger posts_touch after update on posts begin update posts set slug = slug where id = new.id; end;
insert into users (email) values ('a@example.com'), ('b@example.com');
`);
const query = (text: string, params: unknown[]) =>
	database
		.query<Record<string, unknown>, (number | string)[]>(text)
		.all(
			...params.map((param) =>
				typeof param === 'number' ? param : `${param}`
			)
		);
const model = await fromSqlite(query, { statistics: true });
const table = (name: string) =>
	model.tables.find((entry) => entry.name === name);
const column = (tableName: string, name: string) =>
	table(tableName)?.columns.find((entry) => entry.name === name);

describe('a live SQLite database', () => {
	test('reads back from DBML exactly as meant', () => {
		roundTrip(model);
		expect(model.project?.databaseType).toBe('SQLite');
	});

	test('columns: the row id key, defaults, collations, generated columns', () => {
		expect(column('users', 'id')).toMatchObject({
			increment: true,
			note: 'AUTOINCREMENT: ids are never reused',
			pk: true,
			type: 'integer'
		});
		expect(column('users', 'email')).toMatchObject({
			metadata: { collation: 'nocase' },
			notNull: true,
			unique: true
		});
		expect(column('users', 'score')?.default).toEqual({
			kind: 'number',
			value: 0
		});
		expect(column('users', 'label')?.default).toEqual({
			kind: 'string',
			value: "it's"
		});
		expect(column('users', 'joined')?.default).toEqual({
			kind: 'expression',
			value: "datetime('now')"
		});
		expect(column('users', 'shout')?.note).toBe(
			'Generated always as (upper(email)), virtual'
		);
	});

	test('checks, named and not', () => {
		expect(table('users')?.checks).toEqual([
			{ expression: 'score >= 0' },
			{ expression: "email like '%@%'", name: 'email_shape' }
		]);
	});

	test('indexes: expressions, predicates, order, collations, and unique constraints', () => {
		expect(
			table('posts')?.indexes.filter(
				(entry) => entry.name !== 'posts_slug_nocase'
			)
		).toEqual([
			{
				name: 'posts_lang_desc',
				parts: [{ column: 'lang', desc: true, kind: 'column' }]
			},
			{
				name: 'posts_lower',
				note: 'Where slug is not null',
				parts: [{ expression: 'lower(slug)', kind: 'expression' }]
			},
			{
				parts: [
					{ column: 'slug', kind: 'column' },
					{ column: 'lang', kind: 'column' }
				],
				unique: true
			}
		]);
		/* The column's own collation says nothing; a different one does. */
		expect(
			table('users')?.indexes.find(
				(entry) => entry.name === 'users_email_nocase'
			)?.note
		).toBeUndefined();
		expect(
			table('posts')?.indexes.find(
				(entry) => entry.name === 'posts_slug_nocase'
			)?.note
		).toBe('Collation: slug nocase');
	});

	test('keys: composite, a strict table, a table without row ids, one-to-one', () => {
		expect(table('tags')).toMatchObject({
			indexes: [{ pk: true }],
			metadata: { without_rowid: true }
		});
		expect(table('posts')?.metadata).toEqual({ rows: 0, strict: true });
		expect(table('users')?.metadata).toEqual({ rows: 2 });
		expect(
			model.refs.map((ref) => [
				ref.from.table,
				ref.from.columns.join(),
				ref.relation,
				ref.to.table,
				ref.onDelete
			])
		).toEqual([
			['posts', 'author_id', '>', 'users', 'cascade'],
			['tags', 'post_id', '>', 'posts', undefined],
			['profiles', 'user_id', '-', 'users', undefined]
		]);
	});

	test('views with the tables they read, and triggers on their tables', () => {
		expect(table('author_posts')?.headerColor).toBe('#64748b');
		expect(model.deps.map((dep) => dep.upstream.table).sort()).toEqual([
			'posts',
			'users'
		]);
		expect(printedNote(table('posts'))).toBe(
			'Trigger posts_touch: after update on posts begin update posts set slug = slug where id = new.id; end'
		);
	});
});
