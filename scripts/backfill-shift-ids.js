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
    let filled = 0;
    for (const r of rows) {
        if (!r.get('Id')) { r.set('Id', crypto.randomUUID()); await r.save(); filled++; }
    }
    console.log('Doplněno Id: ' + filled);
    console.log('Bez Id po doběhnutí: ' + (await sheet.getRows()).filter(r => !r.get('Id')).length);
})().catch(e => { console.error('CHYBA:', e.message); process.exit(1); });
