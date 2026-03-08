const { User, CreditLog } = require('../models/database');
const { formatTC, deductBet, checkResetStats } = require('../utils/helpers');
const crypto = require('crypto');

// Helper Functions
function drawCard() {
    const vs = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const ss = ['♠','♣','♥','♦'];
    let v = vs[crypto.randomInt(vs.length)];
    let s = ss[crypto.randomInt(ss.length)];
    let bac = isNaN(parseInt(v)) ? (v === 'A' ? 1 : 0) : (v === '10' ? 0 : parseInt(v));
    let bj = isNaN(parseInt(v)) ? (v === 'A' ? 11 : 10) : parseInt(v);
    let dt = 0;
    if (v === 'A') dt = 1; else if (v === 'K') dt = 13; else if (v === 'Q') dt = 12; else if (v === 'J') dt = 11; else dt = parseInt(v);
    let suitHtml = (s === '♥' || s === '♦') ? `<span class="card-red">${s}</span>` : s;
    return { val: v, suit: s, bacVal: bac, bjVal: bj, dtVal: dt, raw: v, suitHtml: suitHtml };
}

function getBJScore(hand) {
    let score = 0, aces = 0;
    for (let card of hand) { score += card.bjVal; if (card.val === 'A') aces += 1; }
    while (score > 21 && aces > 0) { score -= 10; aces -= 1; }
    return score;
}

