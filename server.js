require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { connectDB, User } = require('./models/database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Global State Object to pass to our socket modules
let globalState = {
    isMaintenanceMode: false,
    globalBankVault: 2000000,
    connectedUsers: {},
    rooms: { baccarat: 0, perya: 0, dt: 0, sicbo: 0, derby: 0 },
    sharedTables: { time: 15, status: 'BETTING', bets: [] },
    globalResults: { baccarat: [], perya: [], dt: [], sicbo: [], derby: [] },
    gameStats: {
        baccarat: { total: 0, Player: 0, Banker: 0, Tie: 0 },
        dt: { total: 0, Dragon: 0, Tiger: 0, Tie: 0 },
        sicbo: { total: 0, Big: 0, Small: 0, Triple: 0 },
        perya: { total: 0, Yellow: 0, White: 0, Pink: 0, Blue: 0, Red: 0, Green: 0 },
        derby: { total: 0, Red: 0, Blue: 0, Green: 0, Yellow: 0 },
        coinflip: { total: 0, Heads: 0, Tails: 0 },
        d20: { total: 0, Win: 0, Lose: 0 },
        blackjack: { total: 0, Win: 0, Lose: 0, Push: 0 }
    }
};

app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'), err => {
        if (err) res.sendFile(path.join(__dirname, 'index.html'));
    });
});

// Admin Live Pulse Emitter
const sendPulse = (msg, type='info') => {
    io.to('admin_room').emit('adminPulse', { msg, type, time: Date.now() });
};

// Initialize MongoDB
connectDB();

// Import Socket Handlers
const registerAuth = require('./sockets/authHandler');
const registerCashier = require('./sockets/cashier');
const registerSoloGames = require('./sockets/soloGames');
const registerSharedGames = require('./sockets/sharedGames');
const registerAdminTools = require('./sockets/adminTools');

io.on('connection', (socket) => {
    socket.emit('timerUpdate', globalState.sharedTables.time);
    socket.emit('maintenanceToggle', globalState.isMaintenanceMode);

    socket.isBetting = false;
    socket.isSharedBetting = false;
    socket.isCashier = false;
    socket.isAuth = false;

    // Register Modules
    registerAuth(io, socket, globalState, sendPulse);
    registerCashier(io, socket, globalState, sendPulse);
    registerSoloGames(io, socket, globalState, sendPulse);
    registerSharedGames(io, socket, globalState, sendPulse);
    registerAdminTools(io, socket, globalState, sendPulse);

    socket.on('disconnect', async () => {
        if (socket.user) { 
            await User.findByIdAndUpdate(socket.user._id, { status: 'Offline' }); 
            delete globalState.connectedUsers[socket.user.username];
        }
        if(socket.currentRoom && globalState.rooms[socket.currentRoom] > 0) {
            globalState.rooms[socket.currentRoom]--; 
            io.emit('playerCount', globalState.rooms);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Modular Master Backend running on port ${PORT}`));

// Start Shared Games Timer
registerSharedGames.startSharedTimer(io, globalState);