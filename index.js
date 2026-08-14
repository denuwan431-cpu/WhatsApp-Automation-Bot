const express = require('express');
const mongoose = require('mongoose');
const { default: makeWASocket, initAuthCreds, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

// --- 1. Express Server Setup ---
const app = express();
const PORT = process.env.PORT || 7860;

app.get('/', (req, res) => {
    res.send('WhatsApp Bot is Running Successfully!');
});

app.listen(PORT, () => {
    console.log(`Express server is running on port ${PORT}`);
});

// --- 2. MongoDB Atlas Connection ---
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

// --- 3. WhatsApp Bot Main Logic (Pairing Code Mode) ---
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMongoAuthState();

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    const phoneNumber = "94706647016"; 
    const ownerJid = `${phoneNumber}@s.whatsapp.net`;
    const messageStore = new Map(); // Store messages temporarily for Anti-Delete

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n========================================`);
                console.log(`YOUR WHATSAPP PAIRING CODE IS: ${code}`);
                console.log(`========================================\n`);
            } catch (error) {
                console.error("Error requesting pairing code:", error);
            }
        }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed, reconnecting...', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('Bot Successfully Connected via Pairing Code!');
            
            try {
                await sock.sendPresenceUpdate('unavailable');
            } catch (e) {}
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // --- 4. Bot Features Logic ---
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;

        // Store message for Anti-Delete feature
        if (m.key && m.key.id) {
            messageStore.set(m.key.id, m);
            if (messageStore.size > 500) {
                const oldestKey = messageStore.keys().next().value;
                messageStore.delete(oldestKey);
            }
        }

        // Status Auto-View
        if (m.key && m.key.remoteJid === 'status@broadcast') {
            const participant = m.key.participant || m.participant;
            try {
                await sock.readMessages([{
                    remoteJid: 'status@broadcast',
                    id: m.key.id,
                    participant: participant
                }]);
                console.log(`Status viewed successfully from: ${participant}`);
            } catch (error) {
                console.log('Error viewing status:', error);
            }
        }
    });

    // Anti-Delete Listener (Shows exact phone number)
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update && update.update.message === null) {
                const deletedMsg = messageStore.get(update.key.id);
                if (deletedMsg && !deletedMsg.key.fromMe) {
                    let sender = deletedMsg.key.participant || deletedMsg.key.remoteJid;
                    const chat = deletedMsg.key.remoteJid;
                    
                    if (sender.includes('@lid')) {
                        sender = deletedMsg.participant || chat;
                    }
                    
                    const senderNumber = sender.replace(/[^0-9]/g, '');
                    const chatName = chat.includes('@g.us') ? `Group (${chat.split('@')[0]})` : `Private Chat`;
                    
                    let messageText = "Non-text or Media Message";
                    if (deletedMsg.message.conversation) {
                        messageText = deletedMsg.message.conversation;
                    } else if (deletedMsg.message.extendedTextMessage) {
                        messageText = deletedMsg.message.extendedTextMessage.text;
                    }

                    try {
                        await sock.sendMessage(ownerJid, {
                            text: `🚨 *ANTI-DELETE DETECTED* 🚨\n\n👤 *Sender Number:* +${senderNumber}\n💬 *Chat Type:* ${chatName}\n\n📝 *Deleted Message:* \n${messageText}`
                        });
                        console.log(`Captured deleted message from ${senderNumber}`);
                    } catch (err) {
                        console.log('Error sending anti-delete notification:', err);
                    }
                }
            }
        }
    });

    // Auto-Reply Message on Incoming Call
    sock.ev.on('call', async (calls) => {
        for (const call of calls) {
            if (call.status === 'offer') {
                try {
                    console.log(`Call received from: ${call.from}`);
                    await sock.sendMessage(call.from, { 
                        text: '📵 *CALLS ARE NOT ALLOWED!*\n\n*Please send a text message only.* 💬' 
                    });
                } catch (error) {
                    console.log('Error sending message for call:', error);
                }
            }
        }
    });
}
