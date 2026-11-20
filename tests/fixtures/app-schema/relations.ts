import { defineRelations } from 'drizzle-orm';
import * as schema from './tables';

export const relationsV2 = defineRelations(schema, (r) => ({
	invoices: {
		payer: r.one.users({ from: r.invoices.userId, to: r.users.id })
	}, posts: {
		author: r.one.users({ from: r.posts.authorId, to: r.users.id })
	}, users: {
		groups: r.many.groups({
			from: r.users.id.through(r.members.userId),
			to: r.groups.id.through(r.members.groupId)
		}), reviewing: r.many.posts({
			from: r.users.id,
			to: r.posts.reviewerId,
			where: { published: true }
		}), team: r.one.teams({ from: r.users.teamId, to: r.teams.id })
	}
}));
