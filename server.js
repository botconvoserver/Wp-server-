const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    PHONENUMBER_MCC
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// HTML Interface
const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Bulk Sender - Pair Code</title>
    <style>
        body { font-family: 'Segoe UI', sans-serif; background: #0e1621; color: white; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .container { background: #17212b; padding: 30px; border-radius: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); width: 400px; text-align: center; }
        h2 { color: #4dabf7; margin-bottom: 20px; }
        input, textarea { width: 100%; padding: 12px; margin: 10px 0; border-radius: 8px; border: none; background: #242f3d; color: white; box-sizing: border-box; }
        button { width: 100%; padding: 12px; border-radius: 8px; border: none; background: #4dabf7; color: white; font-weight: bold; cursor: pointer; transition: 0.3s; }
        button:hover { background: #339af0; }
        #pairCodeDisplay { margin-top: 20px; font-size: 24px; font-weight: bold; color: #ff922b; letter-spacing: 5px; background: #242f3d; padding: 10px; border-radius: 5px; display: none; }
        #status { margin-top: 15px; font-size: 14px; color: #adb5bd; }
    </style>
</head>
<body>
    <div class="container">
        <h2>WhatsApp Automation</h2>
        <div id="step1">
            <input type="text" id="phoneNumber" placeholder="Phone Number (with country code, e.g. 919876543210)">
            <button onclick="generatePairCode()">Generate Pairing Code</button>
        </div>
        <div id="pairCodeDisplay"></div>
        
        <div id="bulkSection" style="display:none; margin-top:20px;">
            <textarea id="numbers" placeholder="Enter numbers separated by comma"></textarea>
            <textarea id="message" placeholder="Your message here..."></textarea>
            <input type="number" id="delay" placeholder="Delay in seconds" value="5">
            <button onclick="sendBulk()">Start Sending</button>
        </div>
        <div id="status">Ready...</div>
    </div>

    <script>
        async function generatePairCode() {
            const num = document.getElementById('phoneNumber').value;
            const status = document.getElementById('status');
            if(!num) return alert("Number daalo pehle!");
            
            status.innerText = "Generating code... Please wait";
            const res = await fetch('/get-code', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ number: num })
            });
            const data = await res.json();
            
            if(data.code) {
                const display = document.getElementById('pairCodeDisplay');
                display.innerText = data.code;
                display.style.display = 'block';
                status.innerText = "Notification sent to your phone. Enter this code!";
                checkConnection();
            } else {
                status.innerText = "Error generating code.";
            }
        }

        async function checkConnection() {
            const interval = setInterval(async () => {
                const res = await fetch('/status');
                const data = await res.json();
                if(data.connected) {
                    document.getElementById('step1').style.display = 'none';
                    document.getElementById('pairCodeDisplay').style.display = 'none';
                    document.getElementById('bulkSection').style.display = 'block';
                    document.getElementById('status').innerText = "Connected Successfully!";
                    clearInterval(interval);
                }
            }, 5000);
        }

        async function sendBulk() {
            const numbers = document.getElementById('numbers').value.split(',');
            const message = document.getElementById('message').value;
            const delayTime = document.getElementById('delay').value;
            
            document.getElementById('status').innerText = "Sending started...";
            const res = await fetch('/send-bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ numbers, message, delay: delayTime })
            });
            const data = await res.json();
            alert(data.status);
        }
    </script>
</body>
</html>
`;

let sock;
let isConnected = false;

// WhatsApp Connection Logic
async function startWhatsApp(num, res) {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }),
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            let code = await sock.requestPairingCode(num);
            res.json({ code: code });
        }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'open') {
            isConnected = true;
            console.log("WhatsApp Connected!");
        }
        if (connection === 'close') {
            isConnected = false;
            // Auto reconnect logic could go here
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Routes
app.get('/', (req, res) => res.send(htmlContent));

app.post('/get-code', async (req, res) => {
    let num = req.body.number.replace(/[^0-9]/g, '');
    await startWhatsApp(num, res);
});

app.get('/status', (req, res) => {
    res.json({ connected: isConnected });
});

app.post('/send-bulk', async (req, res) => {
    const { numbers, message, delay: delayTime } = req.body;
    
    for (let num of numbers) {
        let jid = num.trim() + "@s.whatsapp.net";
        await sock.sendMessage(jid, { text: message });
        console.log(`Sent to ${num}`);
        await delay(delayTime * 1000);
    }
    res.json({ status: "All messages sent successfully with delay!" });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
