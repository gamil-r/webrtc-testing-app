const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const CONFIG = require('./config');
const crypto = require('crypto');

// Create Express app
const app = express();

// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, '.')));

// Middleware to handle different content types
app.use((req, res, next) => {
    const contentType = req.headers['content-type'];
    
    // Handle application/sdp as raw text
    if (contentType && contentType.includes('application/sdp')) {
        let data = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
            data += chunk;
        });
        req.on('end', () => {
            req.body = data;
            next();
        });
    } else {
        // Use JSON parser for other content types
        express.json({ limit: '1mb' })(req, res, next);
    }
});

// Simple helper to create SigV4 presigned KVS WSS URL using provided credentials or IAM role on server
// This endpoint mirrors the Kotlin logic in KvsSignaler.kt (GetSignalingChannelEndpoint + presign)
app.post('/kvs/presign', async (req, res) => {
    try {
        const { region, channelArn, clientId, expiresSeconds = 300, credentials } = req.body || {};
        const role = 'VIEWER';
        if (!region || !channelArn || !clientId) {
            return res.status(400).json({ error: 'Missing required fields: region, channelArn, clientId' });
        }

        // 1) Discover WSS endpoint
        const endpoint = await getKvsSignalingEndpoint({ region, channelArn, role, credentials });
        if (!endpoint) return res.status(500).json({ error: 'Failed to get WSS endpoint' });

        // 2) Presign WSS URL
        const url = presignKvsWss({ endpoint, region, channelArn, role, clientId, expiresSeconds, credentials });
        return res.json({ url });
    } catch (e) {
        return res.status(500).json({ error: e.message || 'Unknown error' });
    }
});

async function getKvsSignalingEndpoint({ region, channelArn, role, credentials }) {
    const host = `kinesisvideo.${region}.amazonaws.com`;
    const url = `https://${host}/getSignalingChannelEndpoint`;
    const body = JSON.stringify({
        ChannelARN: channelArn,
        SingleMasterChannelEndpointConfiguration: { Protocols: ['WSS','HTTPS'], Role: role }
    });
    const amzTarget = 'KinesisVideo_20170930.GetSignalingChannelEndpoint';
    const contentType = 'application/x-amz-json-1.1';
    const amzDate = toAmzDate(new Date());
    const dateStamp = toDateStamp(new Date());
    const payloadHash = sha256Hex(Buffer.from(body));
    const headers = {
        'content-type': contentType,
        'host': host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        'x-amz-target': amzTarget
    };
    if (credentials && credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;

    const canonicalRequest = [
        'POST',
        '/getSignalingChannelEndpoint',
        '',
        Object.keys(headers).sort().map(k => `${k}:${headers[k]}`).join('\n') + '\n',
        Object.keys(headers).sort().join(';'),
        payloadHash
    ].join('\n');
    const stringToSignStr = stringToSign(amzDate, dateStamp, region, 'kinesisvideo', canonicalRequest);
    const signingKey = getSigningKey(dateStamp, region, 'kinesisvideo', credentials?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY);
    const signature = hmacHex(signingKey, stringToSignStr);
    const authorization = `AWS4-HMAC-SHA256 Credential=${(credentials?.accessKeyId || process.env.AWS_ACCESS_KEY_ID)}/${credentialScope(dateStamp, region, 'kinesisvideo')}, SignedHeaders=${Object.keys(headers).sort().join(';')}, Signature=${signature}`;

    const fetch = require('node-fetch');
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': contentType,
            'Host': host,
            'X-Amz-Content-Sha256': payloadHash,
            'X-Amz-Date': amzDate,
            ...(credentials && credentials.sessionToken ? { 'X-Amz-Security-Token': credentials.sessionToken } : {}),
            'X-Amz-Target': amzTarget,
            'Authorization': authorization
        },
        body
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`getSignalingChannelEndpoint failed: ${resp.status} ${resp.statusText} - ${text}`);
    }
    const json = await resp.json();
    const list = json.ResourceEndpointList || [];
    const wss = list.find(e => e.Protocol === 'WSS');
    return wss && wss.ResourceEndpoint;
}

