const mongoose = require('mongoose');

const connectDB = () => {
    const MONGO_URI = process.env.MONGO_URL || 'mongodb://localhost:27017/stickntrade';
    mongoose.connect(MONGO_URI)
        .then(async () => {
            console.log('✅ Connected to MongoDB Database');
            const adminExists = await User.findOne({ username: 'admin' });
            if (!adminExists) {
                await new User({ username: 'admin', password: 'Kenm44ashley', role: 'Admin', credits: 10000, playableCredits: 0 }).save();
            }
        })
        .catch(err => { console.error('❌ MongoDB Connection Error.', err); });
};

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: 'Player' },
    credits: { type: Number, default: 0 }, 
    playableCredits: { type: Number, default: 0 }, 
    status: { type: String, default: 'Offline' },
    ipAddress: { type: String, default: 'Unknown' },
    joinDate: { type: Date, default: Date.now },
    dailyReward: { lastClaim: { type: Date, default: null }, streak: { type: Number, default: 0 } }
});

const txSchema = new mongoose.Schema({
    username: String, type: String, amount: Number, ref: String,
    status: { type: String, default: 'Pending' }, date: { type: Date, default: Date.now }
});

const codeSchema = new mongoose.Schema({
    batchId: String, amount: Number, code: String, creditType: { type: String, default: 'playable' },
    redeemedBy: { type: String, default: null }, date: { type: Date, default: Date.now }
});

const creditLogSchema = new mongoose.Schema({
    username: String, action: String, amount: Number, details: String, date: { type: Date, default: Date.now }
});

const adminLogSchema = new mongoose.Schema({
    adminName: String, action: String, details: String, date: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Transaction = mongoose.model('Transaction', txSchema);
const GiftCode = mongoose.model('GiftCode', codeSchema);
const CreditLog = mongoose.model('CreditLog', creditLogSchema);
const AdminLog = mongoose.model('AdminLog', adminLogSchema);

module.exports = { connectDB, User, Transaction, GiftCode, CreditLog, AdminLog };