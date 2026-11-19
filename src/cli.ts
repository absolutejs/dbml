#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { SQL } from 'bun';
import { fromDrizzle, type FromDrizzleOptions } from './drizzle';
import { fromPostgres } from './postgres';
import { printDbml } from './print';

/*
 * absolute-dbml: a Drizzle schema file, or a live Postgres database, as
 * DBML (or the model as JSON). A database is read in a read-only
 * transaction that times out, so pointing this at production is safe.
 */

export const USAGE = `Usage:
  absolute-dbml <schema.ts> [options]          a Drizzle schema module
  absolute-dbml --postgres <url> [options]     a live Postgres database

Options:
  -o, --output <file>     write to a file instead of standard output
      --json              print the model as JSON instead of DBML
      --name <name>       the project's name
      --groups schema     group tables by schema
      --relations <name>  the schema module's defineRelations export
      --schema <name>     a schema to read (repeatable; Postgres only)
      --records <n>       each table's first n rows as Records (Postgres only)
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
		name: { type: 'string' },
		output: { short: 'o', type: 'string' },
		postgres: { type: 'string' },
		records: { type: 'string' },
		relations: { type: 'string' },
		schema: { multiple: true, type: 'string' }
	}
});

if (values.help) {
	process.stdout.write(USAGE);
	process.exit(0);
}

const project = values.name ? { name: values.name } : undefined;

const STATEMENT_TIMEOUT = '15s';

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
					...(project ? { project } : {}),
					...(limit > 0 ? { records: { limit } } : {}),
					...(values.schema ? { schemas: values.schema } : {})
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
	if (source) return readSchema(source);

	return fail('Give a schema file or --postgres <url>.');
};

const model = await readModel();
const output = values.json
	? `${JSON.stringify(model, null, '\t')}\n`
	: printDbml(model);

if (values.output) writeFileSync(resolve(values.output), output);
else process.stdout.write(output);
