import { createNativeGraphResources, NATIVE_GRAPH_LIMITS, type GraphResources, type GraphSourceCosts } from '../../src/core/graph-resources.js';

const meter: GraphResources = createNativeGraphResources({ wireBytes: 0, units: 1000 });
const storage: Record<string, unknown> = { id: 1n, __rs_bad: 0n };
const costs: GraphSourceCosts = meter.source(storage);
const row: Record<string, unknown> = { id: 1 };
meter.attach(row, costs);
meter.relatedWire(0);
meter.outputRecord(row, ['id'] as const);
meter.outputAlias('children', 2);
meter.outputAlias('parent', null);
meter.outputArray(1);
const fieldCost: number = costs.id;
// @ts-expect-error Source costs require opaque provenance, not a caller numeric record.
const forged: GraphSourceCosts = { id: 16 };
// @ts-expect-error Numeric source metadata is readonly.
costs.id = 1;
// @ts-expect-error Fixed native policy limits are readonly.
NATIVE_GRAPH_LIMITS.units = 1;
// @ts-expect-error Native limits need both exact numeric controls.
createNativeGraphResources({ units: 1 });
// @ts-expect-error No arbitrary public option is part of this private seam.
createNativeGraphResources({ units: 1, wireBytes: 1, maxRows: 1 });
// @ts-expect-error Limits are numeric, not coercible strings.
createNativeGraphResources({ units: '1', wireBytes: 1 });
// @ts-expect-error A source row is a record, not SQL text.
meter.source('SELECT private');
// @ts-expect-error Attachment requires opaque source metadata.
meter.attach(row, { id: 16 });
// @ts-expect-error Logical rows must be records.
meter.attach(1, costs);
// @ts-expect-error Wire byte counts are numeric.
meter.relatedWire('1');
// @ts-expect-error Output fields are strings.
meter.outputRecord(row, [1]);
// @ts-expect-error Output fields are a list, not a selector callback.
meter.outputRecord(row, () => ['id']);
// @ts-expect-error Alias references are a count or null, not an actual graph value.
meter.outputAlias('children', []);
// @ts-expect-error Alias names are plain strings.
meter.outputAlias({}, null);
// @ts-expect-error Root array length is numeric.
meter.outputArray(null);
// @ts-expect-error The resource counters are not public mutable state.
meter.remaining = 100;
// @ts-expect-error Wire accounting returns no raw response or numeric counter.
const response: number = meter.relatedWire(0);
// @ts-expect-error Output accounting does not expose caller data.
const output: Record<string, unknown> = meter.outputRecord(row, ['id']);
void [fieldCost, forged, response, output];
