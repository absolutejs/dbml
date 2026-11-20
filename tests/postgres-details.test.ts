import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { file_fdw } from '@electric-sql/pglite/contrib/file_fdw';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DbmlModel } from '../src/model';
import { fromPostgres, type PostgresQuery } from '../src/postgres';
import { printedNote, roundTrip } from './roundTrip';

/* Everything a Postgres database holds beyond tables, keys and indexes,
 * built for real (extensions included) so each is read from the catalogs
 * the way any database has it. */
const SCHEMA = `
create extension pg_trgm;
create extension citext;
create extension file_fdw;
create role reader;

create domain email as text not null default 'x@example.com' check (value like '%@%');
create type address as (street text, city text);

create table people (
	id integer generated always as identity (start with 100 increment by 5) primary key,
	handle citext,
	name text collate "C",
	bio text compression pglz,
	contact email,
	home address,
	score integer
) with (fillfactor = 70);
grant select on people to reader;

create index people_name_trgm on people using gin (name gin_trgm_ops);
create index people_handle_c on people (bio collate "C");
create index people_score_nulls on people (score nulls first);
create unique index people_handle_once on people (handle) nulls not distinct;

create function stamp() returns trigger language plpgsql as $$ begin new.score := coalesce(new.score, 0); return new; end $$;
create trigger people_stamp before insert or update on people for each row execute function stamp();
create procedure tidy(days integer) language sql as $$ select 1 $$;

create table audit_log (id integer, at timestamptz);
create rule audit_never_delete as on delete to audit_log do instead nothing;

create table base_items (id integer primary key, label text);
create table special_items (extra text) inherits (base_items);
create unlogged table scratch (id integer);
create table readings (id integer, at date not null) partition by range (at);
create table readings_2026 partition of readings for values from ('2026-01-01') to ('2027-01-01') partition by range (at);
create table readings_2026_h1 partition of readings_2026 for values from ('2026-01-01') to ('2026-07-01');
create table readings_2027 partition of readings for values from ('2027-01-01') to ('2028-01-01');
insert into readings select g, date '2026-02-01' + (g % 500) from generate_series(1, 300) g where date '2026-02-01' + (g % 500) < date '2026-07-01' or date '2026-02-01' + (g % 500) >= date '2027-01-01';

create server files foreign data wrapper file_fdw;
create foreign table imported (line text) server files options (filename '/dev/null', format 'text');

create view people_names as select id, name from people;

create function on_ddl() returns event_trigger language plpgsql as $$ begin end $$;
create event trigger ddl_watch on ddl_command_end execute function on_ddl();

insert into people (handle, name, score) values ('ann', 'Ann', 3), ('bo', 'Bo', null);
analyze;
`;

let database: PGlite;
let model: DbmlModel;
let query: PostgresQuery;

beforeAll(async () => {
	database = new PGlite({ extensions: { citext, file_fdw, pg_trgm } });
	await database.exec(SCHEMA);
	query = async (text, params) =>
		(await database.query<Record<string, unknown>>(text, params)).rows;
	model = await fromPostgres(query, {
		schemas: ['public'],
		statistics: true
	});
});

afterAll(async () => {
	await database.close();
});

const table = (name: string) =>
	model.tables.find((entry) => entry.name === name);
const column = (tableName: string, name: string) =>
	table(tableName)?.columns.find((entry) => entry.name === name);
const note = (name: string) =>
	model.notes.find((entry) => entry.name === name)?.content;

