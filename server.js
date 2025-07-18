const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

// Create Express app
const app = express();

// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, '.')));

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server with ping/pong configuration
const wss = new WebSocket.Server({ 
    server,
    // Add ping/pong configuration for keepalive
    perMessageDeflate: false, // Disable compression for better performance
    maxPayload: 1024 * 1024, // 1MB max payload
    skipUTF8Validation: false
});

// Store connected clients
const clients = new Map();
const cameras = new Map();
const iceCandidateCount = new Map(); // Track ICE candidates per camera

// Default ICE servers
const defaultIceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
];

// Connection monitoring
const connectionHealth = new Map(); // Map of clientId -> lastPingTime
const PING_INTERVAL = 30000; // 30 seconds
const PONG_TIMEOUT = 10000; // 10 seconds
const CONNECTION_TIMEOUT = 60000; // 60 seconds

function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

function broadcast(message, excludeClient = null) {
    const messageStr = JSON.stringify(message);
    clients.forEach((client, id) => {
        if (client !== excludeClient && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(messageStr);
        }
    });
}

function sendToClient(clientId, message) {
    const client = clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
        return true;
    }
    return false;
}

function sendToWebClients(message) {
    clients.forEach((client) => {
        if (client.type === 'web' && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(message));
        }
    });
}

function sendToAndroidClient(cameraId, message) {
    const camera = cameras.get(cameraId);
    if (camera && camera.client && camera.client.ws.readyState === WebSocket.OPEN) {
        camera.client.ws.send(JSON.stringify(message));
        return true;
    }
    return false;
}

wss.on('connection', (ws, req) => {
    const clientId = generateClientId();
    const clientInfo = {
        id: clientId,
        ws: ws,
        type: null, // 'web' or 'android'
        ip: req.socket.remoteAddress,
        connectedAt: Date.now(),
        lastPingTime: Date.now(),
        lastPongTime: Date.now(),
        isAlive: true
    };
    
    clients.set(clientId, clientInfo);
    connectionHealth.set(clientId, Date.now());
    
    log(`Client connected: ${clientId} from ${clientInfo.ip}`);

    // Send initial ICE servers
    ws.send(JSON.stringify({
        type: 'ice-servers',
        iceServers: defaultIceServers
    }));

    // Set up ping/pong mechanism
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
        clientInfo.lastPongTime = Date.now();
        clientInfo.isAlive = true;
        connectionHealth.set(clientId, Date.now());
        log(`Pong received from client ${clientId}`);
    });

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            
            // Handle ping/pong messages
            if (message.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', timestamp: message.timestamp }));
                clientInfo.lastPingTime = Date.now();
                clientInfo.isAlive = true;
                connectionHealth.set(clientId, Date.now());
                log(`Ping received from client ${clientId}, sent pong`);
                return;
            }
            
            if (message.type === 'pong') {
                clientInfo.lastPongTime = Date.now();
                clientInfo.isAlive = true;
                connectionHealth.set(clientId, Date.now());
                log(`Pong received from client ${clientId}`);
                return;
            }
            
            handleMessage(clientId, message);
        } catch (error) {
            log(`Error parsing message from ${clientId}: ${error.message}`);
        }
    });

    ws.on('close', (code, reason) => {
        log(`Client disconnected: ${clientId} (code: ${code}, reason: ${reason})`);
        
        // Remove cameras registered by this client
        cameras.forEach((camera, cameraId) => {
            if (camera.client && camera.client.id === clientId) {
                cameras.delete(cameraId);
                log(`Camera unregistered: ${cameraId}`);
                
                // Clean up ICE candidate tracking
                iceCandidateCount.forEach((count, sessionKey) => {
                    if (sessionKey.includes(cameraId) || sessionKey.includes(clientId)) {
                        iceCandidateCount.delete(sessionKey);
                        log(`🧊 ICE candidate tracking cleaned up for session: ${sessionKey}`);
                    }
                });
                
                // Notify web clients
                sendToWebClients({
                    type: 'camera-disconnected',
                    cameraId: cameraId
                });
            }
        });
        
        clients.delete(clientId);
        connectionHealth.delete(clientId);
    });

    ws.on('error', (error) => {
        log(`WebSocket error for client ${clientId}: ${error.message}`);
    });
});

// Set up periodic ping/pong to keep connections alive
const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            log(`Terminating connection - no pong received`);
            return ws.terminate();
        }
        
        ws.isAlive = false;
        ws.ping(() => {
            log(`Ping sent to client`);
        });
    });
}, PING_INTERVAL);

