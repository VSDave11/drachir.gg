// Jednorazova migrace: naplni list "People" (Name, Group, Color) ze zabudovaneho seedu.
// Idempotentni: pokud list uz ma radky, nic neprepisuje.
// Spusteni: node scripts/migrate-people-to-sheet.js
const { doc, peopleHierarchy, personColors } = require('../index.js');

(async () => {
    await doc.loadInfo();
    let sheet = doc.sheetsByTitle['People'];
    if (!sheet) {
        sheet = await doc.addSheet({ title: 'People', headerValues: ['Name', 'Group', 'Color'] });
        console.log('Vytvoren list People.');
    } else {
        const existing = await sheet.getRows();
        if (existing.length > 0) {
            console.log('List People uz ma ' + existing.length + ' radku - migrace preskocena (idempotence).');
            return;
        }
    }
    const rows = [];
    for (const g of peopleHierarchy) {
        for (const name of g.members) {
            rows.push({ Name: name, Group: g.label, Color: personColors[name] || '#888' });
        }
    }
    await sheet.addRows(rows);
    const byGroup = {};
    rows.forEach(r => { byGroup[r.Group] = (byGroup[r.Group] || 0) + 1; });
    console.log('Zapsano ' + rows.length + ' lidi.');
    console.log('Podle skupin: ' + JSON.stringify(byGroup));
})().catch(e => { console.error('CHYBA:', e.message); process.exit(1); });
