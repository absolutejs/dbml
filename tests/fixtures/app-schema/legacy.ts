import { relations } from 'drizzle-orm/_relations';
import { invoices, users } from './tables';

export const invoiceRelations = relations(invoices, ({ one }) => ({
	owner: one(users, { fields: [invoices.userId], references: [users.id] })
}));
