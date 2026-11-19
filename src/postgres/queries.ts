/*
 * What a Postgres database says about its own structure, from the system
 * catalogs, one query per kind of thing. Every query takes the schemas to
 * read as its only parameter ($1, a text array) and reads nothing else.
 */

export const SCHEMAS = `
select nspname as name
from pg_namespace
where nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
	and nspname not like 'pg_temp_%' and nspname not like 'pg_toast_temp_%'
order by nspname`;

export const ENUMS = `
select n.nspname as schema, t.typname as name,
	array_agg(e.enumlabel order by e.enumsortorder) as "values"
from pg_type t
join pg_namespace n on n.oid = t.typnamespace
join pg_enum e on e.enumtypid = t.oid
where n.nspname = any($1)
group by n.nspname, t.typname
order by n.nspname, t.typname`;

/* Tables, partitioned tables, views, materialized views and foreign
 * tables; a partition is drawn as part of its parent, not on its own. */
export const RELATIONS = `
select c.oid::int as id, n.nspname as schema, c.relname as name, c.relkind as kind,
	obj_description(c.oid, 'pg_class') as comment,
	c.relrowsecurity as rls, c.relforcerowsecurity as force_rls,
	case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end as partition_key,
	case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid, true) end as definition,
	(select count(*)::int from pg_inherits i where i.inhparent = c.oid) as partitions
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = any($1) and c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
order by n.nspname, c.relname`;

export const COLUMNS = `
select a.attrelid::int as table_id, a.attnum::int as position, a.attname as name,
	format_type(a.atttypid, a.atttypmod) as type,
	a.attnotnull as not_null, a.attidentity as identity, a.attgenerated as generated,
	pg_get_expr(d.adbin, d.adrelid) as "default",
	col_description(a.attrelid, a.attnum) as comment,
	case when t.typtype = 'e' then tn.nspname
		when et.typtype = 'e' then etn.nspname end as enum_schema,
	coalesce(case when t.typtype = 'e' then t.typname end,
		case when et.typtype = 'e' then et.typname || '[]' end) as enum_type,
	pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) as serial_sequence
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_type t on t.oid = a.atttypid
join pg_namespace tn on tn.oid = t.typnamespace
left join pg_type et on et.oid = t.typelem and t.typcategory = 'A'
left join pg_namespace etn on etn.oid = et.typnamespace
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where n.nspname = any($1) and c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
	and a.attnum > 0 and not a.attisdropped
order by a.attrelid, a.attnum`;

/* Keys, uniques, foreign keys, checks and exclusions, columns by position
 * in their table. */
export const CONSTRAINTS = `
select con.conrelid::int as table_id, con.conname as name, con.contype as kind,
	(select array_agg(k::int order by o) from unnest(con.conkey) with ordinality as u(k, o)) as columns,
	con.confrelid::int as foreign_table_id,
	(select array_agg(k::int order by o) from unnest(con.confkey) with ordinality as u(k, o)) as foreign_columns,
	con.confdeltype as on_delete, con.confupdtype as on_update,
	pg_get_constraintdef(con.oid, true) as definition,
	case when con.contype = 'c' then pg_get_expr(con.conbin, con.conrelid, true) end as check_expression,
	obj_description(con.oid, 'pg_constraint') as comment,
	con.condeferrable as deferrable, con.condeferred as deferred,
	/* Read through jsonb so a Postgres older than 15, without the column,
	 * reads null instead of failing. */
	(to_jsonb(con) ->> 'connullsnotdistinct')::boolean as nulls_not_distinct
from pg_constraint con
join pg_namespace n on n.oid = con.connamespace
where n.nspname = any($1) and con.contype in ('p', 'u', 'f', 'c', 'x') and con.conrelid <> 0
order by con.conrelid, con.contype, con.conname`;

/* Indexes that aren't the ones a key or unique constraint makes: each key
 * part as Postgres writes it, descending ones flagged, and any included
 * columns and predicate. */
export const INDEXES = `
select i.indrelid::int as table_id, ic.relname as name, am.amname as method,
	i.indisunique as is_unique, i.indnkeyatts::int as key_count, i.indnatts::int as count,
	(select array_agg(pg_get_indexdef(i.indexrelid, k, true) order by k)
		from generate_series(1, i.indnatts) as k) as parts,
	(select array_agg(i.indkey[k - 1]::int order by k)
		from generate_series(1, i.indnatts) as k) as attnums,
	(select array_agg((i.indoption[k - 1] & 1) = 1 order by k)
		from generate_series(1, i.indnkeyatts) as k) as descending,
	pg_get_expr(i.indpred, i.indrelid, true) as predicate,
	obj_description(i.indexrelid, 'pg_class') as comment
from pg_index i
join pg_class ic on ic.oid = i.indexrelid
join pg_class tc on tc.oid = i.indrelid
join pg_namespace n on n.oid = tc.relnamespace
join pg_am am on am.oid = ic.relam
where n.nspname = any($1)
	and not exists (select 1 from pg_constraint con where con.conindid = i.indexrelid and con.contype in ('p', 'u', 'x'))
order by i.indrelid, ic.relname`;

/* Which tables and views each view or materialized view reads. */
export const VIEW_SOURCES = `
select distinct v.oid::int as view_id, d.refobjid::int as source_id
from pg_class v
join pg_namespace n on n.oid = v.relnamespace
join pg_rewrite r on r.ev_class = v.oid
join pg_depend d on d.objid = r.oid and d.classid = 'pg_rewrite'::regclass
	and d.refclassid = 'pg_class'::regclass and d.refobjid <> v.oid
where n.nspname = any($1) and v.relkind in ('v', 'm')`;

export const POLICIES = `
select p.polrelid::int as table_id, p.polname as name, p.polpermissive as permissive,
	p.polcmd as command,
	(select array_agg(case when r = 0 then 'public' else pg_get_userbyid(r) end) from unnest(p.polroles) as r) as roles,
	pg_get_expr(p.polqual, p.polrelid, true) as "using",
	pg_get_expr(p.polwithcheck, p.polrelid, true) as with_check
from pg_policy p
join pg_class c on c.oid = p.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = any($1)
order by p.polrelid, p.polname`;

/* Sequences that aren't a serial or identity column's own. */
export const SEQUENCES = `
select n.nspname as schema, c.relname as name, s.seqstart::text as start,
	s.seqincrement::text as increment
from pg_sequence s
join pg_class c on c.oid = s.seqrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = any($1)
	and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i'))
order by n.nspname, c.relname`;

export const SCHEMA_COMMENTS = `
select nspname as name, obj_description(oid, 'pg_namespace') as comment
from pg_namespace where nspname = any($1)`;
