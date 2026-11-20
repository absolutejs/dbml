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
	and not exists (select 1 from pg_depend x where x.classid = 'pg_type'::regclass and x.objid = t.oid and x.deptype = 'e')
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
	(select count(*)::int from pg_inherits i where i.inhparent = c.oid) as partitions,
	pg_get_userbyid(c.relowner) as owner,
	c.relpersistence as persistence,
	array_to_string(c.reloptions, ', ') as options,
	/* A partitioned table holds nothing itself: its rows and size are its
	 * partitions', every level down. */
	case
		when c.relkind = 'p' then (select sum(greatest(l.reltuples, 0))::bigint::text
			from pg_partition_tree(c.oid) t join pg_class l on l.oid = t.relid where t.isleaf)
		when c.reltuples >= 0 then c.reltuples::bigint::text
	end as row_estimate,
	case
		when c.relkind = 'p' then (select coalesce(sum(pg_total_relation_size(t.relid)), 0)::text
			from pg_partition_tree(c.oid) t where t.isleaf)
		when c.relkind in ('r', 'm') then pg_total_relation_size(c.oid)::text
	end as size_bytes,
	(select string_agg(g.privilege_type || ' to ' || case when g.grantee = 0 then 'public' else pg_get_userbyid(g.grantee) end, ', ' order by g.grantee, g.privilege_type)
		from aclexplode(c.relacl) as g where g.grantee <> c.relowner) as grants,
	(select s.srvname from pg_foreign_table ft join pg_foreign_server s on s.oid = ft.ftserver where ft.ftrelid = c.oid) as foreign_server,
	(select array_to_string(ft.ftoptions, ', ') from pg_foreign_table ft where ft.ftrelid = c.oid) as foreign_options,
	(select string_agg(quote_ident(pn.nspname) || '.' || quote_ident(p.relname), ', ')
		from pg_inherits i join pg_class p on p.oid = i.inhparent join pg_namespace pn on pn.oid = p.relnamespace
		where i.inhrelid = c.oid and p.relkind <> 'p') as inherits
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = any($1) and c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
	and not exists (select 1 from pg_depend e where e.classid = 'pg_class'::regclass and e.objid = c.oid and e.deptype = 'e')
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
	pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) as serial_sequence,
	case when a.attcollation <> 0 and a.attcollation <> t.typcollation then (select collname from pg_collation where oid = a.attcollation) end as collation,
	case to_jsonb(a) ->> 'attcompression' when 'p' then 'pglz' when 'l' then 'lz4' end as compression,
	case when a.attidentity <> '' then (select s.seqstart::text || ' ' || s.seqincrement::text from pg_sequence s
		where s.seqrelid = pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname)::regclass) end as identity_sequence,
	case when t.typtype = 'd' then format_type(t.typbasetype, t.typtypmod) end as domain_base
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
	(select array_agg((i.indoption[k - 1] & 2) = 2 order by k)
		from generate_series(1, i.indnkeyatts) as k) as nulls_first,
	/* An operator class or collation that isn't the column's own, per key
	 * part, empty where it is. */
	(select array_agg(case when opc.opcdefault then '' else opc.opcname end order by k)
		from generate_series(1, i.indnkeyatts) as k join pg_opclass opc on opc.oid = i.indclass[k - 1]) as opclasses,
	(select array_agg(coalesce((select co.collname from pg_collation co where co.oid = i.indcollation[k - 1]
			and i.indcollation[k - 1] <> coalesce((select a.attcollation from pg_attribute a where a.attrelid = i.indrelid and a.attnum = i.indkey[k - 1]), 0)
			and co.collname <> 'default'), '') order by k)
		from generate_series(1, i.indnkeyatts) as k) as collations,
	(to_jsonb(i) ->> 'indnullsnotdistinct')::boolean as nulls_not_distinct,
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

/* Triggers a table fires, written as Postgres would create them. */
export const TRIGGERS = `
select t.tgrelid::int as table_id, t.tgname as name, pg_get_triggerdef(t.oid, true) as definition,
	t.tgenabled as enabled
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = any($1) and not t.tgisinternal
order by t.tgrelid, t.tgname`;

