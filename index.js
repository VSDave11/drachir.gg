const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const session = require('express-session'); // Načtení paměti (sessions)

const app = express();
const PORT = process.env.PORT || 3000;

// Nastavení "paměti" webu
app.use(session({
    secret: 'moje-tajne-heslo-123', // Můžeš si zvolit jakékoliv
    resave: false,
    saveUninitialized: true
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Google Sheets připojení
// Načtení klíčů (buď z Renderu nebo ze souboru)
let googleKeys;
if (process.env.GOOGLE_CREDENTIALS) {
    // Na Renderu použijeme text z nastavení
    googleKeys = JSON.parse(process.env.GOOGLE_CREDENTIALS);
} else {
    // Doma použijeme soubor
    googleKeys = require('./credentials.json');
}

const serviceAccountAuth = new JWT({
    email: googleKeys.client_email,
    key: googleKeys.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet('17iOEaSnL0ZxKYXCFiIuJkWoSbnB3INx1Ust0fBnLVg4', serviceAccountAuth);

// Cesta pro zpracování přihlášení
app.post('/login', async (req, res) => {
    // .toLowerCase() zajistí, že email od uživatele bude malými písmeny
    const emailInput = req.body.email.toLowerCase().trim();
    const passwordInput = req.body.password.trim();
    
    try {
        await doc.loadInfo(); 
        const sheet = doc.sheetsByTitle['uzivatele'];
        
        if (!sheet) {
            return res.status(500).send("Chyba: List 'uzivatele' nenalezen.");
        }

        const rows = await sheet.getRows();
        
        // Hledáme shodu - pozor na velká písmena u 'Email' a 'Jmeno' podle tvého obrázku!
        const user = rows.find(row => {
            const emailZTabulky = row.get('Email')?.toString().toLowerCase().trim();
            const hesloZTabulky = row.get('heslo')?.toString().trim();
            return emailZTabulky === emailInput && hesloZTabulky === passwordInput;
        });
        
        if (user) {
            req.session.user = {
                jmeno: user.get('Jmeno'), // Velké J
                role: user.get('role'),    // Malé r
                email: user.get('Email')   // Velké E
            };
            console.log(`Přihlášen uživatel: ${req.session.user.jmeno}`);
            res.redirect('/dashboard');
        } else {
            res.send('<h1>Chyba!</h1><p>Špatný email nebo heslo.</p><a href="/">Zkusit znovu</a>');
        }
    } catch (error) {
        console.error("Chyba při přihlašování:", error);
        res.status(500).send('Něco se pokazilo.');
    }
});

// Stránka po přihlášení (Dashboard)
app.get('/dashboard', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/'); // Pokud není přihlášený, vyhodíme ho na login
    }

    const { jmeno, role } = req.session.user;

    let ovladaciPrvky = "";
    if (role === 'Admin') {
        ovladaciPrvky = `
            <div style="background: #ffeaa7; padding: 15px; border: 1px solid #fab1a0;">
                <h3>Administrátorská sekce</h3>
                <button>Smazat uživatele</button>
                <button>Upravit úplně vše</button>
                <button>Exportovat data</button>
            </div>`;
    } else {
        ovladaciPrvky = `
            <div style="background: #e1f5fe; padding: 15px; border: 1px solid #81d4fa;">
                <h3>Uživatelská sekce</h3>
                <button>Přesunout mou směnu</button>
            </div>`;
    }

    res.send(`
        <html>
            <head><title>Dashboard</title><link rel="stylesheet" href="style.css"></head>
            <body>
                <header><h1>Vítej, ${jmeno} (${role})</h1></header>
                <main id="calendar-container">
                    ${ovladaciPrvky}
                    <br><br>
                    <a href="/logout">Odhlásit se</a>
                </main>
            </body>
        </html>
    `);
});

// Odhlášení
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.listen(PORT, () => {
    console.log(`Server běží na http://localhost:${PORT}`);
});