import { column, defineTable, openDatabase, hasMany, hasOne, belongsTo } from '../../src/index.js';

const teams = defineTable('projection_teams', { id: column.integer().primaryKey(), name: column.text(), tag: column.text().nullable() });
const people = defineTable('projection_people', { id: column.integer().primaryKey(), teamId: column.integer().references(teams, 'id'), name: column.text() });
const notes = defineTable('projection_notes', { id: column.integer().primaryKey(), personId: column.integer().references(people, 'id'), body: column.text() });
const db = openDatabase(':memory:', { tables: [teams, people, notes] });
function present<T>(value: T | null | undefined): T { if (value == null) throw new Error('Type fixture requires a row.'); return value; }

const exact = present(db.table(teams).findFirst({ select: ['id', 'name'] }));
const exactId: number = exact.id;
const exactName: string = exact.name;
// @ts-expect-error Exact literal tuples continue to omit every unselected property.
exact.tag;
const exactNullable = present(db.table(teams).findFirst({ select: ['tag'] }));
const nullableTag: string | null = exactNullable.tag;

const arraySelection: ('id' | 'name')[] = ['id'];
const dynamic = present(db.table(teams).findFirst({ select: arraySelection }));
const dynamicId: number | undefined = dynamic.id;
const dynamicName: string | undefined = dynamic.name;
// @ts-expect-error A widened array does not guarantee the id was selected.
const falseDynamicId: number = dynamic.id;
// @ts-expect-error A widened array does not guarantee the name was selected.
const falseDynamicName: string = dynamic.name;
// @ts-expect-error Uncertain properties require a check before a string operation.
dynamic.name.toUpperCase();
// @ts-expect-error A widened array still cannot expose keys outside its possible elements.
dynamic.tag;

const unionSlot: readonly ['id' | 'name'] = [Math.random() ? 'id' : 'name'];
const uncertainTuple = present(db.table(teams).findFirst({ select: unionSlot }));
const uncertainId: number | undefined = uncertainTuple.id;
const uncertainName: string | undefined = uncertainTuple.name;
// @ts-expect-error Fixed tuple length does not make a union-valued slot certain.
const falseUnionId: number = uncertainTuple.id;
// @ts-expect-error A union slot can select id instead of name.
const falseUnionName: string = uncertainTuple.name;

const mixedSlots: readonly ['id', 'name' | 'tag'] = ['id', Math.random() ? 'name' : 'tag'];
const mixed = present(db.table(teams).findFirst({ select: mixedSlots }));
const guaranteedId: number = mixed.id;
const maybeMixedName: string | undefined = mixed.name;
const maybeMixedTag: string | null | undefined = mixed.tag;
// @ts-expect-error An unrelated guaranteed slot cannot make name required.
const falseMixedName: string = mixed.name;
// @ts-expect-error Nullable possible selections retain both null and absence.
const falseMixedTag: string | null = mixed.tag;

const coveredSlot: readonly ['id' | 'name', 'name'] = ['id', 'name'];
const covered = present(db.table(teams).findFirst({ select: coveredSlot }));
const guaranteedName: string = covered.name;
const possiblyCoveredId: number | undefined = covered.id;
// @ts-expect-error Only the singleton name slot is guaranteed.
const falseCoveredId: number = covered.id;

const optionalArray: readonly ('id' | 'name')[] | undefined = Math.random() ? ['id'] : undefined;
const optional = present(db.table(teams).findFirst({ select: optionalArray }));
const optionalId: number | undefined = optional.id;
const optionalName: string | undefined = optional.name;
// @ts-expect-error The array branch may omit name even though no selection returns all fields.
const falseOptionalName: string = optional.name;
const noSelection = present(db.table(teams).findFirst({ select: undefined }));
const fullName: string = noSelection.name;
const fullNullable: string | null = noSelection.tag;
const optionalTuple: readonly ['id'] | undefined = Math.random() ? ['id'] : undefined;
const optionalExact = present(db.table(teams).findFirst({ select: optionalTuple }));
const requiredInEveryBranch: number = optionalExact.id;
// @ts-expect-error The selected-tuple branch has no name; NoInfer must not erase it.
optionalExact.name;

