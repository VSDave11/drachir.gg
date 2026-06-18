// Čistá logika pro per-uživatel řazení řádků (Fáze 4). Bez I/O — testovatelné.
// Stejná logika běží i v klientovi (dashboard šablona); tady kvůli unit testům.

// Seřadí aktuální klíče podle uloženého pořadí: uložené první (jen ty, co stále existují,
// bez duplicit), pak zbývající aktuální klíče v původním pořadí. Robustní vůči přidaným/odebraným.
function reorderBySaved(currentKeys, savedOrder) {
    const cur = Array.isArray(currentKeys) ? currentKeys.slice() : [];
    const saved = Array.isArray(savedOrder) ? savedOrder : [];
    const curSet = new Set(cur);
    const seen = new Set();
    const result = [];
    saved.forEach(function (k) { if (curSet.has(k) && !seen.has(k)) { result.push(k); seen.add(k); } });
    cur.forEach(function (k) { if (!seen.has(k)) { result.push(k); seen.add(k); } });
    return result;
}

// Posune klíč v poli o krok nahoru (dir<0) nebo dolů (dir>0); na kraji se nic nestane.
function moveKey(order, key, dir) {
    const arr = Array.isArray(order) ? order.slice() : [];
    const i = arr.indexOf(key);
    if (i < 0) return arr;
    const j = i + (dir < 0 ? -1 : 1);
    if (j < 0 || j >= arr.length) return arr;
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    return arr;
}

module.exports = { reorderBySaved, moveKey };
