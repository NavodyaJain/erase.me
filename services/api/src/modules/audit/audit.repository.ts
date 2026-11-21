import { newId } from '../../common/ids.js';
import type { Db } from '../../db/client.js';
import { auditLog } from '../../db/schema/index.js';

export interface AuditEntry {
  actorType: 'user' | 'system' | 'admin';
  actorId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  requestId?: string;
}

/** Append-only. Holds ids and action names, never personal content. */
export function createAuditRepository(db: Db) {
  return {
    async record(e: AuditEntry): Promise<void> {
      await db.insert(auditLog).values({
        id: newId('audit'),
        actorType: e.actorType,
        actorId: e.actorId ?? null,
        action: e.action,
        targetType: e.targetType ?? null,
        targetId: e.targetId ?? null,
        requestId: e.requestId ?? null,
      });
    },
  };
}
export type AuditRepository = ReturnType<typeof createAuditRepository>;