// Monitor connection health
const healthCheckInterval = setInterval(() => {
    const now = Date.now();
    connectionHealth.forEach((lastActivity, clientId) => {
        const timeSinceLastActivity = now - lastActivity;
        if (timeSinceLastActivity > CONNECTION_TIMEOUT) {
            const client = clients.get(clientId);
            if (client && client.ws.readyState === WebSocket.OPEN) {
                log(`Client ${clientId} timed out after ${timeSinceLastActivity}ms, terminating connection`);
                client.ws.terminate();
            }
        }
    });
}, 10000); // Check every 10 seconds

// Clean up intervals on server shutdown
process.on('SIGINT', () => {
    clearInterval(pingInterval);
    clearInterval(healthCheckInterval);
    wss.close(() => {
        log('WebSocket server closed');
        process.exit(0);
    });
});

function handleMessage(clientId, message) {
    const client = clients.get(clientId);
    if (!client) return;

    log(`Received from ${clientId}: ${message.type}`);

    switch (message.type) {
        case 'identify':
            handleIdentify(clientId, message);
            break;
        case 'register-camera':
            handleRegisterCamera(clientId, message);
            break;
        case 'call-request':
            handleCallRequest(clientId, message);
            break;
        case 'hang-up':
            handleHangUp(clientId, message);
            break;
        case 'offer':
            handleOffer(clientId, message);
            break;
        case 'answer':
            handleAnswer(clientId, message);
            break;
        case 'ice-candidate':
            handleIceCandidate(clientId, message);
            break;
        default:
            log(`Unknown message type from ${clientId}: ${message.type}`);
    }
}

function handleIdentify(clientId, message) {
    const client = clients.get(clientId);
    if (!client) return;

    client.type = message.clientType; // 'web' or 'android'
    log(`Client ${clientId} identified as: ${client.type}`);
    
    // If this is a web client, send list of registered cameras
    if (client.type === 'web') {
        cameras.forEach((camera, cameraId) => {
            client.ws.send(JSON.stringify({
                type: 'register-camera',
                cameraId: cameraId
            }));
        });
    }
}

function handleRegisterCamera(clientId, message) {
    const client = clients.get(clientId);
    if (!client) return;

    const cameraId = message.cameraId;
    
    if (!cameras.has(cameraId)) {
        cameras.set(cameraId, {
            id: cameraId,
            client: client,
            registeredAt: new Date()
        });
        
        log(`Camera registered: ${cameraId} by client ${clientId}`);
        
        // Notify all web clients
        sendToWebClients({
            type: 'register-camera',
            cameraId: cameraId
        });
    }
}

function handleCallRequest(clientId, message) {
    const cameraId = message.cameraId;
    log(`Call request for camera ${cameraId} from client ${clientId}`);
    
    // Forward call request to the camera's Android client
    const success = sendToAndroidClient(cameraId, {
        type: 'call-request',
        cameraId: cameraId,
        fromClient: clientId
    });
    
    if (!success) {
        sendToClient(clientId, {
            type: 'error',
            message: `Camera ${cameraId} not available`
        });
    }
}

function handleHangUp(clientId, message) {
    const cameraId = message.cameraId;
    const client = clients.get(clientId);
    const clientType = client ? client.type : 'unknown';
    
    log(`Hang-up request for camera ${cameraId} from ${clientType} client ${clientId}`);
    
    // Forward hang-up request to the camera's Android client
    const success = sendToAndroidClient(cameraId, {
        type: 'hang-up',
        cameraId: cameraId,
        fromClient: clientId
    });
    
    if (success) {
        log(`Hang-up request forwarded to camera ${cameraId}`);
    } else {
        log(`Failed to forward hang-up request - camera ${cameraId} not available`);
    }
}

function handleOffer(clientId, message) {
    const cameraId = message.cameraId;
    const client = clients.get(clientId);
    const clientType = client ? client.type : 'unknown';
    
    log(`Offer for camera ${cameraId} from ${clientType} client ${clientId}`);
    
    // Log offer details
    if (message.offer) {
        const offer = message.offer;
        log(`  → SDP Type: ${offer.type}`);
        log(`  → SDP Length: ${offer.sdp ? offer.sdp.length : 0} chars`);
        log(`  → ICE gathering will begin after setting local description`);
    }
    
    // Determine where to forward the offer
    if (client && client.type === 'web') {
        // Web client sending offer to Android client
        log(`  → Forwarding offer to Android client for camera ${cameraId}`);
        const success = sendToAndroidClient(cameraId, {
            type: 'offer',
            cameraId: cameraId,
            offer: message.offer,
            fromClient: clientId
        });
        if (!success) {
            log(`  → Failed to forward offer - Android client not available`);
        }
    } else {
        // Android client sending offer to web clients
        log(`  → Broadcasting offer to web clients for camera ${cameraId}`);
        sendToWebClients({
            type: 'offer',
            cameraId: cameraId,
            offer: message.offer,
            fromClient: clientId
        });
    }
}

