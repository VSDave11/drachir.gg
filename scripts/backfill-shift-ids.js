// Jednorázové, idempotentní doplnění sloupce Id (UUID) do ManualShifts.
// Spuštění: node scripts/backfill-shift-ids.js
const crypto = require('crypto');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

let googleKeys;
if (process.env.GOOGLE_CREDENTIALS) googleKeys = JSON.parse(process.env.GOOGLE_CREDENTIALS);
else googleKeys = require('../credentials.json');

const auth = new JWT({
    email: googleKeys.client_email,
    key: googleKeys.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet('17iOEaSnL0ZxKYXCFiIuJkWoSbnB3INx1Ust0fBnLVg4', auth);

(async () => {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['ManualShifts'];
    if (!sheet) { console.log('ManualShifts neexistuje — nic k doplnění.'); return; }

    // Zajisti hlavičku Id
    await sheet.loadHeaderRow();
    if (!sheet.headerValues.includes('Id')) {
        await sheet.setHeaderRow([...sheet.headerValues, 'Id']);
        console.log('Přidán sloupec Id do hlavičky.');
    }

    const rows = await sheet.getRows();
    console.log('Řádků celkem: ' + rows.length);

    // Batch zápis (1 request) — vyhne se rate limitu "60 write requests / min/user".
    const idCol = sheet.headerValues.indexOf('Id');
    await sheet.loadCells({ startColumnIndex: idCol, endColumnIndex: idCol + 1, startRowIndex: 0, endRowIndex: rows.length + 1 });
    let filled = 0;
    for (let i = 0; i < rows.length; i++) {
        const cell = sheet.getCell(i + 1, idCol); // +1 kvuli radku hlavicky
        if (!(cell.value || '').toString().trim()) { cell.value = crypto.randomUUID(); filled++; }
    }
    if (filled > 0) await sheet.saveUpdatedCells();
    console.log('Doplněno Id: ' + filled + ' (batch)');
    const remaining = (await sheet.getRows()).filter(r => !(r.get('Id') || '').toString().trim()).length;
    console.log('Bez Id po doběhnutí: ' + remaining);
})().catch(e => { console.error('CHYBA:', e.message); process.exit(1); });
