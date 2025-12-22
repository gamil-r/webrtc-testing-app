# WebRTC Testing Application

WebRTC signaling server with support for multiple signaling protocols. Provides tunneled control channel and peer-to-peer media connections for testing Android and web clients.

## Architecture Overview

This application uses a hybrid tunneling + peer-to-peer architecture:

**Control Channel (via Tunnel)**: Browser connects to the device through an HTTP/WebSocket tunnel (ngrok, Cloudflare tunnel, or direct connection). All signaling, commands, and control messages flow through this tunnel to the device.

**Media Channel (Peer-to-Peer)**: Once the WebRTC connection is established, video/audio streams flow directly between browser and device using WebRTC peer connections. Media bypasses the tunnel.

The split allows control traffic to use the reliable tunnel while media uses WebRTC's NAT traversal with STUN/TURN servers configured in `config.js`.

## Supported Signaling Protocols

The server implements four signaling mechanisms:

### 1. WebSocket Signaling
Bidirectional WebSocket connection at the root endpoint. Clients identify themselves as 'web' or 'android' and exchange offer/answer/ICE candidates. The server relays messages between clients based on camera ID. Includes ping/pong keepalive with 30-second intervals.

### 2. WHIP (WebRTC HTTP Ingestion Protocol)
HTTP-based ingestion where devices POST SDP offers to `/cameraId/whip`. The server holds the HTTP connection open, forwards the offer to browsers via WebSocket, waits for the browser's answer, then returns it as the HTTP response. Session is terminated with DELETE to the same endpoint.

### 3. WHEP (WebRTC HTTP Egress Protocol)
Proxy endpoint at `/whep-proxy` that forwards browser requests to external WHEP servers. Browser includes target URL in `X-Target-URL` header. Server proxies the SDP exchange and returns the Location header for session management.

### 4. AWS Kinesis Video Streams
Endpoint at `/kvs/presign` generates SigV4-signed WebSocket URLs for KVS signaling channels. Server calls `GetSignalingChannelEndpoint` to discover the WSS endpoint, then presigns it with AWS credentials (from environment variables or request body). Client receives a presigned URL valid for specified duration (default 300 seconds).

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Server
```bash
npm start
```

