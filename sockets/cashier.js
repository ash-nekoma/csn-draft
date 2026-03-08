const { Transaction, CreditLog, User } = require('../models/database');
const { formatTC } = require('../utils/helpers');

module.exports = function(io, socket, globalState, sendPulse) {
    socket.on('submitTransaction', async (data) => { 
        if (!socket.user) return;
        if (socket.isCashier) return;
        socket.isCashier = true;

        try {
            let amount = formatTC(data.amount);
            if(isNaN(amount) || amount <= 0) return;

            // ENFORCED LIMITS
            if (data.type === 'Deposit') {
                if (amount < 1000) { socket.emit('localGameError', { msg: 'MIN DEPOSIT IS 1,000 TC', game: 'cashier' }); return; }
                if (amount > 100000) { socket.emit('localGameError', { msg: 'MAX DEPOSIT IS 100,000 TC', game: 'cashier' }); return; }
            }
            if (data.type === 'Withdrawal') {
                if (amount < 10000) { socket.emit('localGameError', { msg: 'MIN WITHDRAWAL IS 10,000 TC', game: 'cashier' }); return; }
                if (amount > 100000) { socket.emit('localGameError', { msg: 'MAX WITHDRAWAL IS 100,000 TC', game: 'cashier' }); return; }
                
                // Atomic withdrawal deduction
                const user = await User.findOneAndUpdate(
                    { _id: socket.user._id, credits: { $gte: amount } }, 
                    { $inc: { credits: -amount } }, 
                    { new: true }
                );
                
                if (!user) { socket.emit('localGameError', { msg: 'Insufficient TC.', game: 'cashier' }); return; }
                socket.emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits });
            }

            await new Transaction({ username: socket.user.username, type: data.type, amount: amount, ref: data.ref }).save(); 
            
            let logType = data.type === 'Withdrawal' ? 'WITHDRAWAL' : 'DEPOSIT';
            let logAmount = data.type === 'Withdrawal' ? -amount : amount;

            await new CreditLog({ username: socket.user.username, action: logType, amount: logAmount, details: `Pending` }).save();
            sendPulse(`${socket.user.username} submitted a ${data.type} request for ${amount} TC.`, 'alert');
            
            const txs = await Transaction.find({ username: socket.user.username }).sort({ date: -1 });
            socket.emit('transactionsData', txs);
            
        } finally {
            socket.isCashier = false;
        }
    });
};