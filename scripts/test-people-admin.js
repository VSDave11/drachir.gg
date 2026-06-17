const assert = require('assert');
const { validatePersonInput, computeCapabilityCells } = require('../lib/people-admin');

let n = 0; const ok = (m) => { n++; console.log('  ok ' + n + ' - ' + m); };
const GROUPS = ['Team Leaders', 'Traders - Lima'];

assert.strictEqual(validatePersonInput({ name: 'Nový', group: 'Team Leaders', color: '#111' }, { groups: GROUPS, existingNames: ['Starý'], mode: 'add' }), null);
ok('platny add => null');
assert.match(validatePersonInput({ name: '', group: 'Team Leaders' }, { groups: GROUPS, existingNames: [], mode: 'add' }), /required/);
ok('prazdne jmeno => chyba');
assert.match(validatePersonInput({ name: 'X', group: 'Neznama' }, { groups: GROUPS, existingNames: [], mode: 'add' }), /Unknown group/);
ok('neznama skupina => chyba');
assert.match(validatePersonInput({ name: 'Starý', group: 'Team Leaders' }, { groups: GROUPS, existingNames: ['Starý'], mode: 'add' }), /already exists/);
ok('duplicita v add => chyba');
assert.strictEqual(validatePersonInput({ name: 'Starý', group: 'Team Leaders' }, { groups: GROUPS, existingNames: ['Starý'], mode: 'update' }), null);
ok('update existujiciho => null');
assert.match(validatePersonInput({ name: 'Duch', group: 'Team Leaders' }, { groups: GROUPS, existingNames: ['Starý'], mode: 'update' }), /does not exist/);
ok('update neexistujiciho => chyba');

const header = [{ col: 1, name: 'CS 2 Duels' }, { col: 2, name: 'Madden' }, { col: 3, name: 'eHockey' }];
const cells = computeCapabilityCells(header, ['Madden', 'eHockey']);
assert.deepStrictEqual(cells, [{ col: 1, value: '' }, { col: 2, value: 'x' }, { col: 3, value: 'x' }]);
ok('computeCapabilityCells: x pro vybrane, prazdno pro ostatni');

console.log('\nVSECHNY TESTY OK (' + n + ')');
