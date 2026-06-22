const assert = require('assert');
const { validateNewRequest, canClaim, canCancel, canApprove, buildBoard, replaceNameInCell } = require('../lib/swaps');

let n = 0; const ok = (m) => { n++; console.log('  ok ' + n + ' - ' + m); };

// validateNewRequest
assert.strictEqual(validateNewRequest({ name: 'Alice', date: '2026-06-20', product: 'CS 2 Duels', start: '08:00' }, 'Alice'), null);
assert.ok(validateNewRequest({ name: 'Bob', date: '2026-06-20', product: 'CS 2 Duels', start: '08:00' }, 'Alice'));   // cizí směna
assert.ok(validateNewRequest({ name: 'Alice', date: '2026-06-20', product: 'Vacation', start: '00:00' }, 'Alice'));   // vacation
assert.ok(validateNewRequest(null, 'Alice'));
assert.ok(validateNewRequest({ date: '2026-06-20', product: 'X', start: '08:00' }, ''));   // chybí user
assert.strictEqual(validateNewRequest({ name: 'Bob', date: '2026-06-20', product: 'CS 2 Duels', start: '08:00' }, 'Alice', true), null);   // manager smi nabidnout cizi smenu
assert.ok(validateNewRequest({ name: 'Bob', date: '2026-06-20', product: 'Vacation', start: '00:00' }, 'Alice', true));   // ani manager nevymeni vacation
ok('validateNewRequest: vlastni OK, cizi/vacation/prazdny user odmitnut, manager smi cizi (ne vacation)');

// canClaim
assert.ok(canClaim({ Status: 'OPEN', RequesterName: 'Alice' }, 'Bob'));
assert.ok(!canClaim({ Status: 'OPEN', RequesterName: 'Alice' }, 'Alice'));   // vlastní nelze claimnout
assert.ok(!canClaim({ Status: 'CLAIMED', RequesterName: 'Alice' }, 'Bob')); // už claimnuto
ok('canClaim: jen OPEN cizi');

// canCancel
assert.ok(canCancel({ Status: 'OPEN', RequesterName: 'Alice' }, 'Alice', false));
assert.ok(canCancel({ Status: 'CLAIMED', RequesterName: 'Alice' }, 'Bob', true));  // manažer
assert.ok(!canCancel({ Status: 'OPEN', RequesterName: 'Alice' }, 'Bob', false));   // cizí ne-manažer
assert.ok(!canCancel({ Status: 'APPROVED', RequesterName: 'Alice' }, 'Alice', true)); // už hotovo
ok('canCancel: žadatel nebo manažer, jen OPEN/CLAIMED');

// canApprove
assert.ok(canApprove({ Status: 'CLAIMED', RequesterName: 'Alice' }, 'Alice', false)); // žadatel
assert.ok(canApprove({ Status: 'CLAIMED', RequesterName: 'Alice' }, 'Carol', true));  // manažer
assert.ok(!canApprove({ Status: 'CLAIMED', RequesterName: 'Alice' }, 'Carol', false));// cizí ne-manažer
assert.ok(!canApprove({ Status: 'OPEN', RequesterName: 'Alice' }, 'Alice', true));    // ještě není claimnuto
ok('canApprove: žadatel/manažer, jen CLAIMED');

// buildBoard
const reqs = [
    { Status: 'OPEN',    RequesterName: 'Alice', ClaimedBy: '' },
    { Status: 'OPEN',    RequesterName: 'Bob',   ClaimedBy: '' },
    { Status: 'CLAIMED', RequesterName: 'Carol', ClaimedBy: 'Bob' },
    { Status: 'APPROVED',RequesterName: 'Dave',  ClaimedBy: 'Bob' },  // neaktivní
];
const board = buildBoard(reqs, 'Bob', false);
assert.strictEqual(board.open.length, 1);        // jen Alice (Bob je vlastní)
assert.strictEqual(board.mine.length, 1);        // Bob OPEN
assert.strictEqual(board.claimedByMe.length, 1); // Carol claimnuto Bobem
assert.strictEqual(board.toApprove.length, 0);   // Bob není žadatel ani manažer u Carol
assert.strictEqual(board.openCount, 2);
const boardMgr = buildBoard(reqs, 'Bob', true);
assert.strictEqual(boardMgr.toApprove.length, 1); // manažer schvaluje Carol/Bob
ok('buildBoard: open/mine/claimedByMe/toApprove/openCount správně');

// replaceNameInCell
assert.deepStrictEqual(replaceNameInCell('Alice', 'Alice', 'Bob'), { value: 'Bob', replaced: true });
assert.deepStrictEqual(replaceNameInCell('Alice, Carol', 'Alice', 'Bob'), { value: 'Bob, Carol', replaced: true });
assert.deepStrictEqual(replaceNameInCell('Carol, Alice', 'Alice', 'Bob'), { value: 'Carol, Bob', replaced: true });
assert.deepStrictEqual(replaceNameInCell('Alice + Dan', 'Alice', 'Bob'), { value: 'Bob + Dan', replaced: true });
assert.deepStrictEqual(replaceNameInCell('Carol', 'Alice', 'Bob'), { value: 'Carol', replaced: false });
assert.deepStrictEqual(replaceNameInCell('', 'Alice', 'Bob'), { value: '', replaced: false });
ok('replaceNameInCell: single/multi (,/+)/spaces/not-found');

console.log('\nVSECHNY TESTY OK (' + n + ')');
