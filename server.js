require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ==========================================
// CACHE-BUSTER & RAILWAY ROUTING
// ==========================================
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    if(req.path === '/admin.html') return res.redirect('/'); 
    next();
});

app.get('/master-portal-77X', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'), err => {
        if (err) res.sendFile(path.join(__dirname, 'index.html'));
    });
});

// ==========================================
// SECURITY & LIMITS ENGINE
// ==========================================
function getSecureRNG(min, max) {
    return crypto.randomInt(min, max + 1);
}

const formatTC = (amount) => Math.round(amount * 10) / 10;

const activeUserLocks = new Set();
const rateLimits = {};

function checkRateLimit(socketId) {
    const now = Date.now();
    if (!rateLimits[socketId]) rateLimits[socketId] = [];
    rateLimits[socketId] = rateLimits[socketId].filter(t => now - t < 1000); 
    if (rateLimits[socketId].length >= 10) return false;
    rateLimits[socketId].push(now);
    return true;
}

function sanitizeHTML(str) {
    return str.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function deductBet(user, betAmount) {
    if (typeof betAmount !== 'number' || isNaN(betAmount)) return { success: false };
    
    let amt = formatTC(betAmount);
    let totalBal = formatTC((user.credits || 0) + (user.playableCredits || 0));
    
    if (amt < 10 || amt > 50000 || totalBal < amt) return { success: false };

    let fromPlayable = 0;
    let fromMain = 0;

    if ((user.playableCredits || 0) >= amt) {
        fromPlayable = amt;
        user.playableCredits = formatTC(user.playableCredits - amt);
    } else {
        fromPlayable = user.playableCredits || 0;
        fromMain = formatTC(amt - fromPlayable);
        user.playableCredits = 0;
        user.credits = formatTC((user.credits || 0) - fromMain);
    }
    return { success: true, fromPlayable, fromMain };
}

// ==========================================
// MONGODB SETUP
// ==========================================
const MONGO_URI = process.env.MONGO_URL || 'mongodb://localhost:27017/stickntrade';
mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log('✅ Connected to MongoDB Database');
        
        try {
            const db = mongoose.connection.db;
            const badJoinDates = await db.collection('users').find({ "joinDate.$date": { $exists: true } }).toArray();
            for (let u of badJoinDates) { await db.collection('users').updateOne({ _id: u._id }, { $set: { joinDate: new Date(u.joinDate.$date) } }); }
            const badDaily = await db.collection('users').find({ "dailyReward.lastClaim.$date": { $exists: true } }).toArray();
            for (let u of badDaily) { await db.collection('users').updateOne({ _id: u._id }, { $set: { "dailyReward.lastClaim": new Date(u.dailyReward.lastClaim.$date) } }); }
        } catch (healErr) { console.error("Auto-heal skipped.", healErr); }

        const adminExists = await User.findOne({ username: 'admin' });
        if (!adminExists) {
            await new User({ username: 'admin', password: process.env.ADMIN_PASS || 'Kenm44ashley', role: 'Admin', credits: 10000, playableCredits: 0 }).save();
            console.log('🛡️ Default Admin Account Created');
        }
    })
    .catch(err => { console.error('❌ MongoDB Connection Error.', err); });

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    sessionToken: { type: String, default: null },
    role: { type: String, default: 'Player' },
    credits: { type: Number, default: 0 }, 
    playableCredits: { type: Number, default: 0 }, 
    status: { type: String, default: 'Offline' },
    ipAddress: { type: String, default: 'Unknown' },
    streak: { type: Number, default: 0 },
    joinDate: { type: Date, default: Date.now },
    dailyReward: { lastClaim: { type: Date, default: null }, streak: { type: Number, default: 0 } }
});
const User = mongoose.model('User', userSchema);

