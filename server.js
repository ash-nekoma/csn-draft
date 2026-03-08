require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { connectDB } = require('./models/database');

// Import Socket Handlers
const registerSharedGames = require('./sockets/sharedGames');
const registerSoloGames = require('./sockets/soloGames');
const registerCashier = require('./sockets/cashier');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Connect to MongoDB
connectDB();

// Global State
let globalState = {
    isMaintenanceMode: false,
    globalBankVault: 2000000,
    connectedUsers: {}
};

io.on('connection', (socket) => {
    socket.emit('maintenanceToggle', globalState.isMaintenanceMode);

    // Register modularized socket events
    registerCashier(io, socket, globalState);
    registerSoloGames(io, socket, globalState);
    registerSharedGames(io, socket, globalState);

    socket.on('disconnect', async () => {
        if (socket.user) { 
            const { User } = require('./models/database');
            await User.findByIdAndUpdate(socket.user._id, { status: 'Offline' }); 
            delete globalState.connectedUsers[socket.user.username];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Modular Master Backend running on port ${PORT}`));