// joinStorageSession removed for viewer-only mode

function presignKvsWss({ endpoint, region, channelArn, role, clientId, expiresSeconds, credentials }) {
    // endpoint may be wss://.. or https://.., we need host only
    const host = endpoint.replace(/^wss:\/\//, '').replace(/^https:\/\//, '').split('/')[0].split(':')[0];
    const amzDate = toAmzDate(new Date());
    const dateStamp = toDateStamp(new Date());
    const query = new URLSearchParams();
    query.set('X-Amz-ChannelARN', channelArn);
    query.set('X-Amz-ClientId', clientId);
    query.set('X-Amz-Role', role);
    query.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
    query.set('X-Amz-Credential', `${credentials?.accessKeyId || process.env.AWS_ACCESS_KEY_ID}/${credentialScope(dateStamp, region, 'kinesisvideo')}`);
    query.set('X-Amz-Date', amzDate);
    query.set('X-Amz-Expires', String(expiresSeconds || 300));
    query.set('X-Amz-SignedHeaders', 'host');
    if (credentials?.sessionToken || process.env.AWS_SESSION_TOKEN) query.set('X-Amz-Security-Token', credentials?.sessionToken || process.env.AWS_SESSION_TOKEN);

    const canonicalQuery = Array.from(query.keys()).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(query.get(k))}`).join('&');
    const canonicalHeaders = `host:${host}\n`;
    const signedHeaders = 'host';
    const payloadHash = sha256Hex(Buffer.alloc(0));
    const canonicalRequest = ['GET', '/', canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const stringToSignStr = stringToSign(amzDate, dateStamp, region, 'kinesisvideo', canonicalRequest);
    const signingKey = getSigningKey(dateStamp, region, 'kinesisvideo', credentials?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY);
    const signature = hmacHex(signingKey, stringToSignStr);
    const finalUrl = `wss://${host}/?${canonicalQuery}&X-Amz-Signature=${signature}`;
    return finalUrl;
}

function toAmzDate(date) {
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = date.getUTCFullYear();
    const MM = pad(date.getUTCMonth() + 1);
    const dd = pad(date.getUTCDate());
    const HH = pad(date.getUTCHours());
    const mm = pad(date.getUTCMinutes());
    const ss = pad(date.getUTCSeconds());
    return `${yyyy}${MM}${dd}T${HH}${mm}${ss}Z`;
}
function toDateStamp(date) {
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = date.getUTCFullYear();
    const MM = pad(date.getUTCMonth() + 1);
    const dd = pad(date.getUTCDate());
    return `${yyyy}${MM}${dd}`;
}
function credentialScope(date, region, service) {
    return `${date}/${region}/${service}/aws4_request`;
}
function stringToSign(amzDate, date, region, service, canonicalRequest) {
    const crHash = sha256Hex(Buffer.from(canonicalRequest));
    return ['AWS4-HMAC-SHA256', amzDate, credentialScope(date, region, service), crHash].join('\n');
}
function getSigningKey(date, region, service, secretKey) {
    const kSecret = Buffer.from('AWS4' + (secretKey || ''), 'utf8');
    const kDate = hmac(kSecret, date);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    return hmac(kService, 'aws4_request');
}
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data, 'utf8').digest(); }
function hmacHex(key, data) { return hmac(key, data).toString('hex'); }
function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// WHIP Endpoints - Browser acts as WHIP server (receiver)
// Store pending WHIP requests waiting for browser answer
const pendingWhipRequests = new Map(); // requestId -> { resolve, reject, timeout, cameraId }

