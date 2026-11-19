# @absolutejs/dbml

Turn any Drizzle schema, or a live Postgres database, into
[DBML](https://dbml.dbdiagram.io/docs/), so it can be drawn as a diagram,
read in a review, or kept next to the code.

```ts
import { printDbml } from '@absolutejs/dbml';
import { fromDrizzle } from '@absolutejs/dbml/drizzle';
import * as schema from './db/schema';

const dbml = printDbml(fromDrizzle(schema));
```

```ts
import { fromPostgres } from '@absolutejs/dbml/postgres';

// Any driver: give it a function that runs one query with $1-style parameters.
const model = await fromPostgres((text, params) => client.query(text, params).then((result) => result.rows));
```

Or from a terminal:

```sh
bunx @absolutejs/dbml src/db/schema.ts -o schema.dbml
bunx @absolutejs/dbml --postgres "$DATABASE_URL" --records 5
```

## What it covers

**From a Drizzle schema** (Drizzle 1.0, every dialect: PostgreSQL, MySQL,
SQLite, SingleStore, SQL Server, CockroachDB):

- tables in their schemas, every column type, arrays of any depth;
- enums, named (`pgEnum`, `pgSchema.enum`) and inline (MySQL's `enum(...)`,
  SQLite text limited to some values, which become named enums);
- primary keys, composite and named; unique columns and constraints;
- identity, serial and auto-increment columns, generated columns;
- defaults, literal and SQL, and values the app sets (`$defaultFn`,
  `$onUpdate`, `onUpdateNow`);
- indexes with their order, method (`gin`, `brin`, `hash`...), expressions,
  predicates and options; checks;
- foreign keys with `on delete` / `on update`, one-to-one where the columns
  are unique;
- relations, both `defineRelations` and the older `relations()`: one over a
  foreign key names it; one with no foreign key is an `inactive` ref (a link
  the app relies on that the database doesn't enforce); a many-to-many through
  a junction table is a `<>` ref;
- views and materialized views, as tables set apart with lineage (`Dep`) from
  every table they read;
- row-level security and policies, sequences and roles.

**From a live Postgres database**, read from its own catalogs, so it draws
what is actually there whatever made it: all of the above that a database
holds, plus comments as notes, partitioned tables, deferrable keys, exclusion
constraints and included index columns, and optionally each table's first
rows as `Records`. It only reads, through the query function you give it, so
run it in a read-only transaction.

Anything DBML has no syntax for is said in a note rather than dropped. Every
construct is tested by printing it and reading it back with the official DBML
parser.

## The model

`fromDrizzle` and `fromPostgres` both return a `DbmlModel`: plain data
(tables, columns, indexes, refs, enums, deps, groups, notes, records) that
`printDbml` writes as DBML. Anything that draws a diagram can read the model
directly instead of parsing the text back.

## License

MIT
