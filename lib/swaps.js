// Čistá logika pro žádosti o výměnu směn (swap requests). Bez I/O — testovatelné.
// Lifecycle: OPEN -> CLAIMED -> APPROVED  (+ CANCELLED z OPEN/CLAIMED).
// Model "give-away": žadatel nabídne vlastní směnu, někdo si ji claimne, žadatel/manažer schválí -> reassign.

const STATUSES = ['OPEN', 'CLAIMED', 'APPROVED', 'CANCELLED'];

// Validace nové žádosti: jen vlastní směna, ne RIP/Vacation.
function validateNewRequest(shift, userName) {
    if (!userName) return 'Chybí uživatel';
    if (!shift || !shift.date || !shift.product || !shift.start) return 'Neplatná směna';
    if (shift.name && shift.name !== userName) return 'Můžeš nabídnout jen vlastní směnu';
    if (shift.product === 'Vacation' || shift.product === 'RIP') return 'Tuto položku nelze vyměnit';
    return null;
}

// Guardy přechodů (čisté). req = záznam ze sheetu, userName = jméno, isManager = Admin/TL.
function canClaim(req, userName) {
    return !!req && req.Status === 'OPEN' && !!userName && req.RequesterName !== userName;
}
function canCancel(req, userName, isManager) {
    return !!req && (req.Status === 'OPEN' || req.Status === 'CLAIMED') && (req.RequesterName === userName || !!isManager);
}
function canApprove(req, userName, isManager) {
    // schvaluje žadatel (komu směnu přebírají) nebo manažer
    return !!req && req.Status === 'CLAIMED' && (!!isManager || req.RequesterName === userName);
}

// Rozdělení žádostí pro UI board z pohledu uživatele.
function buildBoard(requests, userName, isManager) {
    const active = (requests || []).filter(r => r && (r.Status === 'OPEN' || r.Status === 'CLAIMED'));
    return {
        open:        active.filter(r => r.Status === 'OPEN' && r.RequesterName !== userName),
        mine:        active.filter(r => r.RequesterName === userName),
        claimedByMe: active.filter(r => r.Status === 'CLAIMED' && r.ClaimedBy === userName),
        toApprove:   active.filter(r => canApprove(r, userName, isManager)),
        openCount:   active.filter(r => r.Status === 'OPEN').length,
    };
}

// Nahraď jméno v buňce Schedule, která může obsahovat víc lidí ("A, B" nebo "A + B").
// Vrací { value, replaced }. replaced=false když se jméno v buňce nenašlo.
function replaceNameInCell(cellValue, oldName, newName) {
    const raw = (cellValue == null ? '' : String(cellValue));
    if (!raw.trim() || !oldName) return { value: raw, replaced: false };
    const parts = raw.split(/([,+])/); // zachovej oddělovače jako tokeny
    let replaced = false;
    const out = parts.map(tok => {
        if (tok === ',' || tok === '+') return tok;
        if (tok.trim() === oldName) { replaced = true; return tok.replace(oldName, newName); }
        return tok;
    });
    return { value: out.join(''), replaced };
}

module.exports = { STATUSES, validateNewRequest, canClaim, canCancel, canApprove, buildBoard, replaceNameInCell };
