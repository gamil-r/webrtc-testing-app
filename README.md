# WebRTC Signaling Server

A robust WebRTC signaling server with automatic reconnection, ping/pong keepalive, and comprehensive video quality monitoring. Perfect for Android WebRTC applications and web clients.

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

- [Configuration](#configuration)
- [ngrok Deployment](#ngrok-deployment)
- [Android Client Setup](#android-client-setup)
- [Features](#features)
- [Monitoring](#monitoring)
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

## ngrok Deployment

> **⚠️ Important Note for Company-Managed Computers:**
> 
> SentinelOne and other enterprise security software may block ngrok and put the executable in quarantine. This can also affect your IDE and terminal emulator. Consider using a personal device or cloud development environment.

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

## Troubleshooting

### Common Issues

#### 1. Connection Fails
**Symptoms**: Status shows "Disconnected", no cameras appear

**Solutions**:
```bash
# Check if server is running
curl http://localhost:8080

# Verify WebSocket URL in config.js
cat config.js | grep URL

# Check ngrok is running
ngrok status  # or check ngrok dashboard
```

#### 2. Frequent Disconnections
**Symptoms**: Connection drops every few minutes

**Solutions**:
- Verify ping/pong is working (check logs)
- Ensure ngrok is stable
- Check network connectivity
- Consider upgrading to ngrok Pro for better stability

#### 3. Android App Not Connecting
**Symptoms**: Android app shows connection errors

**Solutions**:
1. Verify URL format: `wss://` for HTTPS, `ws://` for HTTP
2. Ensure ngrok URL is accessible from mobile network
3. Test with web client first

### Debug Mode
Enable verbose logging in `config.js`:
```javascript
const CONFIG = {
    DEV: {
        VERBOSE_LOGGING: true,
        SHOW_ALL_STATS: true
    }
};
```

### Network Testing
```bash
# Test WebSocket connection
wscat -c wss://your-ngrok-url.ngrok-free.app

# Test HTTP endpoint
curl -I https://your-ngrok-url.ngrok-free.app
```

## API Reference

### WebSocket Messages

#### Client → Server

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

#### Server → Client

**ICE Servers**
```json
{
    "type": "ice-servers",
    "iceServers": [
        { "urls": "stun:stun.l.google.com:19302" }
    ]
}
```

**Camera Events**
```json
{
    "type": "register-camera" | "camera-disconnected",
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