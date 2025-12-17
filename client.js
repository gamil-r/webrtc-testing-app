class WebRTCSignalingClient {
    constructor() {
        this.socket = null;
        this.peerConnections = new Map(); // Map of cameraId -> peerConnection
        this.streamElements = new Map(); // Map of cameraId -> video element
        this.connectionStatus = document.getElementById('connectionStatus');
        this.cameraList = document.getElementById('cameraList');
        this.logContainer = document.getElementById('logContainer');
        this.streamsGrid = document.getElementById('streamsGrid');

        this.cameras = new Map(); // Map of cameraId -> camera info
        this.activeStreams = new Set(); // Set of active stream IDs
        this.statsIntervals = new Map(); // Map of cameraId -> interval ID
        this.streamStats = new Map(); // Map of cameraId -> stats object

        // Floating stats panel
        this.floatingStatsContent = document.getElementById('floatingStatsContent');
        this.previousStats = new Map(); // Map of cameraId -> previous stats for calculations

        // Track manual hang-ups to prevent automatic disconnection handling
        this.manualHangups = new Set();

        // Track video timing for freeze detection
        this.lastVideoTime = new Map(); // Map of cameraId -> last video time

        // Connection management - use CONFIG values
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = CONFIG.WEBSOCKET.RECONNECT_ATTEMPTS;
        this.reconnectDelay = CONFIG.WEBSOCKET.RECONNECT_BASE_DELAY;
        this.maxReconnectDelay = CONFIG.WEBSOCKET.RECONNECT_MAX_DELAY;
        this.pingInterval = null;
        this.pongTimeout = null;
        this.lastPongTime = Date.now();
        this.connectionTimeout = CONFIG.WEBSOCKET.CONNECTION_TIMEOUT;

        this.initializeWebSocket();
        this.setupGlobalStats();
        this.startGlobalStatsUpdate();
        this.initializeFloatingStats();
        this.startVideoHealthMonitoring();

        // Trickle ICE toggle (checkbox represents NO trickle)
        // Default: unchecked → trickle enabled
        this.useTrickleIce = true;
        this.nonTrickleSent = new Set(); // Track cameras for which we've sent the final SDP in non-trickle mode
        const trickleCheckbox = document.getElementById('useTrickleIceCheckbox');
        if (trickleCheckbox) {
            this.useTrickleIce = !trickleCheckbox.checked;
            trickleCheckbox.addEventListener('change', () => {
                this.useTrickleIce = !trickleCheckbox.checked;
                this.log(`Trickle ICE ${this.useTrickleIce ? 'enabled' : 'disabled'}`, 'info');
            });
        }

        // Mode switching
        this.mode = 'ws'; // 'ws' | 'whep' | 'whip' | 'kvs'
        this.whepConnections = new Map(); // Map of whepId -> { pc, endpointUrl, state }
        this.whepUrlCounter = 0;
        this.whipConnections = new Map(); // Map of whipId -> { pc, endpointUrl, state, pendingAnswerCallback }
        this.whipUrlCounter = 0;
        const modeWsBtn = document.getElementById('modeWsBtn');
        const modeWhepBtn = document.getElementById('modeWhepBtn');
        const modeWhipBtn = document.getElementById('modeWhipBtn');
        const modeKvsBtn = document.getElementById('modeKvsBtn');
        if (modeWsBtn && modeWhepBtn && modeWhipBtn && modeKvsBtn) {
            modeWsBtn.addEventListener('click', () => this.switchMode('ws'));
            modeWhepBtn.addEventListener('click', () => this.switchMode('whep'));
            modeWhipBtn.addEventListener('click', () => this.switchMode('whip'));
            modeKvsBtn.addEventListener('click', () => this.switchMode('kvs'));
        }
        // Initialize WHEP URL list
        const addWhepUrlBtn = document.getElementById('addWhepUrlBtn');
        if (addWhepUrlBtn) addWhepUrlBtn.addEventListener('click', () => this.addWhepUrl());

        // Initialize WHIP camera list
        const addWhipCameraBtn = document.getElementById('addWhipCameraBtn');
        if (addWhipCameraBtn) addWhipCameraBtn.addEventListener('click', () => this.addWhipCamera());

        // Initialize with one URL entry
        this.initializeWhepUrls();
        this.initializeWhipCameras();

        // KVS UI bindings
        this.kvs = {
            signalingClient: null,
            pc: null,
            state: 'disconnected',
            cameraId: null,
            keepaliveInterval: null
        };
        const kvsConnectBtn = document.getElementById('kvsConnectBtn');
        const kvsDisconnectBtn = document.getElementById('kvsDisconnectBtn');
        if (kvsConnectBtn) kvsConnectBtn.addEventListener('click', () => this.startKvs());
        if (kvsDisconnectBtn) kvsDisconnectBtn.addEventListener('click', () => this.stopKvs());
    }

    switchMode(mode) {
        this.mode = mode;
        const wsSection = document.getElementById('wsSection');
        const whepSection = document.getElementById('whepSection');
        const whipSection = document.getElementById('whipSection');
        const kvsSection = document.getElementById('kvsSection');
        const modeWsBtn = document.getElementById('modeWsBtn');
        const modeWhepBtn = document.getElementById('modeWhepBtn');
        const modeWhipBtn = document.getElementById('modeWhipBtn');
        const modeKvsBtn = document.getElementById('modeKvsBtn');
        if (wsSection && whepSection && whipSection && kvsSection) {
            wsSection.style.display = mode === 'ws' ? 'block' : 'none';
            whepSection.style.display = mode === 'whep' ? 'block' : 'none';
            whipSection.style.display = mode === 'whip' ? 'block' : 'none';
            kvsSection.style.display = mode === 'kvs' ? 'block' : 'none';
        }
        if (modeWsBtn && modeWhepBtn && modeWhipBtn && modeKvsBtn) {
            modeWsBtn.classList.toggle('active', mode === 'ws');
            modeWhepBtn.classList.toggle('active', mode === 'whep');
            modeWhipBtn.classList.toggle('active', mode === 'whip');
            modeKvsBtn.classList.toggle('active', mode === 'kvs');
        }
        this.log(`Switched mode to ${mode.toUpperCase()}`, 'info');
    }

    // ======================
    // KVS (AWS SDK)
    // ======================
    async startKvs() {
        try {
            if (this.kvs.state !== 'disconnected') {
                this.log('KVS already connecting/connected', 'warning');
                return;
            }

            // Read inputs
            const cameraId = (document.getElementById('kvsCameraId')?.value || 'kvs_camera').trim();
            const channelArn = (document.getElementById('kvsChannelArn')?.value || '').trim();
            const clientId = cameraId || `web_${Math.random().toString(36).slice(2, 8)}`;
            const accessKeyId = (document.getElementById('kvsAccessKeyId')?.value || '').trim();
            const secretAccessKey = (document.getElementById('kvsSecretAccessKey')?.value || '').trim();
            const sessionToken = (document.getElementById('kvsSessionToken')?.value || '').trim();

            const connectBtn = document.getElementById('kvsConnectBtn');
            const disconnectBtn = document.getElementById('kvsDisconnectBtn');
            if (connectBtn) { connectBtn.disabled = true; connectBtn.textContent = 'Connecting...'; }
            if (disconnectBtn) { disconnectBtn.style.display = 'inline-block'; disconnectBtn.disabled = true; }

            this.kvs.cameraId = cameraId;
            this.kvs.state = 'connecting';

            if (!channelArn || !clientId) {
                throw new Error('Channel ARN and Client ID are required');
            }

            // Extract region from ARN: arn:aws:kinesisvideo:REGION:...
            const region = this.extractRegionFromArn(channelArn);
            if (!region) {
                throw new Error('Invalid Channel ARN format. Expected: arn:aws:kinesisvideo:REGION:ACCOUNT:channel/...');
            }

            this.log('Setting up KVS WebRTC connection', 'info', { region, clientId, cameraId });

            // Setup AWS credentials
            let credentials;
            if (accessKeyId && secretAccessKey) {
                credentials = {
                    accessKeyId,
                    secretAccessKey,
                    sessionToken: sessionToken || undefined
                };
            } else {
                // Use server-side credentials via fetch proxy
                credentials = await this.getKvsCredentialsFromServer(region, channelArn, clientId);
            }

            // Use AWS SDK SignalingClient
            const kinesisVideoClient = new window.AWS.KinesisVideo({
                region,
                credentials,
                correctClockSkew: true
            });

            // Get signaling channel endpoints
            this.log('Getting signaling channel endpoints', 'info');
            const getSignalingChannelEndpointResponse = await kinesisVideoClient
                .getSignalingChannelEndpoint({
                    ChannelARN: channelArn,
                    SingleMasterChannelEndpointConfiguration: {
                        Protocols: ['WSS', 'HTTPS'],
                        Role: 'VIEWER'
                    }
                })
                .promise();

            const endpointsByProtocol = getSignalingChannelEndpointResponse.ResourceEndpointList.reduce((endpoints, endpoint) => {
                endpoints[endpoint.Protocol] = endpoint.ResourceEndpoint;
                return endpoints;
            }, {});

            this.log('Got KVS endpoints', 'info', { wss: endpointsByProtocol.WSS });

            // Get ICE server configuration from KVS
            this.log('Getting TURN server configuration from KVS', 'info');
            const kinesisVideoSignalingChannelsClient = new window.AWS.KinesisVideoSignalingChannels({
                region,
                credentials,
                endpoint: endpointsByProtocol.HTTPS,
                correctClockSkew: true
            });

            const getIceServerConfigResponse = await kinesisVideoSignalingChannelsClient
                .getIceServerConfig({
                    ChannelARN: channelArn
                })
                .promise();

            const iceServers = [];
            iceServers.push({ urls: `stun:stun.kinesisvideo.${region}.amazonaws.com:443` });
            
            if (getIceServerConfigResponse.IceServerList) {
                getIceServerConfigResponse.IceServerList.forEach(iceServer => {
                    iceServer.Uris.forEach(uri => {
                        iceServers.push({
                            urls: uri,
                            username: iceServer.Username,
                            credential: iceServer.Password
                        });
                    });
                });
            }

            this.log('Got ICE servers from KVS', 'success', { 
                count: iceServers.length,
                types: iceServers.map(s => s.urls.split(':')[0]).join(', ')
            });

            // Create Signaling Client
            const signalingClient = new window.KVSWebRTC.SignalingClient({
                channelARN: channelArn,
                channelEndpoint: endpointsByProtocol.WSS,
                clientId: clientId,
                role: 'VIEWER',
                region: region,
                credentials: credentials,
                systemClockOffset: kinesisVideoClient.config.systemClockOffset
            });

            this.kvs.signalingClient = signalingClient;

            // Create peer connection with ICE servers
            const configuration = {
                iceServers: iceServers,
                iceTransportPolicy: 'all'
            };
            const peerConnection = new RTCPeerConnection(configuration);
            this.kvs.pc = peerConnection;

            // Add transceiver for receiving video
            peerConnection.addTransceiver('video', { direction: 'recvonly' });
            peerConnection.addTransceiver('audio', { direction: 'recvonly' });

            // Handle incoming tracks
            peerConnection.ontrack = (event) => {
                this.log('KVS track received', 'success', { kind: event.track.kind });
                if (event.streams && event.streams[0]) {
                    this.handleStreamReceived(cameraId, event.streams[0]);
                    this.startStatsCollection(cameraId);
                }
            };

            // Queue ICE candidates until we have remote description
            let candidatesSentCount = 0;
            let pendingIceCandidates = [];
            let canSendCandidates = false;
            
            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    const candidateStr = event.candidate.candidate || '';
                    const typeMatch = candidateStr.match(/typ (\w+)/);
                    const candidateType = typeMatch ? typeMatch[1] : 'unknown';
                    
                    if (canSendCandidates) {
                        // Remote description is set, send immediately
                        candidatesSentCount++;
                        this.log(`➡️ Sending ICE candidate #${candidatesSentCount} to master (${candidateType})`, 'info', {
                            candidate: event.candidate.candidate,
                            sdpMid: event.candidate.sdpMid,
                            sdpMLineIndex: event.candidate.sdpMLineIndex,
                            type: candidateType
                        });
                        signalingClient.sendIceCandidate(event.candidate);
                    } else {
                        // Queue until we get remote description
                        pendingIceCandidates.push(event.candidate);
                        this.log(`Queuing ICE candidate (${candidateType}) - waiting for remote description`, 'info');
                    }
                } else {
                    this.log(`ICE candidate gathering complete - sent ${candidatesSentCount} candidates, ${pendingIceCandidates.length} queued`, 'success');
                }
            };

            // Handle signaling client events
            signalingClient.on('open', async () => {
                this.log('KVS SignalingClient connected', 'success');
                this.kvs.state = 'connected';
                
                // Update UI - show disconnect button
                if (connectBtn) { connectBtn.style.display = 'none'; }
                if (disconnectBtn) { 
                    disconnectBtn.style.display = 'inline-block';
                    disconnectBtn.disabled = false;
                }
                
                // Start keepalive to prevent connection from closing
                this.startKvsKeepalive(signalingClient);
                
                // Create and send offer once connection is open
                try {
                    this.log('Creating SDP offer', 'info');
                    const offer = await peerConnection.createOffer({
                        offerToReceiveVideo: true,
                        offerToReceiveAudio: true
                    });
                    await peerConnection.setLocalDescription(offer);
                    
                    this.log('Sending SDP offer to master', 'info', { 
                        type: offer.type,
                        sdpLength: offer.sdp?.length || 0,
                        sdpPreview: offer.sdp?.substring(0, 100) + '...'
                    });
                    signalingClient.sendSdpOffer(peerConnection.localDescription);
                } catch (err) {
                    this.log('Failed to create/send offer', 'error', { error: err.message });
                }
            });

            signalingClient.on('sdpAnswer', async (answer, remoteClientId) => {
                this.log('Received SDP answer from master', 'success', { 
                    remoteClientId,
                    type: answer.type,
                    sdpLength: answer.sdp?.length || 0,
                    sdpPreview: answer.sdp?.substring(0, 100) + '...'
                });
                await peerConnection.setRemoteDescription(answer);
                
                // Now we can send queued ICE candidates
                canSendCandidates = true;
                if (pendingIceCandidates.length > 0) {
                    this.log(`Sending ${pendingIceCandidates.length} queued ICE candidates`, 'info');
                    pendingIceCandidates.forEach((candidate) => {
                        candidatesSentCount++;
                        const candidateStr = candidate.candidate || '';
                        const typeMatch = candidateStr.match(/typ (\w+)/);
                        const candidateType = typeMatch ? typeMatch[1] : 'unknown';
                        
                        this.log(`➡️ Sending queued ICE candidate #${candidatesSentCount} to master (${candidateType})`, 'info', {
                            candidate: candidate.candidate,
                            sdpMid: candidate.sdpMid,
                            sdpMLineIndex: candidate.sdpMLineIndex,
                            type: candidateType
                        });
                        signalingClient.sendIceCandidate(candidate);
                    });
                    pendingIceCandidates = [];
                }
            });

            let candidatesReceivedCount = 0;
            signalingClient.on('iceCandidate', async (candidate, remoteClientId) => {
                candidatesReceivedCount++;
                const candidateStr = candidate.candidate || '';
                const typeMatch = candidateStr.match(/typ (\w+)/);
                const candidateType = typeMatch ? typeMatch[1] : 'unknown';
                
                this.log(`⬅️ Received ICE candidate #${candidatesReceivedCount} from master (${candidateType})`, 'success', {
                    remoteClientId,
                    candidate: candidate.candidate,
                    sdpMid: candidate.sdpMid,
                    sdpMLineIndex: candidate.sdpMLineIndex,
                    type: candidateType
                });
                
                try {
                    await peerConnection.addIceCandidate(candidate);
                    this.log(`✅ Added remote ICE candidate #${candidatesReceivedCount}`, 'info');
                } catch (err) {
                    this.log(`❌ Failed to add remote ICE candidate #${candidatesReceivedCount}`, 'error', { error: err.message });
                }
            });

            signalingClient.on('close', () => {
                this.log('⚠️ KVS SignalingClient closed by AWS (idle timeout)', 'warning');
                this.stopKvsKeepalive();
                
                // Clear the signaling client reference but keep peer connection alive
                this.kvs.signalingClient = null;
                
                // The peer connection should continue independently
                // Video will keep playing as long as peerConnection state is 'connected'
                const pcState = this.kvs.pc?.connectionState;
                const iceState = this.kvs.pc?.iceConnectionState;
                
                this.log('Peer connection status after signaling close', 'info', {
                    peerConnectionState: pcState,
                    iceConnectionState: iceState,
                    hasActiveStream: this.activeStreams.has(this.kvs.cameraId)
                });
                
                // If peer connection is still good, video continues
                if (pcState === 'connected' || iceState === 'connected' || iceState === 'completed') {
                    this.log('✅ Video stream continues (peer-to-peer connection active)', 'success');
                } else {
                    this.log('❌ Peer connection also failed - cleaning up', 'error');
                    // Only clean up if peer connection is also dead
                    if (this.kvs.state !== 'disconnected') {
                        this.stopKvs();
                    }
                }
            });

            signalingClient.on('error', (error) => {
                this.log('KVS SignalingClient error', 'error', { error: error?.message || error || 'Unknown error' });
            });
            
            // Monitor peer connection state
            peerConnection.onconnectionstatechange = () => {
                const state = peerConnection.connectionState;
                this.log(`KVS peer connection state: ${state}`, 'info');
                
                if (state === 'failed' || state === 'disconnected') {
                    this.log('KVS peer connection lost', 'error');
                    this.stopKvs();
                }
            };

            // Open connection (offer will be sent in 'open' event)
            this.log('Opening KVS SignalingClient connection', 'info');
            signalingClient.open();

        } catch (err) {
            this.log('KVS start failed', 'error', { error: err.message, stack: err.stack });
            const connectBtn = document.getElementById('kvsConnectBtn');
            const disconnectBtn = document.getElementById('kvsDisconnectBtn');
            if (connectBtn) { connectBtn.disabled = false; connectBtn.textContent = 'Connect'; }
            if (disconnectBtn) { disconnectBtn.style.display = 'none'; }
            this.kvs.state = 'disconnected';
        }
    }

    async getKvsCredentialsFromServer(region, channelArn, clientId) {
        // This uses the server to get presigned credentials
        const resp = await fetch('/kvs/presign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ region, channelArn, role: 'VIEWER', clientId, expiresSeconds: 300 })
        });
        if (!resp.ok) throw new Error(`Server credentials failed: ${resp.status}`);
        const data = await resp.json();
        // Server should return credentials object
        return data.credentials || null;
    }

    startKvsKeepalive(signalingClient) {
        // Stop any existing keepalive
        this.stopKvsKeepalive();
        
        // The AWS SDK should handle keepalive internally
        // But we'll monitor the connection health
        this.kvs.keepaliveInterval = setInterval(() => {
            if (this.kvs.state === 'connected') {
                const pcState = this.kvs.pc?.connectionState;
                const iceState = this.kvs.pc?.iceConnectionState;
                this.log('KVS connection health', 'info', { 
                    signalingOpen: !!this.kvs.signalingClient,
                    peerConnectionState: pcState,
                    iceConnectionState: iceState
                });
            }
        }, 30000); // Every 30 seconds
    }

    stopKvsKeepalive() {
        if (this.kvs.keepaliveInterval) {
            clearInterval(this.kvs.keepaliveInterval);
            this.kvs.keepaliveInterval = null;
        }
    }

    async stopKvs() {
        try {
            this.log('Stopping KVS connection', 'info');
            
            // Stop keepalive first
            this.stopKvsKeepalive();
            
            // Mark as disconnected first to prevent 'close' event from retriggering
            this.kvs.state = 'disconnected';
            
            if (this.kvs.signalingClient) {
                try { this.kvs.signalingClient.close(); } catch {}
                this.kvs.signalingClient = null;
            }
            if (this.kvs.pc) {
                this.kvs.pc.close();
                this.kvs.pc = null;
            }
            
            // Update UI - show connect button
            const disconnectBtn = document.getElementById('kvsDisconnectBtn');
            const connectBtn = document.getElementById('kvsConnectBtn');
            if (disconnectBtn) { disconnectBtn.style.display = 'none'; }
            if (connectBtn) { 
                connectBtn.style.display = 'inline-block';
                connectBtn.disabled = false; 
                connectBtn.textContent = 'Connect'; 
            }
            
            // Stop stats for this camera id
            if (this.kvs.cameraId) {
                this.stopStatsCollection(this.kvs.cameraId);
            }
            
            // Remove active stream if exists
            if (this.kvs.cameraId && this.activeStreams.has(this.kvs.cameraId)) {
                this.handleStreamEnded(this.kvs.cameraId);
            }
            
            this.log('KVS disconnected', 'info');
        } catch (e) {
            this.log('KVS stop error', 'error', { error: e.message });
        }
    }

    safeHost(url) {
        try { return new URL(url.replace('wss://','https://')).host; } catch { return '?'; }
    }

    extractRegionFromArn(arn) {
        // ARN format: arn:aws:kinesisvideo:REGION:ACCOUNT:channel/NAME/TIMESTAMP
        // or: arn:aws:kinesisvideo:REGION:ACCOUNT:channel/NAME
        if (!arn) return null;
        const parts = arn.split(':');
        if (parts.length >= 4 && parts[0] === 'arn' && parts[1] === 'aws' && parts[2] === 'kinesisvideo') {
            return parts[3]; // The region is the 4th part (index 3)
        }
        return null;
    }

    initializeWhepUrls() {
        this.addWhepUrl(); // Add first URL entry
    }

    addWhepUrl() {
        const whepId = `whep_${++this.whepUrlCounter}`;
        const whepUrlList = document.getElementById('whepUrlList');

        if (!whepUrlList) return;

        // Create URL entry element
        const urlItem = document.createElement('div');
        urlItem.className = 'whep-url-item';
        urlItem.setAttribute('data-whep-id', whepId);

        urlItem.innerHTML = `
            <input type="text" placeholder="https://your-whep-server/whep" class="whep-url-input">
            <div class="button-group">
                <button class="btn btn-primary btn-sm connect-btn" title="Connect to this WHEP URL">Connect</button>
                            <button class="btn btn-danger btn-sm disconnect-btn" style="display:none;" title="Disconnect this WHEP session">Disconnect</button>
            <button class="btn btn-danger btn-sm cancel-btn" style="display:none;" title="Cancel connection attempt">Cancel</button>
        </div>
        <button class="btn btn-bin btn-icon remove-btn" title="Remove this URL" aria-label="Remove URL">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M9 3h6a1 1 0 0 1 1 1v1h4v2H4V5h4V4a1 1 0 0 1 1-1zm-3 6h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9zm4 2v7h2v-7h-2zm4 0v7h2v-7h-2z"/>
            </svg>
        </button>
        `;

        // Add event listeners
        const connectBtn = urlItem.querySelector('.connect-btn');
        const disconnectBtn = urlItem.querySelector('.disconnect-btn');
        const cancelBtn = urlItem.querySelector('.cancel-btn');
        const removeBtn = urlItem.querySelector('.remove-btn');
        const input = urlItem.querySelector('.whep-url-input');

        connectBtn.addEventListener('click', () => this.startWhepConnection(whepId));
        disconnectBtn.addEventListener('click', () => this.stopWhepConnection(whepId));
        cancelBtn.addEventListener('click', () => this.cancelWhepConnection(whepId));
        removeBtn.addEventListener('click', () => this.removeWhepUrl(whepId));

        whepUrlList.appendChild(urlItem);

        // Initialize connection state
        this.whepConnections.set(whepId, {
            pc: null,
            endpointUrl: '',
            state: 'disconnected',
            abortController: null
        });
    }

    removeWhepUrl(whepId) {
        // Don't allow removing if it's the last one
        if (this.whepConnections.size <= 1) {
            this.log('Cannot remove the last WHEP URL entry', 'warning');
            return;
        }

        // Stop connection if active (this will send DELETE if connected)
        if (this.whepConnections.has(whepId)) {
            this.stopWhepConnection(whepId);
        }

        // Remove from DOM
        const urlItem = document.querySelector(`[data-whep-id="${whepId}"]`);
        if (urlItem) {
            urlItem.remove();
        }

        // Remove from connections map
        this.whepConnections.delete(whepId);
    }

    updateWhepButtonState(whepId, state) {
        const urlItem = document.querySelector(`[data-whep-id="${whepId}"]`);
        if (!urlItem) return;

        const connectBtn = urlItem.querySelector('.connect-btn');
        const disconnectBtn = urlItem.querySelector('.disconnect-btn');
        const cancelBtn = urlItem.querySelector('.cancel-btn');
        const removeBtn = urlItem.querySelector('.remove-btn');

        switch (state) {
            case 'disconnected':
                connectBtn.style.display = 'inline-block';
                connectBtn.disabled = false;
                connectBtn.innerHTML = 'Connect';
                disconnectBtn.style.display = 'none';
                cancelBtn.style.display = 'none';
                removeBtn.disabled = false;
                break;

            case 'connecting':
                connectBtn.style.display = 'inline-block';
                connectBtn.disabled = true;
                connectBtn.innerHTML = '<span class="spinner"></span> Connecting...';
                disconnectBtn.style.display = 'none';
                cancelBtn.style.display = 'inline-block';
                removeBtn.disabled = true;
                break;

            case 'connected':
                connectBtn.style.display = 'none';
                disconnectBtn.style.display = 'inline-block';
                disconnectBtn.disabled = false;
                disconnectBtn.innerHTML = 'Disconnect';
                cancelBtn.style.display = 'none';
                removeBtn.disabled = true;
                break;
        }
    }

    async startWhepConnection(whepId) {
        let connectionTimeout;
        const connection = this.whepConnections.get(whepId);

        try {
            const urlItem = document.querySelector(`[data-whep-id="${whepId}"]`);
            if (!urlItem) return;

            const input = urlItem.querySelector('.whep-url-input');
            const whepUrl = input.value.trim();

            if (!whepUrl) {
                this.log('WHEP URL is required', 'error');
                return;
            }

            if (!connection) return;

            // Set connecting state and update UI
            connection.state = 'connecting';
            connection.endpointUrl = whepUrl;
            this.updateWhepButtonState(whepId, 'connecting');

            // Create AbortController for cancellation
            connection.abortController = new AbortController();

            // Set a timeout for the entire connection process (30 seconds)
            connectionTimeout = setTimeout(() => {
                if (connection.state === 'connecting') {
                    this.log('WHEP connection timeout', 'error', { whepId });
                    if (connection.abortController) {
                        connection.abortController.abort();
                    }
                }
            }, 60000);

            // Setup a dedicated PC for WHEP reception
            connection.pc = this.createWhepPeerConnection(whepId);

            // Check if we should exclude candidates
            const excludeCandidatesCheckbox = document.getElementById('whepExcludeCandidatesCheckbox');
            const excludeCandidates = excludeCandidatesCheckbox ? excludeCandidatesCheckbox.checked : false;

            // Check if we should use proxy mode
            const useProxyCheckbox = document.getElementById('whepUseProxyCheckbox');
            const useProxy = useProxyCheckbox ? useProxyCheckbox.checked : false;

            // Create offer
            const offer = await connection.pc.createOffer({ offerToReceiveVideo: true });
            await connection.pc.setLocalDescription(offer);

            let sdpToSend;
            if (excludeCandidates) {
                // Don't wait for ICE gathering, send SDP without candidates
                const sdpLines = offer.sdp.split('\n');
                const filteredLines = sdpLines.filter(line => !line.startsWith('a=candidate'));
                sdpToSend = filteredLines.join('\n');
                this.log('Sending WHEP offer WITHOUT ICE candidates', 'info', {
                    whepId,
                    sdpLength: sdpToSend.length
                });
            } else {
                // Wait for ICE gathering to complete
                await this.waitForIceGatheringComplete(connection.pc);
                const finalSdp = connection.pc.localDescription;
                sdpToSend = finalSdp.sdp;
                const candidateLines = finalSdp.sdp.split('\n').filter(line => line.startsWith('a=candidate'));
                this.log(`Sending WHEP offer with ${candidateLines.length} ICE candidates`, 'info', {
                    whepId,
                    sdpLength: sdpToSend.length
                });
            }

            if (useProxy) {
                // Use HTTP proxy mode
                this.log('Using HTTP proxy for WHEP', 'info', { whepId, whepUrl });

                // Store that we're using proxy
                connection.proxyUrl = whepUrl;

                // Make request through our server's HTTP proxy endpoint
                const proxyUrl = `${window.location.origin}/whep-proxy`;
                const resp = await fetch(proxyUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/sdp',
                        'Accept': 'application/sdp',
                        'X-Target-URL': whepUrl  // Tell proxy where to forward
                    },
                    body: sdpToSend,
                    signal: connection.abortController.signal
                });

                if (!resp.ok) {
                    const text = await resp.text();
                    throw new Error(`WHEP proxy request failed: ${resp.status} ${resp.statusText} - ${text}`);
                }

                const answerSdp = await resp.text();
                this.log('Received WHEP answer via proxy', 'success', { whepId, sdpLength: answerSdp.length });
                await connection.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

                // Store the endpoint URL from response header if provided
                const locationHeader = resp.headers.get('X-WHEP-Location');
                if (locationHeader) {
                    connection.endpointUrl = locationHeader;
                    this.log('WHEP endpoint URL from proxy', 'info', { whepId, endpointUrl: locationHeader });
                } else {
                    // If no location header, use the original URL as endpoint
                    connection.endpointUrl = whepUrl;
                }
            } else {
                // Direct mode - POST to WHEP endpoint
                const resp = await fetch(whepUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/sdp',
                        'Accept': 'application/sdp'
                    },
                    body: sdpToSend,
                    signal: connection.abortController.signal
                });
                if (!resp.ok) {
                    const text = await resp.text();
                    throw new Error(`WHEP POST failed: ${resp.status} ${resp.statusText} - ${text}`);
                }
                // WHEP session created successfully
                this.log('WHEP session created', 'success', { whepId, endpointUrl: connection.endpointUrl });

                const answerSdp = await resp.text();
                this.log('Received WHEP SDP answer', 'success', { whepId, sdpLength: answerSdp.length });
                await connection.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
            }

            // Clear the connection timeout since we got a response
            if (connectionTimeout) {
                clearTimeout(connectionTimeout);
            }

            // Connection will be marked as 'connected' when ontrack event fires
        } catch (err) {
            // Check if it's an abort error
            if (err.name === 'AbortError') {
                this.log('WHEP connection cancelled by user', 'info', { whepId });
            } else {
                this.log('WHEP start failed', 'error', { whepId, error: err.message });
            }

            // Clean up connection if it exists
            if (connection) {
                if (connection.pc) {
                    connection.pc.close();
                    connection.pc = null;
                }

                // Clear abort controller
                connection.abortController = null;

                // Reset to disconnected state on error
                connection.state = 'disconnected';
                this.updateWhepButtonState(whepId, 'disconnected');
            }

            // Clear the connection timeout
            if (connectionTimeout) {
                clearTimeout(connectionTimeout);
            }
        }
    }

    cancelWhepConnection(whepId) {
        const connection = this.whepConnections.get(whepId);
        if (!connection) return;

        // Cancel the fetch request if it's in progress
        if (connection.abortController) {
            connection.abortController.abort();
            connection.abortController = null;
        }

        // Close the peer connection if it exists
        if (connection.pc) {
            connection.pc.close();
            connection.pc = null;
        }

        // Stop stats collection if it was started
        this.stopStatsCollection(whepId);

        // Reset state
        connection.state = 'disconnected';
        connection.endpointUrl = '';
        this.updateWhepButtonState(whepId, 'disconnected');

        this.log('WHEP connection cancelled', 'info', { whepId });
    }

    async stopWhepConnection(whepId) {
        const connection = this.whepConnections.get(whepId);
        if (!connection) return;

        // Send DELETE to same endpoint URL to terminate WHEP session
        if (connection.endpointUrl) {
            try {
                // Check if we should use proxy
                const useProxyCheckbox = document.getElementById('whepUseProxyCheckbox');
                const useProxy = useProxyCheckbox ? useProxyCheckbox.checked : false;

                let deleteUrl = connection.endpointUrl;
                let deleteOptions = { method: 'DELETE' };

                if (useProxy && connection.proxyUrl) {
                    // Use proxy for DELETE
                    deleteUrl = `${window.location.origin}/whep-proxy`;
                    deleteOptions.headers = {
                        'X-Target-URL': connection.endpointUrl
                    };
                }

                const resp = await fetch(deleteUrl, deleteOptions);
                if (resp.ok) {
                    this.log('WHEP session terminated', 'success', { whepId, endpointUrl: connection.endpointUrl });
                } else {
                    this.log('WHEP DELETE failed', 'warning', { whepId, status: resp.status, endpointUrl: connection.endpointUrl });
                }
            } catch (err) {
                this.log('WHEP DELETE error', 'error', { whepId, error: err.message, endpointUrl: connection.endpointUrl });
            }
            connection.endpointUrl = '';
        }

        if (connection.pc) {
            connection.pc.close();
            connection.pc = null;
            this.log('WHEP peer connection closed', 'info', { whepId });
        }

        // Set disconnected state and update UI
        connection.state = 'disconnected';
        this.updateWhepButtonState(whepId, 'disconnected');

        // Stop stats collection
        this.stopStatsCollection(whepId);

        // Remove any stream elements associated with this WHEP connection
        if (this.activeStreams.has(whepId)) {
            this.handleStreamEnded(whepId);
        }
    }

    createWhepPeerConnection(whepId) {
        const configuration = {
            iceServers: CONFIG.ICE_SERVERS || []
        };
        const pc = new RTCPeerConnection(configuration);
        pc.addTransceiver('video', { direction: 'recvonly' });

        pc.ontrack = (event) => {
            const stream = event.streams[0];
            this.handleStreamReceived(whepId, stream);
            // Mark as connected when stream is received
            const connection = this.whepConnections.get(whepId);
            if (connection) {
                connection.state = 'connected';
                this.updateWhepButtonState(whepId, 'connected');
            }
            // Start stats collection for WHEP connection
            this.startStatsCollection(whepId);
        };
        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            this.log(`WHEP connection state changed: ${state}`, 'info', { whepId, state });

            // Update the stream status indicator
            const streamElement = this.streamElements.get(whepId);
            if (streamElement) {
                const status = streamElement.querySelector('.stream-status');
                if (status) {
                    status.className = `stream-status ${state === 'connected' ? 'connected' : 'disconnected'}`;
                }
            }

            // Handle failed or disconnected states
            if (state === 'failed' || state === 'disconnected') {
                const connection = this.whepConnections.get(whepId);
                if (connection && connection.state !== 'disconnected') {
                    this.log(`WHEP connection ${state}`, 'error', { whepId });

                    // Update state and UI
                    connection.state = 'disconnected';
                    this.updateWhepButtonState(whepId, 'disconnected');

                    // Stop stats collection
                    this.stopStatsCollection(whepId);

                    // Clean up if stream was active
                    if (this.activeStreams.has(whepId)) {
                        this.handleStreamEnded(whepId);
                    }
                }
            }
        };
        pc.oniceconnectionstatechange = () => {
            if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                this.logIceStatistics(whepId, pc);
            }
        };
        return pc;
    }

    // ======================
    // WHIP (Browser as Receiver)
    // ======================

    initializeWhipCameras() {
        this.addWhipCamera(); // Add first camera entry
    }

    addWhipCamera() {
        const whipCameraList = document.getElementById('whipCameraList');
        if (!whipCameraList) return;

        const entryId = `whip_entry_${++this.whipUrlCounter}`;

        // Create camera entry element
        const cameraItem = document.createElement('div');
        cameraItem.className = 'whep-url-item';
        cameraItem.setAttribute('data-whip-entry-id', entryId);
        cameraItem.style.display = 'grid';
        cameraItem.style.gridTemplateColumns = '1fr';
        cameraItem.style.gap = '8px';

        cameraItem.innerHTML = `
            <div style="display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center;">
                <input type="text" placeholder="http://server:port/camera-001/whip" class="whep-url-input whip-endpoint-input" 
                       title="Full WHIP endpoint URL where camera will POST">
                <div class="button-group">
                    <button class="btn btn-primary btn-sm connect-btn" title="Start listening for WHIP connections">Connect</button>
                    <button class="btn btn-danger btn-sm disconnect-btn" style="display:none;" title="Disconnect this WHIP session">Disconnect</button>
                </div>
                <button class="btn btn-bin btn-icon remove-btn" title="Remove this endpoint" aria-label="Remove endpoint">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M9 3h6a1 1 0 0 1 1 1v1h4v2H4V5h4V4a1 1 0 0 1 1-1zm-3 6h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9zm4 2v7h2v-7h-2zm4 0v7h2v-7h-2z"/>
                    </svg>
                </button>
            </div>
            <details style="margin-top: 4px;">
                <summary style="cursor:pointer; color:#4a5568; font-weight: 600; font-size: 0.85rem; padding: 8px 0;">WHIP Server</summary>
                <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
                    <input type="text" placeholder="URL (optional metadata)" class="whep-url-input whip-url-input" 
                           style="font-size: 0.85rem; padding: 6px 8px;"
                           title="Optional URL metadata to send to camera">
                    <input type="text" placeholder="Token (optional auth)" class="whep-url-input whip-token-input" 
                           style="font-size: 0.85rem; padding: 6px 8px;"
                           title="Optional auth token to send to camera">
                </div>
            </details>
        `;

        // Add event listeners
        const connectBtn = cameraItem.querySelector('.connect-btn');
        const disconnectBtn = cameraItem.querySelector('.disconnect-btn');
        const removeBtn = cameraItem.querySelector('.remove-btn');
        const endpointInput = cameraItem.querySelector('.whip-endpoint-input');
        const urlInput = cameraItem.querySelector('.whip-url-input');
        const tokenInput = cameraItem.querySelector('.whip-token-input');

        connectBtn.addEventListener('click', () => {
            const endpoint = endpointInput.value.trim();
            if (!endpoint) {
                this.log('WHIP endpoint URL is required', 'error');
                return;
            }
            const url = urlInput.value.trim();
            const token = tokenInput.value.trim();
            this.startWhipListen(entryId, endpoint, url, token);
        });
        
        disconnectBtn.addEventListener('click', () => {
            this.stopWhipSession(entryId);
        });
        
        removeBtn.addEventListener('click', () => this.removeWhipCamera(entryId));

        whipCameraList.appendChild(cameraItem);
    }

    removeWhipCamera(entryId) {
        const whipCameraList = document.getElementById('whipCameraList');
        if (!whipCameraList) return;

        // Don't allow removing if it's the last one
        const items = whipCameraList.querySelectorAll('[data-whip-entry-id]');
        if (items.length <= 1) {
            this.log('Cannot remove the last WHIP endpoint entry', 'warning');
            return;
        }

        // Stop session if active
        if (this.whipConnections.has(entryId)) {
            this.stopWhipSession(entryId);
        }

        // Remove from DOM
        const cameraItem = document.querySelector(`[data-whip-entry-id="${entryId}"]`);
        if (cameraItem) {
            cameraItem.remove();
        }
    }

    updateWhipButtonState(entryId, state) {
        const targetItem = document.querySelector(`[data-whip-entry-id="${entryId}"]`);
        if (!targetItem) return;

        const connectBtn = targetItem.querySelector('.connect-btn');
        const disconnectBtn = targetItem.querySelector('.disconnect-btn');
        const removeBtn = targetItem.querySelector('.remove-btn');
        const endpointInput = targetItem.querySelector('.whip-endpoint-input');
        const urlInput = targetItem.querySelector('.whip-url-input');
        const tokenInput = targetItem.querySelector('.whip-token-input');

        switch (state) {
            case 'disconnected':
                connectBtn.style.display = 'inline-block';
                connectBtn.disabled = false;
                connectBtn.textContent = 'Connect';
                disconnectBtn.style.display = 'none';
                removeBtn.disabled = false;
                if (endpointInput) endpointInput.disabled = false;
                if (urlInput) urlInput.disabled = false;
                if (tokenInput) tokenInput.disabled = false;
                break;
            case 'listening':
                connectBtn.style.display = 'inline-block';
                connectBtn.disabled = true;
                connectBtn.textContent = 'Connecting...';
                disconnectBtn.style.display = 'none';
                removeBtn.disabled = true;
                if (endpointInput) endpointInput.disabled = true;
                if (urlInput) urlInput.disabled = true;
                if (tokenInput) tokenInput.disabled = true;
                break;
            case 'connected':
                connectBtn.style.display = 'none';
                disconnectBtn.style.display = 'inline-block';
                disconnectBtn.disabled = false;
                removeBtn.disabled = true;
                if (endpointInput) endpointInput.disabled = true;
                if (urlInput) urlInput.disabled = true;
                if (tokenInput) tokenInput.disabled = true;
                break;
        }
    }

    startWhipListen(entryId, endpoint, url, token) {
        if (this.whipConnections.has(entryId)) {
            this.log('Already listening on this endpoint', 'warning', { entryId });
            return;
        }

        this.log('Starting WHIP listening mode', 'info', { entryId, endpoint, url, token: token ? '***' : 'none' });

        // Initialize connection state
        const connection = {
            pc: null,
            endpointUrl: endpoint,
            state: 'listening',
            entryId: entryId,
            url: url,
            token: token
        };
        
        this.whipConnections.set(entryId, connection);
        this.updateWhipButtonState(entryId, 'listening');

        // Notify server that we're ready to receive WHIP connections on this endpoint
        this.sendMessage({
            type: 'whip-listen',
            entryId: entryId,
            endpointUrl: endpoint,
            url: url,
            token: token
        });
    }

    handleWhipOffer(entryId, offer, url, token) {
        this.log('Received WHIP offer from camera', 'info', { entryId, url, token });

        const connection = this.whipConnections.get(entryId);
        if (!connection || connection.state === 'disconnected') {
            this.log('WHIP connection not in listening state', 'error', { entryId });
            return Promise.reject(new Error('Not listening'));
        }

        // Create peer connection for receiving
        connection.pc = this.createWhipPeerConnection(entryId);

        // Set remote description (offer from camera)
        return connection.pc.setRemoteDescription(new RTCSessionDescription(offer))
            .then(() => {
                this.log('Remote description set for WHIP', 'success', { entryId });
                return connection.pc.createAnswer();
            })
            .then((answer) => {
                this.log('Answer created for WHIP', 'info', { entryId });
                return connection.pc.setLocalDescription(answer);
            })
            .then(() => {
                this.log('Local description set for WHIP, waiting for ICE gathering...', 'info', { entryId });
                
                // Wait for ICE gathering to complete before sending answer
                return this.waitForIceGatheringComplete(connection.pc);
            })
            .then(() => {
                this.log('ICE gathering completed for WHIP', 'success', { entryId });
                
                const candidateLines = connection.pc.localDescription.sdp.split('\n').filter(line => line.startsWith('a=candidate'));
                this.log(`Sending WHIP answer with ${candidateLines.length} ICE candidates`, 'info', { entryId });
                
                // Update state
                connection.state = 'connected';
                this.updateWhipButtonState(entryId, 'connected');

                // Return the answer with all candidates to be sent back to camera
                return connection.pc.localDescription;
            })
            .catch((error) => {
                this.log('Error handling WHIP offer', 'error', { entryId, error: error.message });
                throw error;
            });
    }

    stopWhipSession(entryId) {
        const connection = this.whipConnections.get(entryId);
        if (!connection) return;

        this.log('Stopping WHIP session', 'info', { entryId });

        // Close peer connection
        if (connection.pc) {
            connection.pc.close();
            connection.pc = null;
            this.log('WHIP peer connection closed', 'info', { entryId });
        }

        // Set disconnected state and update UI
        connection.state = 'disconnected';
        this.updateWhipButtonState(entryId, 'disconnected');

        // Stop stats collection
        this.stopStatsCollection(entryId);

        // Remove stream display
        if (this.activeStreams.has(entryId)) {
            this.handleStreamEnded(entryId);
        }

        // Notify server to unregister endpoint
        this.sendMessage({
            type: 'whip-stop',
            entryId: entryId,
            endpointUrl: connection.endpointUrl
        });

        // Remove from connections map
        this.whipConnections.delete(entryId);
    }

    createWhipPeerConnection(entryId) {
        const configuration = {
            iceServers: CONFIG.ICE_SERVERS || []
        };
        const pc = new RTCPeerConnection(configuration);
        pc.addTransceiver('video', { direction: 'recvonly' });

        pc.ontrack = (event) => {
            const stream = event.streams[0];
            this.handleStreamReceived(entryId, stream);
            // Mark as connected when stream is received
            const connection = this.whipConnections.get(entryId);
            if (connection) {
                connection.state = 'connected';
                this.updateWhipButtonState(entryId, 'connected');
            }
            // Start stats collection for WHIP connection
            this.startStatsCollection(entryId);
        };

        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            this.log(`WHIP connection state changed: ${state}`, 'info', { entryId, state });

            // Update the stream status indicator
            const streamElement = this.streamElements.get(entryId);
            if (streamElement) {
                const status = streamElement.querySelector('.stream-status');
                if (status) {
                    status.className = `stream-status ${state === 'connected' ? 'connected' : 'disconnected'}`;
                }
            }

            // Handle failed or disconnected states
            if (state === 'failed' || state === 'disconnected') {
                const connection = this.whipConnections.get(entryId);
                if (connection && connection.state !== 'disconnected') {
                    this.log(`WHIP connection ${state}`, 'error', { entryId });

                    // Update state and UI
                    connection.state = 'disconnected';
                    this.updateWhipButtonState(entryId, 'disconnected');

                    // Stop stats collection
                    this.stopStatsCollection(entryId);

                    // Clean up if stream was active
                    if (this.activeStreams.has(entryId)) {
                        this.handleStreamEnded(entryId);
                    }
                }
            }
        };

        pc.oniceconnectionstatechange = () => {
            if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                this.logIceStatistics(entryId, pc);
            }
        };

        // No trickle ICE - we wait for all candidates before sending answer
        // ICE gathering happens after setLocalDescription, we'll wait for it to complete

        return pc;
    }

    // Wait until ICE gathering is complete to ensure localDescription contains candidates
    waitForIceGatheringComplete(peerConnection) {
        return new Promise((resolve) => {
            if (!peerConnection) return resolve();
            if (peerConnection.iceGatheringState === 'complete') {
                return resolve();
            }

            let gatheringTimeout;
            const checkState = () => {
                this.log(`ICE gathering state: ${peerConnection.iceGatheringState}`, 'info');
                if (peerConnection.iceGatheringState === 'complete') {
                    peerConnection.removeEventListener('icegatheringstatechange', checkState);
                    clearTimeout(gatheringTimeout);
                    resolve();
                }
            };

            peerConnection.addEventListener('icegatheringstatechange', checkState);

            // Add timeout as a safety net (10 seconds should be enough for gathering)
            gatheringTimeout = setTimeout(() => {
                this.log('ICE gathering timeout - proceeding with available candidates', 'warning');
                peerConnection.removeEventListener('icegatheringstatechange', checkState);
                resolve();
            }, 10000);
        });
    }

    initializeWebSocket() {
        // Close existing connection if any
        if (this.socket) {
            this.socket.close();
        }

        // Use configured WebSocket URL
        const wsUrl = CONFIG.WEBSOCKET.URL;
        this.socket = new WebSocket(wsUrl);

        this.socket.onopen = () => {
            this.log('WebSocket connection established', 'success', {
                url: wsUrl,
                readyState: this.socket.readyState,
                reconnectAttempt: this.reconnectAttempts,
                timestamp: new Date().toISOString()
            });

            this.updateConnectionStatus(true);
            this.reconnectAttempts = 0; // Reset reconnect attempts on successful connection

            // Start ping/pong mechanism
            this.startPingPong();

            // Identify as web client
            this.sendMessage({
                type: 'identify',
                clientType: 'web'
            });
        };

        this.socket.onclose = (event) => {
            this.log('WebSocket connection closed - affecting all cameras', 'error', {
                code: event.code,
                reason: event.reason,
                wasClean: event.wasClean,
                activeCameras: this.cameras.size,
                activeStreams: this.activeStreams.size,
                reconnectAttempts: this.reconnectAttempts,
                timestamp: new Date().toISOString()
            });

            this.updateConnectionStatus(false);
            this.stopPingPong();
            this.handleGlobalDisconnection();

            // Attempt to reconnect if not a clean close and under max attempts
            if (!event.wasClean && this.reconnectAttempts < this.maxReconnectAttempts) {
                this.scheduleReconnect();
            }
        };

        this.socket.onerror = (error) => {
            this.log('WebSocket error occurred', 'error', {
                error: error.message || 'Unknown error',
                reconnectAttempts: this.reconnectAttempts,
                timestamp: new Date().toISOString()
            });
        };

        this.socket.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);

                // Handle ping/pong messages
                if (message.type === 'ping') {
                    this.sendMessage({ type: 'pong', timestamp: message.timestamp });
                    this.lastPongTime = Date.now();
                    this.log('Ping received, sent pong', 'info');
                    return;
                }

                if (message.type === 'pong') {
                    this.lastPongTime = Date.now();
                    this.log('Pong received from server', 'info');
                    return;
                }

                this.handleMessage(message);
            } catch (error) {
                this.log('Failed to parse WebSocket message', 'error', {
                    error: error.message,
                    rawData: event.data,
                    timestamp: new Date().toISOString()
                });
            }
        };
    }

    setupPeerConnection(cameraId) {
        const configuration = {
            iceServers: CONFIG.ICE_SERVERS || [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ],
            // Gather all candidate types for richer connectivity
            iceCandidatePoolSize: 4
        };

        this.log(`Setting up peer connection for camera ${cameraId}`, 'info', {
            cameraId,
            configuration,
            timestamp: new Date().toISOString()
        });

        const peerConnection = new RTCPeerConnection(configuration);

        // Log available network interfaces (for debugging candidate gathering)
        if (peerConnection.getStats) {
            peerConnection.getStats().then(stats => {
                const networkInfo = [];
                stats.forEach(report => {
                    if (report.type === 'local-candidate' || report.type === 'host') {
                        networkInfo.push({
                            type: report.type,
                            ip: report.ip || report.address,
                            port: report.port,
                            protocol: report.protocol,
                            candidateType: report.candidateType
                        });
                    }
                });
                if (networkInfo.length > 0) {
                    this.log(`Available network interfaces for camera ${cameraId}`, 'info', {
                        cameraId,
                        interfaces: networkInfo,
                        timestamp: new Date().toISOString()
                    });
                }
            }).catch(err => {
                this.log(`Could not get network stats: ${err.message}`, 'warning');
            });
        }

        // Add video transceiver with H.265 codec preference
        const transceiver = peerConnection.addTransceiver('video', { direction: 'recvonly' });

        // Set codec preferences to prioritize H.265
        if (transceiver && transceiver.sender && transceiver.sender.getCapabilities) {
            const capabilities = transceiver.sender.getCapabilities();
            if (capabilities && capabilities.codecs) {
                this.log(`Available codecs for camera ${cameraId}`, 'info', {
                    cameraId,
                    totalCodecs: capabilities.codecs.length,
                    allCodecs: capabilities.codecs.map(c => ({
                        mimeType: c.mimeType,
                        clockRate: c.clockRate,
                        channels: c.channels,
                        sdpFmtpLine: c.sdpFmtpLine
                    })),
                    timestamp: new Date().toISOString()
                });

                // Filter and reorder codecs to prioritize H.265
                const h265Codecs = capabilities.codecs.filter(codec =>
                    codec.mimeType.toLowerCase().includes('h265') ||
                    codec.mimeType.toLowerCase().includes('hevc')
                );
                const otherCodecs = capabilities.codecs.filter(codec =>
                    !codec.mimeType.toLowerCase().includes('h265') &&
                    !codec.mimeType.toLowerCase().includes('hevc')
                );

                // Put H.265 codecs first
                const preferredCodecs = [...h265Codecs, ...otherCodecs];

                this.log(`H.265 codec preference setup for camera ${cameraId}`, 'info', {
                    cameraId,
                    totalCodecs: capabilities.codecs.length,
                    h265CodecsFound: h265Codecs.length,
                    h265CodecDetails: h265Codecs.map(c => ({
                        mimeType: c.mimeType,
                        clockRate: c.clockRate,
                        sdpFmtpLine: c.sdpFmtpLine
                    })),
                    otherCodecsCount: otherCodecs.length,
                    preferredCodecOrder: preferredCodecs.map(c => c.mimeType),
                    timestamp: new Date().toISOString()
                });

                // Set the codec preferences
                transceiver.setCodecPreferences(preferredCodecs);

                this.log(`Codec preferences set for camera ${cameraId}`, 'success', {
                    cameraId,
                    h265Prioritized: h265Codecs.length > 0,
                    totalPreferredCodecs: preferredCodecs.length,
                    timestamp: new Date().toISOString()
                });
            } else {
                this.log(`No codec capabilities available for camera ${cameraId}`, 'warning', {
                    cameraId,
                    hasCapabilities: !!capabilities,
                    hasCodecs: capabilities ? !!capabilities.codecs : false,
                    timestamp: new Date().toISOString()
                });
            }
        } else {
            this.log(`Cannot set codec preferences for camera ${cameraId} - API not available`, 'warning', {
                cameraId,
                hasTransceiver: !!transceiver,
                hasSender: transceiver ? !!transceiver.sender : false,
                hasGetCapabilities: transceiver && transceiver.sender ? !!transceiver.sender.getCapabilities : false,
                timestamp: new Date().toISOString()
            });
        }

        // Track ICE candidates for debugging
        let candidateCount = 0;
        const candidateTypes = { host: 0, srflx: 0, relay: 0, prflx: 0 };

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                candidateCount++;

                // Parse candidate type
                const candidateStr = event.candidate.candidate || '';
                const typeMatch = candidateStr.match(/typ (\w+)/);
                const type = typeMatch ? typeMatch[1] : 'unknown';
                if (candidateTypes.hasOwnProperty(type)) {
                    candidateTypes[type]++;
                }

                // Check if it's mDNS
                const isMdns = candidateStr.includes('.local');

                this.log(`ICE candidate #${candidateCount} generated for camera ${cameraId}`, 'info', {
                    cameraId,
                    candidateNumber: candidateCount,
                    type: type,
                    isMdns: isMdns,
                    candidate: event.candidate.candidate,
                    sdpMLineIndex: event.candidate.sdpMLineIndex,
                    sdpMid: event.candidate.sdpMid,
                    timestamp: new Date().toISOString()
                });

                if (this.useTrickleIce) {
                    this.sendMessage({
                        type: 'ice-candidate',
                        cameraId: cameraId,
                        candidate: event.candidate
                    });
                }
            } else {
                // Gathering complete
                this.log(`ICE candidate gathering completed for camera ${cameraId}`, 'info', {
                    cameraId,
                    totalCandidates: candidateCount,
                    candidateTypes: candidateTypes,
                    iceGatheringState: peerConnection.iceGatheringState,
                    timestamp: new Date().toISOString()
                });

                if (!this.useTrickleIce) {
                    // Non-trickle: send final SDP if not already sent
                    if (!this.nonTrickleSent.has(cameraId)) {
                        this.log(`Sending non-trickle SDP for camera ${cameraId}`, 'info', { cameraId });
                        const pc = this.peerConnections.get(cameraId);
                        if (pc && pc.localDescription) {
                            if (pc.localDescription.type === 'offer') {
                                this.sendMessage({ type: 'offer', cameraId, offer: pc.localDescription });
                            } else if (pc.localDescription.type === 'answer') {
                                this.sendMessage({ type: 'answer', cameraId, answer: pc.localDescription });
                            }
                            this.nonTrickleSent.add(cameraId);
                        }
                    }
                }
            }
        };

        peerConnection.ontrack = (event) => {
            this.log(`Track received from camera ${cameraId}`, 'success', {
                cameraId,
                streamId: event.streams[0].id,
                trackId: event.track.id,
                trackKind: event.track.kind,
                trackLabel: event.track.label,
                trackEnabled: event.track.enabled,
                trackReadyState: event.track.readyState,
                timestamp: new Date().toISOString()
            });

            const stream = event.streams[0];
            this.handleStreamReceived(cameraId, stream);
        };

        peerConnection.onconnectionstatechange = () => {
            const state = peerConnection.connectionState;
            this.log(`Connection state changed for camera ${cameraId}`, 'info', {
                cameraId,
                connectionState: state,
                timestamp: new Date().toISOString()
            });

            this.updateCameraConnectionState(cameraId, state);

            if (state === 'connected') {
                this.startStatsCollection(cameraId);
            } else if (state === 'disconnected' || state === 'failed') {
                // Only handle automatic disconnections, not manual hang-ups
                if (this.peerConnections.has(cameraId) && !this.manualHangups.has(cameraId)) {
                    this.log(`Automatic disconnection detected for camera ${cameraId}`, 'warning', {
                        cameraId,
                        connectionState: state,
                        timestamp: new Date().toISOString()
                    });
                    this.stopStatsCollection(cameraId);
                    this.handleStreamEnded(cameraId);
                }
            }
        };

        peerConnection.oniceconnectionstatechange = () => {
            const state = peerConnection.iceConnectionState;
            this.log(`ICE connection state changed for camera ${cameraId}`, 'info', {
                cameraId,
                iceConnectionState: state,
                timestamp: new Date().toISOString()
            });

            if (state === 'connected' || state === 'completed') {
                this.logIceStatistics(cameraId, peerConnection);
            }
        };

        peerConnection.onicegatheringstatechange = () => {
            this.log(`ICE gathering state changed for camera ${cameraId}`, 'info', {
                cameraId,
                iceGatheringState: peerConnection.iceGatheringState,
                timestamp: new Date().toISOString()
            });
        };

        peerConnection.onsignalingstatechange = () => {
            this.log(`Signaling state changed for camera ${cameraId}`, 'info', {
                cameraId,
                signalingState: peerConnection.signalingState,
                timestamp: new Date().toISOString()
            });
        };

        this.peerConnections.set(cameraId, peerConnection);
        return peerConnection;
    }

    handleMessage(message) {
        this.log(`Message received: ${message.type}`, 'info', {
            messageType: message.type,
            cameraId: message.cameraId || 'N/A',
            fullMessage: JSON.stringify(message),
            timestamp: new Date().toISOString()
        });

        switch (message.type) {
            case 'register-camera':
                this.handleCameraRegistration(message.cameraId);
                break;
            case 'unregister-camera':
                this.handleCameraUnregistration(message.cameraId);
                break;
            case 'camera-disconnected':
                this.handleCameraDisconnection(message.cameraId);
                break;
            case 'offer':
                this.handleOffer(message.cameraId, message.offer);
                break;
            case 'answer':
                this.handleAnswer(message.cameraId, message.answer);
                break;
            case 'ice-candidate':
                this.handleIceCandidate(message.cameraId, message.candidate);
                break;
            case 'ice-servers':
                this.handleIceServers(message.iceServers);
                break;
            case 'whip-offer':
                this.handleWhipOfferMessage(message);
                break;
            case 'whip-delete':
                this.handleWhipDeleteMessage(message);
                break;
            default:
                this.log(`Unknown message type received`, 'warning', {
                    messageType: message.type,
                    timestamp: new Date().toISOString()
                });
        }
    }

    async handleWhipOfferMessage(message) {
        const { entryId, offer, url, token, requestId } = message;
        
        this.log('Received WHIP offer message from server', 'info', { entryId, url, token, requestId });

        try {
            const answer = await this.handleWhipOffer(entryId, offer, url, token);
            
            // Send answer back to server
            this.sendMessage({
                type: 'whip-answer',
                entryId: entryId,
                answer: answer,
                requestId: requestId
            });
            
            this.log('Sent WHIP answer back to server', 'success', { entryId, requestId });
        } catch (error) {
            this.log('Failed to handle WHIP offer', 'error', { entryId, error: error.message });
            
            // Send error back to server
            this.sendMessage({
                type: 'whip-error',
                entryId: entryId,
                error: error.message,
                requestId: requestId
            });
        }
    }

    handleWhipDeleteMessage(message) {
        const { entryId } = message;
        
        this.log('Received WHIP delete from camera', 'info', { entryId });
        
        // Stop the WHIP session
        this.stopWhipSession(entryId);
    }

    handleCameraRegistration(cameraId) {
        if (!this.cameras.has(cameraId)) {
            this.cameras.set(cameraId, {
                id: cameraId,
                connected: true,
                streaming: false,
                registeredAt: new Date().toISOString()
            });
            // Clear any previous non-trickle send state for this camera upon registration
            this.nonTrickleSent.delete(cameraId);

            this.log(`Camera registered successfully`, 'success', {
                cameraId,
                totalCameras: this.cameras.size,
                timestamp: new Date().toISOString()
            });

            this.updateCameraList();
            this.updateGlobalStats();
        }
    }

    handleCameraUnregistration(cameraId) {
        if (this.cameras.has(cameraId)) {
            const camera = this.cameras.get(cameraId);

            this.log(`Camera unregistered`, 'info', {
                cameraId,
                wasStreaming: camera.streaming,
                allCameras: Array.from(this.cameras.keys()),
                activeStreams: Array.from(this.activeStreams),
                timestamp: new Date().toISOString()
            });

            // If camera is streaming, end the stream
            if (camera.streaming) {
                this.handleStreamEnded(cameraId);
            }

            // Clean up any peer connections
            if (this.peerConnections.has(cameraId)) {
                const pc = this.peerConnections.get(cameraId);
                pc.close();
                this.peerConnections.delete(cameraId);
            }

            // Remove the camera from the list
            this.cameras.delete(cameraId);

            // Clear any non-trickle send state
            this.nonTrickleSent.delete(cameraId);

            // Clear any manual hangup flags
            this.manualHangups.delete(cameraId);

            // Update UI
            this.updateCameraList();
            this.updateGlobalStats();
        }
    }

    handleCameraDisconnection(cameraId) {
        if (this.cameras.has(cameraId)) {
            this.log(`Camera disconnected`, 'warning', {
                cameraId,
                wasStreaming: this.cameras.get(cameraId).streaming,
                allCameras: Array.from(this.cameras.keys()),
                activeStreams: Array.from(this.activeStreams),
                isManualHangup: this.manualHangups.has(cameraId),
                timestamp: new Date().toISOString()
            });

            this.cameras.delete(cameraId);
            this.handleStreamEnded(cameraId);
            this.updateCameraList();
            this.updateGlobalStats();
        }
    }

    handleOffer(cameraId, offer) {
        // Log offer details and check for H.265 codecs in received SDP
        const sdpLines = offer.sdp.split('\n');
        const h265Lines = sdpLines.filter(line =>
            line.toLowerCase().includes('h265') ||
            line.toLowerCase().includes('hevc')
        );
        const videoCodecLines = sdpLines.filter(line =>
            line.startsWith('a=rtpmap:') && line.includes('H265') ||
            line.startsWith('a=rtpmap:') && line.includes('HEVC')
        );

        this.log(`Offer received from camera ${cameraId}`, 'info', {
            cameraId,
            sdpType: offer.type,
            sdpLength: offer.sdp.length,
            h265LinesFound: h265Lines.length,
            h265Lines: h265Lines,
            videoCodecLines: videoCodecLines,
            timestamp: new Date().toISOString()
        });

        const peerConnection = this.peerConnections.get(cameraId) || this.setupPeerConnection(cameraId);

        peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
            .then(() => {
                this.log(`Remote description set for camera ${cameraId}`, 'success', {
                    cameraId,
                    timestamp: new Date().toISOString()
                });
                return peerConnection.createAnswer();
            })
            .then((answer) => {
                this.log(`Answer created for camera ${cameraId}`, 'info', {
                    cameraId,
                    sdpType: answer.type,
                    sdpLength: answer.sdp.length,
                    timestamp: new Date().toISOString()
                });
                return peerConnection.setLocalDescription(answer);
            })
            .then(async () => {
                this.log(`Local description set for camera ${cameraId}`, 'success', {
                    cameraId,
                    timestamp: new Date().toISOString()
                });
                if (this.useTrickleIce) {
                    this.sendMessage({ type: 'answer', cameraId: cameraId, answer: peerConnection.localDescription });
                } else {
                    await this.waitForIceGatheringComplete(peerConnection);
                    if (!this.nonTrickleSent.has(cameraId)) {
                        this.sendMessage({ type: 'answer', cameraId: cameraId, answer: peerConnection.localDescription });
                        this.nonTrickleSent.add(cameraId);
                    }
                }
            })
            .catch((error) => {
                this.log(`Error handling offer from camera ${cameraId}`, 'error', {
                    cameraId,
                    error: error.message,
                    stack: error.stack,
                    timestamp: new Date().toISOString()
                });
            });
    }

    handleAnswer(cameraId, answer) {
        this.log(`Answer received from camera ${cameraId}`, 'info', {
            cameraId,
            sdpType: answer.type,
            sdpLength: answer.sdp.length,
            timestamp: new Date().toISOString()
        });

        const peerConnection = this.peerConnections.get(cameraId);
        if (peerConnection) {
            peerConnection.setRemoteDescription(new RTCSessionDescription(answer))
                .then(() => {
                    this.log(`Remote description (answer) set for camera ${cameraId}`, 'success', {
                        cameraId,
                        timestamp: new Date().toISOString()
                    });
                })
                .catch((error) => {
                    this.log(`Error setting remote description for camera ${cameraId}`, 'error', {
                        cameraId,
                        error: error.message,
                        timestamp: new Date().toISOString()
                    });
                });
        }
    }

    handleIceCandidate(cameraId, candidate) {
        this.log(`ICE candidate received from camera ${cameraId}`, 'info', {
            cameraId,
            candidate: candidate.candidate,
            sdpMLineIndex: candidate.sdpMLineIndex,
            timestamp: new Date().toISOString()
        });

        const peerConnection = this.peerConnections.get(cameraId);
        if (peerConnection) {
            peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
                .catch((error) => {
                    this.log(`Error adding ICE candidate for camera ${cameraId}`, 'error', {
                        cameraId,
                        error: error.message,
                        timestamp: new Date().toISOString()
                    });
                });
        }
    }

    handleIceServers(iceServers) {
        this.log(`ICE servers configuration received`, 'info', {
            serverCount: iceServers.length,
            servers: iceServers,
            timestamp: new Date().toISOString()
        });

        // Update the ICE servers configuration
        if (iceServers && iceServers.length > 0) {
            CONFIG.ICE_SERVERS = iceServers;
            this.log('ICE servers configuration updated', 'success');
        }
    }

    handleStreamReceived(cameraId, stream, isOutgoing = false) {
        const streamType = isOutgoing ? 'outgoing (publishing)' : 'incoming (receiving)';
        this.log(`Media stream ${streamType} for ${cameraId}`, 'success', {
            cameraId,
            streamId: stream.id,
            videoTracks: stream.getVideoTracks().length,
            audioTracks: stream.getAudioTracks().length,
            isOutgoing,
            timestamp: new Date().toISOString()
        });

        // Update camera streaming state
        if (this.cameras.has(cameraId)) {
            this.cameras.get(cameraId).streaming = true;
            this.cameras.get(cameraId).streamId = stream.id;
        }

        // Create or update video element
        this.createOrUpdateStreamElement(cameraId, stream, isOutgoing);

        // Update UI
        this.activeStreams.add(cameraId);
        this.updateCameraList();
        this.updateGlobalStats();
        this.updateStreamsGrid();
        this.updateFloatingStats();
    }

    handleStreamEnded(cameraId) {
        this.log(`Stream ended for camera ${cameraId}`, 'warning', {
            cameraId,
            activeStreamsBeforeEnd: Array.from(this.activeStreams),
            isManualHangup: this.manualHangups.has(cameraId),
            timestamp: new Date().toISOString()
        });

        // Update camera streaming state
        if (this.cameras.has(cameraId)) {
            this.cameras.get(cameraId).streaming = false;
        }

        // Remove from active streams
        this.activeStreams.delete(cameraId);

        // Clean up peer connection
        if (this.peerConnections.has(cameraId)) {
            this.peerConnections.get(cameraId).close();
            this.peerConnections.delete(cameraId);
        }

        // Stop stats collection
        this.stopStatsCollection(cameraId);

        // Clean up stats data
        this.previousStats.delete(cameraId);

        // Update UI
        this.updateCameraList();
        this.updateGlobalStats();
        this.updateStreamsGrid();
        this.updateFloatingStats();

        // Only remove stream element if it's not a manual hangup (let hangUpCamera handle it)
        if (!this.manualHangups.has(cameraId)) {
            if (this.streamElements.has(cameraId)) {
                const element = this.streamElements.get(cameraId);
                if (element.parentNode) {
                    element.parentNode.remove();
                }
                this.streamElements.delete(cameraId);
            }
        }

        this.log(`Stream cleanup completed for camera ${cameraId}`, 'info', {
            cameraId,
            activeStreamsAfterEnd: Array.from(this.activeStreams),
            timestamp: new Date().toISOString()
        });
    }

    createOrUpdateStreamElement(cameraId, stream, isOutgoing = false) {
        let streamContainer = this.streamElements.get(cameraId);

        if (!streamContainer) {
            // Create new stream container
            streamContainer = document.createElement('div');
            streamContainer.className = 'stream-container';
            streamContainer.setAttribute('data-camera-id', cameraId);

            // Create video element
            const video = document.createElement('video');
            video.className = 'stream-video';
            video.autoplay = true;
            video.playsinline = true;
            video.muted = true;
            video.preload = 'auto';
            video.disablePictureInPicture = true;
            video.disableRemotePlayback = true;

            // Add event listeners for better error handling and recovery
            video.addEventListener('error', (e) => {
                this.log(`Video error for ${cameraId}`, 'error', {
                    cameraId,
                    error: e.target.error,
                    videoReadyState: e.target.readyState,
                    networkState: e.target.networkState,
                    timestamp: new Date().toISOString()
                });

                // Try to recover by reloading the stream
                setTimeout(() => {
                    if (this.activeStreams.has(cameraId)) {
                        this.log(`Attempting to recover video stream for ${cameraId}`, 'info');
                        video.load();
                    }
                }, 2000);
            });

            video.addEventListener('abort', () => {
                this.log(`Video aborted for ${cameraId}`, 'warning', { cameraId });
            });

            video.addEventListener('suspend', () => {
                this.log(`Video suspended for ${cameraId}`, 'info', { cameraId });
            });

            video.addEventListener('stalled', () => {
                this.log(`Video stalled for ${cameraId}`, 'warning', { cameraId });
            });

            video.addEventListener('waiting', () => {
                this.log(`Video waiting for data for ${cameraId}`, 'info', { cameraId });
            });

            video.addEventListener('canplay', () => {
                this.log(`Video can play for ${cameraId}`, 'success', { cameraId });
            });

            video.addEventListener('loadedmetadata', () => {
                this.log(`Video metadata loaded for ${cameraId}`, 'info', {
                    cameraId,
                    videoWidth: video.videoWidth,
                    videoHeight: video.videoHeight,
                    duration: video.duration
                });
                if (video.videoWidth &&  video.videoHeight) {
                    streamContainer.style.aspectRatio = `${video.videoWidth}/${video.videoHeight}`;
                }
            });

            video.addEventListener('ratechange', () => {
                this.log(`Video playback rate changed for ${cameraId}: ${video.playbackRate}`, 'info', { cameraId });
            });

            video.addEventListener('volumechange', () => {
                this.log(`Video volume changed for ${cameraId}: ${video.volume}`, 'info', { cameraId });
            });

            // Add more diagnostic events for black video issues
            video.addEventListener('resize', () => {
                this.log(`Video resized for ${cameraId}`, 'info', {
                    cameraId,
                    videoWidth: video.videoWidth,
                    videoHeight: video.videoHeight,
                    timestamp: new Date().toISOString()
                });

                if (video.videoWidth &&  video.videoHeight) {
                    streamContainer.style.aspectRatio = `${video.videoWidth}/${video.videoHeight}`;
                }
            });

            video.addEventListener('emptied', () => {
                this.log(`Video emptied for ${cameraId}`, 'warning', { cameraId });
            });

            video.addEventListener('loadstart', () => {
                this.log(`Video load started for ${cameraId}`, 'info', { cameraId });
            });

            video.addEventListener('progress', () => {
                this.log(`Video progress for ${cameraId}`, 'info', {
                    cameraId,
                    buffered: video.buffered.length > 0 ? video.buffered.end(0) : 0,
                    currentTime: video.currentTime
                });
            });

            video.addEventListener('timeupdate', () => {
                // Only log occasionally to avoid spam
                if (Math.floor(video.currentTime) % 5 === 0) {
                    this.log(`Video time update for ${cameraId}`, 'debug', {
                        cameraId,
                        currentTime: video.currentTime,
                        readyState: video.readyState,
                        networkState: video.networkState
                    });
                }
            });

            // Create status indicator (top left)
            const statusOverlay = document.createElement('div');
            statusOverlay.className = 'stream-overlay';

            const streamStatus = document.createElement('div');
            streamStatus.className = 'stream-status connected';
            statusOverlay.appendChild(streamStatus);

            // Create camera label (bottom right)
            const streamInfo = document.createElement('div');
            streamInfo.className = 'stream-info';
            // Check connection type
            const isWhepStream = this.whepConnections.has(cameraId);
            const isWhipStream = this.whipConnections.has(cameraId);
            const isKvsStream = this.kvs.cameraId === cameraId;
            streamInfo.textContent = isKvsStream ? `KVS ${cameraId}` : (isWhipStream ? `WHIP ${cameraId}` : (isWhepStream ? `WHEP ${cameraId}` : `Camera ${cameraId}`));

            streamContainer.appendChild(video);
            streamContainer.appendChild(statusOverlay);
            streamContainer.appendChild(streamInfo);

            this.streamElements.set(cameraId, streamContainer);
        }

        // Set stream
        const video = streamContainer.querySelector('.stream-video');

        // Set the new stream
        video.srcObject = stream;

        // Ensure video starts playing
        if (video.paused) {
            video.play().catch(err => {
                this.log(`Failed to autoplay video for ${cameraId}`, 'warning', {
                    cameraId,
                    error: err.message,
                    timestamp: new Date().toISOString()
                });
            });
        }

        // Update status
        const status = streamContainer.querySelector('.stream-status');
        status.className = 'stream-status connected';
    }

    updateStreamsGrid() {
        this.log(`Updating streams grid`, 'info', {
            activeStreams: Array.from(this.activeStreams),
            streamElements: Array.from(this.streamElements.keys()),
            timestamp: new Date().toISOString()
        });

        // Get currently displayed stream elements
        const currentElements = Array.from(this.streamsGrid.children);
        const currentStreamIds = new Set();

        // Identify current stream elements (skip "no-streams" message)
        currentElements.forEach(element => {
            if (element.classList.contains('stream-container')) {
                const cameraId = element.getAttribute('data-camera-id');
                if (cameraId) {
                    currentStreamIds.add(cameraId);
                }
            }
        });

        // Handle empty state
        if (this.activeStreams.size === 0) {
            // Only clear and show "no streams" message if we have streams currently displayed
            if (currentStreamIds.size > 0) {
                this.streamsGrid.innerHTML = '';
                const noStreams = document.createElement('div');
                noStreams.className = 'no-streams';
                noStreams.textContent = 'No active streams. Connect to a camera to start streaming.';
                this.streamsGrid.appendChild(noStreams);
            }
            return;
        }

        // Remove "no streams" message if it exists
        const noStreamsElement = this.streamsGrid.querySelector('.no-streams');
        if (noStreamsElement) {
            noStreamsElement.remove();
        }

        // Remove stream elements that are no longer active
        currentStreamIds.forEach(cameraId => {
            if (!this.activeStreams.has(cameraId)) {
                const elementToRemove = this.streamsGrid.querySelector(`[data-camera-id="${cameraId}"]`);
                if (elementToRemove) {
                    elementToRemove.remove();
                    this.log(`Removed stream element for inactive camera ${cameraId}`, 'info', {
                        cameraId,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        });

        // Add new stream elements that aren't already displayed
        for (const cameraId of this.activeStreams) {
            if (!currentStreamIds.has(cameraId)) {
                const streamElement = this.streamElements.get(cameraId);
                if (streamElement) {
                    // Set data attribute for tracking
                    streamElement.setAttribute('data-camera-id', cameraId);
                    this.streamsGrid.appendChild(streamElement);

                    this.log(`Added stream element for camera ${cameraId}`, 'info', {
                        cameraId,
                        timestamp: new Date().toISOString()
                    });
                } else {
                    this.log(`No stream element found for camera ${cameraId}`, 'warning', {
                        cameraId,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        }
    }

    requestCall(cameraId) {
        const camera = this.cameras.get(cameraId);
        if (!camera) return;

        if (camera.streaming) {
            // Hang up - manual disconnect
            this.log(`Hanging up call to camera ${cameraId}`, 'info', {
                cameraId,
                timestamp: new Date().toISOString()
            });

            this.hangUpCamera(cameraId);
        } else {
            // Send call request and wait for SDP offer
            this.log(`Sending call request to camera ${cameraId}`, 'info', {
                cameraId,
                timestamp: new Date().toISOString()
            });

            if (!this.peerConnections.has(cameraId)) {
                this.setupPeerConnection(cameraId);
            }

            this.sendMessage({
                type: 'call-request',
                cameraId: cameraId
            });
        }
    }

    async callCamera(cameraId) {
        const camera = this.cameras.get(cameraId);
        if (!camera) return;

        if (camera.streaming) {
            // Hang up - manual disconnect
            this.log(`Hanging up call to camera ${cameraId}`, 'info', {
                cameraId,
                timestamp: new Date().toISOString()
            });

            this.hangUpCamera(cameraId);
        } else {
            // Create and send SDP offer directly
            this.log(`Creating direct offer for camera ${cameraId}`, 'info', {
                cameraId,
                timestamp: new Date().toISOString()
            });

            try {
                // Set up peer connection if not already exists
                if (!this.peerConnections.has(cameraId)) {
                    this.setupPeerConnection(cameraId);
                }

                const peerConnection = this.peerConnections.get(cameraId);
                // Reset non-trickle send state for this camera on new call
                this.nonTrickleSent.delete(cameraId);

                // Create offer
                const offer = await peerConnection.createOffer();

                // Log offer details and check for H.265 codecs in SDP
                const sdpLines = offer.sdp.split('\n');
                const h265Lines = sdpLines.filter(line =>
                    line.toLowerCase().includes('h265') ||
                    line.toLowerCase().includes('hevc')
                );
                const videoCodecLines = sdpLines.filter(line =>
                    line.startsWith('a=rtpmap:') && line.includes('H265') ||
                    line.startsWith('a=rtpmap:') && line.includes('HEVC')
                );

                this.log(`Offer created for camera ${cameraId}`, 'info', {
                    cameraId,
                    sdpType: offer.type,
                    sdpLength: offer.sdp.length,
                    h265LinesFound: h265Lines.length,
                    h265Lines: h265Lines,
                    videoCodecLines: videoCodecLines,
                    timestamp: new Date().toISOString()
                });

                // Set local description
                await peerConnection.setLocalDescription(offer);

                this.log(`Local description set for camera ${cameraId}`, 'success', {
                    cameraId,
                    timestamp: new Date().toISOString()
                });

                if (this.useTrickleIce) {
                    // Trickle: send immediately; ICE candidates will be sent as they arrive
                    this.sendMessage({ type: 'offer', cameraId: cameraId, offer: offer });
                } else {
                    // Non-trickle: wait for ICE completion and then send once
                    await this.waitForIceGatheringComplete(peerConnection);
                    if (!this.nonTrickleSent.has(cameraId)) {
                        this.sendMessage({ type: 'offer', cameraId: cameraId, offer: peerConnection.localDescription });
                        this.nonTrickleSent.add(cameraId);
                    }
                }

            } catch (error) {
                this.log(`Error creating offer for camera ${cameraId}`, 'error', {
                    cameraId,
                    error: error.message,
                    stack: error.stack,
                    timestamp: new Date().toISOString()
                });
            }
        }
    }

    hangUpCamera(cameraId) {
        this.log(`Manually hanging up camera ${cameraId}`, 'info', {
            cameraId,
            timestamp: new Date().toISOString()
        });

        // Mark this as a manual hang-up to prevent automatic disconnection handling
        this.manualHangups.add(cameraId);

        // Update camera streaming state first
        if (this.cameras.has(cameraId)) {
            this.cameras.get(cameraId).streaming = false;
        }

        // Remove from active streams
        this.activeStreams.delete(cameraId);

        // Stop stats collection for this camera only
        this.stopStatsCollection(cameraId);

        // Clean up stats data
        this.previousStats.delete(cameraId);

        // Close peer connection for this camera only
        if (this.peerConnections.has(cameraId)) {
            const peerConnection = this.peerConnections.get(cameraId);
            peerConnection.close();
            this.peerConnections.delete(cameraId);
        }

        // Update UI first (this should only affect this camera)
        this.updateCameraList();
        this.updateGlobalStats();
        this.updateStreamsGrid();
        this.updateFloatingStats();

        // Remove stream element after grid update
        if (this.streamElements.has(cameraId)) {
            const element = this.streamElements.get(cameraId);
            if (element.parentNode) {
                element.parentNode.remove();
            }
            this.streamElements.delete(cameraId);
        }

        // Send hang-up message to server
        this.sendMessage({
            type: 'hang-up',
            cameraId: cameraId
        });

        // Clear the manual hangup flag after a short delay to ensure all events have processed
        setTimeout(() => {
            this.manualHangups.delete(cameraId);
        }, 1000);
    }

    sendMessage(message) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(message));
            this.log(`Message sent: ${message.type}`, 'info', {
                messageType: message.type,
                cameraId: message.cameraId || 'N/A',
                timestamp: new Date().toISOString()
            });
        } else {
            this.log('Cannot send message - WebSocket not connected', 'error', {
                messageType: message.type,
                socketState: this.socket ? this.socket.readyState : 'null',
                reconnectAttempts: this.reconnectAttempts,
                timestamp: new Date().toISOString()
            });

            // If we can't send a message and we're not trying to reconnect, schedule a reconnect
            if (this.reconnectAttempts < this.maxReconnectAttempts &&
                (!this.socket || this.socket.readyState !== WebSocket.CONNECTING)) {
                this.scheduleReconnect();
            }
        }
    }

    startPingPong() {
        // Clear any existing intervals
        this.stopPingPong();

        // Send ping using configured interval
        this.pingInterval = setInterval(() => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.sendMessage({
                    type: 'ping',
                    timestamp: Date.now()
                });
                this.log('Ping sent to server', 'info');

                // Set up pong timeout
                this.pongTimeout = setTimeout(() => {
                    const timeSinceLastPong = Date.now() - this.lastPongTime;
                    if (timeSinceLastPong > this.connectionTimeout) {
                        this.log('Pong timeout - connection may be stale', 'warning', {
                            timeSinceLastPong,
                            connectionTimeout: this.connectionTimeout
                        });
                        // Force reconnection
                        this.socket.close();
                    }
                }, 5000); // Wait 5 seconds for pong
            }
        }, CONFIG.WEBSOCKET.PING_INTERVAL);
    }

    stopPingPong() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
        }
    }

    scheduleReconnect() {
        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay);

        this.log(`Scheduling reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`, 'warning', {
            reconnectAttempts: this.reconnectAttempts,
            maxReconnectAttempts: this.maxReconnectAttempts,
            delay,
            timestamp: new Date().toISOString()
        });

        setTimeout(() => {
            if (this.socket && this.socket.readyState !== WebSocket.OPEN) {
                this.log(`Attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts}`, 'info', {
                    reconnectAttempts: this.reconnectAttempts,
                    timestamp: new Date().toISOString()
                });
                this.initializeWebSocket();
            }
        }, delay);
    }

    updateConnectionStatus(connected) {
        this.connectionStatus.textContent = connected ? 'Connected' : 'Disconnected';
        this.connectionStatus.className = connected ? 'status connected' : 'status disconnected';
    }

    updateCameraList() {
        this.cameraList.innerHTML = '';

        if (this.cameras.size === 0) {
            const emptyItem = document.createElement('li');
            emptyItem.className = 'no-cameras';
            emptyItem.textContent = 'No cameras registered';
            this.cameraList.appendChild(emptyItem);
            return;
        }

        for (const [cameraId, camera] of this.cameras) {
            const listItem = document.createElement('li');
            listItem.className = 'camera-item';

            const cameraInfo = document.createElement('div');
            cameraInfo.className = 'camera-info';

            const statusIndicator = document.createElement('div');
            statusIndicator.style.width = '8px';
            statusIndicator.style.height = '8px';
            statusIndicator.style.borderRadius = '50%';
            statusIndicator.style.backgroundColor = camera.connected ? '#28a745' : '#dc3545';
            statusIndicator.title = camera.connected ? 'Online' : 'Offline';

            const cameraIdSpan = document.createElement('span');
            cameraIdSpan.className = 'camera-id';
            cameraIdSpan.textContent = cameraId;

            cameraInfo.appendChild(statusIndicator);
            cameraInfo.appendChild(cameraIdSpan);

            const buttonContainer = document.createElement('div');
            buttonContainer.className = 'button-container';

            if (camera.streaming) {
                // Show single Hang Up button when streaming
                const hangUpButton = document.createElement('button');
                hangUpButton.className = 'call-button hang-up';
                hangUpButton.textContent = 'Hang Up';
                hangUpButton.onclick = () => this.callCamera(cameraId);
                buttonContainer.appendChild(hangUpButton);
            } else {
                // Show both Request Call and Call buttons when not streaming
                const requestCallButton = document.createElement('button');
                requestCallButton.className = 'call-button request';
                requestCallButton.textContent = 'Request Call';
                requestCallButton.onclick = () => this.requestCall(cameraId);

                const callButton = document.createElement('button');
                callButton.className = 'call-button';
                callButton.textContent = 'Call';
                callButton.onclick = () => this.callCamera(cameraId);

                buttonContainer.appendChild(requestCallButton);
                buttonContainer.appendChild(callButton);
            }

            listItem.appendChild(cameraInfo);
            listItem.appendChild(buttonContainer);
            this.cameraList.appendChild(listItem);
        }
    }

    updateCameraConnectionState(cameraId, state) {
        const camera = this.cameras.get(cameraId);
        if (camera) {
            camera.connectionState = state;

            // Update stream status indicator
            const streamElement = this.streamElements.get(cameraId);
            if (streamElement) {
                const status = streamElement.querySelector('.stream-status');
                if (status) {
                    status.className = `stream-status ${state === 'connected' ? 'connected' : 'disconnected'}`;
                }
            }
        }
    }

    setupGlobalStats() {
        this.updateStatValue('activeStreams', '0');
        this.updateStatValue('totalCameras', '0');
        this.updateStatValue('totalBytesReceived', '0');
        this.updateStatValue('totalPacketsReceived', '0');
        this.updateStatValue('averageFrameRate', '0 fps');
        this.updateStatValue('averageBandwidth', '0 kbps');
    }

    updateGlobalStats() {
        this.updateStatValue('activeStreams', this.activeStreams.size.toString());
        this.updateStatValue('totalCameras', this.cameras.size.toString());

        // Calculate totals from individual stream stats
        let totalBytes = 0;
        let totalPackets = 0;
        let totalFrameRate = 0;
        let totalBandwidth = 0;

        for (const [cameraId, stats] of this.streamStats) {
            totalBytes += stats.bytesReceived || 0;
            totalPackets += stats.packetsReceived || 0;
            totalFrameRate += stats.frameRate || 0;
            totalBandwidth += stats.bandwidth || 0;
        }

        this.updateStatValue('totalBytesReceived', totalBytes.toLocaleString());
        this.updateStatValue('totalPacketsReceived', totalPackets.toLocaleString());
        this.updateStatValue('averageFrameRate', `${Math.round(totalFrameRate / Math.max(1, this.activeStreams.size))} fps`);
        this.updateStatValue('averageBandwidth', `${Math.round(totalBandwidth / Math.max(1, this.activeStreams.size))} kbps`);
    }

    updateStatValue(statId, value) {
        const element = document.getElementById(statId);
        if (element) {
            element.textContent = value;
        }
    }

    startStatsCollection(cameraId) {
        if (this.statsIntervals.has(cameraId)) {
            clearInterval(this.statsIntervals.get(cameraId));
        }

        this.log(`Starting statistics collection for camera ${cameraId}`, 'info', {
            cameraId,
            timestamp: new Date().toISOString()
        });

        const interval = setInterval(async () => {
            await this.collectStats(cameraId);
        }, 1000);

        this.statsIntervals.set(cameraId, interval);
    }

    stopStatsCollection(cameraId) {
        if (this.statsIntervals.has(cameraId)) {
            clearInterval(this.statsIntervals.get(cameraId));
            this.statsIntervals.delete(cameraId);
            this.streamStats.delete(cameraId);

            this.log(`Stopped statistics collection for camera ${cameraId}`, 'info', {
                cameraId,
                timestamp: new Date().toISOString()
            });
        }
    }

    async collectStats(cameraId) {
        // Check regular peer connections, WHEP connections, and KVS connections
        let peerConnection = this.peerConnections.get(cameraId);
        if (!peerConnection) {
            // Check if it's a WHEP connection
            const whepConnection = this.whepConnections.get(cameraId);
            if (whepConnection && whepConnection.pc) {
                peerConnection = whepConnection.pc;
            } else if (this.kvs.cameraId === cameraId && this.kvs.pc) {
                // Check if it's a KVS connection
                peerConnection = this.kvs.pc;
            } else {
                return;
            }
        }

        try {
            const stats = await peerConnection.getStats();
            let inboundRtpStats = null;
            let remoteInboundRtpStats = null;
            let candidatePairStats = null;
            let trackStats = null;
            let codecStats = null;
            let remoteOutboundRtpStats = null;

            stats.forEach(report => {
                if (report.type === 'inbound-rtp' && report.kind === 'video') {
                    inboundRtpStats = report;
                } else if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
                    remoteInboundRtpStats = report;
                } else if (report.type === 'remote-outbound-rtp' && report.kind === 'video') {
                    remoteOutboundRtpStats = report;
                } else if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                    candidatePairStats = report;
                } else if (report.type === 'track' && report.kind === 'video') {
                    trackStats = report;
                } else if (report.type === 'codec' && report.payloadType) {
                    codecStats = report;
                }
            });

            if (inboundRtpStats) {
                // Get video tracks from the stream element
                const streamElement = this.streamElements.get(cameraId);
                let videoTracks = 1;
                if (streamElement) {
                    const video = streamElement.querySelector('.stream-video');
                    if (video && video.srcObject) {
                        videoTracks = video.srcObject.getVideoTracks().length;
                    }
                }

                const currentStats = {
                    bytesReceived: inboundRtpStats.bytesReceived || 0,
                    packetsReceived: inboundRtpStats.packetsReceived || 0,
                    packetsLost: inboundRtpStats.packetsLost || 0,
                    framesReceived: inboundRtpStats.framesReceived || 0,
                    framesDropped: inboundRtpStats.framesDropped || 0,
                    frameRate: inboundRtpStats.framesPerSecond || 0,
                    jitter: inboundRtpStats.jitter || 0,
                    rtt: candidatePairStats ? candidatePairStats.currentRoundTripTime : 0,
                    videoTracks: videoTracks,
                    bandwidth: 0,
                    packetLossRate: 0,
                    encoder: codecStats ? codecStats.mimeType || 'Unknown' : 'Unknown',
                    codecId: codecStats ? codecStats.payloadType || 'Unknown' : 'Unknown',
                    // Add freeze monitoring
                    freezeCount: inboundRtpStats.freezeCount || 0,
                    freezeRate: 0, // Will be calculated below
                    // Add PLI and NACK monitoring
                    pliCount: inboundRtpStats.pliCount || 0,
                    nackCount: inboundRtpStats.nackCount || 0,
                    pliRate: 0, // Will be calculated below
                    nackRate: 0, // Will be calculated below
                    timestamp: Date.now()
                };

                // Add remote stats if available
                if (remoteInboundRtpStats) {
                    currentStats.remotePacketsLost = remoteInboundRtpStats.packetsLost || 0;
                    currentStats.remoteJitter = remoteInboundRtpStats.jitter || 0;
                    currentStats.remoteRtt = remoteInboundRtpStats.roundTripTime || 0;
                }

                // Add remote outbound stats for PLI/NACK sent by remote
                if (remoteOutboundRtpStats) {
                    currentStats.remotePliCount = remoteOutboundRtpStats.pliCount || 0;
                    currentStats.remoteNackCount = remoteOutboundRtpStats.nackCount || 0;
                }

                // Add track stats if available
                if (trackStats) {
                    currentStats.trackFrameWidth = trackStats.frameWidth || 0;
                    currentStats.trackFrameHeight = trackStats.frameHeight || 0;
                }

                // Calculate derived metrics
                const previousStats = this.previousStats.get(cameraId);
                if (previousStats) {
                    const timeDiff = (currentStats.timestamp - previousStats.timestamp) / 1000;
                    const bytesDiff = currentStats.bytesReceived - previousStats.bytesReceived;
                    const packetsSent = currentStats.packetsReceived - previousStats.packetsReceived;
                    const packetsLostDiff = currentStats.packetsLost - previousStats.packetsLost;

                    // Calculate bandwidth
                    currentStats.bandwidth = timeDiff > 0 ? Math.round((bytesDiff * 8) / timeDiff / 1000) : 0;

                    // Calculate packet loss rate
                    if (packetsSent > 0) {
                        currentStats.packetLossRate = Math.round((packetsLostDiff / (packetsSent + packetsLostDiff)) * 100 * 100) / 100;
                    }

                    // Calculate freeze rate (freezes per minute)
                    const freezeDiff = currentStats.freezeCount - previousStats.freezeCount;
                    if (timeDiff > 0) {
                        currentStats.freezeRate = Math.round((freezeDiff / timeDiff) * 60 * 100) / 100; // freezes per minute
                    }

                    // Calculate PLI rate (PLIs per minute)
                    const pliDiff = currentStats.pliCount - previousStats.pliCount;
                    if (timeDiff > 0) {
                        currentStats.pliRate = Math.round((pliDiff / timeDiff) * 60 * 100) / 100; // PLIs per minute
                    }

                    // Calculate NACK rate (NACKs per minute)
                    const nackDiff = currentStats.nackCount - previousStats.nackCount;
                    if (timeDiff > 0) {
                        currentStats.nackRate = Math.round((nackDiff / timeDiff) * 60 * 100) / 100; // NACKs per minute
                    }

                    // Log freeze events
                    if (freezeDiff > 0) {
                        this.log(`Video freeze detected for camera ${cameraId}`, 'warning', {
                            cameraId,
                            freezeCount: currentStats.freezeCount,
                            freezeDiff,
                            timeSinceLastStats: timeDiff,
                            freezeRate: currentStats.freezeRate,
                            frameRate: currentStats.frameRate,
                            packetLossRate: currentStats.packetLossRate,
                            timestamp: new Date().toISOString()
                        });
                    }

                    // Log PLI events (Picture Loss Indication)
                    if (pliDiff > 0) {
                        this.log(`PLI (Picture Loss) detected for camera ${cameraId}`, 'warning', {
                            cameraId,
                            pliCount: currentStats.pliCount,
                            pliDiff,
                            pliRate: currentStats.pliRate,
                            packetLossRate: currentStats.packetLossRate,
                            frameRate: currentStats.frameRate,
                            timestamp: new Date().toISOString()
                        });
                    }

                    // Log NACK events (Negative Acknowledgment)
                    if (nackDiff > 0) {
                        this.log(`NACK (Retransmission request) detected for camera ${cameraId}`, 'warning', {
                            cameraId,
                            nackCount: currentStats.nackCount,
                            nackDiff,
                            nackRate: currentStats.nackRate,
                            packetLossRate: currentStats.packetLossRate,
                            rtt: currentStats.rtt,
                            timestamp: new Date().toISOString()
                        });
                    }
                }

                this.streamStats.set(cameraId, currentStats);
                this.previousStats.set(cameraId, currentStats);

                // Update floating stats panel
                this.updateFloatingStats();

                // Log detailed stats every 5 seconds
                if (Date.now() % 5000 < 1000) {
                    this.log(`Individual stream statistics for camera ${cameraId}`, 'info', {
                        cameraId,
                        streamId: this.cameras.get(cameraId)?.streamId,
                        encoder: currentStats.encoder,
                        codecId: currentStats.codecId,
                        freezeCount: currentStats.freezeCount,
                        freezeRate: currentStats.freezeRate,
                        pliCount: currentStats.pliCount,
                        pliRate: currentStats.pliRate,
                        nackCount: currentStats.nackCount,
                        nackRate: currentStats.nackRate,
                        ...currentStats,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        } catch (error) {
            this.log(`Error collecting stream statistics for camera ${cameraId}`, 'error', {
                cameraId,
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
    }

    startGlobalStatsUpdate() {
        setInterval(() => {
            this.updateGlobalStats();
        }, 1000);
    }

    async logIceStatistics(cameraId, peerConnection) {
        try {
            const stats = await peerConnection.getStats();
            const iceStats = {
                localCandidates: [],
                remoteCandidates: [],
                candidatePairs: []
            };

            stats.forEach(report => {
                if (report.type === 'local-candidate') {
                    iceStats.localCandidates.push({
                        id: report.id,
                        candidateType: report.candidateType,
                        ip: report.ip,
                        port: report.port,
                        protocol: report.protocol
                    });
                } else if (report.type === 'remote-candidate') {
                    iceStats.remoteCandidates.push({
                        id: report.id,
                        candidateType: report.candidateType,
                        ip: report.ip,
                        port: report.port,
                        protocol: report.protocol
                    });
                } else if (report.type === 'candidate-pair' && report.selected) {
                    iceStats.candidatePairs.push({
                        id: report.id,
                        state: report.state,
                        bytesSent: report.bytesSent,
                        bytesReceived: report.bytesReceived,
                        localCandidateId: report.localCandidateId,
                        remoteCandidateId: report.remoteCandidateId
                    });
                }
            });

            this.log(`ICE statistics for camera ${cameraId}`, 'info', {
                cameraId,
                ...iceStats,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            this.log(`Error collecting ICE statistics for camera ${cameraId}`, 'error', {
                cameraId,
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
    }

    handleGlobalDisconnection() {
        this.log('Handling global WebSocket disconnection - cleaning up all cameras', 'warning', {
            totalCameras: this.cameras.size,
            activeStreams: this.activeStreams.size,
            timestamp: new Date().toISOString()
        });

        // Clean up all connections
        for (const [cameraId, peerConnection] of this.peerConnections) {
            this.log(`Closing peer connection for camera ${cameraId}`, 'info', {
                cameraId,
                timestamp: new Date().toISOString()
            });
            peerConnection.close();
        }
        this.peerConnections.clear();

        // Clear all streams
        this.activeStreams.clear();
        this.streamElements.clear();

        // Stop all stats collection
        for (const [cameraId, interval] of this.statsIntervals) {
            clearInterval(interval);
        }
        this.statsIntervals.clear();
        this.streamStats.clear();
        this.previousStats.clear();

        // Reset camera states
        for (const [cameraId, camera] of this.cameras) {
            camera.streaming = false;
            camera.connected = false;
        }

        // Update UI
        this.updateCameraList();
        this.updateGlobalStats();
        this.updateStreamsGrid();
        this.updateFloatingStats();
    }

    log(message, type = 'info', data = null) {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;

        const timestampSpan = document.createElement('span');
        timestampSpan.className = 'log-timestamp';
        timestampSpan.textContent = `[${timestamp}]`;

        const messageSpan = document.createElement('span');
        messageSpan.className = 'log-message';
        messageSpan.textContent = message;

        logEntry.appendChild(timestampSpan);
        logEntry.appendChild(messageSpan);

        if (data) {
            const dataSpan = document.createElement('div');
            dataSpan.className = 'log-data';
            dataSpan.textContent = this.formatLogData(data);
            logEntry.appendChild(dataSpan);
        }

        this.logContainer.appendChild(logEntry);
        this.logContainer.scrollTop = this.logContainer.scrollHeight;

        // Keep only last 100 log entries
        while (this.logContainer.children.length > 100) {
            this.logContainer.removeChild(this.logContainer.firstChild);
        }
    }

    formatLogData(data) {
        if (!data || typeof data !== 'object') {
            return String(data);
        }

        const parts = [];
        for (const [key, value] of Object.entries(data)) {
            if (key === 'timestamp') continue; // Skip timestamp as it's redundant

            let formattedValue = value;

            // Format specific types for better readability
            if (Array.isArray(value)) {
                formattedValue = `[${value.length} items]`;
            } else if (typeof value === 'object' && value !== null) {
                if (value.urls) {
                    formattedValue = `ICE:${value.urls}`;
                } else if (Object.keys(value).length > 3) {
                    formattedValue = `{${Object.keys(value).length} props}`;
                } else {
                    formattedValue = JSON.stringify(value);
                }
            } else if (typeof value === 'string' && value.length > 50) {
                formattedValue = `${value.substring(0, 50)}...`;
            } else if (typeof value === 'number' && value > 999) {
                formattedValue = value.toLocaleString();
            }

            parts.push(`${key}: ${formattedValue}`);
        }

        return parts.join(' | ');
    }

    initializeFloatingStats() {
        // Initially collapsed on mobile
        if (window.innerWidth <= 768) {
            const floatingStats = document.getElementById('floatingStats');
            floatingStats.classList.add('collapsed');
        }

        this.updateFloatingStats();
    }

    updateFloatingStats() {
        if (!this.floatingStatsContent) return;

        // Clear existing content
        this.floatingStatsContent.innerHTML = '';

        const floatingStats = document.getElementById('floatingStats');

        if (this.activeStreams.size === 0) {
            this.floatingStatsContent.innerHTML = '<div class="floating-stats-no-data">No active video streams</div>';
            floatingStats.classList.remove('has-data');
            return;
        }

        // Add has-data class to make panel taller
        floatingStats.classList.add('has-data');

        // Create stats for each active stream
        this.activeStreams.forEach(cameraId => {
            const stats = this.streamStats.get(cameraId);

            // Check if it's a regular camera, WHEP connection, or KVS connection
            let camera = this.cameras.get(cameraId);
            let isWhep = false;
            let isKvs = false;

            if (!camera) {
                // Check if it's a WHEP connection
                const whepConnection = this.whepConnections.get(cameraId);
                if (whepConnection && whepConnection.state === 'connected') {
                    // Create a camera-like object for WHEP
                    camera = {
                        id: cameraId,
                        streamId: this.streamElements.get(cameraId)?.querySelector('video')?.srcObject?.id || 'WHEP',
                        connected: true,
                        streaming: true
                    };
                    isWhep = true;
                } else if (this.kvs.cameraId === cameraId && this.kvs.state === 'connected') {
                    // Create a camera-like object for KVS
                    camera = {
                        id: cameraId,
                        streamId: this.streamElements.get(cameraId)?.querySelector('video')?.srcObject?.id || 'KVS',
                        connected: true,
                        streaming: true
                    };
                    isKvs = true;
                }
            }

            if (!stats || !camera) return;

            const streamDiv = document.createElement('div');
            streamDiv.className = 'floating-stats-camera';

            // Stream header with stream ID
            const headerDiv = document.createElement('div');
            headerDiv.className = 'floating-stats-camera-title';

            const statusDiv = document.createElement('div');
            statusDiv.className = 'floating-stats-camera-status';

            const titleContainer = document.createElement('div');
            const streamType = isKvs ? 'AWS KVS' : (isWhep ? 'WHEP' : 'WebSocket');
            const streamLabel = isKvs ? 'KVS Viewer' : (isWhep ? 'WHEP' : 'Camera');
            titleContainer.innerHTML = `
                <div style="font-size: 14px; font-weight: bold;">${streamType} Stream</div>
                <div style="font-size: 11px; color: #6c757d; margin-top: 2px;">
                    ${streamLabel}: ${cameraId} | Stream: ${camera.streamId ? camera.streamId.substring(0, 8) + '...' : 'N/A'}
                </div>
            `;

            headerDiv.appendChild(statusDiv);
            headerDiv.appendChild(titleContainer);
            streamDiv.appendChild(headerDiv);

            // Stream Info section
            const infoSection = document.createElement('div');
            infoSection.className = 'floating-stats-section';

            const infoTitle = document.createElement('div');
            infoTitle.className = 'floating-stats-section-title';
            infoTitle.textContent = 'Stream Information';
            infoSection.appendChild(infoTitle);

            // Stream ID (full)
            const streamIdDiv = document.createElement('div');
            streamIdDiv.className = 'floating-stat-item';
            streamIdDiv.innerHTML = `
                <span class="floating-stat-label">Stream ID:</span>
                <span class="floating-stat-value" style="font-size: 10px; word-break: break-all;">${camera.streamId || 'N/A'}</span>
            `;
            infoSection.appendChild(streamIdDiv);

            // Video Tracks
            const videoTracksDiv = document.createElement('div');
            videoTracksDiv.className = 'floating-stat-item';
            videoTracksDiv.innerHTML = `
                <span class="floating-stat-label">Video Tracks:</span>
                <span class="floating-stat-value">${stats.videoTracks || 1}</span>
            `;
            infoSection.appendChild(videoTracksDiv);

            // Video Resolution (if available)
            if (stats.trackFrameWidth && stats.trackFrameHeight) {
                const resolutionDiv = document.createElement('div');
                resolutionDiv.className = 'floating-stat-item';
                resolutionDiv.innerHTML = `
                    <span class="floating-stat-label">Resolution:</span>
                    <span class="floating-stat-value">${stats.trackFrameWidth}x${stats.trackFrameHeight}</span>
                `;
                infoSection.appendChild(resolutionDiv);
            }

            streamDiv.appendChild(infoSection);

            // Codec/Encoder section
            const codecSection = document.createElement('div');
            codecSection.className = 'floating-stats-section';

            const codecTitle = document.createElement('div');
            codecTitle.className = 'floating-stats-section-title';
            codecTitle.textContent = 'Codec Information';
            codecSection.appendChild(codecTitle);

            // Encoder/Codec Information
            const encoderDiv = document.createElement('div');
            encoderDiv.className = 'floating-stat-item';
            encoderDiv.innerHTML = `
                <span class="floating-stat-label">Encoder:</span>
                <span class="floating-stat-value">${stats.encoder}</span>
            `;
            codecSection.appendChild(encoderDiv);

            // Codec ID
            const codecIdDiv = document.createElement('div');
            codecIdDiv.className = 'floating-stat-item';
            codecIdDiv.innerHTML = `
                <span class="floating-stat-label">Codec ID:</span>
                <span class="floating-stat-value">${stats.codecId}</span>
            `;
            codecSection.appendChild(codecIdDiv);

            streamDiv.appendChild(codecSection);

            // Network Quality section
            const networkSection = document.createElement('div');
            networkSection.className = 'floating-stats-section';

            const networkTitle = document.createElement('div');
            networkTitle.className = 'floating-stats-section-title';
            networkTitle.textContent = 'Network Quality';
            networkSection.appendChild(networkTitle);

            // Packet Loss
            const packetLossDiv = document.createElement('div');
            packetLossDiv.className = 'floating-stat-item';
            packetLossDiv.innerHTML = `
                <span class="floating-stat-label">Packet Loss:</span>
                <span class="floating-stat-value ${this.getPacketLossClass(stats.packetLossRate)}">${stats.packetLossRate}%</span>
            `;
            networkSection.appendChild(packetLossDiv);

            // Packets Lost (absolute count)
            const packetsLostDiv = document.createElement('div');
            packetsLostDiv.className = 'floating-stat-item';
            packetsLostDiv.innerHTML = `
                <span class="floating-stat-label">Packets Lost:</span>
                <span class="floating-stat-value ${stats.packetsLost > 0 ? 'warning' : 'good'}">${stats.packetsLost}</span>
            `;
            networkSection.appendChild(packetsLostDiv);

            // Latency (RTT)
            const latencyDiv = document.createElement('div');
            latencyDiv.className = 'floating-stat-item';
            latencyDiv.innerHTML = `
                <span class="floating-stat-label">Latency (RTT):</span>
                <span class="floating-stat-value ${this.getLatencyClass(stats.rtt)}">${this.formatLatency(stats.rtt)}</span>
            `;
            networkSection.appendChild(latencyDiv);

            // Jitter
            const jitterDiv = document.createElement('div');
            jitterDiv.className = 'floating-stat-item';
            jitterDiv.innerHTML = `
                <span class="floating-stat-label">Jitter:</span>
                <span class="floating-stat-value ${this.getJitterClass(stats.jitter)}">${this.formatJitter(stats.jitter)}</span>
            `;
            networkSection.appendChild(jitterDiv);

            streamDiv.appendChild(networkSection);

            // Stream Quality section
            const streamSection = document.createElement('div');
            streamSection.className = 'floating-stats-section';

            const streamTitle = document.createElement('div');
            streamTitle.className = 'floating-stats-section-title';
            streamTitle.textContent = 'Stream Quality';
            streamSection.appendChild(streamTitle);

            // Bandwidth
            const bandwidthDiv = document.createElement('div');
            bandwidthDiv.className = 'floating-stat-item';
            bandwidthDiv.innerHTML = `
                <span class="floating-stat-label">Bandwidth:</span>
                <span class="floating-stat-value">${stats.bandwidth} kbps</span>
            `;
            streamSection.appendChild(bandwidthDiv);

            // Frame Rate
            const frameRateDiv = document.createElement('div');
            frameRateDiv.className = 'floating-stat-item';
            frameRateDiv.innerHTML = `
                <span class="floating-stat-label">Frame Rate:</span>
                <span class="floating-stat-value">${Math.round(stats.frameRate)} fps</span>
            `;
            streamSection.appendChild(frameRateDiv);

            // Frames Received
            const framesReceivedDiv = document.createElement('div');
            framesReceivedDiv.className = 'floating-stat-item';
            framesReceivedDiv.innerHTML = `
                <span class="floating-stat-label">Frames Received:</span>
                <span class="floating-stat-value">${stats.framesReceived}</span>
            `;
            streamSection.appendChild(framesReceivedDiv);

            // Frames Dropped
            const framesDroppedDiv = document.createElement('div');
            framesDroppedDiv.className = 'floating-stat-item';
            framesDroppedDiv.innerHTML = `
                <span class="floating-stat-label">Frames Dropped:</span>
                <span class="floating-stat-value ${stats.framesDropped > 0 ? 'warning' : 'good'}">${stats.framesDropped}</span>
            `;
            streamSection.appendChild(framesDroppedDiv);

            // Freeze Count
            const freezeCountDiv = document.createElement('div');
            freezeCountDiv.className = 'floating-stat-item';
            freezeCountDiv.innerHTML = `
                <span class="floating-stat-label">Freeze Count:</span>
                <span class="floating-stat-value ${this.getFreezeCountClass(stats.freezeCount)}">${stats.freezeCount}</span>
            `;
            streamSection.appendChild(freezeCountDiv);

            // Freeze Rate
            const freezeRateDiv = document.createElement('div');
            freezeRateDiv.className = 'floating-stat-item';
            freezeRateDiv.innerHTML = `
                <span class="floating-stat-label">Freeze Rate:</span>
                <span class="floating-stat-value ${this.getFreezeRateClass(stats.freezeRate)}">${stats.freezeRate} freezes/min</span>
            `;
            streamSection.appendChild(freezeRateDiv);

            streamDiv.appendChild(streamSection);

            // Video Quality Issues section
            const qualitySection = document.createElement('div');
            qualitySection.className = 'floating-stats-section';

            const qualityTitle = document.createElement('div');
            qualityTitle.className = 'floating-stats-section-title';
            qualityTitle.textContent = 'Video Quality Issues';
            qualitySection.appendChild(qualityTitle);

            // PLI Count
            const pliCountDiv = document.createElement('div');
            pliCountDiv.className = 'floating-stat-item';
            pliCountDiv.innerHTML = `
                <span class="floating-stat-label">PLI Count:</span>
                <span class="floating-stat-value ${this.getPliCountClass(stats.pliCount)}">${stats.pliCount}</span>
            `;
            qualitySection.appendChild(pliCountDiv);

            // PLI Rate
            const pliRateDiv = document.createElement('div');
            pliRateDiv.className = 'floating-stat-item';
            pliRateDiv.innerHTML = `
                <span class="floating-stat-label">PLI Rate:</span>
                <span class="floating-stat-value ${this.getPliRateClass(stats.pliRate)}">${stats.pliRate} PLIs/min</span>
            `;
            qualitySection.appendChild(pliRateDiv);

            // NACK Count
            const nackCountDiv = document.createElement('div');
            nackCountDiv.className = 'floating-stat-item';
            nackCountDiv.innerHTML = `
                <span class="floating-stat-label">NACK Count:</span>
                <span class="floating-stat-value ${this.getNackCountClass(stats.nackCount)}">${stats.nackCount}</span>
            `;
            qualitySection.appendChild(nackCountDiv);

            // NACK Rate
            const nackRateDiv = document.createElement('div');
            nackRateDiv.className = 'floating-stat-item';
            nackRateDiv.innerHTML = `
                <span class="floating-stat-label">NACK Rate:</span>
                <span class="floating-stat-value ${this.getNackRateClass(stats.nackRate)}">${stats.nackRate} NACKs/min</span>
            `;
            qualitySection.appendChild(nackRateDiv);

            // Remote PLI/NACK (if available)
            if (stats.remotePliCount !== undefined || stats.remoteNackCount !== undefined) {
                const remoteTitle = document.createElement('div');
                remoteTitle.className = 'floating-stats-section-title';
                remoteTitle.textContent = 'Remote Quality Issues';
                qualitySection.appendChild(remoteTitle);

                if (stats.remotePliCount !== undefined) {
                    const remotePliDiv = document.createElement('div');
                    remotePliDiv.className = 'floating-stat-item';
                    remotePliDiv.innerHTML = `
                        <span class="floating-stat-label">Remote PLI:</span>
                        <span class="floating-stat-value">${stats.remotePliCount}</span>
                    `;
                    qualitySection.appendChild(remotePliDiv);
                }

                if (stats.remoteNackCount !== undefined) {
                    const remoteNackDiv = document.createElement('div');
                    remoteNackDiv.className = 'floating-stat-item';
                    remoteNackDiv.innerHTML = `
                        <span class="floating-stat-label">Remote NACK:</span>
                        <span class="floating-stat-value">${stats.remoteNackCount}</span>
                    `;
                    qualitySection.appendChild(remoteNackDiv);
                }
            }

            streamDiv.appendChild(qualitySection);

            // Data Transfer section
            const dataSection = document.createElement('div');
            dataSection.className = 'floating-stats-section';

            const dataTitle = document.createElement('div');
            dataTitle.className = 'floating-stats-section-title';
            dataTitle.textContent = 'Data Transfer';
            dataSection.appendChild(dataTitle);

            // Bytes Received
            const bytesReceivedDiv = document.createElement('div');
            bytesReceivedDiv.className = 'floating-stat-item';
            bytesReceivedDiv.innerHTML = `
                <span class="floating-stat-label">Bytes Received:</span>
                <span class="floating-stat-value">${this.formatBytes(stats.bytesReceived)}</span>
            `;
            dataSection.appendChild(bytesReceivedDiv);

            // Packets Received
            const packetsReceivedDiv = document.createElement('div');
            packetsReceivedDiv.className = 'floating-stat-item';
            packetsReceivedDiv.innerHTML = `
                <span class="floating-stat-label">Packets Received:</span>
                <span class="floating-stat-value">${stats.packetsReceived.toLocaleString()}</span>
            `;
            dataSection.appendChild(packetsReceivedDiv);

            streamDiv.appendChild(dataSection);

            this.floatingStatsContent.appendChild(streamDiv);
        });
    }

    getPacketLossClass(packetLoss) {
        if (packetLoss === 0) return 'good';
        if (packetLoss <= 1) return 'warning';
        return 'error';
    }

    getLatencyClass(rtt) {
        if (rtt === 0) return '';
        if (rtt <= 0.1) return 'good'; // <= 100ms
        if (rtt <= 0.3) return 'warning'; // <= 300ms
        return 'error';
    }

    getJitterClass(jitter) {
        if (jitter === 0) return '';
        if (jitter <= 0.03) return 'good'; // <= 30ms
        if (jitter <= 0.1) return 'warning'; // <= 100ms
        return 'error';
    }

    formatLatency(rtt) {
        if (rtt === 0) return 'N/A';
        return `${Math.round(rtt * 1000)}ms`;
    }

    formatJitter(jitter) {
        if (jitter === 0) return 'N/A';
        return `${Math.round(jitter * 1000)}ms`;
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    getFreezeCountClass(freezeCount) {
        if (freezeCount === 0) return 'good';
        if (freezeCount <= 5) return 'warning';
        return 'error';
    }

    getFreezeRateClass(freezeRate) {
        if (freezeRate === 0) return 'good';
        if (freezeRate <= 1) return 'warning';
        return 'error';
    }

    getPliCountClass(pliCount) {
        if (pliCount === 0) return 'good';
        if (pliCount <= 5) return 'warning';
        return 'error';
    }

    getPliRateClass(pliRate) {
        if (pliRate === 0) return 'good';
        if (pliRate <= 1) return 'warning';
        return 'error';
    }

    getNackCountClass(nackCount) {
        if (nackCount === 0) return 'good';
        if (nackCount <= 5) return 'warning';
        return 'error';
    }

    getNackRateClass(nackRate) {
        if (nackRate === 0) return 'good';
        if (nackRate <= 1) return 'warning';
        return 'error';
    }

    // Monitor video health and recover from issues
    startVideoHealthMonitoring() {
        setInterval(() => {
            this.streamElements.forEach((streamContainer, cameraId) => {
                const video = streamContainer.querySelector('.stream-video');
                if (!video || !this.activeStreams.has(cameraId)) return;

                // Check if video is frozen (not receiving new frames)
                if (video.readyState >= 2) { // HAVE_CURRENT_DATA or higher
                    const currentTime = video.currentTime;
                    const lastTime = this.lastVideoTime.get(cameraId) || 0;

                    if (currentTime === lastTime && !video.paused) {
                        // Video appears to be frozen
                        this.log(`Video appears frozen for ${cameraId}, attempting recovery`, 'warning', {
                            cameraId,
                            currentTime,
                            lastTime,
                            readyState: video.readyState,
                            networkState: video.networkState,
                            videoWidth: video.videoWidth,
                            videoHeight: video.videoHeight,
                            timestamp: new Date().toISOString()
                        });

                        // Try multiple recovery strategies
                        this.recoverVideoStream(cameraId, video);
                    }

                    this.lastVideoTime.set(cameraId, currentTime);
                }

                // Check for black video (video dimensions but no visual content)
                this.checkForBlackVideo(cameraId, video);
            });
        }, 2000); // Check every 2 seconds
    }

    // Enhanced recovery for video streams
    recoverVideoStream(cameraId, video) {
        this.log(`Starting video recovery for ${cameraId}`, 'info', { cameraId });

        // Strategy 1: Try seeking slightly forward
        const currentTime = video.currentTime;
        try {
            video.currentTime = currentTime + 0.1;
        } catch (e) {
            this.log(`Seek recovery failed for ${cameraId}`, 'warning', { cameraId, error: e.message });
        }

        // Strategy 2: Force repaint (Chrome specific)
        setTimeout(() => {
            if (this.activeStreams.has(cameraId) && video.currentTime === currentTime) {
                this.log(`Forcing video repaint for ${cameraId}`, 'info', { cameraId });
                video.style.display = 'none';
                video.offsetHeight; // Force reflow
                video.style.display = '';

                // Strategy 3: If still frozen, reload
                setTimeout(() => {
                    if (this.activeStreams.has(cameraId) && video.currentTime === currentTime) {
                        this.log(`Video still frozen for ${cameraId}, reloading stream`, 'warning');
                        video.load();
                    }
                }, 1000);
            }
        }, 500);
    }

    // Check for black video issues (Chrome-specific problem)
    checkForBlackVideo(cameraId, video) {
        if (!video.videoWidth || !video.videoHeight) return;

        // Try to detect black video by checking if video is playing but appears black
        if (!video.paused && video.readyState >= 2 && video.currentTime > 0) {
            // Check if we can create a canvas to sample pixels (privacy-conscious approach)
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = 32;
                canvas.height = 18;

                // Draw a small sample of the video
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

                // Get image data for a small sample
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const data = imageData.data;

                // Check if most pixels are black (or very dark)
                let blackPixels = 0;
                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    const brightness = (r + g + b) / 3;
                    if (brightness < 10) blackPixels++;
                }

                const totalPixels = data.length / 4;
                const blackPercentage = (blackPixels / totalPixels) * 100;

                if (blackPercentage > 90) {
                    this.log(`Detected mostly black video for ${cameraId} (${blackPercentage.toFixed(1)}% black)`, 'warning', {
                        cameraId,
                        blackPercentage,
                        videoWidth: video.videoWidth,
                        videoHeight: video.videoHeight
                    });

                    // Try recovery for black video
                    this.recoverFromBlackVideo(cameraId, video);
                }

            } catch (e) {
                // Canvas sampling failed (probably due to CORS), that's okay
                this.log(`Cannot sample video pixels for ${cameraId} (CORS restriction)`, 'debug', { cameraId });
            }
        }
    }

    // Specific recovery for black video issues
    recoverFromBlackVideo(cameraId, video) {
        this.log(`Attempting black video recovery for ${cameraId}`, 'info', { cameraId });

        // Force video refresh by toggling src
        const currentSrc = video.srcObject;
        video.srcObject = null;

        setTimeout(() => {
            if (this.activeStreams.has(cameraId)) {
                video.srcObject = currentSrc;
                this.log(`Re-applied video source for ${cameraId}`, 'info', { cameraId });
            }
        }, 100);
    }
}

// Initialize the client when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new WebRTCSignalingClient();
}); 