const tupleUnion: readonly ['id'] | readonly ['name'] = Math.random() ? ['id'] : ['name'];
const distributed = present(db.table(teams).findFirst({ select: tupleUnion }));
// @ts-expect-error A union of exact tuples must distribute instead of requiring both fields.
distributed.id;
// @ts-expect-error Either exact tuple can be chosen.
distributed.name;
if ('id' in distributed) { const narrowedId: number = distributed.id; void narrowedId; }
if ('name' in distributed) { const narrowedName: string = distributed.name; void narrowedName; }

const childArray: ('id' | 'name')[] = ['name'];
const childGraph = present(db.table(teams).findFirst({ select: arraySelection, include: {
  people: hasMany(people, { localKey: teams.col('id'), foreignKey: people.col('teamId'), select: childArray,
    include: { notes: hasMany(notes, { localKey: people.col('id'), foreignKey: notes.col('personId'), select: ['body'] }) } }),
} }));
const child = present(childGraph.people[0]);
const childId: number | undefined = child.id;
const childName: string | undefined = child.name;
const guaranteedNestedBody: string = present(child.notes[0]).body;
// @ts-expect-error Root widened selections stay conservative when includes exist.
const falseGraphName: string = childGraph.name;
// @ts-expect-error Child array selections cannot promise omitted ids.
const falseChildId: number = child.id;
// @ts-expect-error Child array selections cannot promise omitted names.
const falseChildName: string = child.name;
// @ts-expect-error Hidden join fields are still not public projected properties.
child.teamId;
// @ts-expect-error Exact nested projections remain exact.
present(child.notes[0]).id;

const noteArray: ('id' | 'body')[] = ['body'];
const nestedGraph = present(db.table(teams).findFirst({ include: {
  people: hasMany(people, { localKey: teams.col('id'), foreignKey: people.col('teamId'), select: ['id'],
    include: { notes: hasMany(notes, { localKey: people.col('id'), foreignKey: notes.col('personId'), select: noteArray }) } }),
} }));
const exactChild = present(nestedGraph.people[0]);
const stillRequiredChildId: number = exactChild.id;
const dynamicNote = present(exactChild.notes[0]);
const optionalBody: string | undefined = dynamicNote.body;
// @ts-expect-error Nested array selections cannot promise an unselected body.
const falseNestedBody: string = dynamicNote.body;
// @ts-expect-error Hidden nested foreign keys remain omitted.
dynamicNote.personId;

const singularGraph = present(db.table(teams).findFirst({ include: {
  leader: hasOne(people, { localKey: teams.col('id'), foreignKey: people.col('teamId'), select: childArray }),
} }));
const leader = present(singularGraph.leader);
const leaderName: string | undefined = leader.name;
// @ts-expect-error Singular projections have the same conservative array semantics.
const falseLeaderName: string = leader.name;
// @ts-expect-error Singular absence remains distinct from selected-field uncertainty.
singularGraph.leader.name;
const personGraph = present(db.table(people).findFirst({ include: {
  team: belongsTo(teams, { localKey: people.col('teamId'), foreignKey: teams.col('id'), select: unionSlot }),
} }));
const team = present(personGraph.team);
const teamName: string | undefined = team.name;
// @ts-expect-error Belongs-to union-slot projections cannot promise a name.
const falseTeamName: string = team.name;
db.close();

void [exactId, exactName, nullableTag, dynamicId, dynamicName, falseDynamicId, falseDynamicName,
  uncertainId, uncertainName, falseUnionId, falseUnionName, guaranteedId, maybeMixedName, maybeMixedTag,
  falseMixedName, falseMixedTag, guaranteedName, possiblyCoveredId, falseCoveredId, optionalId, optionalName,
  falseOptionalName, fullName, fullNullable, requiredInEveryBranch, childId, childName, guaranteedNestedBody, falseGraphName,
  falseChildId, falseChildName, stillRequiredChildId, optionalBody, falseNestedBody, leaderName,
  falseLeaderName, teamName, falseTeamName];

