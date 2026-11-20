import { PGlite } from '@electric-sql/pglite';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { fromDbml } from '../src/dbml';
import { diffModels } from '../src/diff';
import { fromPostgres } from '../src/postgres';
import { printDbml } from '../src/print';
import { fromSqlite } from '../src/sqlite';

/* Read back what's printed and print it again: the same text means
 * nothing was lost on the way in. */
const again = (dbml: string) => printDbml(fromDbml(dbml));

describe('DBML read back into a model', () => {
	test('a live Postgres schema prints the same after a trip through fromDbml', async () => {
		const database = new PGlite();
		await database.exec(`
create schema billing;
create type mood as enum ('happy', 'sad');
create table users (id serial primary key, email text not null unique, feeling mood default 'happy', tags text[], score numeric(10, 2) default 0 check (score >= 0));
comment on table users is 'Everyone';
create table billing.invoices (id integer generated always as identity primary key, user_id integer references users(id) on delete cascade, total numeric, constraint total_positive check (total > 0));
create index invoices_total on billing.invoices (total desc) where total > 100;
create view big_invoices as select id, total from billing.invoices where total > 1000;
insert into users (email) values ('a@example.com');
`);
		const model = await fromPostgres(
			async (text, params) =>
				(await database.query<Record<string, unknown>>(text, params))
					.rows,
			{
				groups: 'schema',
				records: { limit: 2 }
			}
		);
		const printed = printDbml(model);
		expect(again(printed)).toBe(printed);
		await database.close();
	});

	test('so does a SQLite one', async () => {
		const database = new Database(':memory:');
		database.exec(`create table a (id integer primary key, name text not null default 'x' collate nocase);
create table b (id integer primary key, a_id integer references a(id) on delete set null, unique (a_id, id));`);
		const model = await fromSqlite((text, params) =>
			database
				.query<Record<string, unknown>, (number | string)[]>(text)
				.all(
					...params.map((param) =>
						typeof param === 'number' ? param : `${param}`
					)
				)
		);
		const printed = printDbml(model);
		expect(again(printed)).toBe(printed);
	});

	test('a hand-written file, read as written', () => {
		const model = fromDbml(`
Project shop { database_type: 'PostgreSQL' }
Table users [headercolor: #3498db] {
  id integer [pk, increment]
  email varchar [not null, unique, note: 'Where we write']
}
Table orders {
  id integer [pk]
  user_id integer [ref: > users.id]
  status varchar [default: 'open']
  Note: 'Every order'
}
TableGroup people { users }
Note todo { 'Add carts' }
`);
		expect(model.project).toEqual({
			databaseType: 'PostgreSQL',
			name: 'shop'
		});
		expect(model.tables.map((table) => table.name)).toEqual([
			'users',
			'orders'
		]);
		expect(model.tables[0]).toMatchObject({ headerColor: '#3498db' });
		expect(model.tables[1]?.columns[2]?.default).toEqual({
			kind: 'string',
			value: 'open'
		});
		expect(model.refs).toEqual([
			{
				from: { columns: ['user_id'], table: 'orders' },
				relation: '>',
				to: { columns: ['id'], table: 'users' }
			}
		]);
		expect(model.tableGroups).toEqual([
			{ name: 'people', tables: [{ table: 'users' }] }
		]);
		expect(model.notes).toEqual([{ content: 'Add carts', name: 'todo' }]);
		/* And a model read from text can be compared like any other. */
		expect(diffModels(model, model)).toEqual([]);
	});
});
