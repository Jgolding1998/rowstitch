/** Internal per-Work accounting for native eager graphs. Not a driver-allocation or JavaScript heap limit. */
import { RowstitchError } from './errors.js';
import { types } from 'node:util';

export const NATIVE_GRAPH_LIMITS: Readonly<{ wireBytes: number; units: number }> = Object.freeze({
  wireBytes: 33_554_432, units: 268_435_456,
});
declare const sourceCostsBrand: unique symbol;
/** Numeric metadata is accepted only by the meter that created it. It retains no storage or logical values. */
export type GraphSourceCosts = Readonly<Record<string, number>> & { readonly [sourceCostsBrand]: true };
export interface GraphResources {
  source(storage: Record<string, unknown>): GraphSourceCosts;
  attach(row: Record<string, unknown>, costs: GraphSourceCosts): void;
  relatedWire(bytes: number): void;
  outputRecord(row: Record<string, unknown>, fields: readonly string[]): void;
  outputAlias(name: string, entries: number | null): void;
  outputArray(length: number): void;
}

const { isProxy } = types;
const { getPrototypeOf, ownKeys } = Reflect;
const { getOwnPropertyDescriptors, hasOwn, freeze } = Object;
const MAX_NODES = 100_000, MAX_DEPTH = 64, SAFE = Number.MAX_SAFE_INTEGER;
const bad = (): never => { throw new RowstitchError('DATA', 'Native graph accounting data is invalid.'); };
const limited = (): never => { throw new RowstitchError('RESULT_LIMIT', 'The native eager graph exceeds its resource budget. Narrow the selected fields or page limits.'); };

function descriptors(value: unknown): Record<string, PropertyDescriptor> {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
    || ![null, Object.prototype].includes(getPrototypeOf(value))) return bad();
  const result = getOwnPropertyDescriptors(value);
  for (const key of ownKeys(result)) {
    if (typeof key !== 'string') return bad();
    const property = result[key]!;
    if (!hasOwn(property, 'value') || !property.enumerable) return bad();
  }
  return result;
}
function natural(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return bad();
  return value;
}
function add(a: number, b: number): number {
  if (b > SAFE - a) return limited();
  return a + b;
}
function text(value: string): number { return Math.max(Buffer.byteLength(value, 'utf8'), value.length * 2); }
function property(name: string): number { return add(16, text(name)); }
function primitive(value: unknown): number {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return 16;
  if (typeof value === 'string') return add(16, text(value));
  if (typeof value === 'bigint') return add(16, text(String(value)));
  return bad();
}
function array(length: number): number {
  if (length > Math.floor((SAFE - 32) / 8)) return limited();
  return 32 + length * 8;
}
/** Own dense array data only; neither caller descriptors nor inherited serialization behavior is evaluated. */
function elements(value: unknown): unknown[] {
  if (!value || typeof value !== 'object' || isProxy(value) || !Array.isArray(value)) return bad();
  const prototype = getPrototypeOf(value);
  if (prototype !== null && prototype !== Array.prototype) return bad();
  const props = getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>, length: unknown = props.length?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || ownKeys(props).length !== length + 1) return bad();
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const item = hasOwn(props, String(i)) ? props[String(i)] : undefined;
    if (!item || !hasOwn(item, 'value') || !item.enumerable) return bad();
    result.push(item.value);
  }
  return result;
}
function jsonUnits(value: object): number {
  let nodes = 0;
  const active = new Set<object>();
  function visit(item: unknown, depth: number): number {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return bad();
    if (item === null || typeof item === 'boolean' || typeof item === 'string'
      || typeof item === 'number' && Number.isFinite(item)) return primitive(item);
    if (!item || typeof item !== 'object' || isProxy(item) || active.has(item)) return bad();
    active.add(item);
    let units: number;
    if (Array.isArray(item)) {
      const values = elements(item);
      if (values.length > MAX_NODES) return bad();
      units = array(values.length);
      for (const child of values) units = add(units, visit(child, depth + 1));
    } else {
      const props = descriptors(item);
      units = 32;
      for (const name of Object.keys(props)) units = add(units, add(property(name), visit(props[name]!.value, depth + 1)));
    }
    active.delete(item);
    return units;
  }
  return visit(value, 0);
}

/** Private smaller test limits may never increase the native defaults. */
export function createNativeGraphResources(limits?: { wireBytes: number; units: number }): GraphResources {
  let wire = NATIVE_GRAPH_LIMITS.wireBytes, units = NATIVE_GRAPH_LIMITS.units;
  if (limits !== undefined) {
    const props = descriptors(limits);
    if (Object.keys(props).length !== 2 || !hasOwn(props, 'wireBytes') || !hasOwn(props, 'units')) return bad();
    wire = natural(props.wireBytes!.value); units = natural(props.units!.value);
    if (wire > NATIVE_GRAPH_LIMITS.wireBytes || units > NATIVE_GRAPH_LIMITS.units) return bad();
  }
  const ownedCosts = new WeakSet<object>(), attached = new WeakMap<object, Readonly<Record<string, number>>>();
  const charge = (amount: number): void => { if (amount > units) limited(); units -= amount; };
  return freeze({
    source(storage: Record<string, unknown>): GraphSourceCosts {
      const props = descriptors(storage), costs: Record<string, number> = Object.create(null);
      let total = 32;
      for (const name of Object.keys(props)) {
        const cost = add(property(name), primitive(props[name]!.value));
        costs[name] = cost; total = add(total, cost);
      }
      charge(total);
      const captured = freeze(costs);
      ownedCosts.add(captured);
      return captured as GraphSourceCosts;
    },
    attach(row: Record<string, unknown>, costs: GraphSourceCosts): void {
      if (!costs || typeof costs !== 'object' || isProxy(costs) || !ownedCosts.has(costs)) return bad();
      const props = descriptors(row);
      if (attached.has(row)) return bad();
      const copied: Record<string, number> = Object.create(null);
      let total = 0;
      for (const name of Object.keys(props)) {
        if (!hasOwn(costs, name)) return bad();
        const value: unknown = props[name]!.value;
        const object = value !== null && typeof value === 'object';
        const logical = object ? jsonUnits(value) : primitive(value);
        if (object) total = add(total, logical);
        copied[name] = Math.max(costs[name]!, add(property(name), logical));
      }
      charge(total);
      attached.set(row, freeze(copied));
    },
    relatedWire(bytes: number): void {
      const amount = natural(bytes);
      if (amount > wire) return limited();
      wire -= amount;
    },
    outputRecord(row: Record<string, unknown>, fields: readonly string[]): void {
      if (!row || typeof row !== 'object' || isProxy(row)) return bad();
      const costs = attached.get(row);
      if (!costs) return bad();
      const names = elements(fields), seen = new Set<string>();
      let total = 32;
      for (const name of names) {
        if (typeof name !== 'string' || seen.has(name) || !hasOwn(costs, name)) return bad();
        seen.add(name); total = add(total, costs[name]!);
      }
      charge(total);
    },
    outputAlias(name: string, entries: number | null): void {
      if (typeof name !== 'string') return bad();
      charge(add(property(name), entries === null ? 16 : array(natural(entries))));
    },
    outputArray(length: number): void { charge(array(natural(length))); },
  });
}
