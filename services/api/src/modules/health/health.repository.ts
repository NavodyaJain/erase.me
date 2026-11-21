export interface Queryable {
  query(text: string): Promise<unknown>;
}

/** The only code that touches the database for health checks. */
export function createHealthRepository(db: Queryable) {
  return {
    async pingDatabase(): Promise<void> {
      await db.query('select 1');
    },
  };
}

export type HealthRepository = ReturnType<typeof createHealthRepository>;
