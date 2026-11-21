import { index, inet, pgTable, text } from 'drizzle-orm/pg-core';
import { actorType } from './enums.js';
import { idCheck, ts } from './_shared.js';

/**
 * Append-only audit log (TRD 6.4, PRD F11). The app role has INSERT and SELECT only.
 * Holds references, never personal content. `ip` is the actor's address (admin and system actors);
 * decide its retention before admin ships.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    at: ts('at').notNull().defaultNow(),
    actorType: actorType('actor_type').notNull(),
    actorId: text('actor_id'),
    role: text('role'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    reason: text('reason'),
    ip: inet('ip'),
    requestId: text('request_id'),
  },
  (t) => [
    index('audit_log_at_idx').on(t.at),
    index('audit_log_target_idx').on(t.targetType, t.targetId),
    index('audit_log_actor_idx').on(t.actorType, t.actorId),
    idCheck(t, 'audit_log', 'aud'),
  ],
);
