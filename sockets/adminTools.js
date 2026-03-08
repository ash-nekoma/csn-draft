const { User, Transaction, CreditLog, AdminLog, GiftCode } = require('../models/database');
const crypto = require('crypto');

module.exports = function(io, socket, globalState, sendPulse) {
    
    // Helper function to send all data to admin dashboard
    const pushAdminData = async () => {
        const users = await User.find({}, '-password').sort({ joinDate: -1 });
        const txs = await Transaction.find().sort({ date: -1 }).limit(200);
        const codes = await GiftCode.find().sort({ date: -1 });
        const adminLogs = await AdminLog.find().sort({ date: -1 }).limit(100);
        
        let vault = globalState.globalBankVault;
        let tBal = 0, pBal = 0;
        users.forEach(u => { tBal += (u.credits||0); pBal += (u.playableCredits||0); });
        
        socket.emit('adminDataFull', { 
            users, transactions: txs, codes, logs: adminLogs, 
            vault, totalCredits: tBal, totalPlayable: pBal, maintenance: globalState.isMaintenanceMode 
        });
    };

    socket.on('adminLogin', async (data) => {
        const user = await User.findOne({ username: data.username, password: data.password });
        if (user && user.role === 'Admin') {
            socket.join('admin_room');
            socket.emit('adminAuthSuccess', { username: user.username });
            await pushAdminData();
        } else {
            socket.emit('adminAuthError', 'Invalid Admin Credentials.');
        }
    });

    socket.on('adminAction', async (data) => {
        const adminName = data.adminName || 'Admin';

        try {
            if (data.type === 'toggleMaintenance') {
                globalState.isMaintenanceMode = !globalState.isMaintenanceMode;
                await new AdminLog({ adminName, action: 'MAINTENANCE', details: `Toggled to ${globalState.isMaintenanceMode}` }).save();
                io.emit('maintenanceToggle', globalState.isMaintenanceMode);
            }
            else if (data.type === 'editUser') {
                const u = await User.findById(data.userId);
                if(u) {
                    u.credits = parseFloat(data.updates.credits);
                    u.playableCredits = parseFloat(data.updates.playableCredits);
                    u.role = data.updates.role;
                    await u.save();
                    await new AdminLog({ adminName, action: 'EDIT USER', details: `Edited ${u.username} balances/role` }).save();
                    if(globalState.connectedUsers[u.username]) {
                        io.to(globalState.connectedUsers[u.username]).emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits });
                    }
                }
            }
            // Add Ban, Unban, approve/reject transactions, and Gift code logic here mimicking your original server.js exactly.
            
            await pushAdminData();
        } catch(e) {
            socket.emit('adminError', "Server Error: " + e.message);
        }
    });
};