// POST /:cameraId/whip - Device posts SDP offer here (server always listens)
app.post('/:cameraId/whip', async (req, res) => {
    try {
        const cameraId = req.params.cameraId;
        const requestPath = `/${cameraId}/whip`;
        
        log(`WHIP POST request to path: ${requestPath}`);
        log(`  → Content-Type: ${req.headers['content-type']}`);
        log(`  → Body type: ${typeof req.body}`);
        log(`  → Body is Buffer: ${Buffer.isBuffer(req.body)}`);
        log(`  → Body keys: ${typeof req.body === 'object' && req.body ? Object.keys(req.body).join(', ') : 'N/A'}`);
        log(`  → Raw body preview: ${JSON.stringify(req.body).substring(0, 200)}`);
        
        // SDP offer should be in the body as application/sdp or parsed from JSON
        let offer;
        if (req.headers['content-type'] === 'application/sdp' || req.headers['content-type']?.includes('application/sdp')) {
            log(`  → Parsing as SDP (Content-Type: application/sdp)`);
            const sdpBody = typeof req.body === 'string' ? req.body : req.body.toString();
            offer = {
                type: 'offer',
                sdp: sdpBody
            };
            log(`  → SDP length: ${offer.sdp.length}`);
        } else if (req.body && req.body.sdp) {
            log(`  → Parsing as JSON with sdp field`);
            offer = req.body;
            log(`  → SDP length: ${offer.sdp.length}`);
        } else {
            log(`  → ERROR: Missing SDP offer in body`);
            log(`  → Body content: ${JSON.stringify(req.body)}`);
            return res.status(400).send('Missing SDP offer');
        }

        const requestId = crypto.randomBytes(16).toString('hex');
        
        log(`  → Request ID: ${requestId}`);
        log(`  → Offer type: ${offer.type}`);
        log(`  → SDP length: ${offer.sdp ? offer.sdp.length : 0}`);
        log(`  → SDP preview: ${offer.sdp ? offer.sdp.substring(0, 100) + '...' : 'N/A'}`);

        // Create promise that will be resolved when browser sends answer
        const answerPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingWhipRequests.delete(requestId);
                reject(new Error('Timeout waiting for browser answer'));
            }, 30000); // 30 second timeout

            pendingWhipRequests.set(requestId, {
                resolve,
                reject,
                timeout,
                cameraId: cameraId
            });
        });

        // Broadcast offer to all connected browsers (they'll match by cameraId/path)
        sendToWebClients({
            type: 'whip-offer',
            cameraId: cameraId,
            requestPath: requestPath,
            offer: offer,
            requestId: requestId
        });

        log(`  → Offer broadcast to all browsers, waiting for answer (with all ICE candidates)...`);

        // Wait for answer from browser
        try {
            const answer = await answerPromise;
            
            log(`  → Received answer from browser for camera ${cameraId}`);
            log(`  → Answer SDP length: ${answer.sdp ? answer.sdp.length : 0}`);
            log(`  → Answer SDP preview: ${answer.sdp ? answer.sdp.substring(0, 100) + '...' : 'N/A'}`);
            
            // Send answer back to device as SDP
            res.setHeader('Content-Type', 'application/sdp');
            res.setHeader('Location', requestPath); // WHIP spec - location for DELETE
            res.status(201).send(answer.sdp);
            
            log(`  → HTTP 201 response sent to device with SDP answer`);
        } catch (error) {
            log(`  → Error: ${error.message}`);
            res.status(500).send(error.message);
        }
    } catch (error) {
        log(`WHIP POST error: ${error.message}`);
        res.status(500).send(error.message);
    }
});

// DELETE /:cameraId/whip - Device terminates WHIP session
app.delete('/:cameraId/whip', (req, res) => {
    try {
        const cameraId = req.params.cameraId;
        const requestPath = `/${cameraId}/whip`;
        
        log(`WHIP DELETE request to path: ${requestPath}`);

        // Broadcast delete to all browsers (they'll match by cameraId/path)
        sendToWebClients({
            type: 'whip-delete',
            cameraId: cameraId,
            requestPath: requestPath
        });

        log(`  → Delete notification broadcast to all browsers`);
        res.status(200).send('OK');
    } catch (error) {
        log(`WHIP DELETE error: ${error.message}`);
        res.status(500).send(error.message);
    }
});

