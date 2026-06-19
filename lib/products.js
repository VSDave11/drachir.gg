// Čistá transformace: řádky listu "Products" + definice trading kategorií -> datové struktury produktů.
// Sloty mají offsety vždy 0/1/2 (night/morning/afternoon) - neukládají se, jen časy start/end.
// Vrací { productMapping, productColors, productCoverage, tradingHierarchy, warnings, rejected }.
// rejected (string|null): sheet-level gate - hrubě nekonzistentní list (překryv/rozsah startCol) se NEAPLIKUJE,
// volající drží seed (chyba sloupcové mřížky nesmí tiše rozbít čtení/zápis Schedule listů).
const TIME_RE = /^\d{1,2}:\d{2}$/;

function buildProductStructures(rows, categories) {
    const cats = categories || [];
    const validCats = new Set(cats.map(c => c.name));
    const catColor = {};
    cats.forEach(c => { catColor[c.name] = c.color; });
    const warnings = [];
    const parsed = [];

    for (const r of (rows || [])) {
        const name = (r.Name || '').toString().trim();
        if (!name) continue;
        if (name.includes('`') || name.includes('${')) {       // template-literal guard (CLAUDE.md)
            warnings.push('Nazev "' + name + '" obsahuje zakazany znak (`/${) - vynechan');
            continue;
        }
        const trading = (r.Trading || '').toString().trim();
        if (!validCats.has(trading)) {
            warnings.push('Neznama kategorie "' + trading + '" u "' + name + '" - vynechan');
            continue;
        }
        const sc = Number((r.StartCol || '').toString().trim());
        if (!Number.isInteger(sc) || sc < 0) {
            warnings.push('Nevalidni StartCol u "' + name + '" - vynechan');
            continue;
        }
        const slotCols = [['NightStart', 'NightEnd'], ['MorningStart', 'MorningEnd'], ['AfternoonStart', 'AfternoonEnd']];
        let timesOk = true;
        const slots = slotCols.map(([sk, ek], i) => {
            const s = (r[sk] || '').toString().trim();
            const e = (r[ek] || '').toString().trim();
            if (!TIME_RE.test(s) || !TIME_RE.test(e)) timesOk = false;
            return { o: i, s, e };
        });
        if (!timesOk) {
            warnings.push('Nevalidni cas slotu u "' + name + '" - vynechan');
            continue;
        }

        parsed.push({
            name, trading, startCol: sc, slots,
            color: (r.Color || '').toString().trim(),
            covSlots: (r.CoverageSlots || '').toString().trim(),
            covDays: (r.CoverageDays || '').toString().trim(),
        });
    }

    parsed.sort((a, b) => a.startCol - b.startCol);

    // Sheet-level gate.
    let rejected = null;
    if (parsed.length === 0) rejected = 'zadny platny produkt';
    if (!rejected) {
        for (let i = 1; i < parsed.length; i++) {
            if (parsed[i].startCol <= parsed[i - 1].startCol + 2) {   // bloky 3 sloupců se nesmí překrývat
                rejected = 'prekryvajici se StartCol: "' + parsed[i - 1].name + '" a "' + parsed[i].name + '"';
                break;
            }
        }
    }
    if (!rejected) {
        const maxCol = Math.max(...parsed.map(p => p.startCol + 2));
        if (maxCol >= 54) rejected = 'StartCol presahuje OFF sloupce (max col ' + maxCol + ' >= 54)';   // OFF/Vacation = 54-58
    }
    if (rejected) {
        return { rejected, warnings, productMapping: [], productColors: {}, productCoverage: {}, tradingHierarchy: [] };
    }

    const productMapping = parsed.map(p => ({
        name: p.name, startCol: p.startCol, trading: p.trading,
        slots: p.slots.map(s => ({ o: s.o, s: s.s, e: s.e })),
    }));

    const productColors = {};
    parsed.forEach(p => { productColors[p.name] = p.color || catColor[p.trading] || '#888'; });

    const productCoverage = {};
    parsed.forEach(p => {
        if (!p.covSlots && !p.covDays) return;       // default 0,1,2 / all -> neukládat
        const slots = p.covSlots
            ? p.covSlots.split(',').map(x => parseInt(x.trim(), 10)).filter(x => !isNaN(x))
            : [0, 1, 2];
        productCoverage[p.name] = { slots, days: p.covDays || 'all' };
    });

    const subsByCat = {};
    parsed.forEach(p => { (subsByCat[p.trading] = subsByCat[p.trading] || []).push(p.name); });   // už v startCol pořadí
    const tradingHierarchy = cats.map(c => ({
        name: c.name, color: c.color, icon: c.icon,
        subs: c.subs ? c.subs.slice() : (subsByCat[c.name] || []),   // "Other" = statické subs ze seedu
    }));

    return { productMapping, productColors, productCoverage, tradingHierarchy, warnings, rejected: null };
}

module.exports = { buildProductStructures };
