// Čistá logika pro import směn z CSV. Bez I/O — testovatelné.
// normalizeDate (dep) převede datum na 'YYYY-MM-DD' (injektuje se convertCzechDate z index.js).
const TIME_RE = /^\d{1,2}:\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseShiftsCsv(text, deps) {
    deps = deps || {};
    const normalizeDate = typeof deps.normalizeDate === 'function' ? deps.normalizeDate : (d => d);
    const lines = String(text == null ? '' : text).split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length < 2) return { rows: [], validCount: 0, errorCount: 0, headerError: 'Soubor je prázdný nebo nemá data.' };

    const delim = (lines[0].split(';').length > lines[0].split(',').length) ? ';' : ',';
    const header = lines[0].split(delim).map(h => h.trim().toLowerCase());
    const idx = (names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
    const ci = {
        date: idx(['date', 'datum']), name: idx(['name', 'jmeno', 'jméno']),
        trading: idx(['trading', 'kategorie']), product: idx(['product', 'produkt']),
        start: idx(['start', 'od']), end: idx(['end', 'do']), note: idx(['note', 'poznamka', 'poznámka'])
    };
    if (ci.date < 0 || ci.name < 0 || ci.start < 0 || ci.end < 0)
        return { rows: [], validCount: 0, errorCount: 0, headerError: 'Chybí povinné sloupce: Date, Name, Start, End.' };

    const rows = []; let validCount = 0, errorCount = 0;
    for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(delim);
        const get = (k) => ci[k] >= 0 ? (c[ci[k]] || '').trim() : '';
        const rawDate = get('date');
        const date = normalizeDate(rawDate) || rawDate;
        const name = get('name'), start = get('start'), end = get('end');
        const product = get('product'), trading = get('trading'), note = get('note');
        let error = null;
        const badChars = (s) => s.indexOf('`') >= 0 || s.indexOf('${') >= 0;
        if (!name) error = 'chybí jméno';
        else if (badChars(name) || badChars(product) || badChars(trading) || badChars(note)) error = 'nepovolený znak (`/${)';
        else if (!ISO_RE.test(date)) error = 'neplatné datum';
        else if (!TIME_RE.test(start) || !TIME_RE.test(end)) error = 'neplatný čas (HH:MM)';
        else if (!product) error = 'chybí produkt';
        const valid = !error;
        if (valid) validCount++; else errorCount++;
        rows.push({ Date: date, Name: name, Trading: trading, Product: product, Start: start, End: end, Note: note, valid, error });
    }
    return { rows, validCount, errorCount, headerError: null };
}

module.exports = { parseShiftsCsv };
