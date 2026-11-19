#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { SQL } from 'bun';
import { Database } from 'bun:sqlite';
import { fromDrizzle, type FromDrizzleOptions } from './drizzle';
import { fromMysql, type FromMysqlOptions } from './mysql';
import { fromPostgres } from './postgres';
import { printDbml } from './print';
import { fromSqlite } from './sqlite';

/*
 * absolute-dbml: a Drizzle schema file, or a live Postgres, MySQL, MariaDB
 * or SQLite database, as DBML (or the model as JSON). A database is only
 * read (a read-only transaction or connection with a statement timeout,
 * or a SQLite file opened read-only), so pointing this at production is
 * safe.
 */

export const USAGE = `Usage:
  absolute-dbml <schema.ts> [options]          a Drizzle schema module
  absolute-dbml --postgres <url> [options]     a live Postgres database
  absolute-dbml --mysql <url> [options]        a live MySQL or MariaDB database
  absolute-dbml --sqlite <file> [options]      a SQLite database file

Options:
  -o, --output <file>     write to a file instead of standard output
      --json              print the model as JSON instead of DBML
      --name <name>       the project's name
      --groups schema     group tables by schema
      --relations <name>  the schema module's defineRelations export
      --schema <name>     a schema (or MySQL database) to read (repeatable)
      --records <n>       each table's first n rows as Records (Postgres only)
      --statistics        each table's row count and size, as metadata
  -h, --help              show this help
`;

const fail = (message: string) => {
	process.stderr.write(`${message}\n\n${USAGE}`);
	process.exit(1);
};

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: {
		groups: { type: 'string' },
		help: { short: 'h', type: 'boolean' },
		json: { type: 'boolean' },
		mysql: { type: 'string' },
		name: { type: 'string' },
		output: { short: 'o', type: 'string' },
		postgres: { type: 'string' },
		records: { type: 'string' },
		relations: { type: 'string' },
		schema: { multiple: true, type: 'string' },
		sqlite: { type: 'string' },
		statistics: { type: 'boolean' }
	}
});

if (values.help) {
	process.stdout.write(USAGE);
	process.exit(0);
}

const project = values.name ? { name: values.name } : undefined;

const STATEMENT_TIMEOUT = '15s';
const TIMEOUT_MS = 15_000;

const shared: Pick<
	FromMysqlOptions,
	'groups' | 'project' | 'schemas' | 'statistics'
> = {
	...(project ? { project } : {}),
	...(values.groups === 'schema' ? { groups: 'schema' } : {}),
	...(values.schema ? { schemas: values.schema } : {}),
	...(values.statistics ? { statistics: true } : {})
};

/* One connection of its own, made read-only with a statement timeout
 * (MySQL's max_execution_time, MariaDB's max_statement_time) before
 * anything is read. */
const readMysql = async (url: string) => {
	const client = new SQL({ max: 1, url });
	try {
		const connection = await client.reserve();
		await connection.unsafe('SET SESSION TRANSACTION READ ONLY');
		await connection
			.unsafe(`SET SESSION max_execution_time = ${TIMEOUT_MS}`)
			.catch(() =>
				connection.unsafe(
					`SET SESSION max_statement_time = ${TIMEOUT_MS / 1000}`
				)
			);

		return await fromMysql(async (text, params) => {
			const rows: Record<string, unknown>[] = await connection.unsafe(
				text,
				params
			);

			return [...rows];
		}, shared);
	} finally {
		await client.close();
	}
};

const readSqlite = async (file: string) => {
	const database = new Database(resolve(file), { readonly: true });
	try {
		return await fromSqlite(
			(text, params) =>
				database
					.query<Record<string, unknown>, (number | string)[]>(text)
					.all(
						...params.map((param) =>
							typeof param === 'number' ? param : `${param}`
						)
					),
			shared
		);
	} finally {
		database.close();
	}
};

const readDatabase = async (url: string) => {
	const client = new SQL({ max: 1, url });
	try {
		return await client.begin(async (transaction) => {
			await transaction`SET TRANSACTION READ ONLY`;
			await transaction.unsafe(
				`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`
			);
			const limit = Number.parseInt(values.records ?? '0', 10);

			return fromPostgres(
				async (text, params) => {
					const rows: Record<string, unknown>[] =
						await transaction.unsafe(text, params);

					return rows;
				},
				{
					...shared,
					...(limit > 0 ? { records: { limit } } : {})
				}
			);
		});
	} finally {
		await client.close();
	}
};

const readSchema = async (file: string) => {
	const module: Record<string, unknown> = await import(
		pathToFileURL(resolve(file)).href
	);
	const options: FromDrizzleOptions = {
		...(project ? { project } : {}),
		...(values.groups === 'schema' ? { groups: 'schema' } : {}),
		...(values.relations ? { relations: module[values.relations] } : {})
	};

	return fromDrizzle(module, options);
};

const [source] = positionals;

const readModel = () => {
	if (values.postgres) return readDatabase(values.postgres);
	if (values.mysql) return readMysql(values.mysql);
	if (values.sqlite) return readSqlite(values.sqlite);
	if (source) return readSchema(source);

	return fail(
		'Give a schema file, --postgres <url>, --mysql <url> or --sqlite <file>.'
	);
};

const model = await readModel();
const output = values.json
	? `${JSON.stringify(model, null, '\t')}\n`
	: printDbml(model);

if (values.output) writeFileSync(resolve(values.output), output);
else process.stdout.write(output);
