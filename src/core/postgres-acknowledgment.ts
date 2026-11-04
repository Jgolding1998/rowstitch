/** Private evidence from a confirmed native ErrorResponse. Never attaches SQLSTATE or driver details to public errors. */
import { RowstitchError } from './errors.js';
import { acknowledgedRejection, isAcknowledgedRejection } from './executor.js';

const states = new WeakMap<object, string>();

/** Only the executor calls this after validating ReadyForQuery and the request's rejection transition. */
export function acknowledgedPostgresRejection(code: string, sqlstate: string): RowstitchError {
  const error = acknowledgedRejection(new RowstitchError(code, 'A PostgreSQL engine response rejected this operation.'));
  states.set(error, sqlstate);
  return error;
}

/** Called only by a compiled summary that contains native real SUM arithmetic, after session state was processed. */
export function postgresRealAggregateError(error: unknown): unknown {
  if (isAcknowledgedRejection(error) && states.get(error) === '22003') {
    return new RowstitchError('AGGREGATE_RANGE', 'An aggregate result is not a finite number.');
  }
  return error;
}
