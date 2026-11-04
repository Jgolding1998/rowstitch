/** Generated SQL only: average a finite float8 SUM and its int8 non-NULL count without PostgreSQL variance state. */
const cast = (name: string): string => '::"pg_catalog"."' + name + '"';
const op = (left: string, operator: '+' | '-' | '*' | '/' | '%' | '<' | '<=' | '>' | '>=' | '=' | '<>', right: string): string =>
  '(' + left + ' OPERATOR("pg_catalog".' + operator + ') ' + right + ')';

/**
 * Native float8 AVG also accumulates squared deviations, which can overflow when SUM and the mean remain finite.
 * SUM/count avoids that state, but PostgreSQL float8 division rejects a nonzero quotient rounded down to zero.
 * Below 2^62 minimum-subnormal units, compute the quotient in integer units first, rounding ties to even.
 * Larger sums cannot divide down to zero for a positive int8 count, even after that count rounds to float8.
 *
 * This keeps native SUM's approximate/order-sensitive behavior. It is not a compensated or exact real SUM.
 * The integer-unit branch can double-round near normal values; the native corpus bounds that error separately.
 * sum/count references are trusted compiler expressions over a materialized aggregate row, never caller SQL.
 */
export function postgresRealAverage(sum: string, count: string): string {
  const zero = '0' + cast('int8'), two = '2' + cast('int8');
  const minimum = "'5e-324'" + cast('float8');
  const cutoff = "'2.2784756311113742e-305'" + cast('float8');
  const units = '(' + op(sum, '/', minimum) + ')' + cast('int8');
  const quotient = op(units, '/', count), remainder = '"pg_catalog"."abs"(' + op(units, '%', count) + ')';
  // Comparing r with n-r avoids an int8 overflow from 2*r.
  const otherHalf = op(count, '-', remainder);
  const round = '(' + op(remainder, '>', otherHalf) + ' OR (' + op(remainder, '=', otherHalf)
    + ' AND ' + op(op(quotient, '%', two), '<>', zero) + '))';
  const direction = '(CASE WHEN ' + op(sum, '<', '0' + cast('float8')) + " THEN '-1'" + cast('int8') + ' ELSE 1' + cast('int8') + ' END)';
  const rounded = op(quotient, '+', '(CASE WHEN ' + round + ' THEN ' + direction + ' ELSE ' + zero + ' END)');
  const negative = op('"pg_catalog"."get_byte"("pg_catalog"."float8send"(' + sum + '), 0)', '>=', '128');
  const tiny = '(CASE WHEN ' + op(rounded, '=', zero) + ' AND ' + negative + " THEN '-0'" + cast('float8')
    + ' ELSE ' + op('(' + rounded + ')' + cast('float8'), '*', minimum) + ' END)';
  return '(CASE WHEN ' + op(count, '=', zero) + ' THEN NULL' + cast('float8')
    + ' WHEN ' + op('"pg_catalog"."abs"(' + sum + ')', '<=', cutoff) + ' THEN ' + tiny
    + ' ELSE ' + op(sum, '/', '(' + count + ')' + cast('float8')) + ' END)';
}
