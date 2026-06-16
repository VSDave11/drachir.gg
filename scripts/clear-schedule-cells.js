// scripts/clear-schedule-cells.js
// Vymaze vsechny produktove bunky (sloupce dle productMapping) v Schedule - <Month> listu.
// VACATION/OFF kolonky BC-BG (sloupce 54-58) NECHA — to jsou dovolene a nevztahuji se ke generovani.
//
// DEFAULT = DRY-RUN. Pro skutecne smazani: --commit
//
// Pouziti:
//   node scripts/clear-schedule-cells.js "July 2026"
//   node scripts/clear-schedule-cells.js "July 2026" --commit
//
// Co se vymaze: vsechny bunky ve sloupcich startCol .. startCol+slots.maxOffset pro kazdy produkt
// Co zustane: col A (datum), col B (den v tydnu), col BC-BG (OFF kolonky)

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
}));

const monthLabel = positional[0];
const dryRun = !flags.commit;

if (!monthLabel) {
    console.error('Pouziti: node scripts/clear-schedule-cells.js "July 2026" [--commit]');
    process.exit(1);
}

const { doc, productMapping } = require('..');

function colToLetter(c) {
    let s = ''; let n = c + 1;
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
}

async function main() {
    console.log('[clear] Month:', monthLabel);
    console.log('[clear] Mode:', dryRun ? 'DRY-RUN (zadne smazani)' : 'COMMIT (skutecne smaze)');
    console.log('');

    await doc.loadInfo();
    const sheetTitle = 'Schedule - ' + monthLabel;
    const sheet = doc.sheetsByTitle[sheetTitle];
    if (!sheet) {
        console.error('CHYBA: list "' + sheetTitle + '" neexistuje');
        process.exit(2);
    }
    console.log('[clear] List nalezen:', sheetTitle, '(rows=' + sheet.rowCount + ', cols=' + sheet.columnCount + ')');

    // Spocteme rozsah ktery se ma vymazat
    // Pro kazdy produkt: startCol .. startCol+max(slot.o) (typicky +2)
    const colsToClear = new Set();
    productMapping.forEach(pm => {
        const maxOffset = Math.max(...pm.slots.map(s => s.o));
        for (let off = 0; off <= maxOffset; off++) {
            colsToClear.add(pm.startCol + off);
        }
    });
    const sortedCols = Array.from(colsToClear).sort((a, b) => a - b);
    const lastCol = Math.max(...sortedCols);

    console.log('[clear] Sloupce ke smazani:', sortedCols.length, '(' + sortedCols.map(colToLetter).join(', ') + ')');

    const maxRow = Math.min(sheet.rowCount, 500);
    await sheet.loadCells(`A1:${colToLetter(lastCol)}${maxRow}`);

    let toClearCount = 0;
    let nonEmpty = 0;
    for (let r = 0; r < maxRow; r++) {
        // Skip header rows (row 0/1) — typically date column 0 is empty there
        const dateCell = sheet.getCell(r, 0);
        const hasDateInRow = !!(dateCell.value || dateCell.formattedValue);
        if (!hasDateInRow) continue; // jen rady s datem
        for (const col of sortedCols) {
            const cell = sheet.getCell(r, col);
            if (cell.value != null && String(cell.value).trim() !== '') {
                nonEmpty++;
                if (!dryRun) {
                    cell.value = null;
                }
                toClearCount++;
            }
        }
    }

    console.log('[clear] Bunek ke smazani:', toClearCount, '(non-empty: ' + nonEmpty + ')');

    if (dryRun) {
        console.log('');
        console.log('[clear] === DRY-RUN — nic se nesmazalo ===');
        console.log('[clear] Pro skutecne smazani spust znovu s --commit');
        return;
    }

    if (toClearCount === 0) {
        console.log('[clear] Nic ke smazani.');
        return;
    }

    console.log('[clear] Ukladam...');
    await sheet.saveUpdatedCells();
    console.log('[clear] === HOTOVO === Smazano ' + toClearCount + ' bunek z "' + sheetTitle + '"');
}

main().catch(e => {
    console.error('[clear] CHYBA:', e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
});
