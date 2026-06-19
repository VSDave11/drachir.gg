// Jednorazova migrace: naplni list "Products" ze zabudovaneho seedu (productMapping + productColors + productCoverage).
// Idempotentni: pokud list uz ma radky, nic neprepisuje.
// Spusteni: node scripts/migrate-products-to-sheet.js
const { doc, productMapping, productColors, productCoverage } = require('../index.js');

const HEADERS = ['Name', 'Trading', 'Color', 'StartCol',
    'NightStart', 'NightEnd', 'MorningStart', 'MorningEnd', 'AfternoonStart', 'AfternoonEnd',
    'CoverageSlots', 'CoverageDays'];

(async () => {
    await doc.loadInfo();
    let sheet = doc.sheetsByTitle['Products'];
    if (!sheet) {
        sheet = await doc.addSheet({ title: 'Products', headerValues: HEADERS });
        console.log('Vytvoren list Products.');
    } else {
        const existing = await sheet.getRows();
        if (existing.length > 0) {
            console.log('List Products uz ma ' + existing.length + ' radku - migrace preskocena (idempotence).');
            return;
        }
    }
    const rows = productMapping.map(p => {
        const cov = productCoverage[p.name];
        return {
            Name: p.name, Trading: p.trading, Color: productColors[p.name] || '', StartCol: p.startCol,
            NightStart: p.slots[0].s,     NightEnd: p.slots[0].e,
            MorningStart: p.slots[1].s,   MorningEnd: p.slots[1].e,
            AfternoonStart: p.slots[2].s, AfternoonEnd: p.slots[2].e,
            CoverageSlots: cov ? cov.slots.join(',') : '',
            CoverageDays:  cov ? cov.days : '',
        };
    });
    // raw: true => Google ulozi presne stringy (jinak USER_ENTERED prepise "06:44"->"6:44" a "0,1,2"->"2000,1,2")
    await sheet.addRows(rows, { raw: true });
    console.log('Zapsano ' + rows.length + ' produktu.');
    rows.forEach(r => console.log('  ' + r.Name + ' -> col ' + r.StartCol + ' / ' + r.Trading));
})().catch(e => { console.error('CHYBA:', e.message); process.exit(1); });
