// Čistá validační + výpočetní logika pro admin správu lidí (bez I/O).

function validatePersonInput(person, opts) {
    const name = (person && person.name || '').toString().trim();
    const group = (person && person.group || '').toString().trim();
    const groups = (opts && opts.groups) || [];
    const existingNames = (opts && opts.existingNames) || [];
    const mode = (opts && opts.mode) || 'add';
    if (!name) return 'Jméno je povinné';
    if (!groups.includes(group)) return 'Neznámá skupina: ' + group;
    if (mode === 'add' && existingNames.includes(name)) return 'Člověk "' + name + '" už existuje';
    if (mode === 'update' && !existingNames.includes(name)) return 'Člověk "' + name + '" neexistuje';
    return null;
}

// headerProducts: [{col, name}]; selectedProducts: [name]
// vrátí [{col, value}] kde value='x' pro vybrané, '' pro ostatní.
function computeCapabilityCells(headerProducts, selectedProducts) {
    const sel = new Set(selectedProducts || []);
    return (headerProducts || []).map(h => ({ col: h.col, value: sel.has(h.name) ? 'x' : '' }));
}

module.exports = { validatePersonInput, computeCapabilityCells };