module.exports = function(io, socket, globalState, sendPulse) {

    // PROVABLY FAIR SYSTEM
    socket.on('requestFairSeed', () => {
        const serverSeed = crypto.randomBytes(16).toString('hex');
        const hashedSeed = crypto.createHash('sha256').update(serverSeed).digest('hex');
        socket.currentFairSeed = serverSeed; 
        socket.emit('fairSeedHash', { hash: hashedSeed }); 
    });

    socket.on('playSolo', async (data) => {
        if (globalState.isMaintenanceMode) return socket.emit('localGameError', { msg: 'SYSTEM UNDER MAINTENANCE', game: data.game });
        if (!socket.user || socket.isBetting) return; 
        socket.isBetting = true;

        try {
            let isNewBet = (data.game === 'd20' || data.game === 'coinflip' || (data.game === 'blackjack' && data.action === 'start'));
            
            if (isNewBet) {
                let amt = formatTC(data.bet || 0);
                let maxPotentialMultiplier = 1;

                if (data.game === 'd20') {
                    if (!Array.isArray(data.bets) || data.bets.length === 0) { socket.emit('localGameError', { msg: 'Select at least one bet', game: 'd20' }); return; }
                    let totalD20Bet = 0;
                    for (let b of data.bets) {
                        let a = formatTC(b.amount);
                        if(isNaN(a) || a < 10) { socket.emit('localGameError', { msg: 'MIN BET IS 10 TC', game: 'd20' }); return; }
                        totalD20Bet += a;
                    }
                    amt = totalD20Bet;
                    maxPotentialMultiplier = 1.95 * data.bets.length; 
                } else {
                    if (isNaN(amt) || amt < 10) { socket.emit('localGameError', { msg: 'MIN BET IS 10 TC', game: data.game }); return; }
                    if (data.game === 'coinflip') maxPotentialMultiplier = 1.95;
                    if (data.game === 'blackjack') maxPotentialMultiplier = 2.5;
                }
                
                if (amt > 50000) { socket.emit('localGameError', { msg: 'MAX TOTAL BET IS 50K TC', game: data.game }); return; }
                
                if ((amt * maxPotentialMultiplier) > globalState.globalBankVault) {
                    socket.emit('localGameError', { msg: 'VAULT LIMIT REACHED. CANNOT COVER BET.', game: data.game }); return;
                }

                if (data.game === 'coinflip' && data.choice !== 'Heads' && data.choice !== 'Tails') { 
                    socket.emit('localGameError', { msg: 'INVALID CHOICE', game: 'coinflip' }); return; 
                }
                
                // ATOMIC DEDUCTION
                let deduction = await deductBet(socket.user._id, amt);
                if (!deduction.success) {
                    socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: data.game }); return;
                }
                
                let user = deduction.user; // Use the updated user object
                sendPulse(`${user.username} bet ${amt} TC on ${data.game.toUpperCase()}`, 'bet');

                if (data.game === 'blackjack') {
                    socket.bjState = { 
                        bet: amt, 
                        pHand: [drawCard(), drawCard()], 
                        dHand: [drawCard(), drawCard()],
                        fromPlayable: deduction.fromPlayable,
                        fromMain: deduction.fromMain,
                        userObj: user
                    };
                }
                socket.currentUserState = user; // cache for the result
            }

            let user = socket.currentUserState;
            let payout = 0;

            if (data.game === 'd20') {
                // Determine roll using Provably Fair seed if available
                let roll = crypto.randomInt(1, 21);
                if (socket.currentFairSeed) {
                    roll = (parseInt(socket.currentFairSeed.substring(0, 8), 16) % 20) + 1;
                }

                let wonAny = false;
                
                for(let b of data.bets) {
                    let win = false;
                    let val = b.guessValue;
                    if (val === 'high' && roll >= 11) win = true;
                    if (val === 'low' && roll <= 10) win = true;
                    if (val === 'even' && roll % 2 === 0) win = true;
                    if (val === 'odd' && roll % 2 !== 0) win = true;
                    
                    if(win) { payout += formatTC(b.amount * 1.95); wonAny = true; }
                }
                payout = formatTC(payout);
                
                user.credits = formatTC(user.credits + payout); await user.save();
                let net = formatTC(payout - data.bet);
                await new CreditLog({ username: user.username, action: 'GAME', amount: net, details: `D20` }).save();
                
                socket.emit('d20Result', { roll, payout, bet: data.bet, resStr: `ROLLED ${roll}`, newBalance: { credits: user.credits, playable: user.playableCredits }, serverSeed: socket.currentFairSeed });
                socket.currentFairSeed = null; // Reset seed
                
                setTimeout(() => {
                    globalState.gameStats.d20.total++;
                    if (wonAny) globalState.gameStats.d20.Win++; else globalState.gameStats.d20.Lose++;
                    checkResetStats(globalState.gameStats, 'd20');
                }, 2000);
            } 
            else if (data.game === 'coinflip') {
                let result = crypto.randomInt(2) === 0 ? 'Heads' : 'Tails';
                if (socket.currentFairSeed) {
                    result = (parseInt(socket.currentFairSeed.substring(0, 8), 16) % 2) === 0 ? 'Heads' : 'Tails';
                }

                if (data.choice === result) payout = formatTC(data.bet * 1.95);
                
                user.credits = formatTC(user.credits + payout); await user.save();
                await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - data.bet), details: `Coin Flip` }).save();
                
                socket.emit('coinResult', { result, payout, bet: data.bet, resStr: `${result.toUpperCase()}`, newBalance: { credits: user.credits, playable: user.playableCredits }, serverSeed: socket.currentFairSeed });
                socket.currentFairSeed = null; // Reset seed
                
                setTimeout(() => {
                    globalState.gameStats.coinflip.total++; globalState.gameStats.coinflip[result]++; checkResetStats(globalState.gameStats, 'coinflip');
                }, 2000);
            }
            else if (data.game === 'blackjack') {
                user = await User.findById(socket.user._id); // Refresh state for multi-action
                if (data.action === 'start') {
                    let pS = getBJScore(socket.bjState.pHand); let dS = getBJScore(socket.bjState.dHand);
                    
                    if (pS === 21) {
                        let msg = dS === 21 ? 'Push' : 'Blackjack!';
                        payout = formatTC(dS === 21 ? socket.bjState.bet : socket.bjState.bet * 2.5);
                        
                        if (msg === 'Push') {
                            user.playableCredits = formatTC(user.playableCredits + socket.bjState.fromPlayable);
                            user.credits = formatTC(user.credits + socket.bjState.fromMain);
                        } else { user.credits = formatTC(user.credits + payout); }
                        await user.save();

                        await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - socket.bjState.bet), details: `Blackjack` }).save();
                        
                        socket.emit('bjUpdate', { event: 'deal', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, naturalBJ: true, payout, msg, resStr: `${msg.toUpperCase()} (${pS} TO ${dS})`, bet: socket.bjState.bet, newBalance: { credits: user.credits, playable: user.playableCredits }});
                        socket.bjState = null;

                        setTimeout(() => {
                            globalState.gameStats.blackjack.total++; 
                            if(msg === 'Blackjack!') globalState.gameStats.blackjack.Win++; else globalState.gameStats.blackjack.Push++;
                            checkResetStats(globalState.gameStats, 'blackjack');
                        }, 2500);

                    } else {
                        socket.emit('bjUpdate', { event: 'deal', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand });
                    }
                }
                else if (data.action === 'hit') {
                    if(!socket.bjState) return;
                    socket.bjState.pHand.push(drawCard());
                    let pS = getBJScore(socket.bjState.pHand);
                    
                    if (pS > 21) {
                        await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(-socket.bjState.bet), details: `Blackjack` }).save();
                        
                        socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout: 0, msg: 'Bust!', resStr: `PLAYER BUSTS!`, bet: socket.bjState.bet, newBalance: { credits: user.credits, playable: user.playableCredits } });
                        socket.bjState = null;
                        
                        setTimeout(() => { globalState.gameStats.blackjack.total++; globalState.gameStats.blackjack.Lose++; checkResetStats(globalState.gameStats, 'blackjack'); }, 2500);
                    } else { socket.emit('bjUpdate', { event: 'hit', pHand: socket.bjState.pHand }); }
                }
                else if (data.action === 'stand') {
                    if(!socket.bjState) return;
                    let pS = getBJScore(socket.bjState.pHand);
                    while (getBJScore(socket.bjState.dHand) < 17) { socket.bjState.dHand.push(drawCard()); }
                    let dS = getBJScore(socket.bjState.dHand);
                    let msg = '';
                    
                    if (dS > 21 || pS > dS) { payout = formatTC(socket.bjState.bet * 2); msg = 'You Win!'; } 
                    else if (pS === dS) { payout = formatTC(socket.bjState.bet); msg = 'Push'; } 
                    else { msg = 'Dealer Wins'; }
                    
                    if (msg === 'Push') {
                        user.playableCredits = formatTC(user.playableCredits + socket.bjState.fromPlayable);
                        user.credits = formatTC(user.credits + socket.bjState.fromMain);
                    } else { user.credits = formatTC(user.credits + payout); }
                    await user.save();

                    await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - socket.bjState.bet), details: `Blackjack` }).save();
                    
                    let resStr = (dS > 21) ? `DEALER BUSTS!` : (msg === 'Push' ? `TIE (${dS} TO ${pS})` : (msg === 'You Win!' ? `PLAYER (${dS} TO ${pS})` : `DEALER (${dS} TO ${pS})`));
                    
                    socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout, msg, resStr: resStr, bet: socket.bjState.bet, newBalance: { credits: user.credits, playable: user.playableCredits } });
                    socket.bjState = null;

                    setTimeout(() => { 
                        globalState.gameStats.blackjack.total++;
                        if (dS > 21 || pS > dS) globalState.gameStats.blackjack.Win++;
                        else if (pS === dS) globalState.gameStats.blackjack.Push++;
                        else globalState.gameStats.blackjack.Lose++;
                        checkResetStats(globalState.gameStats, 'blackjack'); 
                    }, 2500);
                }
            }
        } finally {
            socket.isBetting = false; 
        }
    });
};

module.exports.drawCard = drawCard; // Expose for sharedGames.js