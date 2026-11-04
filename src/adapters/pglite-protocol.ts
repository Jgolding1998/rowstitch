/**
 * PGlite through its public raw protocol, so status is the real ReadyForQuery byte rather than inferred from isInTransaction,
 * which cannot tell T from E. One extended Parse per query refuses scripts. Everything stays positional raw text with its OID.
 */
import { uint32Oid, type Status } from './shared.js';

interface Message { readonly name?: unknown; readonly [key: string]: unknown }
export interface PgliteSerializer {
  parse(options: { text: string }): Uint8Array;
  bind(options: { values: readonly (string | null)[] }): Uint8Array;
  describe(options: { type: 'P' }): Uint8Array;
  execute(options: Record<string, never>): Uint8Array;
  sync(): Uint8Array;
}
export interface PgliteOutcome {
  readonly status: Status;
  readonly error?: Message;
  readonly afterCommandComplete?: boolean;
  readonly result?: { readonly fields: readonly { name: string; typeOid: number }[]; readonly rows: readonly (readonly (string | null)[])[]; readonly commandTag: string };
}

const IGNORED_MESSAGES: ReadonlySet<unknown> = new Set(['notice', 'notification', 'parameterStatus']);
const malformed = (reason: string): Error => new Error(reason);
const concatenated = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};
/** Each part is copied as it is produced, in case the serializer reuses its buffer. */
export function extendedStatement(serialize: PgliteSerializer, sql: string, values: readonly (string | null)[]): Uint8Array {
  return concatenated([
    new Uint8Array(serialize.parse({ text: sql })),
    new Uint8Array(serialize.bind({ values })),
    new Uint8Array(serialize.describe({ type: 'P' })),
    new Uint8Array(serialize.execute({})),
    new Uint8Array(serialize.sync()),
  ]);
}
/**
 * The replies to Parse, Bind, Describe(portal), Execute and Sync arrive in this order, and an ordinary error can stop them at
 * any point, including after rows or after CommandComplete, when an implicit commit fails at Sync. Returns how far the legal
 * order reached.
 */
function readLegalPrefix(body: readonly Message[]): { at: number; described?: Message; completed?: Message; rows: (readonly (string | null)[])[] } {
  let at = 0, described: Message | undefined, completed: Message | undefined;
  const rows: (readonly (string | null)[])[] = [];
  if (body[at]?.name === 'parseComplete' && body[++at]?.name === 'bindComplete') {
    const next = body[++at];
    if (next?.name === 'rowDescription' || next?.name === 'noData') {
      described = next; at++;
      const fields = described.name === 'rowDescription' ? described.fields as { format?: unknown }[] : [];
      if (!Array.isArray(fields) || !fields.every(field => field.format === 0)) throw malformed('Text results only');
      if (described.name === 'rowDescription') while (body[at]?.name === 'dataRow') {
        const row = body[at]!.fields as (string | null)[];
        if (!Array.isArray(row) || row.length !== fields.length) throw malformed('Row width must match its description');
        rows.push(row); at++;
      }
      if (body[at]?.name === 'commandComplete') {
        completed = body[at++];
        if (typeof completed!.text !== 'string' || !/^[A-Z]/.test(completed!.text)) throw malformed('Malformed command tag');
      }
    }
  }
  return { at, rows, ...(described ? { described } : {}), ...(completed ? { completed } : {}) };
}
/** The whole response must be one exchange ending in one ReadyForQuery. Anything else is not a known outcome. */
export function readExchange(messages: unknown): PgliteOutcome {
  if (!Array.isArray(messages)) throw malformed('Messages required');
  const list = (messages as Message[]).filter(message => !IGNORED_MESSAGES.has(message?.name));
  const last = list.at(-1);
  if (last?.name !== 'readyForQuery' || !['I', 'T', 'E'].includes(last.status as string)) throw malformed('No ReadyForQuery ended this exchange');
  const status = last.status as Status;
  const body = list.slice(0, -1);
  if (body.some(message => message?.name === 'readyForQuery')) throw malformed('More than one ReadyForQuery');
  const error = body.at(-1)?.name === 'error' ? body.at(-1) : undefined;
  const replies = error ? body.slice(0, -1) : body;
  const { at, described, completed, rows } = readLegalPrefix(replies);
  if (at !== replies.length) throw malformed('Replies must follow the legal order of one extended query');
  // Rows already received before an error are discarded: the statement is reported only as rejected.
  if (error) return { status, error, afterCommandComplete: completed !== undefined };
  if (!described || !completed) throw malformed('A successful exchange is complete');
  const fields = described.name === 'rowDescription' ? described.fields as { name: string; dataTypeID: unknown }[] : [];
  return { status, result: { fields: fields.map(field => ({ name: field.name, typeOid: uint32Oid(field.dataTypeID) })), rows, commandTag: completed.text as string } };
}
