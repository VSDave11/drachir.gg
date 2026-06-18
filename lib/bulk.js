// Čistá logika pro hromadné operace se směnami (Fáze 5). Bez I/O — testovatelné.

// Unikátní neprázdné string id (zachová pořadí).
function dedupeIds(ids) {
    const seen = new Set();
    const out = [];
    (Array.isArray(ids) ? ids : []).forEach(function (x) {
        if (x == null) return;
        const s = String(x).trim();
        if (!s || seen.has(s)) return;
        seen.add(s); out.push(s);
    });
    return out;
}

// Rozdělí vybrané položky: ManualShifts (mazatelné podle Id) vs Schedule (jen cache) vs invalid.
//   items: [{ id, sheetTitle, name }]
function partitionSelection(items) {
    const manual = [], scheduleOnly = [], invalid = [];
    (Array.isArray(items) ? items : []).forEach(function (it) {
        if (!it || typeof it !== 'object') { invalid.push(it); return; }
        const sheetTitle = (it.sheetTitle == null ? '' : String(it.sheetTitle)).trim();
        const id = (it.id == null ? '' : String(it.id)).trim();
        const name = (it.name == null ? '' : String(it.name)).trim();
        if (sheetTitle === 'ManualShifts') {
            if (id) manual.push({ id: id, name: name });
            else invalid.push(it);
        } else if (sheetTitle) {
            scheduleOnly.push({ sheetTitle: sheetTitle, name: name });
        } else {
            invalid.push(it);
        }
    });
    return { manual: manual, scheduleOnly: scheduleOnly, invalid: invalid };
}

module.exports = { dedupeIds, partitionSelection };
