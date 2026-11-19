import process from 'node:process';
import { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DbmlModel } from '../src/model';
import { fromMysql } from '../src/mysql';
import { roundTrip } from './roundTrip';

/* Runs against a real MySQL (or MariaDB) when DBML_MYSQL_URL names a
 * throwaway one, e.g. `docker run -e MYSQL_ROOT_PASSWORD=probe
 * -p 53306:3306 mysql:8` and mysql://root:probe@127.0.0.1:53306/app. */
const url = process.env.DBML_MYSQL_URL;

const SCHEMA = [
	'drop database if exists app',
	'create database app',
	'use app',
	`create table users (
		id int unsigned auto_increment primary key,
		email varchar(255) not null comment 'Where we write',
		role enum('admin','member') not null default 'member',
		flags set('a','b'),
		score decimal(10,2) default 0,
		bio text,
		created_at timestamp not null default current_timestamp on update current_timestamp,
		shout varchar(255) generated always as (upper(email)) virtual,
		unique key users_email (email),
		key users_bio (bio(20)),
		constraint score_positive check (score >= 0)
	) engine=InnoDB comment='Everyone'`,
	`create table posts (
		id int unsigned auto_increment primary key,
		author_id int unsigned,
		slug varchar(100),
		constraint posts_author foreign key (author_id) references users (id) on delete cascade,
		key posts_slug_desc (slug desc)
	)`,
	`create table profiles (user_id int unsigned primary key, foreign key (user_id) references users (id))`,
	`create table logs (id int not null, at date not null, primary key (id, at)) partition by range (year(at)) (partition p2025 values less than (2026), partition pmax values less than maxvalue)`,
	'create view author_posts as select users.email, posts.slug from posts join users on users.id = posts.author_id',
	'create trigger posts_touch before update on posts for each row set new.slug = lower(new.slug)',
	'create function double_it (x int) returns int deterministic return x * 2',
	"insert into users (email) values ('a@example.com')"
];

let model: DbmlModel;
let mariadb = false;
let database: SQL;

describe.skipIf(!url)('a live MySQL database', () => {
	beforeAll(async () => {
		database = new SQL({ allowPublicKeyRetrieval: true, url: url ?? '' });
		const [version] = await database.unsafe('select version() as version');
		mariadb = /mariadb/iu.test(`${version?.version}`);
		/* In order: each statement builds on the last. */
		await SCHEMA.reduce<Promise<unknown>>(
			(previous, statement) =>
				previous.then(() => database.unsafe(statement)),
			Promise.resolve()
		);
		/* Functional indexes are MySQL's alone. */
		if (!mariadb)
			await database.unsafe(
				'create index users_lower on users ((lower(email)))'
			);
		const query = async (text: string, params: unknown[]) => [
			...(await database.unsafe(text, params))
		];
		model = await fromMysql(query, { schemas: ['app'] });
	});

	afterAll(async () => {
		await database?.close();
	});

	const table = (name: string) =>
		model.tables.find((entry) => entry.name === name);
	const column = (tableName: string, name: string) =>
		table(tableName)?.columns.find((entry) => entry.name === name);

	test('reads back from DBML exactly as meant', () => {
		roundTrip(model);
	});

	test('columns: types, enums and sets, defaults, generation, comments', () => {
		expect(column('users', 'id')).toMatchObject({
			increment: true,
			pk: true,
			/* MariaDB still writes the display width. */
			type: expect.stringMatching(/^int(\(10\))? unsigned$/u)
		});
		expect(column('users', 'email')).toMatchObject({
			note: 'Where we write',
			notNull: true,
			type: 'varchar(255)'
		});
		/* A unique key with its own name keeps it, as an index. */
		expect(
			table('users')?.indexes.find(
				(entry) => entry.name === 'users_email'
			)
		).toMatchObject({ unique: true });
		expect(column('users', 'role')).toMatchObject({
			default: { kind: 'string', value: 'member' },
			type: 'users_role'
		});
		expect(
			model.enums.map((entry) => [
				entry.name,
				entry.values.map((value) => value.name)
			])
		).toEqual([
			['users_role', ['admin', 'member']],
			['users_flags', ['a', 'b']]
		]);
		expect(column('users', 'score')?.default).toEqual({
			kind: 'number',
			value: 0
		});
		expect(column('users', 'created_at')).toMatchObject({
			/* Each server's own spelling. */
			default: {
				kind: 'expression',
				value: expect.stringMatching(/^current_timestamp(\(\))?$/iu)
			}
		});
		expect(column('users', 'created_at')?.note).toContain(
			'on every update'
		);
		expect(column('users', 'shout')?.note).toContain('Generated always as');
	});

	test('indexes: prefixes, expressions, order', () => {
		const index = (tableName: string, name: string) =>
			table(tableName)?.indexes.find((entry) => entry.name === name);
		expect(index('users', 'users_bio')?.note).toBe('Prefix: bio(20)');
		if (!mariadb)
			expect(index('users', 'users_lower')?.parts[0]).toMatchObject({
				kind: 'expression'
			});
		expect(index('posts', 'posts_slug_desc')?.parts[0]).toEqual({
			column: 'slug',
			desc: true,
			kind: 'column'
		});
	});

	test('checks, foreign keys and one-to-one links', () => {
		expect(table('users')?.checks).toEqual([
			{ expression: '`score` >= 0', name: 'score_positive' }
		]);
		expect(
			model.refs.map((ref) => [
				ref.from.table,
				ref.relation,
				ref.to.table,
				ref.onDelete,
				ref.name
			])
		).toEqual(
			expect.arrayContaining([
				['posts', '>', 'users', 'cascade', 'posts_author'],
				['profiles', '-', 'users', undefined, undefined]
			])
		);
	});

	test('engine, partitions, triggers, views and routines', () => {
		expect(table('users')).toMatchObject({
			metadata: { engine: 'InnoDB' },
			note: 'Everyone'
		});
		expect(table('logs')?.note).toContain('Partition p2025');
		expect(table('posts')?.note).toContain(
			'Trigger posts_touch BEFORE UPDATE'
		);
		expect(table('author_posts')?.headerColor).toBe('#64748b');
		expect(model.deps.map((dep) => dep.upstream.table).sort()).toEqual([
			'posts',
			'users'
		]);
		expect(
			model.notes.find((note) => note.name === 'functions')?.content
		).toContain('double_it(');
	});
});
