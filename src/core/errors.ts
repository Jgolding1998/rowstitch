/** Stable errors never include bound values, database paths or driver messages. */
export class RowstitchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RowstitchError';
  }
}

export class ConflictError extends RowstitchError {
  constructor() {
    super('CONFLICT', 'The record changed or no longer exists. Read it again before saving.');
    this.name = 'ConflictError';
  }
}

export function fail(code: string, message: string): never {
  throw new RowstitchError(code, message);
}

export function databaseError(error: unknown): RowstitchError {
  if (error instanceof RowstitchError) return error;
  const code = error && typeof error === 'object' && 'errcode' in error
    ? Number(error.errcode) & 255 : 0;
  if (code === 5 || code === 6) return new RowstitchError('BUSY', 'The SQLite database is busy. No callback was automatically retried.');
  if (code === 19) return new RowstitchError('CONSTRAINT', 'A database constraint rejected this change.');
  if (code === 8) return new RowstitchError('READ_ONLY', 'This database is read-only.');
  return new RowstitchError('DATABASE_ERROR', 'SQLite could not complete this operation.');
}
