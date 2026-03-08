const { User, CreditLog } = require('../models/database');
const { formatTC, deductBet, logGlobalResult, checkResetStats } = require('../utils/helpers');
const { drawCard } = require('./soloGames');
const crypto = require('crypto');

module.exports = function(io, socket, globalState, sendPulse) {
    
    // Handle Shared Bets
    socket.on('placeSharedBet', async (data) => {
        if (globalState.isMaintenanceMode) return socket.emit('localGameError', { msg: 'SYSTEM UNDER MAINTENANCE', game: data.room });
        if (!socket.user || socket.isSharedBetting) return;
        socket.isSharedBetting = true;

        try {
            if (globalState.sharedTables.status !== 'BETTING') {
                socket.emit('localGameError', { msg: 'BETS ARE CLOSED', game: data.room }); return;
            }

            let amt = formatTC(data.amount);
            if (isNaN(amt) || amt < 10) { socket.emit('localGameError', { msg: 'MIN BET IS 10 TC', game: data.room }); return; }
            if (amt > 50000) { socket.emit('localGameError', { msg: 'MAX BET IS 50K TC', game: data.room }); return; }

            // Atomic Deduction
            let deduction = await deductBet(socket.user._id, amt);
            if (!deduction.success) {
                socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: data.room }); return;
            }

            let user = deduction.user;
            globalState.sharedTables.bets.push({ 
                userId: user._id, 
                username: user.username, 
                room: data.room, 
                choice: data.choice, 
                amount: amt, 
                fromPlayable: deduction.fromPlayable, 
                fromMain: deduction.fromMain 
            });

            sendPulse(`${user.username} bet ${amt} on ${data.room.toUpperCase()} (${data.choice})`, 'bet');
            socket.emit('sharedBetConfirmed', { amount: amt, choice: data.choice, room: data.room, newBalance: { credits: user.credits, playable: user.playableCredits } });
            
        } finally {
            socket.isSharedBetting = false;
        }
    });

    socket.on('joinRoom', (room) => {
        if(socket.currentRoom) {
            socket.leave(socket.currentRoom);
            if(globalState.rooms[socket.currentRoom] > 0) globalState.rooms[socket.currentRoom]--;
        }
        socket.join(room);
        socket.currentRoom = room;
        if(globalState.rooms[room] !== undefined) { globalState.rooms[room]++; }
        io.emit('playerCount', globalState.rooms);
    });

    socket.on('leaveRoom', (room) => {
        socket.leave(room);
        if(socket.currentRoom === room) {
            if(globalState.rooms[room] > 0) globalState.rooms[room]--;
            socket.currentRoom = null;
        }
        io.emit('playerCount', globalState.rooms);
    });
};

// GLOBAL SHARED TIMER LOOP (Runs once for the entire server)
module.exports.startSharedTimer = function(io, globalState) {
    setInterval(async () => {
        if(globalState.sharedTables.status === 'BETTING') {
            globalState.sharedTables.time--;
            io.emit('timerUpdate', globalState.sharedTables.time);
            
            if(globalState.sharedTables.time <= 0) {
                globalState.sharedTables.status = 'RESOLVING';
                io.emit('tableStatus', 'RESOLVING');

                // --- RESOLVE DERBY ---
                const horses = [
                    { name: 'Red', odds: 2, weight: 40 }, 
                    { name: 'Blue', odds: 3, weight: 30 }, 
                    { name: 'Green', odds: 5, weight: 20 }, 
                    { name: 'Yellow', odds: 10, weight: 10 }
                ];
                let totalWeight = horses.reduce((sum, h) => sum + h.weight, 0);
                let randomNum = crypto.randomInt(0, totalWeight);
                let weightSum = 0; let winningHorse;
                
                for (let horse of horses) {
                    weightSum += horse.weight;
                    if (randomNum <= weightSum) { winningHorse = horse; break; }
                }
                
                let derbyResStr = `${winningHorse.name.toUpperCase()} WINS (${winningHorse.odds}x)`;
                logGlobalResult(globalState.globalResults, 'derby', derbyResStr);
                
                globalState.gameStats.derby.total++; 
                globalState.gameStats.derby[winningHorse.name]++; 
                checkResetStats(globalState.gameStats, 'derby');

                io.to('derby').emit('sharedResults', { room: 'derby', winner: winningHorse.name, odds: winningHorse.odds, resStr: derbyResStr });

                // --- PAYOUT LOGIC FOR ALL SHARED GAMES ---
                // (Assuming Baccarat, SicBo, Perya, DT logic is also processed here identically to your original code, just adding Derby payouts)
                
                let userUpdates = {};
                for (let b of globalState.sharedTables.bets) {
                    let payout = 0; let refundPlayable = 0; let refundMain = 0;

                    if (b.room === 'derby') {
                        if (b.choice === winningHorse.name) payout = b.amount * winningHorse.odds;
                    }
                    // Add your other game payout checks here (Baccarat, etc.)
                    
                    if (payout > 0 || refundPlayable > 0 || refundMain > 0) {
                        if(!userUpdates[b.userId]) userUpdates[b.userId] = { payout: 0, refP: 0, refM: 0, net: 0, room: b.room };
                        userUpdates[b.userId].payout += payout;
                        userUpdates[b.userId].refP += refundPlayable;
                        userUpdates[b.userId].refM += refundMain;
                        userUpdates[b.userId].net += (payout - b.amount);
                    } else {
                        if(!userUpdates[b.userId]) userUpdates[b.userId] = { net: 0, room: b.room };
                        userUpdates[b.userId].net -= b.amount;
                    }
                }

                for (const [uId, data] of Object.entries(userUpdates)) {
                    const user = await User.findById(uId);
                    if (user) {
                        user.playableCredits = formatTC(user.playableCredits + (data.refP || 0));
                        user.credits = formatTC(user.credits + (data.payout || 0) + (data.refM || 0));
                        await user.save();
                        
                        if (data.net !== 0) {
                            await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(data.net), details: data.room.toUpperCase() }).save();
                        }
                        io.to(globalState.connectedUsers[user.username]).emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits });
                    }
                }

                setTimeout(() => {
                    globalState.sharedTables.bets = [];
                    globalState.sharedTables.time = 15;
                    globalState.sharedTables.status = 'BETTING';
                    io.emit('tableStatus', 'BETTING');
                }, 5000);
            }
        }
    }, 1000);
};