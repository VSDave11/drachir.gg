const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Nastavení "paměti" webu (Sessions)
app.use(session({
    secret: 'yggdrasil-secret-key-123', // Tajný klíč pro šifrování relace
    resave: false,
    saveUninitialized: true
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// 2. Nastavení přístupu k Google Sheets (Render vs Local)
let googleKeys;
if (process.env.GOOGLE_CREDENTIALS) {
    // Pro Render (bere data z Environment Variables v dashboardu Renderu)
    googleKeys = JSON.parse(process.env.GOOGLE_CREDENTIALS);
} else {
    // Pro lokální vývoj (bere data ze tvého souboru credentials.json)
    try {
        googleKeys = require('./credentials.json');
    } catch (e) {
        console.error("Missing credentials.json file for local development!");
    }
}

const serviceAccountAuth = new JWT({
    email: googleKeys.client_email,
    key: googleKeys.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Tvůj konkrétní ID tabulky
const doc = new GoogleSpreadsheet('17iOEaSnL0ZxKYXCFiIuJkWoSbnB3INx1Ust0fBnLVg4', serviceAccountAuth);

// 3. Login logika (Anglicky a ošetřeno na velká/malá písmena)
app.post('/login', async (req, res) => {
    const emailInput = req.body.email.toLowerCase().trim();
    const passwordInput = req.body.password.trim();
    
    try {
        await doc.loadInfo(); 
        const sheet = doc.sheetsByTitle['uzivatele'];
        
        if (!sheet) {
            console.error("Sheet 'uzivatele' not found!");
            return res.status(500).send("Error: Database sheet not found.");
        }

        const rows = await sheet.getRows();
        
        // Hledáme shodu v tabulce (sloupce Email, heslo, Jmeno, role)
        const user = rows.find(row => {
            const emailZTabulky = row.get('Email')?.toString().toLowerCase().trim();
            const hesloZTabulky = row.get('heslo')?.toString().trim();
            return emailZTabulky === emailInput && hesloZTabulky === passwordInput;
        });
        
        if (user) {
            // Uložení uživatele do paměti prohlížeče
            req.session.user = {
                jmeno: user.get('Jmeno'),
                role: user.get('role'),
                email: user.get('Email')
            };
            console.log(`User logged in: ${req.session.user.jmeno}`);
            res.redirect('/dashboard');
        } else {
            res.send('<h1>Login Failed</h1><p>Invalid email or password.</p><a href="/">Try again</a>');
        }
    } catch (error) {
        console.error("Detailed login error:", error);
        res.status(500).send('Something went wrong with the connection.');
    }
});

// 4. Dashboard (Zatím jednoduchý výpis, který zítra změníme na kalendář)
app.get('/dashboard', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/');
    }

    const { jmeno, role } = req.session.user;

    // Speciální panel, který uvidí jen Admin
    let adminPanel = "";
    if (role === 'Admin') {
        adminPanel = `
            <div style="background: #1a1a1a; padding: 20px; border: 1px solid #fbc02d; margin-top: 20px; border-radius: 8px;">
                <h3 style="color: #fbc02d; margin-bottom: 15px;">Admin Control Panel</h3>
                <button class="admin-btn">Add New User</button>
                <button class="admin-btn">Edit All Shifts</button>
                <button class="admin-btn">System Settings</button>
            </div>`;
    }

    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Yggdrasil.gg - Dashboard</title>
            <link rel="stylesheet" href="style.css">
            <style>
                .admin-btn { background: #333; color: #fbc02d; border: 1px solid #fbc02d; padding: 10px; margin: 5px; cursor: pointer; font-weight: bold; border-radius: 4px; }
                .admin-btn:hover { background: #fbc02d; color: #000; }
                .logo-text { font-family: 'Oswald', sans-serif; color: #fbc02d; font-size: 3rem; text-transform: uppercase; }
            </style>
        </head>
        <body style="display: flex; flex-direction: column; align-items: center; padding-top: 50px; background-color: #0d0d0d; color: white; font-family: sans-serif;">
            <header style="text-align: center;">
                <h1 class="logo-text">Yggdrasil.gg</h1>
                <p style="font-size: 1.2rem;">Welcome back, <strong>${jmeno}</strong>!</p>
                <p style="color: #fbc02d; text-transform: uppercase; font-size: 0.8rem; letter-spacing: 2px;">Access Level: ${role}</p>
            </header>
            
            <main style="width: 90%; max-width: 800px; margin-top: 30px;">
                <div class="dashboard-box" style="background: #1a1a1a; padding: 30px; border-radius: 8px; border: 1px solid #333; text-align: center;">
                    <h3>Your Dashboard</h3>
                    <p style="color: #888;">The calendar view is being prepared...</p>
                    
                    ${role === 'User' ? '<button style="background: #fbc02d; padding: 10px 20px; border: none; font-weight: bold; margin-top: 15px; cursor: pointer;">Request Shift Change</button>' : ''}
                    ${adminPanel}

                    <div style="margin-top: 40px;">
                        <a href="/logout" style="color: #666; text-decoration: none; font-size: 0.9rem;">Logout from the Hall</a>
                    </div>
                </div>
            </main>
        </body>
        </html>
    `);
});

// 5. Odhlášení
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.listen(PORT, () => {
    console.log(`Yggdrasil.gg server running on http://localhost:${PORT}`);
});