const { User } = require('../models/database');

const formatTC = (amount) => Math.round(amount * 10) / 10;

// Atomic Deduction function to prevent rapid-fire exploit
async function deductBet(userId, betAmount) {
    let amt = formatTC(betAmount);
    const user = await User.findById(userId);
    if (!user) return { success: false };

    let totalBal = formatTC((user.credits || 0) + (user.playableCredits || 0));
    if (amt <= 0 || totalBal < amt) return { success: false };

    let fromPlayable = 0;
    let fromMain = 0;

    if ((user.playableCredits || 0) >= amt) {
        fromPlayable = amt;
    } else {
        fromPlayable = user.playableCredits || 0;
        fromMain = formatTC(amt - fromPlayable);
    }

    // ATOMIC UPDATE: Only processes if balance hasn't changed maliciously
    const updatedUser = await User.findOneAndUpdate(
        { _id: userId, credits: { $gte: fromMain }, playableCredits: { $gte: fromPlayable } },
        { $inc: { credits: -fromMain, playableCredits: -fromPlayable } },
        { new: true }
    );

    if (!updatedUser) return { success: false };
    return { success: true, fromPlayable, fromMain, user: updatedUser };
}

function checkResetStats(gameStats, game) {
    if (gameStats[game].total >= 100) { 
        Object.keys(gameStats[game]).forEach(key => { gameStats[game][key] = 0; }); 
    }
}

function logGlobalResult(globalResults, game, resultStr) {
    if(globalResults[game]) {
        globalResults[game].unshift({ result: resultStr, time: new Date() });
        if (globalResults[game].length > 5) globalResults[game].pop(); 
    }
}

module.exports = { formatTC, deductBet, checkResetStats, logGlobalResult };