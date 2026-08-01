const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Base de données SQLite (stockée dans un fichier local database.db)
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error("Erreur de bdd", err.message);
    else console.log("Connecté à la base de données SQLite.");
});

// Création des tables si elles n'existent pas
db.serialize(() => {
    // Table des utilisateurs
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT
    )`);

    // Table des demandes d'amis
    db.run(`CREATE TABLE IF NOT EXISTS friendships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT,
        receiver TEXT,
        status TEXT -- 'pending', 'accepted'
    )`);

    // Table des messages sauvegardés
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT,
        receiver TEXT, -- 'General' ou un pseudo d'ami
        content TEXT
    )`);
});

io.on('connection', (socket) => {
    console.log('Un utilisateur s\'est connecté');

    // Inscription / Connexion
    socket.on('login', ({ username, password }) => {
        db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, row) => {
            if (row) {
                // Compte existant -> Vérifier le mot de passe
                if (row.password === password) {
                    socket.username = username;
                    socket.emit('login_success', username);
                    chargerDonneesUtilisateur(socket, username);
                } else {
                    socket.emit('error_msg', "Mot de passe incorrect.");
                }
            } else {
                // Nouveau compte -> Inscription automatique
                db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, password], (err) => {
                    if (!err) {
                        socket.username = username;
                        socket.emit('login_success', username);
                        chargerDonneesUtilisateur(socket, username);
                    }
                });
            }
        });
    });

    // Envoyer une demande d'ami
    socket.on('send_friend_request', (targetUsername) => {
        if (targetUsername === socket.username) return;
        
        db.get(`SELECT * FROM users WHERE username = ?`, [targetUsername], (err, row) => {
            if (row) {
                db.run(`INSERT INTO friendships (sender, receiver, status) VALUES (?, ?, 'pending')`, 
                    [socket.username, targetUsername], () => {
                        chargerDonneesUtilisateur(socket, socket.username);
                        // Si l'ami est connecté, on met aussi à jour sa liste
                        io.sockets.sockets.forEach(s => {
                            if (s.username === targetUsername) {
                                chargerDonneesUtilisateur(s, targetUsername);
                            }
                        });
                    });
            } else {
                socket.emit('error_msg', "Cet utilisateur n'existe pas.");
            }
        });
    });

    // Accepter ou refuser une demande d'ami
    socket.on('respond_friend', ({ sender, accept }) => {
        if (accept) {
            db.run(`UPDATE friendships SET status = 'accepted' WHERE sender = ? AND receiver = ?`, 
                [sender, socket.username], () => {
                    actualiserTousLesAmis(socket.username, sender);
                });
        } else {
            db.run(`DELETE FROM friendships WHERE sender = ? AND receiver = ?`, 
                [sender, socket.username], () => {
                    actualiserTousLesAmis(socket.username, sender);
                });
        }
    });

    // Envoyer un message (sauvegardé en base)
    socket.on('send_message', ({ receiver, content }) => {
        db.run(`INSERT INTO messages (sender, receiver, content) VALUES (?, ?, ?)`, 
            [socket.username, receiver, content], () => {
                // Envoyer au destinataire s'il est connecté et à l'expéditeur
                io.sockets.sockets.forEach(s => {
                    if (s.username === socket.username || s.username === receiver) {
                        s.emit('new_message', { sender: socket.username, receiver, content });
                    }
                });
            });
    });

    // Charger l'historique d'une discussion
    socket.on('load_chat', (contact) => {
        let query = `SELECT * FROM messages WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?) ORDER BY id ASC`;
        db.all(query, [socket.username, contact, contact, socket.username], (err, rows) => {
            socket.emit('chat_history', { contact, messages: rows });
        });
    });
});

function chargerDonneesUtilisateur(socket, username) {
    // Charger la liste des amis et demandes
    db.all(`SELECT * FROM friendships WHERE sender = ? OR receiver = ?`, [username, username], (err, rows) => {
        socket.emit('friend_data', rows);
    });
}

function actualiserTousLesAmis(user1, user2) {
    io.sockets.sockets.forEach(s => {
        if (s.username === user1 || s.username === user2) {
            chargerDonneesUtilisateur(s, s.username);
        }
    });
}

server.listen(3000, () => {
    console.log('Serveur lancé sur http://localhost:3000');
});