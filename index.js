const express = require('express');
const mongoose = require('mongoose');
const { default: makeWASocket, initAuthCreds, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');

// --- 1. Express Server Setup (Hugging Face & UptimeRobot සඳහා) ---
const app = express();
const PORT = process.env.PORT || 7860;

app.get('/', (req, res) => {
    res.send('WhatsApp Bot is Running Successfully!');
});

app.listen(PORT, () => {
    console.log(`Express server is running on port ${PORT}`);
});

// --- 2. MongoDB Atlas Connection & Auth State Adapter ---
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
    console.error('Please set MONGO_URI in Environment Variables!');
    process.exit(1);
}

mongoose.connect(mongoURI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('Connected to MongoDB Atlas successfully!');
    connectToWhatsApp();
}).catch(err => {
    console.error('MongoDB connection error:', err);
});

// Mongoose Schema for Baileys Session Storage
const AuthSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    data: { type: Object, required: true }
});
const AuthModel = mongoose.models.AuthState || mongoose.model('AuthState', AuthSchema);

const useMongoAuthState = async () => {
    const writeData = async (data, id) => {
        const jsonString = JSON.stringify(data, (k, v) => Buffer.isBuffer(v) ? { type: 'Buffer', data: Array.from(v) } : v);
        await AuthModel.findByIdAndUpdate(
            id,
            { data: JSON.parse(jsonString) },
            { upsert: true, new: true }
        );
    };

    const readData = async (id) => {
        try {
            const doc = await AuthModel.findById(id);
            if (doc) {
                return JSON.parse(JSON.stringify(doc.data), (k, v) => {
                    if (v !== null && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) {
                        return Buffer.from(v.data);
                    }
                    return v;
                });
            }
            return null;
        } catch (error) {
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await AuthModel.findByIdAndDelete(id);
        } catch (error) {}
    };

    let creds = await readData('creds');
    if (!creds) {
        creds = initAuthCreds();
        await writeData(creds, 'creds');
    }

    const state = {
        creds,
        keys: {
            get: async (type, ids) => {
                const data = {};
                for (const id of ids) {
                    let value = await readData(`${type}-${id}`);
                    data[id] = value;
                }
                return data;
            },
            set: async (data) => {
                const tasks = [];
                for (const category of Object.keys(data)) {
                    for (const id of Object.keys(data[category])) {
                        const value = data[category][id];
                        const key = `${category}-${id}`;
                        if (value) {
                            tasks.push(writeData(value, key));
                        } else {
                            tasks.push(removeData(key));
                        }
                    }
                }
                await Promise.all(tasks);
            }
        }
    };

    return {
        state,
        saveCreds: async () => {
            return await writeData(state.creds, 'creds');
        }
    };
};

// --- 3. WhatsApp Bot Main Logic ---
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMongoAuthState();

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('--- SCAN THIS QR CODE LINK ---');
            try {
                // QR එක බ්‍රව්සර් එකෙන් බලාගන්න ලස්සන ලින්ක් එකක් ලෙස ලබා දීම
                const qrImageUrl = await qrcode.toDataURL(qr);
                console.log('Open this link in your browser to scan QR code:');
                console.log(qrImageUrl);
            } catch (err) {
                console.log('Error generating QR code URL:', err);
            }
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('Bot Successfully Connected!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;

        if (m.key && m.key.remoteJid === 'status@broadcast') {
            const participant = m.key.participant || m.participant;
            try {
                // ස්ටේටස් එක Seen කිරීම
                await sock.readMessages([{
                    remoteJid: 'status@broadcast',
                    id: m.key.id,
                    participant: participant
                }]);

                // වර්ණවත් හාට් ඉමෝජි වලින් එකක් අහඹු ලෙස තෝරා ගැනීම
                const hearts = ['❤️', '💙', '💚', '💛', '💜', '🧡', '💖', '🤍'];
                const randomHeart = hearts[Math.floor(Math.random() * hearts.length)];

                // තෝරාගත් හාට් එකෙන් React කිරීම
                await sock.sendMessage('status@broadcast', {
                    react: {
                        text: randomHeart,
                        key: m.key
                    }
                }, {
                    statusJidList: [participant]
                });

                console.log(`Status viewed and reacted with ${randomHeart} from: ${participant}`);
            } catch (error) {
                console.log('Error viewing or reacting to status:', error);
            }
        }
    });
}
