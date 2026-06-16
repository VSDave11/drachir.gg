const assert = require('assert');
const { buildPeopleStructures } = require('../lib/people');

let n = 0; const ok = (m) => { n++; console.log('  ok ' + n + ' - ' + m); };

const GROUPS = [
  { label: 'Team Leaders',   color: '#4caf50', target: 20 },
  { label: 'Traders - Lima', color: '#ff5722', target: 40 }
];
const rows = [
  { Name: 'Alice', Group: 'Team Leaders',   Color: '#111111' },
  { Name: 'Bob',   Group: 'Traders - Lima', Color: '' },
  { Name: 'Carol', Group: 'Traders - Lima', Color: '#222222' },
  { Name: 'Ghost', Group: 'Neexistuje',     Color: '#333333' }
];
const { peopleHierarchy, personColors, limaSet, warnings } = buildPeopleStructures(rows, GROUPS);

assert.deepStrictEqual(peopleHierarchy.map(g => g.label), ['Team Leaders', 'Traders - Lima']);
ok('skupiny v poradi GROUPS');

assert.deepStrictEqual(peopleHierarchy[0].members, ['Alice']);
assert.deepStrictEqual(peopleHierarchy[1].members, ['Bob', 'Carol']);
ok('clenove ve spravnych skupinach, v poradi radku');

assert.strictEqual(peopleHierarchy[1].color, '#ff5722');
assert.strictEqual(peopleHierarchy[1].target, 40);
ok('skupina nese color+target z GROUPS');

assert.strictEqual(personColors['Alice'], '#111111');
assert.strictEqual(personColors['Bob'], '#888');
ok('personColors + fallback #888 pro prazdnou barvu');

assert.ok(limaSet.has('Bob') && limaSet.has('Carol'));
assert.ok(!limaSet.has('Alice'));
ok('limaSet jen Lima skupina');

assert.ok(!personColors['Ghost']);
assert.strictEqual(peopleHierarchy.flatMap(g => g.members).includes('Ghost'), false);
assert.ok(warnings.some(w => w.includes('Ghost')));
ok('neznama skupina vynechana + warning');

console.log('\nVSECHNY TESTY OK (' + n + ')');