describe('what a Postgres database holds beyond its tables', () => {
	test('reads back from DBML exactly as meant', () => {
		roundTrip(model);
	});

	test('table facts as metadata: owner, grants, storage options, statistics', () => {
		expect(table('people')?.metadata).toMatchObject({
			grants: 'SELECT to reader',
			options: 'fillfactor=70',
			owner: 'postgres',
			rows: 2
		});
		const size = table('people')?.metadata?.size_bytes;
		expect(typeof size === 'number' && size > 0).toBe(true);
		expect(table('scratch')?.metadata).toMatchObject({ unlogged: true });
		expect(table('imported')?.metadata).toMatchObject({
			foreign_options: 'filename=/dev/null, format=text',
			foreign_server: 'files'
		});
	});

	test('column facts: collation, compression, a domain, an identity sequence', () => {
		expect(column('people', 'name')?.metadata).toEqual({ collation: 'C' });
		expect(column('people', 'bio')?.metadata).toEqual({
			compression: 'pglz'
		});
		expect(column('people', 'contact')).toMatchObject({
			metadata: { domain_of: 'text' },
			type: 'email'
		});
		expect(column('people', 'id')?.metadata).toEqual({
			identity_increment: 5,
			identity_start: 100
		});
	});

	test('index details: operator class, collation, nulls ordering, nulls not distinct', () => {
		const index = (name: string) =>
			table('people')?.indexes.find((entry) => entry.name === name);
		expect(index('people_name_trgm')).toMatchObject({
			note: 'Operator class: name gin_trgm_ops',
			type: 'gin'
		});
		expect(index('people_handle_c')?.note).toBe('Collation: bio C');
		expect(index('people_score_nulls')?.note).toBe(
			'Sorted with score nulls first'
		);
		expect(index('people_handle_once')).toMatchObject({
			note: 'Nulls not distinct',
			unique: true
		});
	});

	test('triggers, rules and inheritance on their tables', () => {
		expect(printedNote(table('people'))).toBe(
			'Trigger people_stamp: BEFORE INSERT OR UPDATE ON people FOR EACH ROW EXECUTE FUNCTION stamp()'
		);
		expect(printedNote(table('audit_log'))).toBe(
			'Rule audit_never_delete: ON DELETE TO audit_log DO INSTEAD NOTHING;'
		);
		expect(table('special_items')).toMatchObject({
			details: [{ kind: 'inherits', text: 'public.base_items' }],
			metadata: { inherits: 'public.base_items' }
		});
		/* As data, for anything that draws them. */
		expect(table('people')?.details).toEqual([
			{
				kind: 'trigger',
				name: 'people_stamp',
				text: 'BEFORE INSERT OR UPDATE ON people FOR EACH ROW EXECUTE FUNCTION stamp()'
			}
		]);
	});

	test('functions, domains, composite types, extensions and event triggers as sticky notes', () => {
		expect(note('functions')).toBe(
			'Functions and procedures\non_ddl() → event_trigger, function in plpgsql\nstamp() → trigger, function in plpgsql\ntidy(IN days integer), procedure in sql'
		);
		expect(note('domains')).toBe(
			"Domains\nemail: text, not null, default 'x@example.com'::text, CHECK (VALUE ~~ '%@%'::text)"
		);
		expect(note('composite_types')).toBe(
			'Composite types\naddress: street text, city text'
		);
		/* Versions are the build's; the shape is what's read. */
		expect(note('extensions')).toMatch(
			/^Extensions\ncitext [\d.]+, in public\nfile_fdw [\d.]+, in public\npg_trgm [\d.]+, in public$/u
		);
		expect(note('event_triggers')).toBe(
			'Event triggers\nddl_watch: on ddl_command_end, runs on_ddl'
		);
	});

	test('nothing an extension installed is taken for the app’s own', () => {
		expect(note('functions')).not.toContain('similarity');
		expect(model.enums).toEqual([]);
	});

	test('a view’s lineage names the columns it reads', () => {
		expect(model.deps).toEqual([
			{
				downstream: { table: 'people_names' },
				upstream: { columns: ['id', 'name'], table: 'people' }
			}
		]);
	});

	test('a partitioned table counts what its partitions hold, every level down', () => {
		const readings = table('readings')?.metadata;
		expect(readings?.rows).toBeGreaterThan(0);
		expect(
			typeof readings?.size_bytes === 'number' && readings.size_bytes > 0
		).toBe(true);
	});

	test('statistics stay out unless asked for', async () => {
		const plain = await fromPostgres(query, { schemas: ['public'] });
		expect(
			plain.tables.find((entry) => entry.name === 'people')?.metadata
				?.rows
		).toBeUndefined();
	});
});
