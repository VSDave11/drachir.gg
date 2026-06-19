const assert = require('assert');
const { buildProductStructures } = require('../lib/products');

let n = 0; const ok = (m) => { n++; console.log('  ok ' + n + ' - ' + m); };

// Kategorie jako v index.js (TRADING_CATEGORIES) - reálné nemají subs, "Other" má statické.
const CATS = [
    { name: 'FIFA',         color: '#fbc02d', icon: '&#9917;' },
    { name: 'Tanks',        color: '#607d8b', icon: '&#128299;' },
    { name: 'Other',        color: '#607d8b', icon: '&#128203;',
      subs: ['Stand Up', '1on1', 'Vacation'] },
];

// Pozn.: řádky schválně NESEŘAZENé podle StartCol - transformace má řadit sama.
const rows = [
    { Name: 'Valhalla Cup B', Trading: 'FIFA', Color: '#ff5722', StartCol: 6,
      NightStart: '22:57', NightEnd: '06:46', MorningStart: '06:57', MorningEnd: '14:50', AfternoonStart: '14:57', AfternoonEnd: '22:49',
      CoverageSlots: '', CoverageDays: '' },
    { Name: 'Valhalla Cup A', Trading: 'FIFA', Color: '#f44336', StartCol: 2,
      NightStart: '22:55', NightEnd: '06:44', MorningStart: '06:55', MorningEnd: '14:48', AfternoonStart: '14:55', AfternoonEnd: '22:47',
      CoverageSlots: '', CoverageDays: '' },
    { Name: 'World of Tanks', Trading: 'Tanks', Color: '', StartCol: 46,
      NightStart: '23:30', NightEnd: '07:30', MorningStart: '07:30', MorningEnd: '15:30', AfternoonStart: '15:30', AfternoonEnd: '23:30',
      CoverageSlots: '1', CoverageDays: 'weekdays' },
];

const built = buildProductStructures(rows, CATS);
assert.strictEqual(built.rejected, null);

// 1) productMapping seřazen podle startCol + správný tvar slotů (offsety 0/1/2)
assert.deepStrictEqual(built.productMapping.map(p => p.name), ['Valhalla Cup A', 'Valhalla Cup B', 'World of Tanks']);
assert.deepStrictEqual(built.productMapping[0], {
    name: 'Valhalla Cup A', startCol: 2, trading: 'FIFA',
    slots: [{ o: 0, s: '22:55', e: '06:44' }, { o: 1, s: '06:55', e: '14:48' }, { o: 2, s: '14:55', e: '22:47' }],
});
ok('productMapping serazen podle startCol + tvar slotu {o,s,e}');

// 2) productColors + fallback na barvu kategorie pro prázdnou barvu
assert.strictEqual(built.productColors['Valhalla Cup A'], '#f44336');
assert.strictEqual(built.productColors['World of Tanks'], '#607d8b');   // prázdná -> barva kategorie Tanks
ok('productColors + fallback na barvu kategorie');

// 3) productCoverage: jen override; parsování "1" -> [1]; default řádky se neukládají
assert.deepStrictEqual(built.productCoverage, { 'World of Tanks': { slots: [1], days: 'weekdays' } });
ok('productCoverage jen override (default radky vynechany)');

// 4) tradingHierarchy: reálné subs odvozené v startCol pořadí; "Other" statické; barvy/ikony ze seedu
const fifa = built.tradingHierarchy.find(t => t.name === 'FIFA');
assert.deepStrictEqual(fifa.subs, ['Valhalla Cup A', 'Valhalla Cup B']);   // startCol pořadí (2 před 6)
assert.strictEqual(fifa.color, '#fbc02d');
assert.strictEqual(fifa.icon, '&#9917;');
const other = built.tradingHierarchy.find(t => t.name === 'Other');
assert.deepStrictEqual(other.subs, ['Stand Up', '1on1', 'Vacation']);     // statické ze seedu
assert.deepStrictEqual(built.tradingHierarchy.map(t => t.name), ['FIFA', 'Tanks', 'Other']);  // pořadí kategorií
ok('tradingHierarchy: subs odvozene/staticke, barvy+ikony+poradi ze seedu');

// 5) neznámá kategorie -> warning + vynecháno
{
    const b = buildProductStructures([{ Name: 'Ghost', Trading: 'Neexistuje', StartCol: 2,
        NightStart: '00:00', NightEnd: '08:00', MorningStart: '08:00', MorningEnd: '16:00', AfternoonStart: '16:00', AfternoonEnd: '00:00' }], CATS);
    assert.strictEqual(b.rejected, 'zadny platny produkt');
    assert.ok(b.warnings.some(w => w.includes('Ghost') && w.includes('Neznama kategorie')));
    ok('neznama kategorie vynechana + warning');
}

// 6) nevalidní StartCol -> warning + vynecháno
{
    const b = buildProductStructures([{ Name: 'Bad', Trading: 'FIFA', StartCol: 'xx',
        NightStart: '00:00', NightEnd: '08:00', MorningStart: '08:00', MorningEnd: '16:00', AfternoonStart: '16:00', AfternoonEnd: '00:00' }], CATS);
    assert.ok(b.warnings.some(w => w.includes('Bad') && w.includes('StartCol')));
    ok('nevalidni StartCol vynechan + warning');
}

// 7) nevalidní čas slotu -> warning + vynecháno
{
    const b = buildProductStructures([{ Name: 'BadTime', Trading: 'FIFA', StartCol: 2,
        NightStart: '8h', NightEnd: '08:00', MorningStart: '08:00', MorningEnd: '16:00', AfternoonStart: '16:00', AfternoonEnd: '00:00' }], CATS);
    assert.ok(b.warnings.some(w => w.includes('BadTime') && w.includes('cas')));
    ok('nevalidni cas slotu vynechan + warning');
}

// 8) překrývající se startCol -> rejected
{
    const mk = (name, sc) => ({ Name: name, Trading: 'FIFA', StartCol: sc, Color: '#111',
        NightStart: '00:00', NightEnd: '08:00', MorningStart: '08:00', MorningEnd: '16:00', AfternoonStart: '16:00', AfternoonEnd: '00:00' });
    const b = buildProductStructures([mk('A', 2), mk('B', 3)], CATS);   // 2..4 a 3..5 se překrývají
    assert.ok(b.rejected && b.rejected.includes('prekryvajici'));
    assert.deepStrictEqual(b.productMapping, []);
    ok('prekryvajici startCol -> rejected, struktury prazdne');
}

// 9) startCol přesahující OFF sloupce (>=54) -> rejected
{
    const b = buildProductStructures([{ Name: 'Over', Trading: 'FIFA', StartCol: 53, Color: '#111',
        NightStart: '00:00', NightEnd: '08:00', MorningStart: '08:00', MorningEnd: '16:00', AfternoonStart: '16:00', AfternoonEnd: '00:00' }], CATS);
    assert.ok(b.rejected && b.rejected.includes('OFF'));   // 53+2 = 55 >= 54
    ok('startCol presahujici OFF sloupce -> rejected');
}

// 10) název s backtickem/${ -> vynechán (template-literal guard)
{
    const b = buildProductStructures([{ Name: 'Ev`il', Trading: 'FIFA', StartCol: 2,
        NightStart: '00:00', NightEnd: '08:00', MorningStart: '08:00', MorningEnd: '16:00', AfternoonStart: '16:00', AfternoonEnd: '00:00' }], CATS);
    assert.ok(b.warnings.some(w => w.includes('zakazany znak')));
    ok('nazev s backtickem vynechan + warning');
}

console.log('\nVSECHNY TESTY OK (' + n + ')');