### 3. Open Web Client
```bash
# Server runs on http://localhost:8080
open http://localhost:8080
```

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Supported Signaling Protocols](#supported-signaling-protocols)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Tunnel Deployment (ngrok)](#tunnel-deployment-ngrok)
- [Android Client Setup](#android-client-setup)
- [Signaling Protocol Usage](#signaling-protocol-usage)
- [Troubleshooting](#troubleshooting)
- [API Reference](#api-reference)

## Configuration

### Changing the WebSocket URL

The easiest way to change the server URL is by editing `config.js`:

```javascript
// config.js
const CONFIG = {
    WEBSOCKET: {
        // Choose one of the following:
        
        // For local development with devices on the same network
        // Replace with your actual LAN IP (e.g., your WiFi IP address)
        URL: 'ws://192.168.1.100:8080',
        
        // For localhost-only testing (web browser on same machine)
        // URL: 'ws://localhost:8080',
        
        // For ngrok tunneling
        // URL: 'wss://your-ngrok-url.ngrok-free.app',
        
        // For production
        // URL: 'wss://your-domain.com',
    }
};
```

**Important for Local Development:**
- **Use your LAN IP address** (not `localhost`) when connecting from devices on your local network (phones, tablets, etc.)
- **Both devices must be connected to the same local network** (same WiFi network)
- Find your LAN IP with: `ipconfig` (Windows) or `ifconfig` / `ip addr` (Linux/macOS)
- Example: If your computer's WiFi IP is `192.168.1.100`, use `ws://192.168.1.100:8080`

### Configuration Options

| Setting | Default | Description |
|---------|---------|-------------|
| `WEBSOCKET.URL` | `ws://localhost:8080` | WebSocket server URL |
| `WEBSOCKET.RECONNECT_ATTEMPTS` | `10` | Maximum reconnection attempts |
| `WEBSOCKET.PING_INTERVAL` | `25000` | Ping interval (ms) |
| `WEBSOCKET.CONNECTION_TIMEOUT` | `60000` | Connection timeout (ms) |

## Tunnel Deployment (ngrok)

Tunneling provides HTTP/WebSocket access to the server from external networks. The tunnel carries control and signaling messages. WebRTC media flows peer-to-peer after connection is established.

**Note:** Enterprise security software may quarantine ngrok. Alternatives include Cloudflare Tunnel, localtunnel, or direct port forwarding.

### Step 1: Install ngrok
```bash
# Download from https://ngrok.com/download
# Or install via package manager:
brew install ngrok  # macOS
choco install ngrok # Windows
```

### Step 2: Get Auth Token
1. Sign up at [ngrok.com](https://ngrok.com)
2. Get your auth token from the dashboard
3. Configure ngrok:
```bash
ngrok config add-authtoken YOUR_AUTH_TOKEN
```

### Step 3: Create ngrok Configuration (Optional)
Create `~/.ngrok2/ngrok.yml`:
```yaml
version: "2"
authtoken: YOUR_AUTH_TOKEN
tunnels:
  webrtc-signaling:
    proto: http
    addr: 8080
    # Optional: Use a custom subdomain (requires paid plan)
    # subdomain: my-webrtc-app
    inspect: false
    bind_tls: true
    http_version: "1.1"
    # Optimize for WebSocket connections
    keepalive_interval: 30
    timeout: 300
```

### Step 4: Start ngrok
```bash
# Simple method
ngrok http 8080

# Or with configuration file
ngrok start webrtc-signaling
```

### Step 5: Update Configuration
Copy the ngrok URL and update `config.js`:
```javascript
// config.js
const CONFIG = {
    WEBSOCKET: {
        // Replace with your ngrok URL
        URL: 'wss://abc123.ngrok-free.app',
    }
};
```

### Step 6: Test Connection
1. Restart your server: `npm start`
2. Open the web client
3. Check that the status shows "Connected"
4. Look for the ngrok URL in the header

## Android Client Setup

### Update WebSocket URL in Signaling Client
In the file `../webrtcstreamer/signaling/WebSocketSignalingClient.kt`:

```kotlin
class WebSocketSignalingClient(
    // Update this URL to match your ngrok or server URL
    private val serverUrl: String = "wss://abc123.ngrok-free.app"
) : WebrtcSignalingClient {
    // ... existing code
}
```

## Signaling Protocol Usage

### WebSocket Signaling

Connect to the WebSocket endpoint and send an `identify` message. After identification, clients can register cameras and exchange WebRTC signaling messages. The server routes messages based on `cameraId`.

Flow:
1. Connect to `ws://server:8080` or `wss://tunnel-url`
2. Send `{"type": "identify", "clientType": "web"}` or `"android"`
3. Android clients send `{"type": "register-camera", "cameraId": "camera-1"}`
4. Clients exchange `offer`, `answer`, and `ice-candidate` messages with `cameraId` field
5. Server forwards messages between matching clients

Example:
```javascript
const ws = new WebSocket('wss://your-tunnel-url');
ws.send(JSON.stringify({
    type: 'identify',
    clientType: 'web'
}));
```

### WHIP

Device POSTs SDP offer to `/cameraId/whip` with `Content-Type: application/sdp`. The server generates a request ID, broadcasts the offer to all web clients via WebSocket, and waits up to 30 seconds for a browser to respond with `whip-answer`. The answer is returned as HTTP 201 with `Content-Type: application/sdp` and `Location` header.

Implementation details:
- Server stores pending requests in `pendingWhipRequests` Map
- Browser must be connected via WebSocket to receive `whip-offer` message
- Browser responds with `{"type": "whip-answer", "requestId": "...", "answer": {...}}`
- DELETE to same endpoint notifies browsers via `whip-delete` message

Example:
```bash
# POST offer
curl -X POST https://tunnel-url/camera-1/whip \
  -H "Content-Type: application/sdp" \
  --data-binary @offer.sdp

# Terminate session
curl -X DELETE https://tunnel-url/camera-1/whip
```

### WHEP Proxy

The `/whep-proxy` endpoint forwards requests to external WHEP servers. Client includes the target WHEP server URL in the `X-Target-URL` header. Server proxies the POST request with `Content-Type: application/sdp` and forwards back the status, headers (especially `Location`), and response body.

DELETE requests work the same way - include target URL in `X-Target-URL` header.

Example:
```javascript
const offer = await peerConnection.createOffer();
await peerConnection.setLocalDescription(offer);

const response = await fetch('https://tunnel-url/whep-proxy', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/sdp',
        'X-Target-URL': 'https://external-whep-server.com/stream/id'
    },
    body: offer.sdp
});

const answerSdp = await response.text();
const sessionLocation = response.headers.get('Location');
```

### AWS Kinesis Video Streams

POST to `/kvs/presign` with channel details to get a presigned WSS URL. Server calls AWS `GetSignalingChannelEndpoint` API to discover the endpoint, then generates a SigV4-signed WebSocket URL valid for the specified duration.

Required fields:
- `region`: AWS region (e.g., 'us-west-2')
- `channelArn`: Full ARN of KVS signaling channel
- `clientId`: Unique client identifier
- `expiresSeconds`: URL validity period (default 300)
- `credentials`: Object with `accessKeyId`, `secretAccessKey`, optional `sessionToken`

Server will use environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`) if credentials not provided in request.

Example:
```javascript
const response = await fetch('https://tunnel-url/kvs/presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        region: 'us-west-2',
        channelArn: 'arn:aws:kinesisvideo:us-west-2:123456789:channel/my-channel/1234567890',
        clientId: 'browser-viewer-' + Date.now(),
        expiresSeconds: 300,
        credentials: {
            accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
            secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
            sessionToken: 'optional-token'
        }
    })
});

const { url } = await response.json();
// Use url to connect to KVS signaling channel
```

## Troubleshooting

### Connection Issues

Check server is running:
```bash
curl http://localhost:8080
```

Verify WebSocket URL in `config.js` matches your tunnel or local IP.

Test WebSocket connection:
```bash
wscat -c wss://your-ngrok-url.ngrok-free.app
```

Check server logs for connection events. Ping/pong keepalive runs every 30 seconds - connection times out after 60 seconds without activity.

### WHIP Issues

Device POST to `/whip` holds connection open for up to 30 seconds waiting for browser answer. Ensure:
- Browser is connected via WebSocket before device POSTs
- Content-Type is `application/sdp`
- Browser handles `whip-offer` message and responds with `whip-answer`

Check server logs for "WHIP POST request" and request ID matching.

### WHEP/WHIP Proxy Issues

Proxy forwards requests to external server. Check:
- External server URL in `X-Target-URL` header is correct
- Server can reach external endpoint (no firewall blocking)
- External server accepts `Content-Type: application/sdp`

Test external server directly:
```bash
curl -X POST https://external-server.com/endpoint \
  -H "Content-Type: application/sdp" \
  --data-binary @offer.sdp -v
```

### AWS KVS Issues

Endpoint `/kvs/presign` calls AWS APIs with SigV4 signing. Check:
- AWS credentials are valid (in request or environment variables)
- IAM role has `kinesisvideo:GetSignalingChannelEndpoint` permission
- Channel ARN and region are correct

Test with AWS CLI:
```bash
aws kinesisvideo get-signaling-channel-endpoint \
  --channel-arn "arn:aws:kinesisvideo:region:account:channel/name/id" \
  --single-master-channel-endpoint-configuration Protocols=WSS,Role=VIEWER \
  --region us-west-2
```

### WebRTC Media Issues

If signaling succeeds but no media flows, check ICE connection state in browser console:
```javascript
peerConnection.oniceconnectionstatechange = () => {
    console.log('ICE State:', peerConnection.iceConnectionState);
};
```

Should transition: `new` → `checking` → `connected`. If stuck in `checking`, add TURN server to `config.js` ICE_SERVERS array. Behind symmetric NAT, STUN alone is insufficient.

## API Reference

### 1. WebSocket Signaling API

#### Client → Server Messages

**Identify Client**
```json
{
    "type": "identify",
    "clientType": "web" | "android"
}
```

**Register Camera**
```json
{
    "type": "register-camera",
    "cameraId": "camera-1",
    "httpEndpoint": "https://device-tunnel-url" // Optional
}
```

**Unregister Camera**
```json
{
    "type": "unregister-camera",
    "cameraId": "camera-1"
}
```

**WebRTC Signaling**
```json
{
    "type": "offer" | "answer" | "ice-candidate",
    "cameraId": "camera-1",
    "offer": { "type": "offer", "sdp": "..." },
    "answer": { "type": "answer", "sdp": "..." },
    "candidate": { "candidate": "...", "sdpMLineIndex": 0, "sdpMid": "0" }
}
```

**Keepalive**
```json
{
    "type": "ping",
    "timestamp": 1640995200000
}
```

#### Server → Client Messages

**ICE Servers Configuration**
```json
{
    "type": "ice-servers",
    "iceServers": [
        { "urls": "stun:stun.l.google.com:19302" },
        { "urls": "turn:turn-server:3478", "username": "user", "credential": "pass" }
    ]
}
```

**Camera Events**
```json
{
    "type": "register-camera" | "camera-disconnected" | "unregister-camera",
    "cameraId": "camera-1"
}
```

**Call Management**
```json
{
    "type": "call-request" | "hang-up",
    "cameraId": "camera-1",
    "fromClient": "client-123"
}
```

**WHIP Offer (to Browser)**
```json
{
    "type": "whip-offer",
    "cameraId": "camera-1",
    "requestPath": "/camera-1/whip",
    "offer": { "type": "offer", "sdp": "..." },
    "requestId": "abc123..."
}
```

**WHIP Delete Notification**
```json
{
    "type": "whip-delete",
    "cameraId": "camera-1",
    "requestPath": "/camera-1/whip"
}
```

### 2. WHIP HTTP API

#### POST /cameraId/whip
Device publishes stream by posting SDP offer. The URL format is `hostname:port/cameraId/whip` where `cameraId` is your camera identifier (e.g., `camera-1`).

**Request:**
```http
POST /camera-1/whip HTTP/1.1
Content-Type: application/sdp

v=0
o=- 123456789 2 IN IP4 127.0.0.1
s=-
...
```

**Response (201 Created):**
```http
HTTP/1.1 201 Created
Content-Type: application/sdp
Location: /camera-1/whip

v=0
o=- 987654321 2 IN IP4 127.0.0.1
s=-
...
```

#### DELETE /cameraId/whip
Terminate WHIP session. Uses same URL format: `hostname:port/cameraId/whip`.

**Request:**
```http
DELETE /camera-1/whip HTTP/1.1
```

**Response:**
```http
HTTP/1.1 200 OK
```

### 3. WHEP Proxy API

#### POST /whep-proxy
Proxy request to external WHEP server.

**Request:**
```http
POST /whep-proxy HTTP/1.1
Content-Type: application/sdp
X-Target-URL: https://external-whep-server.com/stream/abc123

v=0
o=- 123456789 2 IN IP4 127.0.0.1
...
```

**Response:**
```http
HTTP/1.1 201 Created
Content-Type: application/sdp
Location: https://external-whep-server.com/stream/abc123/session/xyz

v=0
o=- 987654321 2 IN IP4 127.0.0.1
...
```

#### DELETE /whep-proxy
Terminate WHEP session on external server.

**Request:**
```http
DELETE /whep-proxy HTTP/1.1
X-Target-URL: https://external-whep-server.com/stream/abc123/session/xyz
```

### 4. WHIP Proxy API

#### POST /whip-proxy
Proxy request to external WHIP server (for publishing).

**Request:**
```http
POST /whip-proxy HTTP/1.1
Content-Type: application/sdp
X-Target-URL: https://external-whip-server.com/publish/stream123

v=0
o=- 123456789 2 IN IP4 127.0.0.1
...
```

**Response:**
```http
HTTP/1.1 201 Created
Content-Type: application/sdp
Location: https://external-whip-server.com/publish/stream123/session/xyz

v=0
o=- 987654321 2 IN IP4 127.0.0.1
...
```

#### DELETE /whip-proxy
Terminate WHIP session on external server.

**Request:**
```http
DELETE /whip-proxy HTTP/1.1
X-Target-URL: https://external-whip-server.com/publish/stream123/session/xyz
```

### 5. AWS KVS API

#### POST /kvs/presign
Generate presigned WSS URL for KVS signaling channel.

**Request:**
```json
{
    "region": "us-west-2",
    "channelArn": "arn:aws:kinesisvideo:us-west-2:123456789:channel/my-channel/1234567890",
    "clientId": "browser-viewer-123",
    "expiresSeconds": 300,
    "credentials": {
        "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
        "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "sessionToken": "optional-session-token"
    }
}
```

**Response:**
```json
{
    "url": "wss://kinesisvideo.us-west-2.amazonaws.com/?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=..."
}
```

**Error Response (400/500):**
```json
{
    "error": "Missing required fields: region, channelArn, clientId"
}
```