// A full supported-width tuple stays precise without recursive type instantiation.
const wide = defineTable('projection_wide', {
  id: column.integer().primaryKey(),
  c0: column.text(),
  c1: column.text(),
  c2: column.text(),
  c3: column.text(),
  c4: column.text(),
  c5: column.text(),
  c6: column.text(),
  c7: column.text(),
  c8: column.text(),
  c9: column.text(),
  c10: column.text(),
  c11: column.text(),
  c12: column.text(),
  c13: column.text(),
  c14: column.text(),
  c15: column.text(),
  c16: column.text(),
  c17: column.text(),
  c18: column.text(),
  c19: column.text(),
  c20: column.text(),
  c21: column.text(),
  c22: column.text(),
  c23: column.text(),
  c24: column.text(),
  c25: column.text(),
  c26: column.text(),
  c27: column.text(),
  c28: column.text(),
  c29: column.text(),
  c30: column.text(),
  c31: column.text(),
  c32: column.text(),
  c33: column.text(),
  c34: column.text(),
  c35: column.text(),
  c36: column.text(),
  c37: column.text(),
  c38: column.text(),
  c39: column.text(),
  c40: column.text(),
  c41: column.text(),
  c42: column.text(),
  c43: column.text(),
  c44: column.text(),
  c45: column.text(),
  c46: column.text(),
  c47: column.text(),
  c48: column.text(),
  c49: column.text(),
  c50: column.text(),
  c51: column.text(),
  c52: column.text(),
  c53: column.text(),
  c54: column.text(),
  c55: column.text(),
  c56: column.text(),
  c57: column.text(),
  c58: column.text(),
  c59: column.text(),
  c60: column.text(),
  c61: column.text(),
  c62: column.text(),
  c63: column.text(),
  c64: column.text(),
  c65: column.text(),
  c66: column.text(),
  c67: column.text(),
  c68: column.text(),
  c69: column.text(),
  c70: column.text(),
  c71: column.text(),
  c72: column.text(),
  c73: column.text(),
  c74: column.text(),
  c75: column.text(),
  c76: column.text(),
  c77: column.text(),
  c78: column.text(),
  c79: column.text(),
  c80: column.text(),
  c81: column.text(),
  c82: column.text(),
  c83: column.text(),
  c84: column.text(),
  c85: column.text(),
  c86: column.text(),
  c87: column.text(),
  c88: column.text(),
  c89: column.text(),
  c90: column.text(),
  c91: column.text(),
  c92: column.text(),
  c93: column.text(),
  c94: column.text(),
  c95: column.text(),
  c96: column.text(),
  c97: column.text(),
  c98: column.text(),
});
const wideDb = openDatabase(':memory:', { tables: [wide] });
const wideResult = present(wideDb.table(wide).findFirst({ select: ['id','c0','c1','c2','c3','c4','c5','c6','c7','c8','c9','c10','c11','c12','c13','c14','c15','c16','c17','c18','c19','c20','c21','c22','c23','c24','c25','c26','c27','c28','c29','c30','c31','c32','c33','c34','c35','c36','c37','c38','c39','c40','c41','c42','c43','c44','c45','c46','c47','c48','c49','c50','c51','c52','c53','c54','c55','c56','c57','c58','c59','c60','c61','c62','c63','c64','c65','c66','c67','c68','c69','c70','c71','c72','c73','c74','c75','c76','c77','c78','c79','c80','c81','c82','c83','c84','c85','c86','c87','c88','c89','c90','c91','c92','c93','c94','c95','c96','c97','c98'] }));
const wideLast: string = wideResult.c98;
const wideId: number = wideResult.id;
wideDb.close();
void [wideLast, wideId];