/* Rewrite rules other than a view's own. */
export const RULES = `
select r.ev_class::int as table_id, r.rulename as name, pg_get_ruledef(r.oid, true) as definition
from pg_rewrite r
join pg_class c on c.oid = r.ev_class
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = any($1) and r.rulename <> '_RETURN'
order by r.ev_class, r.rulename`;

/* Functions, procedures and aggregates the app defines (not an
 * extension's). */
export const FUNCTIONS = `
select n.nspname as schema, p.proname as name, p.prokind as kind,
	pg_get_function_identity_arguments(p.oid) as arguments,
	pg_get_function_result(p.oid) as result, l.lanname as language
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language l on l.oid = p.prolang
where n.nspname = any($1)
	and not exists (select 1 from pg_depend e where e.classid = 'pg_proc'::regclass and e.objid = p.oid and e.deptype = 'e')
order by n.nspname, p.proname, arguments`;

export const DOMAINS = `
select n.nspname as schema, t.typname as name, format_type(t.typbasetype, t.typtypmod) as base,
	t.typnotnull as not_null, t.typdefault as "default",
	(select string_agg(pg_get_constraintdef(con.oid, true), ' and ' order by con.conname)
		/* Postgres 17 also keeps NOT NULL as a constraint; typnotnull says it. */
		from pg_constraint con where con.contypid = t.oid and con.contype <> 'n') as constraints
from pg_type t
join pg_namespace n on n.oid = t.typnamespace
where n.nspname = any($1) and t.typtype = 'd'
	and not exists (select 1 from pg_depend e where e.classid = 'pg_type'::regclass and e.objid = t.oid and e.deptype = 'e')
order by n.nspname, t.typname`;

/* Composite types made with CREATE TYPE ... AS (not a table's row type). */
export const COMPOSITES = `
select n.nspname as schema, t.typname as name,
	string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attnum) as fields
from pg_type t
join pg_namespace n on n.oid = t.typnamespace
join pg_class c on c.oid = t.typrelid and c.relkind = 'c'
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where n.nspname = any($1)
	and not exists (select 1 from pg_depend e where e.classid = 'pg_type'::regclass and e.objid = t.oid and e.deptype = 'e')
group by n.nspname, t.typname
order by n.nspname, t.typname`;

/* Extensions installed in the database (plpgsql is always there). */
export const EXTENSIONS = `
select e.extname as name, e.extversion as version, n.nspname as schema
from pg_extension e
join pg_namespace n on n.oid = e.extnamespace
where e.extname <> 'plpgsql'
order by e.extname`;

export const EVENT_TRIGGERS = `
select evtname as name, evtevent as event, evtfoid::regproc::text as function, evtenabled as enabled
from pg_event_trigger
order by evtname`;

/* Each partitioned table's partitions and the rows each takes. */
export const PARTITIONS = `
select i.inhparent::int as table_id, c.relname as name, pg_get_expr(c.relpartbound, c.oid, true) as bound
from pg_inherits i
join pg_class c on c.oid = i.inhrelid
join pg_class p on p.oid = i.inhparent
join pg_namespace n on n.oid = p.relnamespace
where n.nspname = any($1) and p.relkind = 'p'
order by i.inhparent, c.relname`;

/* Which table columns each view reads, for column-level lineage. */
export const VIEW_COLUMNS = `
select distinct v.oid::int as view_id, d.refobjid::int as source_id, a.attname as name
from pg_class v
join pg_namespace n on n.oid = v.relnamespace
join pg_rewrite r on r.ev_class = v.oid
join pg_depend d on d.objid = r.oid and d.classid = 'pg_rewrite'::regclass
	and d.refclassid = 'pg_class'::regclass and d.refobjid <> v.oid and d.refobjsubid > 0
join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
where n.nspname = any($1) and v.relkind in ('v', 'm')
order by view_id, source_id, name`;