// WHEP Proxy Endpoint - allows client to access WHEP servers through our server
app.post('/whep-proxy', async (req, res) => {
    try {
        const targetUrl = req.headers['x-target-url'];
        if (!targetUrl) {
            return res.status(400).send('Missing X-Target-URL header');
        }

        log(`WHEP proxy POST request to ${targetUrl}`);

        const fetch = require('node-fetch');
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/sdp',
                'Accept': 'application/sdp'
            },
            body: req.body
        });

        // Forward status and headers
        res.status(response.status);
        
        // Forward important headers (especially Location for session management)
        const location = response.headers.get('Location');
        if (location) {
            res.setHeader('Location', location);
        }
        const contentType = response.headers.get('Content-Type');
        if (contentType) {
            res.setHeader('Content-Type', contentType);
        }

        const responseBody = await response.text();
        log(`WHEP proxy response: ${response.status} ${response.statusText}, body length: ${responseBody.length}`);
        
        res.send(responseBody);
    } catch (error) {
        log(`WHEP proxy error: ${error.message}`);
        res.status(500).send(`WHEP proxy error: ${error.message}`);
    }
});

app.delete('/whep-proxy', async (req, res) => {
    try {
        const targetUrl = req.headers['x-target-url'];
        if (!targetUrl) {
            return res.status(400).send('Missing X-Target-URL header');
        }

        log(`WHEP proxy DELETE request to ${targetUrl}`);

        const fetch = require('node-fetch');
        const response = await fetch(targetUrl, {
            method: 'DELETE'
        });

        log(`WHEP proxy DELETE response: ${response.status} ${response.statusText}`);
        res.status(response.status).send();
    } catch (error) {
        log(`WHEP proxy DELETE error: ${error.message}`);
        res.status(500).send(`WHEP proxy error: ${error.message}`);
    }
});

// WHIP Proxy Endpoint - allows client to publish to WHIP servers through our server
app.post('/whip-proxy', async (req, res) => {
    try {
        const targetUrl = req.headers['x-target-url'];
        if (!targetUrl) {
            return res.status(400).send('Missing X-Target-URL header');
        }

        log(`WHIP proxy POST request to ${targetUrl}`);

        const fetch = require('node-fetch');
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/sdp',
                'Accept': 'application/sdp'
            },
            body: req.body
        });

        // Forward status and headers
        res.status(response.status);
        
        // Forward important headers (especially Location for session management)
        const location = response.headers.get('Location');
        if (location) {
            res.setHeader('Location', location);
        }
        const contentType = response.headers.get('Content-Type');
        if (contentType) {
            res.setHeader('Content-Type', contentType);
        }

        const responseBody = await response.text();
        log(`WHIP proxy response: ${response.status} ${response.statusText}, body length: ${responseBody.length}`);
        
        res.send(responseBody);
    } catch (error) {
        log(`WHIP proxy error: ${error.message}`);
        res.status(500).send(`WHIP proxy error: ${error.message}`);
    }
});

app.delete('/whip-proxy', async (req, res) => {
    try {
        const targetUrl = req.headers['x-target-url'];
        if (!targetUrl) {
            return res.status(400).send('Missing X-Target-URL header');
        }

        log(`WHIP proxy DELETE request to ${targetUrl}`);

        const fetch = require('node-fetch');
        const response = await fetch(targetUrl, {
            method: 'DELETE'
        });

        log(`WHIP proxy DELETE response: ${response.status} ${response.statusText}`);
        res.status(response.status).send();
    } catch (error) {
        log(`WHIP proxy DELETE error: ${error.message}`);
        res.status(500).send(`WHIP proxy error: ${error.message}`);
    }
});

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

