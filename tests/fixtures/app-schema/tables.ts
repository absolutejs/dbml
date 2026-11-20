import * as pg from 'drizzle-orm/pg-core';

export const billing = pg.pgSchema('billing');

export const users = pg.pgTable('users', {
	email: pg.text().notNull(), id: pg.integer().primaryKey(), teamId: pg.integer('team_id')
});

export const teams = pg.pgTable('teams', { id: pg.integer().primaryKey() });

export const posts = pg.pgTable('posts', {
	authorId: pg
		.integer('author_id')
		.references(() => users.id, { onDelete: 'cascade' }), id: pg.integer().primaryKey(), published: pg.boolean(), reviewerId: pg.integer('reviewer_id')
});

export const groups = pg.pgTable('groups', { id: pg.integer().primaryKey() });

export const members = pg.pgTable('members', {
	groupId: pg.integer('group_id').notNull(), userId: pg.integer('user_id').notNull()
});

export const invoices = billing.table('invoices', {
	id: pg.integer().primaryKey(),
	userId: pg.integer('user_id')
});