function handleAnswer(clientId, message) {
    const cameraId = message.cameraId;
    const client = clients.get(clientId);
    const clientType = client ? client.type : 'unknown';
    
    log(`Answer for camera ${cameraId} from ${clientType} client ${clientId}`);
    
    // Log answer details
    if (message.answer) {
        const answer = message.answer;
        log(`  → SDP Type: ${answer.type}`);
        log(`  → SDP Length: ${answer.sdp ? answer.sdp.length : 0} chars`);
        log(`  → ICE gathering will continue after setting local description`);
    }
    
    // Determine where to forward the answer
    if (client && client.type === 'web') {
        // Web client sending answer to Android client
        log(`  → Forwarding answer to Android client for camera ${cameraId}`);
        const success = sendToAndroidClient(cameraId, {
            type: 'answer',
            cameraId: cameraId,
            answer: message.answer,
            fromClient: clientId
        });
        if (!success) {
            log(`  → Failed to forward answer - Android client not available`);
        }
    } else {
        // Android client sending answer to web clients
        log(`  → Broadcasting answer to web clients for camera ${cameraId}`);
        sendToWebClients({
            type: 'answer',
            cameraId: cameraId,
            answer: message.answer,
            fromClient: clientId
        });
    }
}

function handleIceCandidate(clientId, message) {
    const cameraId = message.cameraId;
    const client = clients.get(clientId);
    const clientType = client ? client.type : 'unknown';
    
    // Track ICE candidates per camera
    const sessionKey = `${cameraId}_${clientId}`;
    if (!iceCandidateCount.has(sessionKey)) {
        iceCandidateCount.set(sessionKey, 0);
        log(`🧊 ICE gathering started for camera ${cameraId} from ${clientType} client ${clientId}`);
    }
    
    const currentCount = iceCandidateCount.get(sessionKey) + 1;
    iceCandidateCount.set(sessionKey, currentCount);
    
    log(`🧊 ICE candidate #${currentCount} for camera ${cameraId} from ${clientType} client ${clientId}`);
    
    // Log ICE candidate details
    if (message.candidate) {
        const candidate = message.candidate;
        log(`  → Candidate: ${candidate.candidate || 'N/A'}`);
        log(`  → SDP MLine Index: ${candidate.sdpMLineIndex || 'N/A'}`);
        log(`  → SDP MID: ${candidate.sdpMid || 'N/A'}`);
        
        // Extract candidate type from SDP
        const candidateStr = candidate.candidate || '';
        const typeMatch = candidateStr.match(/typ (\w+)/);
        const type = typeMatch ? typeMatch[1] : 'unknown';
        log(`  → Type: ${type}`);
        
        // Extract protocol and address
        const protocolMatch = candidateStr.match(/udp|tcp/i);
        const protocol = protocolMatch ? protocolMatch[0].toUpperCase() : 'unknown';
        const addressMatch = candidateStr.match(/(\d+\.\d+\.\d+\.\d+)/);
        const address = addressMatch ? addressMatch[1] : 'unknown';
        log(`  → Protocol: ${protocol}, Address: ${address}`);
    } else {
        // Null candidate indicates end of gathering
        log(`🧊 ICE gathering completed for camera ${cameraId} from ${clientType} client ${clientId}`);
        log(`  → Total ICE candidates collected: ${currentCount - 1}`);
    }
    
    // Determine where to forward the ICE candidate
    if (client && client.type === 'web') {
        // Web client sending ICE candidate to Android client
        log(`  → Forwarding to Android client for camera ${cameraId}`);
        const success = sendToAndroidClient(cameraId, {
            type: 'ice-candidate',
            cameraId: cameraId,
            candidate: message.candidate,
            fromClient: clientId
        });
        if (!success) {
            log(`  → Failed to forward ICE candidate - Android client not available`);
        }
    } else {
        // Android client sending ICE candidate to web clients
        log(`  → Broadcasting to web clients for camera ${cameraId}`);
        sendToWebClients({
            type: 'ice-candidate',
            cameraId: cameraId,
            candidate: message.candidate,
            fromClient: clientId
        });
    }
}

function generateClientId() {
    return Math.random().toString(36).substr(2, 9);
}

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    log(`WebRTC Signaling Server running on port ${PORT}`);
    log(`Web interface: http://localhost:${PORT}`);
    log(`WebSocket endpoint: ws://localhost:${PORT}`);
});