// Default ICE servers - fallback if config.js doesn't have any
const defaultIceServers = [
    { urls: 'stun:stun.l.google.com:19302' }
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
/*
process.on('SIGINT', () => {
    clearInterval(pingInterval);
    clearInterval(healthCheckInterval);
    wss.close(() => {
        log('WebSocket server closed');
        process.exit(0// 
    });
});
*/
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
        case 'unregister-camera':
            handleUnregisterCamera(clientId, message);
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
        case 'whip-answer':
            handleWhipAnswer(clientId, message);
            break;
        case 'whip-error':
            handleWhipError(clientId, message);
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

    // Send ICE servers configuration from config.js to all clients
    const iceServers = CONFIG.ICE_SERVERS || defaultIceServers;
    client.ws.send(JSON.stringify({
        type: 'ice-servers',
        iceServers: iceServers
    }));

    log(`Sent ICE servers configuration to ${client.type} client ${clientId}:`, iceServers);
    
    // If this is a web client, send list of registered cameras
    if (client.type === 'web') {
        // Send list of all registered cameras
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
    const httpEndpoint = message.httpEndpoint; // Optional HTTP endpoint for direct communication

    if (!cameras.has(cameraId)) {
        cameras.set(cameraId, {
            id: cameraId,
            client: client,
            httpEndpoint: httpEndpoint || null,
            registeredAt: new Date()
        });

        log(`Camera registered: ${cameraId} by client ${clientId}`);
        if (httpEndpoint) {
            log(`  → HTTP Endpoint: ${httpEndpoint}`);
        }

        // Notify all web clients
        sendToWebClients({
            type: 'register-camera',
            cameraId: cameraId
        });
    }
}

function handleUnregisterCamera(clientId, message) {
    const client = clients.get(clientId);
    if (!client) return;

    const cameraId = message.cameraId;

    if (!cameraId) {
        log(`Invalid camera unregistration from ${clientId}: missing cameraId`);
        return;
    }

    const camera = cameras.get(cameraId);
    if (!camera) {
        log(`Camera ${cameraId} not found for unregistration`);
        return;
    }

    // Verify the client owns this camera
    if (camera.client.id !== clientId) {
        log(`Client ${clientId} attempted to unregister camera ${cameraId} owned by ${camera.client.id}`);
        return;
    }

    // Remove the camera
    cameras.delete(cameraId);
    log(`Camera unregistered: ${cameraId} by client ${clientId}`);

    // Clean up ICE candidate tracking
    iceCandidateCount.forEach((count, sessionKey) => {
        if (sessionKey.includes(cameraId)) {
            iceCandidateCount.delete(sessionKey);
            log(`ICE candidate tracking cleaned up for session: ${sessionKey}`);
        }
    });

    // Notify all web clients
    sendToWebClients({
        type: 'unregister-camera',
        cameraId: cameraId
    });
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

function handleWhipAnswer(clientId, message) {
    const { cameraId, requestId, answer } = message;
    
    log(`Received WHIP answer from browser for request ${requestId}`);
    log(`  → Camera ID: ${cameraId}`);
    log(`  → Answer type: ${answer.type}`);
    log(`  → Answer SDP length: ${answer.sdp ? answer.sdp.length : 0}`);
    
    const pending = pendingWhipRequests.get(requestId);
    if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(answer);
        pendingWhipRequests.delete(requestId);
        log(`  → Answer resolved and will be forwarded to device ${cameraId}`);
    } else {
        log(`  → Warning: No pending request found for ${requestId}`);
    }
}

function handleWhipError(clientId, message) {
    const { cameraId, requestId, error } = message;
    
    log(`Received WHIP error from browser for request ${requestId}: ${error}`);
    if (cameraId) {
        log(`  → Camera ID: ${cameraId}`);
    }
    
    const pending = pendingWhipRequests.get(requestId);
    if (pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(error));
        pendingWhipRequests.delete(requestId);
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