const txSchema = new mongoose.Schema({
    username: String, type: String, amount: Number, ref: String,
    status: { type: String, default: 'Pending' }, date: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', txSchema);

const codeSchema = new mongoose.Schema({
    batchId: String, amount: Number, code: String, creditType: { type: String, default: 'playable' },
    redeemedBy: { type: String, default: null }, date: { type: Date, default: Date.now }
});
const GiftCode = mongoose.model('GiftCode', codeSchema);

const creditLogSchema = new mongoose.Schema({
    username: String, action: String, amount: Number, details: String, date: { type: Date, default: Date.now }
});
const CreditLog = mongoose.model('CreditLog', creditLogSchema);

const adminLogSchema = new mongoose.Schema({
    adminName: String, action: String, details: String, date: { type: Date, default: Date.now }
});
const AdminLog = mongoose.model('AdminLog', adminLogSchema);

// ==========================================
// ENGINE & STATS
// ==========================================
let rooms = { baccarat: 0, perya: 0, dt: 0, sicbo: 0, duel: 0 };
let sharedTables = { time: 10, status: 'BETTING', bets: [] }; 
let connectedUsers = {}; 

let globalResults = { baccarat: [], perya: [], dt: [], sicbo: [], d20: [], coinflip: [], blackjack: [] }; 

let gameStats = {
    baccarat: { total: 0, Player: 0, Banker: 0, Tie: 0 },
    dt: { total: 0, Dragon: 0, Tiger: 0, Tie: 0 },
    sicbo: { total: 0, Big: 0, Small: 0, Triple: 0 },
    perya: { total: 0, Yellow: 0, White: 0, Pink: 0, Blue: 0, Red: 0, Green: 0 },
    coinflip: { total: 0, Heads: 0, Tails: 0 },
    d20: { total: 0, Win: 0, Lose: 0 },
    blackjack: { total: 0, Win: 0, Lose: 0, Push: 0 }
};

function logGlobalResult(game, resultStr) {
    if(globalResults[game]) {
        globalResults[game].unshift({ result: resultStr, time: new Date() });
        if (globalResults[game].length > 5) globalResults[game].pop(); 
    }
}

function checkResetStats(game) {
    if (gameStats[game].total >= 100) { Object.keys(gameStats[game]).forEach(key => { gameStats[game][key] = 0; }); }
}

function drawCard(hidden = false) {
    const vs = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const ss = ['♠','♣','♥','♦'];
    let v = vs[getSecureRNG(0, vs.length - 1)];
    let s = ss[getSecureRNG(0, ss.length - 1)];
    
    if (hidden) return { val: '?', suit: '?', bacVal: 0, bjVal: 0, dtVal: 0, raw: '?', suitHtml: `<div class="card-back" style="width:100%;height:100%;border-radius:6px;"></div>`, realVal: v, realSuit: s };

    let bac = isNaN(parseInt(v)) ? (v === 'A' ? 1 : 0) : (v === '10' ? 0 : parseInt(v));
    let bj = isNaN(parseInt(v)) ? (v === 'A' ? 11 : 10) : parseInt(v);
    let dt = (v === 'A') ? 1 : (v === 'K' ? 13 : (v === 'Q' ? 12 : (v === 'J' ? 11 : parseInt(v))));
    let suitHtml = (s === '♥' || s === '♦') ? `<span class="card-red">${s}</span>` : s;
    return { val: v, suit: s, bacVal: bac, bjVal: bj, dtVal: dt, raw: v, suitHtml: suitHtml };
}

function getBJScore(hand) {
    let score = 0, aces = 0;
    for (let card of hand) { 
        let v = card.realVal || card.val; 
        if (v === '?') continue; // Skip hidden cards
        let bjV = isNaN(parseInt(v)) ? (v === 'A' ? 11 : 10) : parseInt(v);
        score += bjV; 
        if (v === 'A') aces += 1; 
    }
    while (score > 21 && aces > 0) { score -= 10; aces -= 1; }
    return score;
}

// ==========================================
// DUEL ARENA ENGINE
// ==========================================
let arena = {
    p1: null, p2: null, 
    target: 1, p1Score: 0, p2Score: 0,
    game: 'dice', turn: 1, state: 'WAITING',
    tempData: {}, bets: []
};

function syncArena() { io.to('duel').emit('arenaSync', arena); }

async function resetArenaFull() {
    if(arena.bets.length > 0) {
        for (let b of arena.bets) { await User.findByIdAndUpdate(b.userId, { $inc: { playableCredits: b.fromPlayable, credits: b.fromMain } }); }
    }
    arena = { p1: null, p2: null, target: 1, p1Score: 0, p2Score: 0, game: 'dice', turn: 1, state: 'WAITING', tempData: {}, bets: [] };
    syncArena();
}

async function resolveArenaBets(winnerNum) {
    for (let b of arena.bets) {
        if (b.betOn === winnerNum) {
            let winAmt = formatTC(b.amount * 2);
            await User.findByIdAndUpdate(b.userId, { $inc: { credits: winAmt } });
            await new CreditLog({ username: b.username, action: 'GAME', amount: formatTC(winAmt - b.amount), details: `Duel Arena Win` }).save();
        } else {
            await new CreditLog({ username: b.username, action: 'GAME', amount: -b.amount, details: `Duel Arena Loss` }).save();
        }
    }
    arena.bets = [];
}

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================
async function gracefulShutdown() {
    console.log('⚠️ Server restarting... Refunding active bets.');
    for (let b of sharedTables.bets) await User.findByIdAndUpdate(b.userId, { $inc: { playableCredits: b.fromPlayable, credits: b.fromMain } });
    for (let b of arena.bets) await User.findByIdAndUpdate(b.userId, { $inc: { playableCredits: b.fromPlayable, credits: b.fromMain } });
    process.exit(0);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// ==========================================
// SHARED TABLES LOOP (10s)
// ==========================================
setInterval(() => {
    if (sharedTables.status === 'BETTING') {
        sharedTables.time--;
        io.emit('timerUpdate', sharedTables.time);

        if (sharedTables.time <= 0) {
            sharedTables.status = 'RESOLVING';
            io.emit('lockBets');

            setTimeout(async () => {
                // DRAGON TIGER
                let dtD = drawCard(), dtT = drawCard();
                let dtWin = dtD.dtVal > dtT.dtVal ? 'Dragon' : (dtT.dtVal > dtD.dtVal ? 'Tiger' : 'Tie');
                let dtResStr = dtWin === 'Tie' ? `TIE (${dtD.raw} TO ${dtT.raw})` : `${dtWin.toUpperCase()} WINS`;
                logGlobalResult('dt', dtResStr);
                gameStats.dt.total++; gameStats.dt[dtWin]++;
                
                // SIC BO
                let sbR = [getSecureRNG(1,6), getSecureRNG(1,6), getSecureRNG(1,6)];
                let sbSum = sbR[0] + sbR[1] + sbR[2];
                let sbTrip = (sbR[0] === sbR[1] && sbR[1] === sbR[2]);
                let sbWin = sbTrip ? 'Triple' : (sbSum <= 10 ? 'Small' : 'Big');
                let sbResStr = sbTrip ? `TRIPLE (${sbR[0]})` : `${sbWin.toUpperCase()} (${sbSum})`;
                logGlobalResult('sicbo', sbResStr);
                gameStats.sicbo.total++; gameStats.sicbo[sbWin]++;

                // PERYA
                const cols = ['Yellow','White','Pink','Blue','Red','Green'];
                let pyR = [cols[getSecureRNG(0,5)], cols[getSecureRNG(0,5)], cols[getSecureRNG(0,5)]];
                logGlobalResult('perya', pyR.join(',').toUpperCase());
                gameStats.perya.total++; pyR.forEach(c => gameStats.perya[c]++);

                // BACCARAT
                let pC = [drawCard(), drawCard()], bC = [drawCard(), drawCard()];
                let pS = (pC[0].bacVal + pC[1].bacVal) % 10;
                let bS = (bC[0].bacVal + bC[1].bacVal) % 10;
                let p3Drawn = false, b3Drawn = false;

                if (pS < 8 && bS < 8) {
                    let p3Val = -1;
                    if (pS <= 5) { pC.push(drawCard()); p3Val = pC[2].bacVal; pS = (pS + p3Val) % 10; p3Drawn = true; }
                    let bDraws = false;
                    if (pC.length === 2) { if (bS <= 5) bDraws = true; } 
                    else {
                        if (bS <= 2) bDraws = true;
                        else if (bS === 3 && p3Val !== 8) bDraws = true;
                        else if (bS === 4 && p3Val >= 2 && p3Val <= 7) bDraws = true;
                        else if (bS === 5 && p3Val >= 4 && p3Val <= 7) bDraws = true;
                        else if (bS === 6 && (p3Val === 6 || p3Val === 7)) bDraws = true;
                    }
                    if (bDraws) { bC.push(drawCard()); bS = (bS + bC[bC.length-1].bacVal) % 10; b3Drawn = true; }
                }
                let bacWin = pS > bS ? 'Player' : (bS > pS ? 'Banker' : 'Tie');
                let bacResStr = bacWin === 'Tie' ? `TIE (${pS} TO ${bS})` : `${bacWin.toUpperCase()} WINS`;
                logGlobalResult('baccarat', bacResStr);
                gameStats.baccarat.total++; gameStats.baccarat[bacWin]++;

                let playerStats = {}; 
                sharedTables.bets.forEach(b => {
                    let payout = 0;
                    if (b.room === 'dt') { 
                        if (dtWin === 'Tie') { if (b.choice === 'Tie') payout = b.amount * 9; else payout = b.amount; } 
                        else { if (b.choice === dtWin) payout = b.amount * 2; }
                    } 
                    else if (b.room === 'sicbo') { if (b.choice === sbWin) payout = b.amount * 2; } 
                    else if (b.room === 'perya') {
                        let matches = pyR.filter(c => c === b.choice).length;
                        if (matches > 0) payout = b.amount + (b.amount * matches);
                    } 
                    else if (b.room === 'baccarat') {
                        if (bacWin === 'Tie') { if (b.choice === 'Tie') payout = b.amount * 9; else if (b.choice === 'Player' || b.choice === 'Banker') payout = b.amount; } 
                        else if (bacWin === 'Player') { if (b.choice === 'Player') payout = b.amount * 2; } 
                        else if (bacWin === 'Banker') { if (b.choice === 'Banker') payout = b.amount * 1.95; }
                    }

                    if (!playerStats[b.userId]) playerStats[b.userId] = { socketId: b.socketId, username: b.username, amountWon: 0, amountBet: 0, room: b.room };
                    playerStats[b.userId].amountBet += b.amount;
                    playerStats[b.userId].amountWon += formatTC(payout);
                });

                let roomNames = { 'perya': 'Color Game', 'dt': 'Dragon Tiger', 'sicbo': 'Sic Bo', 'baccarat': 'Baccarat' };

                Object.keys(playerStats).forEach(async (userId) => {
                    let st = playerStats[userId];
                    let isWin = st.amountWon > st.amountBet;
                    let net = formatTC(st.amountWon - st.amountBet);
                    
                    let updateData = { $inc: {} };
                    if (st.amountWon > 0) updateData.$inc.credits = formatTC(st.amountWon);
                    if (isWin) updateData.$inc.streak = 1; else updateData.$set = { streak: 0 };
                    
                    await User.findByIdAndUpdate(userId, updateData);

                    if (st.amountWon >= 5000) {
                        io.emit('globalToast', { msg: `🎉 ${st.username} just won ${formatTC(st.amountWon)} TC on ${roomNames[st.room]}!` });
                    }

                    if (net !== 0) {
                        await new CreditLog({ username: st.username, action: 'GAME', amount: net, details: roomNames[st.room] }).save();
                    }

                    // Delay balance emission slightly so it hits after the frontend animation finishes
                    setTimeout(async () => {
                        let updatedUser = await User.findById(userId);
                        let targetSocketId = connectedUsers[updatedUser.username];
                        if (targetSocketId) {
                            io.to(targetSocketId).emit('balanceUpdateData', { credits: updatedUser.credits, playable: updatedUser.playableCredits });
                        }
                    }, 2500); 
                });

                io.to('dt').emit('sharedResults', { room: 'dt', dCard: dtD, tCard: dtT, winner: dtWin, resStr: dtResStr, stats: gameStats.dt });
                io.to('sicbo').emit('sharedResults', { room: 'sicbo', roll: sbR, sum: sbSum, winner: sbWin, resStr: sbResStr, stats: gameStats.sicbo });
                io.to('perya').emit('sharedResults', { room: 'perya', roll: pyR, stats: gameStats.perya });
                io.to('baccarat').emit('sharedResults', { room: 'baccarat', pCards: pC, bCards: bC, pScore: pS, bScore: bS, winner: bacWin, resStr: bacResStr, p3Drawn: p3Drawn, b3Drawn: b3Drawn, stats: gameStats.baccarat });

                checkResetStats('dt'); checkResetStats('sicbo'); checkResetStats('perya'); checkResetStats('baccarat');

            }, 500);

            setTimeout(() => {
                sharedTables.time = 10; 
                sharedTables.status = 'BETTING';
                sharedTables.bets = [];
                io.emit('newRound'); 
                pushAdminData();
            }, 7500); 
        }
    }
}, 1000);

async function pushAdminData(targetSocket = null) {
    try {
        const users = await User.find(); 
        const txs = await Transaction.find().sort({ date: -1 }); 
        const gcs = await GiftCode.find().sort({ date: -1 });
        let totalEconomy = formatTC(users.reduce((a, b) => a + (b.credits || 0) + (b.playableCredits || 0), 0));
        let approvedDeposits = txs.filter(t => t.type === 'Deposit' && t.status === 'Approved').reduce((a, b) => a + b.amount, 0);

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const gameLogs = await CreditLog.find({ action: 'GAME', date: { $gte: oneDayAgo } });
        let playerNet = gameLogs.reduce((sum, l) => sum + l.amount, 0);
        let houseProfit24h = formatTC(-playerNet);

        const adminLogs = await AdminLog.find().sort({ date: -1 }).limit(100);

        let payload = { 
            users, transactions: txs, giftBatches: gcs, adminLogs,
            stats: { economy: totalEconomy, approvedDeposits: formatTC(approvedDeposits), limit: 2000000, houseProfit: houseProfit24h } 
        };

        if(targetSocket) { targetSocket.emit('adminDataSync', payload); }
        else { io.to('admin_room').emit('adminDataSync', payload); }
        
    } catch(e) { console.error(e); }
}

// ==========================================
// CLIENT SOCKET COMMUNICATION
// ==========================================
io.on('connection', (socket) => {
    socket.emit('timerUpdate', sharedTables.time);

    socket.isBetting = false;
    socket.isSharedBetting = false;
    socket.isCashier = false;
    socket.isAuth = false;
    socket.lastBetTime = 0; 

    socket.on('requestBalanceRefresh', async () => {
        if(socket.user) {
            let u = await User.findById(socket.user._id);
            if(u) socket.emit('balanceUpdateData', { credits: formatTC(u.credits), playable: formatTC(u.playableCredits) });
        }
    });

    socket.on('getWalletLogs', async () => {
        if(socket.user) {
            const logs = await CreditLog.find({ username: socket.user.username }).sort({ date: -1 }).limit(50);
            const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
            const todayLogs = await CreditLog.find({ username: socket.user.username, date: { $gte: startOfDay }});
            let dailyProfit = 0;
            todayLogs.forEach(l => { if (l.action === 'GAME') dailyProfit += l.amount; });
            socket.emit('walletLogsData', { logs, dailyProfit: formatTC(dailyProfit) });
        }
    });

    socket.on('clearWalletLogs', async () => {
        if(socket.user) {
            await CreditLog.deleteMany({ username: socket.user.username });
            socket.emit('walletLogsData', { logs: [], dailyProfit: 0 });
        }
    });

    socket.on('fetchUserLogs', async (username) => {
        if (!socket.rooms.has('admin_room')) return;
        const logs = await CreditLog.find({ username }).sort({ date: -1 }).limit(100);
        socket.emit('userLogsData', { username, logs });
    });

    // --- SOLO GAMES ENGINE ---
    socket.on('playSolo', async (data) => {
        const now = Date.now();
        if (now - socket.lastBetTime < 150) return;
        socket.lastBetTime = now;

        if (!socket.user || socket.isBetting || !checkRateLimit(socket.id)) return;
        socket.isBetting = true;

        try {
            const user = await User.findById(socket.user._id);
            if (!user) return;
            
            let isNewBet = (data.game === 'd20' || data.game === 'coinflip' || (data.game === 'blackjack' && data.action === 'start'));
            let totalWagerAmount = 0;

            if (isNewBet) {
                if (data.game === 'd20') {
                    // D20 MULTI-BET SUPPORT
                    for (let key in data.bets) { totalWagerAmount += formatTC(data.bets[key]); }
                    if (totalWagerAmount < 10) { socket.emit('localGameError', { msg: 'MIN BET IS 10 TC', game: 'd20' }); return; }
                } else {
                    totalWagerAmount = formatTC(data.bet);
                    if (isNaN(totalWagerAmount) || totalWagerAmount < 10) { socket.emit('localGameError', { msg: 'MIN BET IS 10 TC', game: data.game }); return; }
                }

                if (totalWagerAmount > 50000) { socket.emit('localGameError', { msg: 'MAX BET IS 50K TC', game: data.game }); return; }
                
                let deduction = await deductBet(user, totalWagerAmount);
                if (!deduction.success) { socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: data.game }); return; }
                
                await User.findByIdAndUpdate(socket.user._id, { $inc: { playableCredits: -deduction.fromPlayable, credits: -deduction.fromMain }});

                if (data.game === 'blackjack') {
                    socket.bjState = { 
                        bet: totalWagerAmount, 
                        pHand: [drawCard(), drawCard()], 
                        dHand: [drawCard(), drawCard(true)],
                        fromPlayable: deduction.fromPlayable,
                        fromMain: deduction.fromMain
                    };
                }
            }

            let payout = 0;

            if (data.game === 'd20') {
                gameStats.d20.total++;
                let roll = getSecureRNG(1, 20);
                
                for (let key in data.bets) {
                    let bAmt = formatTC(data.bets[key]);
                    let [type, val] = key.split('-');
                    let win = false; let mult = 0;
                    
                    if(type === 'exact' && roll === parseInt(val)) { win = true; mult = 18; }
                    if(type === 'highlow' && val === 'high' && roll >= 11) { win = true; mult = 1.95; }
                    if(type === 'highlow' && val === 'low' && roll <= 10) { win = true; mult = 1.95; }
                    if(type === 'oddeven' && val === 'even' && roll % 2 === 0) { win = true; mult = 1.95; }
                    if(type === 'oddeven' && val === 'odd' && roll % 2 !== 0) { win = true; mult = 1.95; }
                    
                    if(win) { payout += formatTC(bAmt * mult); }
                }

                if (payout > 0) { gameStats.d20.Win++; await User.findByIdAndUpdate(socket.user._id, { $inc: { credits: payout } }); } 
                else { gameStats.d20.Lose++; }
                
                let net = formatTC(payout - totalWagerAmount);
                if(net !== 0) await new CreditLog({ username: user.username, action: 'GAME', amount: net, details: `D20` }).save();
                
                let updatedUser = await User.findById(socket.user._id);
                let resStr = `ROLLED ${roll}`;
                logGlobalResult('d20', resStr);
                pushAdminData();
                socket.emit('d20Result', { roll, payout, bet: totalWagerAmount, resStr: resStr, newBalance: { credits: updatedUser.credits, playable: updatedUser.playableCredits }, stats: gameStats.d20 });
                checkResetStats('d20');
            } 
            else if (data.game === 'coinflip') {
                gameStats.coinflip.total++;
                let result = getSecureRNG(0, 1) === 0 ? 'Heads' : 'Tails';
                gameStats.coinflip[result]++; // Track Heads/Tails instead of Win/Lose
                if (data.choice === result) payout = formatTC(data.bet * 1.95);
                
                if (payout > 0) { await User.findByIdAndUpdate(socket.user._id, { $inc: { credits: payout } }); }
                
                let net = formatTC(payout - data.bet);
                if(net !== 0) await new CreditLog({ username: user.username, action: 'GAME', amount: net, details: `Coin Flip` }).save();
                
                let updatedUser = await User.findById(socket.user._id);
                let resStr = `LANDED ON ${result.toUpperCase()}`;
                logGlobalResult('coinflip', resStr);
                pushAdminData();
                socket.emit('coinResult', { result, payout, bet: data.bet, choice: data.choice, resStr: resStr, newBalance: { credits: updatedUser.credits, playable: updatedUser.playableCredits }, stats: gameStats.coinflip });
                checkResetStats('coinflip');
            }
            else if (data.game === 'blackjack') {
                if (data.action === 'start') {
                    gameStats.blackjack.total++; 
                    let pS = getBJScore(socket.bjState.pHand); let dS = getBJScore(socket.bjState.dHand);
                    
                    if (pS === 21) {
                        let msg = dS === 21 ? 'Push' : 'Blackjack!';
                        payout = formatTC(dS === 21 ? socket.bjState.bet : socket.bjState.bet * 2.5);
                        if(msg === 'Blackjack!') gameStats.blackjack.Win++; else gameStats.blackjack.Push++;
                        
                        if (msg === 'Push') {
                            await User.findByIdAndUpdate(socket.user._id, { $inc: { playableCredits: socket.bjState.fromPlayable, credits: socket.bjState.fromMain } });
                        } else if (payout > 0) {
                            await User.findByIdAndUpdate(socket.user._id, { $inc: { credits: payout } });
                        }

                        let net = formatTC(payout - socket.bjState.bet);
                        if(net !== 0) await new CreditLog({ username: user.username, action: 'GAME', amount: net, details: `Blackjack` }).save();
                        
                        let resStr = `${msg.toUpperCase()} (${pS} TO ${dS})`;
                        
                        let updatedUser = await User.findById(socket.user._id);
                        socket.bjState.dHand[1].suitHtml = socket.bjState.dHand[1].realSuit === '♥' || socket.bjState.dHand[1].realSuit === '♦' ? `<span class="card-red">${socket.bjState.dHand[1].realSuit}</span>` : socket.bjState.dHand[1].realSuit;
                        socket.bjState.dHand[1].raw = socket.bjState.dHand[1].realVal;

                        logGlobalResult('blackjack', resStr);
                        pushAdminData();
                        socket.emit('bjUpdate', { event: 'deal', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, naturalBJ: true, payout, msg, resStr: resStr, bet: socket.bjState.bet, newBalance: { credits: updatedUser.credits, playable: updatedUser.playableCredits }, stats: gameStats.blackjack });
                        socket.bjState = null;
                        checkResetStats('blackjack');
                    } else {
                        let maskedDHand = [socket.bjState.dHand[0], {val: '?', suit: '?', raw: '?', suitHtml: `<div class="card-back" style="width:100%;height:100%;border-radius:6px;"></div>`, bacVal: 0, bjVal: 0, dtVal: 0}];
                        socket.emit('bjUpdate', { event: 'deal', pHand: socket.bjState.pHand, dHand: maskedDHand });
                    }
                }
                else if (data.action === 'hit') {
                    if(!socket.bjState) return;
                    socket.bjState.pHand.push(drawCard());
                    let pS = getBJScore(socket.bjState.pHand); let dS = getBJScore(socket.bjState.dHand);
                    
                    if (pS > 21) {
                        gameStats.blackjack.Lose++;
                        await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(-socket.bjState.bet), details: `Blackjack` }).save();
                        let resStr = `PLAYER BUSTS! (${pS})`;
                        
                        let updatedUser = await User.findById(socket.user._id);
                        socket.bjState.dHand[1].suitHtml = socket.bjState.dHand[1].realSuit === '♥' || socket.bjState.dHand[1].realSuit === '♦' ? `<span class="card-red">${socket.bjState.dHand[1].realSuit}</span>` : socket.bjState.dHand[1].realSuit;
                        socket.bjState.dHand[1].raw = socket.bjState.dHand[1].realVal;

                        logGlobalResult('blackjack', resStr);
                        socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout: 0, msg: 'Bust!', resStr: resStr, bet: socket.bjState.bet, newBalance: { credits: updatedUser.credits, playable: updatedUser.playableCredits }, stats: gameStats.blackjack });
                        socket.bjState = null;
                        checkResetStats('blackjack');
                    } else {
                        socket.emit('bjUpdate', { event: 'hit', pHand: socket.bjState.pHand });
                    }
                }
                else if (data.action === 'stand') {
                    if(!socket.bjState) return;
                    let pS = getBJScore(socket.bjState.pHand);
                    
                    socket.bjState.dHand[1].val = socket.bjState.dHand[1].realVal;
                    socket.bjState.dHand[1].raw = socket.bjState.dHand[1].realVal;
                    socket.bjState.dHand[1].suitHtml = socket.bjState.dHand[1].realSuit === '♥' || socket.bjState.dHand[1].realSuit === '♦' ? `<span class="card-red">${socket.bjState.dHand[1].realSuit}</span>` : socket.bjState.dHand[1].realSuit;
                    
                    while (getBJScore(socket.bjState.dHand) < 17) { socket.bjState.dHand.push(drawCard()); }
                    let dS = getBJScore(socket.bjState.dHand);
                    let msg = '';
                    
                    if (dS > 21 || pS > dS) { payout = formatTC(socket.bjState.bet * 2); msg = 'You Win!'; gameStats.blackjack.Win++; } 
                    else if (pS === dS) { payout = formatTC(socket.bjState.bet); msg = 'Push'; gameStats.blackjack.Push++; } 
                    else { msg = 'Dealer Wins'; gameStats.blackjack.Lose++; }
                    
                    if (msg === 'Push') {
                        await User.findByIdAndUpdate(socket.user._id, { $inc: { playableCredits: socket.bjState.fromPlayable, credits: socket.bjState.fromMain } });
                    } else if (payout > 0) {
                        await User.findByIdAndUpdate(socket.user._id, { $inc: { credits: payout } }); 
                    }

                    let net = formatTC(payout - socket.bjState.bet);
                    if(net !== 0) await new CreditLog({ username: user.username, action: 'GAME', amount: net, details: `Blackjack` }).save();
                    
                    let resStr = "";
                    if (dS > 21) { resStr = `DEALER BUSTS! (${dS} TO ${pS})`; } 
                    else if (msg === 'Push') { resStr = `TIE (${dS} TO ${pS})`; } 
                    else if (msg === 'You Win!') { resStr = `PLAYER (${pS} TO ${dS})`; } 
                    else { resStr = `DEALER (${dS} TO ${pS})`; }
                    
                    logGlobalResult('blackjack', resStr);
                    pushAdminData();
                    let updatedUser = await User.findById(socket.user._id);
                    socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout, msg, resStr: resStr, bet: socket.bjState.bet, newBalance: { credits: updatedUser.credits, playable: updatedUser.playableCredits }, stats: gameStats.blackjack });
                    socket.bjState = null;
                    checkResetStats('blackjack');
                }
            }
        } finally {
            socket.isBetting = false; 
        }
    });

    // --- SHARED TABLES NETWORKING ---
    socket.on('joinRoom', (room) => { 
        if(socket.currentRoom) { socket.leave(socket.currentRoom); if(rooms[socket.currentRoom] > 0) rooms[socket.currentRoom]--; }
        socket.join(room); socket.currentRoom = room; rooms[room]++; 
        io.emit('playerCount', rooms); 
        
        if(room === 'duel') {
            socket.emit('arenaSync', arena);
        }
    });

    socket.on('getRoomPlayers', async (room) => {
        const players = await User.find({ status: 'Active' });
        socket.emit('roomPlayersData', players.map(p => ({ username: p.username, streak: p.streak || 0 })));
    });
    
    socket.on('leaveRoom', (room) => { 
        socket.leave(room); socket.currentRoom = null;
        if (rooms[room] > 0) rooms[room]--; 
        io.emit('playerCount', rooms); 
    });
    
    socket.on('sendChat', async (data) => { 
        if (socket.user && socket.currentRoom) { 
            let safeText = sanitizeHTML(data.msg);
            const user = await User.findById(socket.user._id);
            const streakIcon = (user && user.streak >= 3) ? '🔥 ' : '';
            io.to(socket.currentRoom).emit('chatMessage', { user: streakIcon + socket.user.username, text: safeText, sys: false }); 
        } 
    });
    
    socket.on('placeSharedBet', async (data) => {
        const now = Date.now();
        if (now - socket.lastBetTime < 150) return;
        socket.lastBetTime = now;

        if (!socket.user || sharedTables.status !== 'BETTING') return;
        if (socket.isSharedBetting) return;
        socket.isSharedBetting = true;
        
        try {
            const validGames = {
                'baccarat': ['Player', 'Banker', 'Tie'],
                'dt': ['Dragon', 'Tiger', 'Tie'],
                'sicbo': ['Small', 'Big'],
                'perya': ['Yellow', 'White', 'Pink', 'Blue', 'Red', 'Green']
            };
            if (!validGames[data.room] || !validGames[data.room].includes(data.choice)) {
                return socket.emit('localGameError', { msg: 'INVALID BET CHOICE', game: data.room });
            }
            
            const user = await User.findById(socket.user._id);
            if (!user) return;

            let amt = formatTC(data.amount);
            if (isNaN(amt) || amt < 10) {
                return socket.emit('localGameError', { msg: 'MIN BET IS 10 TC', game: data.room });
            }

            let currentTileBet = sharedTables.bets
                .filter(b => b.userId.toString() === user._id.toString() && b.room === data.room && b.choice === data.choice)
                .reduce((sum, b) => sum + b.amount, 0);

            if (currentTileBet + amt > 50000) {
                socket.emit('localGameError', { msg: 'MAX 50K TC PER TILE', game: data.room });
                return;
            }
            
            let deduction = await deductBet(user, amt);
            if (!deduction.success) {
                socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: data.room });
                return;
            }
            
            await User.findByIdAndUpdate(socket.user._id, { $inc: { playableCredits: -deduction.fromPlayable, credits: -deduction.fromMain }});
            
            sharedTables.bets.push({ 
                userId: user._id, 
                socketId: socket.id, 
                username: user.username, 
                room: data.room, 
                choice: data.choice, 
                amount: amt,
                fromPlayable: deduction.fromPlayable,
                fromMain: deduction.fromMain 
            });
        } finally {
            socket.isSharedBetting = false;
        }
    });

    socket.on('undoSharedBet', async (data) => {
        if (!socket.user || sharedTables.status !== 'BETTING') return;
        if (socket.isSharedBetting) return;
        socket.isSharedBetting = true;

        try {
            for (let i = sharedTables.bets.length - 1; i >= 0; i--) {
                let b = sharedTables.bets[i];
                if (b.userId.toString() === socket.user._id.toString() && b.room === data.room) {
                    
                    await User.findByIdAndUpdate(socket.user._id, { $inc: { playableCredits: b.fromPlayable, credits: b.fromMain } });
                    
                    let updatedUser = await User.findById(socket.user._id);
                    if (updatedUser) {
                        socket.emit('balanceUpdateData', { credits: updatedUser.credits, playable: updatedUser.playableCredits });
                        socket.emit('undoSuccess', { choice: b.choice, amount: b.amount });
                    }
                    sharedTables.bets.splice(i, 1);
                    break;
                }
            }
        } finally {
            socket.isSharedBetting = false;
        }
    });

    // ==========================================
    // DUEL ARENA (PVP) SOCKET LOGIC
    // ==========================================

    socket.on('arenaTakeSeat', (playerIndex) => {
        if(!socket.user || arena.state !== 'WAITING') return;

        if(arena.p1 && arena.p1.uid === socket.user._id.toString()) return;
        if(arena.p2 && arena.p2.uid === socket.user._id.toString()) return;

        if(playerIndex === 1 && !arena.p1) {
            arena.p1 = { uid: socket.user._id.toString(), username: socket.user.username, socketId: socket.id };
        } else if(playerIndex === 2 && !arena.p2) {
            arena.p2 = { uid: socket.user._id.toString(), username: socket.user.username, socketId: socket.id };
        }
        syncArena();

        if(arena.p1 && arena.p2) {
            arena.state = 'PLAYING';
            if(arena.game === 'ttt') arena.tempData.bd = Array(9).fill(null);
            if(arena.game === 'hl') arena.tempData.curr = getSecureRNG(1,13);

            io.to('duel').emit('chatMessage', { user: 'System', text: 'MATCH STARTING!', sys: true });
            syncArena();
        }
    });

    socket.on('arenaSetParams', (data) => {
        if(arena.state !== 'WAITING') return;
        if(data.game) arena.game = data.game;
        if(data.target) arena.target = parseInt(data.target);
        syncArena();
    });

    socket.on('arenaBet', async (data) => {
        if(!socket.user || arena.state !== 'WAITING') return;
        const amt = formatTC(data.amount);
        if(isNaN(amt) || amt < 10 || amt > 50000) return socket.emit('localGameError', { msg: 'Bet must be 10-50k TC', game: 'duel' });
        
        const user = await User.findById(socket.user._id);
        let deduction = await deductBet(user, amt);
        if(!deduction.success) return socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: 'duel' });
        
        await User.findByIdAndUpdate(socket.user._id, { $inc: { playableCredits: -deduction.fromPlayable, credits: -deduction.fromMain }});
        
        arena.bets.push({ 
            userId: user._id, username: user.username, betOn: data.playerIndex, amount: amt, fromPlayable: deduction.fromPlayable, fromMain: deduction.fromMain 
        });
        
        let updatedUser = await User.findById(socket.user._id);
        socket.emit('balanceUpdateData', { credits: updatedUser.credits, playable: updatedUser.playableCredits });
        socket.emit('arenaBetSuccess', { betOn: data.playerIndex, amount: amt });
    });

    function awardArenaPoint(winnerNum) {
        if(winnerNum === 1) arena.p1Score++;
        else if(winnerNum === 2) arena.p2Score++;
        
        if (arena.p1Score >= arena.target || arena.p2Score >= arena.target) {
            let matchWinner = arena.p1Score >= arena.target ? 1 : 2;
            arena.state = 'ENDED';
            resolveArenaBets(matchWinner);
            io.to('duel').emit('arenaAnim', { event: 'matchOver', winner: matchWinner });
            setTimeout(resetArenaFull, 5000);
        } else {
            arena.tempData = {}; arena.turn = 1;
            if(arena.game === 'ttt') arena.tempData.bd = Array(9).fill(null);
            if(arena.game === 'hl') arena.tempData.curr = getSecureRNG(1,13);
            io.to('duel').emit('arenaAnim', { event: 'roundReset' });
            setTimeout(syncArena, 1500);
        }
    }

    socket.on('arenaAction', (data) => {
        if(arena.state !== 'PLAYING') return;
        
        let isP1 = arena.p1 && arena.p1.uid === socket.user._id.toString();
        let isP2 = arena.p2 && arena.p2.uid === socket.user._id.toString();
        if(!isP1 && !isP2) return; 

        let pNum = isP1 ? 1 : 2;
        if(arena.game !== 'rps' && arena.turn !== pNum) return;

        if (arena.game === 'dice') {
            let roll = [getSecureRNG(1,6), getSecureRNG(1,6), getSecureRNG(1,6)];
            let total = roll.reduce((a,b)=>a+b,0);
            io.to('duel').emit('arenaAnim', { event: 'diceRoll', player: pNum, roll: roll });
            
            if(pNum === 1) {
                arena.tempData.p1Roll = total; arena.turn = 2;
                setTimeout(syncArena, 2000);
            } else {
                let p1 = arena.tempData.p1Roll; let p2 = total;
                setTimeout(() => {
                    if(p1 > p2) awardArenaPoint(1); else if(p2 > p1) awardArenaPoint(2);
                    else { arena.tempData = {}; arena.turn = 1; setTimeout(syncArena, 1500); }
                }, 2000);
            }
        } 
        else if (arena.game === 'coin') {
            let isHeads = Math.random() < 0.5;
            let res = isHeads ? 'H' : 'T';
            io.to('duel').emit('arenaAnim', { event: 'coinFlip', player: pNum, call: data.choice, result: res });
            setTimeout(() => {
                if(data.choice === res) awardArenaPoint(pNum);
                else { arena.turn = pNum === 1 ? 2 : 1; setTimeout(syncArena, 1500); }
            }, 3000);
        }
        else if (arena.game === 'hl') {
            let next = getSecureRNG(1,13);
            while(next === arena.tempData.curr) next = getSecureRNG(1,13); 
            let win = (next > arena.tempData.curr && data.choice === 'high') || (next < arena.tempData.curr && data.choice === 'low');
            arena.tempData.curr = next;
            io.to('duel').emit('arenaAnim', { event: 'hlDraw', player: pNum, nextCard: next, win: win });
            setTimeout(() => {
                if(win) awardArenaPoint(pNum);
                else { arena.turn = pNum === 1 ? 2 : 1; setTimeout(syncArena, 1500); }
            }, 2000);
        }
        else if (arena.game === 'roulette') {
            let winNum = getSecureRNG(0, 36);
            let res = winNum % 2 === 0 ? 'RED' : 'BLACK';
            io.to('duel').emit('arenaAnim', { event: 'rouletteSpin', player: pNum, result: res });
            setTimeout(() => {
                if(data.choice === res) awardArenaPoint(pNum);
                else { arena.turn = pNum === 1 ? 2 : 1; setTimeout(syncArena, 1500); }
            }, 3500);
        }
        else if (arena.game === 'rps') {
            if(pNum === 1) {
                arena.tempData.p1 = data.choice; arena.turn = 2; 
                io.to('duel').emit('arenaAnim', { event: 'rpsLock', player: 1 });
                setTimeout(syncArena, 1000);
            } else {
                arena.tempData.p2 = data.choice;
                io.to('duel').emit('arenaAnim', { event: 'rpsLock', player: 2 });
                setTimeout(() => {
                    let p1 = arena.tempData.p1; let p2 = arena.tempData.p2;
                    let w = 0;
                    if(p1 !== p2) { if((p1==='R'&&p2==='S')||(p1==='P'&&p2==='R')||(p1==='S'&&p2==='P')) w = 1; else w = 2; }
                    io.to('duel').emit('arenaAnim', { event: 'rpsSolve', p1: p1, p2: p2, winner: w });
                    setTimeout(() => {
                        if(w) awardArenaPoint(w); else { arena.tempData = {}; arena.turn = 1; setTimeout(syncArena, 1500); }
                    }, 2500);
                }, 1000);
            }
        }
        else if (arena.game === 'ttt') {
            let bd = arena.tempData.bd; let idx = data.index;
            if(bd[idx] !== null) return;
            let s = pNum === 1 ? 'X' : 'O'; bd[idx] = s;
            io.to('duel').emit('arenaAnim', { event: 'tttMove', index: idx, symbol: s });
            
            const w = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
            let won = w.some(c => bd[c[0]]===s && bd[c[1]]===s && bd[c[2]]===s);
            
            if(won) { setTimeout(() => awardArenaPoint(pNum), 1000); } 
            else if(!bd.includes(null)) {
                setTimeout(() => {
                    arena.tempData.bd = Array(9).fill(null); arena.turn = 1;
                    io.to('duel').emit('arenaAnim', { event: 'tttDraw' }); setTimeout(syncArena, 1500);
                }, 1000);
            } else { arena.turn = pNum === 1 ? 2 : 1; setTimeout(syncArena, 500); }
        }
    });

    // --- CASHIER & AUTH ---
    socket.on('submitTransaction', async (data) => { 
        if (!socket.user || !checkRateLimit(socket.id)) return;
        if (socket.isCashier) return;
        socket.isCashier = true;

        try {
            let amount = formatTC(data.amount);
            if(isNaN(amount) || amount <= 0) return;

            if (data.type === 'Deposit') {
                if (amount < 1000 || amount > 1000000) {
                    socket.emit('localGameError', { msg: 'DEPOSIT LIMIT: 1,000 - 1,000,000 TC', game: 'cashier' }); return;
                }
            }
            if (data.type === 'Withdrawal') {
                if (amount < 10000 || amount > 1000000) {
                    socket.emit('localGameError', { msg: 'WITHDRAW LIMIT: 10,000 - 1,000,000 TC', game: 'cashier' }); return;
                }
                const user = await User.findOneAndUpdate(
                    { _id: socket.user._id, credits: { $gte: amount } },
                    { $inc: { credits: -amount } },
                    { new: true }
                );
                if (!user) {
                    socket.emit('localGameError', { msg: 'Insufficient TC.', game: 'cashier' }); return;
                }
                socket.emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits });
            }

            let safeRef = sanitizeHTML(data.ref);
            await new Transaction({ username: socket.user.username, type: data.type, amount: amount, ref: safeRef }).save(); 
            
            if(data.type === 'Withdrawal') {
                await new CreditLog({ username: socket.user.username, action: 'WITHDRAWAL', amount: -amount, details: `Pending` }).save();
            } else {
                await new CreditLog({ username: socket.user.username, action: 'DEPOSIT', amount: amount, details: `Pending` }).save();
            }
            const txs = await Transaction.find({ username: socket.user.username }).sort({ date: -1 });
            socket.emit('transactionsData', txs);
            pushAdminData(); 
        } finally {
            socket.isCashier = false;
        }
    });

    socket.on('getTransactions', async () => { 
        if (socket.user) {
            const txs = await Transaction.find({ username: socket.user.username }).sort({ date: -1 });
            socket.emit('transactionsData', txs);
        }
    });

    socket.on('clearResolvedRequests', async () => {
        if (socket.user) {
            await Transaction.deleteMany({ username: socket.user.username, status: { $in: ['Approved', 'Rejected'] } });
            const txs = await Transaction.find({ username: socket.user.username }).sort({ date: -1 });
            socket.emit('transactionsData', txs);
        }
    });

    socket.on('adminLogin', async (data) => {
        if (!checkRateLimit(socket.id)) return;
        try {
            if (mongoose.connection.readyState !== 1) {
                return socket.emit('authError', 'Database Offline.');
            }

            const user = await User.findOne({ username: data.username, password: data.password });
            if (user && user.role === 'Admin') {
                socket.join('admin_room'); 
                
                let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
                user.ipAddress = ip;
                await user.save();
                
                socket.user = user; 
                socket.emit('adminLoginSuccess', { username: user.username, role: user.role });
                await pushAdminData(socket);
            } else { 
                socket.emit('authError', 'Invalid Admin Credentials.'); 
            }
        } catch(e) {
            socket.emit('authError', 'System Error'); 
        }
    });

    socket.on('login', async (data) => {
        if (!checkRateLimit(socket.id)) return;
        if (socket.isAuth) return;
        socket.isAuth = true;
        try {
            if (mongoose.connection.readyState !== 1) {
                return socket.emit('authError', 'Database Offline.');
            }

            const user = await User.findOne({ username: data.username, password: data.password });
            if (!user) return socket.emit('authError', 'Invalid login credentials.');
            if (user.status === 'Banned') return socket.emit('authError', 'This account has been banned.');

            if (isNaN(user.credits) || user.credits === null) user.credits = 0;
            if (isNaN(user.playableCredits) || user.playableCredits === null) user.playableCredits = 0;

            let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
            user.ipAddress = ip;
            user.status = 'Active'; 
            user.sessionToken = crypto.randomUUID(); 
            await user.save(); 
            socket.user = user;
            connectedUsers[user.username] = socket.id;
            
            pushAdminData();
            
            let now = new Date(), canClaim = true, day = 1, nextClaim = null;
            if (user.dailyReward.lastClaim) {
                let diffHours = (now - user.dailyReward.lastClaim) / (1000 * 60 * 60);
                if (diffHours < 24) { canClaim = false; nextClaim = new Date(user.dailyReward.lastClaim.getTime() + 24 * 60 * 60 * 1000); } 
                else if (diffHours > 48) { user.dailyReward.streak = 0; }
                day = (user.dailyReward.streak % 7) + 1;
            }
            
            socket.emit('loginSuccess', { username: user.username, credits: formatTC(user.credits), playable: formatTC(user.playableCredits), role: user.role, sessionToken: user.sessionToken, daily: { canClaim, day, nextClaim } });
        } catch(e) { 
            socket.emit('authError', 'System Error'); 
        } finally {
            socket.isAuth = false;
        }
    });

    socket.on('register', async (data) => {
        if (!checkRateLimit(socket.id)) return;
        if (socket.isAuth) return;
        socket.isAuth = true;
        try {
            if (mongoose.connection.readyState !== 1) {
                return socket.emit('authError', 'Database Offline.');
            }

            const exists = await User.findOne({ username: data.username });
            if (exists) return socket.emit('authError', 'Username is already taken.');
            
            let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
            await new User({ username: data.username, password: data.password, ipAddress: ip }).save();
            
            pushAdminData();
            socket.emit('registerSuccess', 'Account created! You may now login.');
        } catch(e) { 
            socket.emit('authError', 'System Error'); 
        } finally {
            socket.isAuth = false;
        }
    });

    socket.on('claimDaily', async () => {
        if (!socket.user || !checkRateLimit(socket.id)) return;
        const uid = socket.user._id.toString();
        if (activeUserLocks.has(uid)) return; activeUserLocks.add(uid);

        try {
            const user = await User.findById(uid);
            let now = new Date();
            if (user.dailyReward.lastClaim && (now - user.dailyReward.lastClaim) / (1000 * 60 * 60) < 24) return; 

            let day = (user.dailyReward.streak % 7) + 1;
            const rewards = [25, 50, 100, 200, 500, 750, 1000];
            let amt = formatTC(rewards[day - 1]);

            await User.findByIdAndUpdate(uid, { 
                $inc: { playableCredits: amt },
                $set: { "dailyReward.lastClaim": now, "dailyReward.streak": user.dailyReward.streak + 1 }
            });
            
            await new CreditLog({ username: user.username, action: 'GIFT', amount: amt, details: `Daily Reward` }).save();
            pushAdminData();
            let updatedUser = await User.findById(uid);
            socket.emit('dailyClaimed', { amt, newBalance: { credits: updatedUser.credits, playable: updatedUser.playableCredits }, nextClaim: new Date(now.getTime() + 24 * 60 * 60 * 1000) });
        } finally {
            activeUserLocks.delete(uid);
        }
    });

    socket.on('redeemPromo', async (code) => {
        if (!socket.user || !checkRateLimit(socket.id)) return;
        const uid = socket.user._id.toString();
        if (activeUserLocks.has(uid)) return; activeUserLocks.add(uid);

        try {
            const gc = await GiftCode.findOneAndUpdate(
                { code: code, redeemedBy: null },
                { redeemedBy: socket.user.username },
                { new: true }
            );
            if (!gc) return socket.emit('promoResult', { success: false, msg: 'Invalid or already used' });

            if(gc.creditType === 'playable') {
                await User.findByIdAndUpdate(uid, { $inc: { playableCredits: gc.amount }});
            } else {
                await User.findByIdAndUpdate(uid, { $inc: { credits: gc.amount }});
            }
            
            await new CreditLog({ username: socket.user.username, action: 'CODE', amount: gc.amount, details: `Redeemed` }).save();
            pushAdminData();
            
            let updatedUser = await User.findById(uid);
            socket.emit('promoResult', { success: true, amt: gc.amount, type: gc.creditType });
            socket.emit('balanceUpdateData', { credits: updatedUser.credits, playable: updatedUser.playableCredits });
        } catch(e) { 
            socket.emit('promoResult', { success: false, msg: 'Server error' }); 
        } finally {
            activeUserLocks.delete(uid);
        }
    });

    socket.on('adminAction', async (data) => {
        if (!socket.rooms.has('admin_room')) return; 
        try {
            const adminName = socket.user ? socket.user.username : 'System';

            if (data.type === 'editUser') { 
                let u = await User.findById(data.id);
                if (u) {
                    u.credits = formatTC(data.credits);
                    u.playableCredits = formatTC(data.playableCredits);
                    u.role = data.role;
                    await u.save();
                    
                    await new AdminLog({ adminName, action: 'EDIT USER', details: `Updated balances for ${u.username}` }).save();
                    
                    let targetSocketId = connectedUsers[u.username];
                    if (targetSocketId) {
                        io.to(targetSocketId).emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits });
                        io.to(targetSocketId).emit('silentNotification', { id: Date.now(), title: 'Balance Updated', msg: 'An admin has manually adjusted your account balance.', date: new Date() });
                    }
                    socket.emit('adminSuccess', `Successfully updated ${u.username}.`);
                }
            }
            else if (data.type === 'ban') { 
                let u = await User.findByIdAndUpdate(data.id, { status: 'Banned' }); 
                await new AdminLog({ adminName, action: 'BAN', details: `Banned user ${u.username}` }).save();
                socket.emit('adminSuccess', `Banned ${u.username}.`);
            }
            else if (data.type === 'unban') { 
                let u = await User.findByIdAndUpdate(data.id, { status: 'Active' }); 
                await new AdminLog({ adminName, action: 'UNBAN', details: `Unbanned user ${u.username}` }).save();
                socket.emit('adminSuccess', `Unbanned ${u.username}.`);
            }
            else if (data.type === 'clearUserLogs') {
                await CreditLog.deleteMany({ username: data.username });
                const logs = await CreditLog.find({ username: data.username }).sort({ date: -1 }).limit(100);
                socket.emit('userLogsData', { username: data.username, logs });
                await new AdminLog({ adminName, action: 'CLEAR LOGS', details: `Cleared logs for ${data.username}` }).save();
                socket.emit('adminSuccess', `Cleared logs for ${data.username}.`);
            }
            else if (data.type === 'sendUpdate') { 
                io.emit('silentNotification', { id: Date.now(), title: 'System Announcement', msg: data.msg, date: new Date() }); 
                await new AdminLog({ adminName, action: 'BROADCAST', details: `Msg: ${data.msg}` }).save();
                socket.emit('adminSuccess', `Broadcast sent successfully.`);
            }
            else if (data.type === 'giftCredits') {
                let amount = formatTC(data.amount);
                
                if (amount > 500000) {
                    socket.emit('adminError', 'Max gift limit is 500,000 TC per transaction.');
                    return;
                }

                let updateQuery = data.creditType === 'playable' ? { $inc: { playableCredits: amount } } : { $inc: { credits: amount } };
                let notifMsg = `Admin has gifted you ${amount} ${data.creditType === 'playable' ? 'Playable TC' : 'TC'}!`;

                if (data.target === 'all_registered') {
                    await User.updateMany({}, updateQuery);
                    io.emit('silentNotification', { id: Date.now(), title: 'Gift Received!', msg: notifMsg, date: new Date() });
                    io.emit('requestBalanceRefresh'); 
                    await new AdminLog({ adminName, action: 'GIFT', details: `Mass gifted ${amount} to All Registered` }).save();
                    socket.emit('adminSuccess', `Mass gift sent to All Registered users.`);
                } 
                else if (data.target === 'all_active') {
                    await User.updateMany({ status: 'Active' }, updateQuery);
                    io.emit('silentNotification', { id: Date.now(), title: 'Gift Received!', msg: notifMsg, date: new Date() });
                    io.emit('requestBalanceRefresh');
                    await new AdminLog({ adminName, action: 'GIFT', details: `Mass gifted ${amount} to All Active` }).save();
                    socket.emit('adminSuccess', `Mass gift sent to All Active users.`);
                } 
                else {
                    let u = await User.findOne({ username: new RegExp('^' + data.target + '$', 'i') });
                    if (u) {
                        await User.findByIdAndUpdate(u._id, updateQuery);
                        await new CreditLog({ username: u.username, action: 'GIFT', amount: amount, details: `From Admin` }).save();
                        await new AdminLog({ adminName, action: 'GIFT', details: `Gifted ${amount} to ${u.username}` }).save();
                        
                        let targetSocketId = connectedUsers[u.username];
                        if (targetSocketId) {
                            let updatedUser = await User.findById(u._id);
                            io.to(targetSocketId).emit('silentNotification', { id: Date.now(), title: 'Gift Received!', msg: notifMsg, date: new Date() });
                            io.to(targetSocketId).emit('balanceUpdateData', { credits: updatedUser.credits, playable: updatedUser.playableCredits });
                        }
                        socket.emit('adminSuccess', `Gift sent to ${u.username}.`);
                    } else {
                        socket.emit('adminError', `User ${data.target} not found.`);
                    }
                }
            }
            else if (data.type === 'resolveTx') {
                let tx = await Transaction.findById(data.id);
                if (tx && tx.status === 'Pending') {
                    tx.status = data.status; await tx.save();
                    
                    await new AdminLog({ adminName, action: 'RESOLVE TX', details: `Marked ${tx.type} for ${tx.username} as ${data.status}` }).save();
                    
                    let targetSocketId = connectedUsers[tx.username];
                    if (tx.type === 'Deposit' && data.status === 'Approved') {
                        let u = await User.findOne({ username: tx.username });
                        if (u) {
                            await User.findByIdAndUpdate(u._id, { $inc: { credits: tx.amount }});
                            await new CreditLog({ username: u.username, action: 'DEPOSIT', amount: tx.amount, details: `Approved` }).save();
                            if (targetSocketId) {
                                let updatedUser = await User.findById(u._id);
                                io.to(targetSocketId).emit('silentNotification', { id: Date.now(), title: 'Deposit Approved', msg: `Your deposit of ${tx.amount} TC has been added to your balance.`, date: new Date() });
                                io.to(targetSocketId).emit('balanceUpdateData', { credits: updatedUser.credits, playable: updatedUser.playableCredits });
                            }
                        }
                    }
                    else if (data.status === 'Rejected') {
                        if (tx.type === 'Withdrawal') {
                            let u = await User.findOne({ username: tx.username });
                            if (u) { 
                                await User.findByIdAndUpdate(u._id, { $inc: { credits: tx.amount }});
                                await new CreditLog({ username: u.username, action: 'REFUND', amount: tx.amount, details: `Withdrawal Rejected` }).save();
                                if (targetSocketId) {
                                    let updatedUser = await User.findById(u._id);
                                    io.to(targetSocketId).emit('balanceUpdateData', { credits: updatedUser.credits, playable: updatedUser.playableCredits }); 
                                }
                            }
                        }
                        if (targetSocketId) { io.to(targetSocketId).emit('silentNotification', { id: Date.now(), title: `${tx.type} Rejected`, msg: `Your request was rejected.`, date: new Date() }); }
                    }
                    socket.emit('adminSuccess', `Transaction marked as ${data.status}.`);
                }
            }
            else if (data.type === 'createBatch') {
                const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
                let prefix = data.creditType === 'playable' ? 'PB-' : 'RB-';
                let existingBatches = await GiftCode.find({ batchId: new RegExp('^' + prefix) }).distinct('batchId');
                let nextNum = existingBatches.length + 1;
                let batchId = prefix + String(nextNum).padStart(3, '0');
                
                for(let i=0; i<data.count; i++) {
                    let code = '';
                    for(let j=0; j<10; j++) code += chars.charAt(getSecureRNG(0, chars.length - 1));
                    await new GiftCode({ batchId, amount: formatTC(data.amount), code, creditType: data.creditType }).save();
                }
                await new AdminLog({ adminName, action: 'CREATE BATCH', details: `Created batch ${batchId} (${data.count} codes)` }).save();
                socket.emit('adminSuccess', `Batch ${batchId} created successfully.`);
            }
            else if (data.type === 'deleteBatch') { 
                await GiftCode.deleteMany({ batchId: data.batchId }); 
                await new AdminLog({ adminName, action: 'DELETE BATCH', details: `Deleted batch ${data.batchId}` }).save();
                socket.emit('adminSuccess', `Batch ${data.batchId} deleted.`);
            }
            await pushAdminData();
        } catch(e) { console.error("Admin Action Error:", e); socket.emit('adminError', "Server Error: " + e.message); }
    });

    socket.on('getGlobalResults', (game) => {
        let statsData = gameStats[game] || { total: 0 };
        socket.emit('globalResultsData', { game: game, results: globalResults[game] || [], stats: statsData });
    });

    socket.on('disconnect', async () => {
        delete rateLimits[socket.id]; 
        
        if (socket.user) { 
            await User.findByIdAndUpdate(socket.user._id, { status: 'Offline' }); 
            delete connectedUsers[socket.user.username];

            if(arena.p1 && arena.p1.uid === socket.user._id.toString()) {
                arena.p1 = null; resetArenaFull();
            }
            if(arena.p2 && arena.p2.uid === socket.user._id.toString()) {
                arena.p2 = null; resetArenaFull();
            }
        }
        if(socket.currentRoom && rooms[socket.currentRoom] > 0) {
            rooms[socket.currentRoom]--; 
            io.emit('playerCount', rooms);
        }
        pushAdminData();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Master Backend running on port ${PORT}`));
