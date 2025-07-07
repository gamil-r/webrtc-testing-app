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
        
        this.initializeWebSocket();
        this.setupGlobalStats();
        this.startGlobalStatsUpdate();
    }
    
    initializeWebSocket() {
        this.socket = new WebSocket('ws://localhost:8080');
        
        this.socket.onopen = () => {
            this.log('WebSocket connection established', 'success', {
                url: 'ws://localhost:8080',
                readyState: this.socket.readyState,
                timestamp: new Date().toISOString()
            });
            this.updateConnectionStatus(true);
            
            // Identify as web client
            this.sendMessage({
                type: 'identify',
                clientType: 'web'
            });
        };
        
        this.socket.onclose = (event) => {
            this.log('WebSocket connection closed', 'error', {
                code: event.code,
                reason: event.reason,
                wasClean: event.wasClean,
                timestamp: new Date().toISOString()
            });
            this.updateConnectionStatus(false);
            this.handleDisconnection();
        };
        
        this.socket.onerror = (error) => {
            this.log('WebSocket error occurred', 'error', {
                error: error.message || 'Unknown error',
                timestamp: new Date().toISOString()
            });
        };
        
        this.socket.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
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
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        };
        
        this.log(`Setting up peer connection for camera ${cameraId}`, 'info', {
            cameraId,
            configuration,
            timestamp: new Date().toISOString()
        });
        
        const peerConnection = new RTCPeerConnection(configuration);
        
        peerConnection.addTransceiver('video', { direction: 'recvonly' });
        
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.log(`ICE candidate generated for camera ${cameraId}`, 'info', {
                    cameraId,
                    candidate: event.candidate.candidate,
                    sdpMLineIndex: event.candidate.sdpMLineIndex,
                    sdpMid: event.candidate.sdpMid,
                    timestamp: new Date().toISOString()
                });
                
                this.sendMessage({
                    type: 'ice-candidate',
                    cameraId: cameraId,
                    candidate: event.candidate
                });
            } else {
                this.log(`ICE candidate gathering completed for camera ${cameraId}`, 'info', {
                    cameraId,
                    timestamp: new Date().toISOString()
                });
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
                this.stopStatsCollection(cameraId);
                this.handleStreamEnded(cameraId);
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
            timestamp: new Date().toISOString()
        });
        
        switch (message.type) {
            case 'register-camera':
                this.handleCameraRegistration(message.cameraId);
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
            default:
                this.log(`Unknown message type received`, 'warning', {
                    messageType: message.type,
                    timestamp: new Date().toISOString()
                });
        }
    }
    
    handleCameraRegistration(cameraId) {
        if (!this.cameras.has(cameraId)) {
            this.cameras.set(cameraId, { 
                id: cameraId, 
                connected: true, 
                streaming: false,
                registeredAt: new Date().toISOString()
            });
            
            this.log(`Camera registered successfully`, 'success', {
                cameraId,
                totalCameras: this.cameras.size,
                timestamp: new Date().toISOString()
            });
            
            this.updateCameraList();
            this.updateGlobalStats();
        }
    }
    
    handleCameraDisconnection(cameraId) {
        if (this.cameras.has(cameraId)) {
            this.log(`Camera disconnected`, 'warning', {
                cameraId,
                wasStreaming: this.cameras.get(cameraId).streaming,
                timestamp: new Date().toISOString()
            });
            
            this.cameras.delete(cameraId);
            this.handleStreamEnded(cameraId);
            this.updateCameraList();
            this.updateGlobalStats();
        }
    }
    
    handleOffer(cameraId, offer) {
        this.log(`Offer received from camera ${cameraId}`, 'info', {
            cameraId,
            sdpType: offer.type,
            sdpLength: offer.sdp.length,
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
            .then(() => {
                this.log(`Local description set for camera ${cameraId}`, 'success', {
                    cameraId,
                    timestamp: new Date().toISOString()
                });
                
                this.sendMessage({
                    type: 'answer',
                    cameraId: cameraId,
                    answer: peerConnection.localDescription
                });
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
    }
    
    handleStreamReceived(cameraId, stream) {
        this.log(`Media stream received from camera ${cameraId}`, 'success', {
            cameraId,
            streamId: stream.id,
            videoTracks: stream.getVideoTracks().length,
            audioTracks: stream.getAudioTracks().length,
            timestamp: new Date().toISOString()
        });
        
        // Update camera streaming state
        if (this.cameras.has(cameraId)) {
            this.cameras.get(cameraId).streaming = true;
        }
        
        // Create or update video element
        this.createOrUpdateStreamElement(cameraId, stream);
        
        // Update UI
        this.activeStreams.add(cameraId);
        this.updateCameraList();
        this.updateGlobalStats();
        this.updateStreamsGrid();
    }
    
    handleStreamEnded(cameraId) {
        this.log(`Stream ended for camera ${cameraId}`, 'warning', {
            cameraId,
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
        
        // Remove stream element
        if (this.streamElements.has(cameraId)) {
            const element = this.streamElements.get(cameraId);
            if (element.parentNode) {
                element.parentNode.remove();
            }
            this.streamElements.delete(cameraId);
        }
        
        // Stop stats collection
        this.stopStatsCollection(cameraId);
        
        // Update UI
        this.updateCameraList();
        this.updateGlobalStats();
        this.updateStreamsGrid();
    }
    
    createOrUpdateStreamElement(cameraId, stream) {
        let streamContainer = this.streamElements.get(cameraId);
        
        if (!streamContainer) {
            // Create new stream container
            streamContainer = document.createElement('div');
            streamContainer.className = 'stream-container';
            
            // Create video element
            const video = document.createElement('video');
            video.className = 'stream-video';
            video.autoplay = true;
            video.playsinline = true;
            video.muted = true;
            
            // Create status indicator (top left)
            const statusOverlay = document.createElement('div');
            statusOverlay.className = 'stream-overlay';
            
            const streamStatus = document.createElement('div');
            streamStatus.className = 'stream-status connected';
            statusOverlay.appendChild(streamStatus);
            
            // Create camera label (bottom right)
            const streamInfo = document.createElement('div');
            streamInfo.className = 'stream-info';
            streamInfo.textContent = `Camera ${cameraId}`;
            
            streamContainer.appendChild(video);
            streamContainer.appendChild(statusOverlay);
            streamContainer.appendChild(streamInfo);
            
            this.streamElements.set(cameraId, streamContainer);
        }
        
        // Set stream
        const video = streamContainer.querySelector('.stream-video');
        video.srcObject = stream;
        
        // Update status
        const status = streamContainer.querySelector('.stream-status');
        status.className = 'stream-status connected';
    }
    
    updateStreamsGrid() {
        // Clear existing content
        this.streamsGrid.innerHTML = '';
        
        if (this.activeStreams.size === 0) {
            const noStreams = document.createElement('div');
            noStreams.className = 'no-streams';
            noStreams.textContent = 'No active streams. Connect to a camera to start streaming.';
            this.streamsGrid.appendChild(noStreams);
        } else {
            // Add all active stream elements
            for (const cameraId of this.activeStreams) {
                const streamElement = this.streamElements.get(cameraId);
                if (streamElement) {
                    this.streamsGrid.appendChild(streamElement);
                }
            }
        }
    }
    
    callCamera(cameraId) {
        const camera = this.cameras.get(cameraId);
        if (!camera) return;
        
        if (camera.streaming) {
            // Hang up
            this.log(`Hanging up call to camera ${cameraId}`, 'info', {
                cameraId,
                timestamp: new Date().toISOString()
            });
            
            this.handleStreamEnded(cameraId);
        } else {
            // Start call
            this.log(`Initiating call to camera ${cameraId}`, 'info', {
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
                timestamp: new Date().toISOString()
            });
        }
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
            cameraInfo.style.display = 'flex';
            cameraInfo.style.alignItems = 'center';
            cameraInfo.style.gap = '8px';
            
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
            
            const callButton = document.createElement('button');
            callButton.className = camera.streaming ? 'call-button hang-up' : 'call-button';
            callButton.textContent = camera.streaming ? 'Hang Up' : 'Call';
            callButton.onclick = () => this.callCamera(cameraId);
            
            listItem.appendChild(cameraInfo);
            listItem.appendChild(callButton);
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
        this.updateStatValue('connectionState', 'disconnected');
        this.updateStatValue('iceConnectionState', 'new');
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
        const peerConnection = this.peerConnections.get(cameraId);
        if (!peerConnection) return;
        
        try {
            const stats = await peerConnection.getStats();
            let inboundRtpStats = null;
            
            stats.forEach(report => {
                if (report.type === 'inbound-rtp' && report.kind === 'video') {
                    inboundRtpStats = report;
                }
            });
            
            if (inboundRtpStats) {
                const currentStats = {
                    bytesReceived: inboundRtpStats.bytesReceived || 0,
                    packetsReceived: inboundRtpStats.packetsReceived || 0,
                    framesReceived: inboundRtpStats.framesReceived || 0,
                    frameRate: inboundRtpStats.framesPerSecond || 0,
                    bandwidth: 0,
                    timestamp: Date.now()
                };
                
                // Calculate bandwidth
                const previousStats = this.streamStats.get(cameraId);
                if (previousStats) {
                    const timeDiff = (currentStats.timestamp - previousStats.timestamp) / 1000;
                    const bytesDiff = currentStats.bytesReceived - previousStats.bytesReceived;
                    currentStats.bandwidth = timeDiff > 0 ? Math.round((bytesDiff * 8) / timeDiff / 1000) : 0;
                }
                
                this.streamStats.set(cameraId, currentStats);
                
                // Log detailed stats every 5 seconds
                if (Date.now() % 5000 < 1000) {
                    this.log(`Statistics for camera ${cameraId}`, 'info', {
                        cameraId,
                        ...currentStats,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        } catch (error) {
            this.log(`Error collecting statistics for camera ${cameraId}`, 'error', {
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
    
    handleDisconnection() {
        // Clean up all connections
        for (const [cameraId, peerConnection] of this.peerConnections) {
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
        
        // Reset camera states
        for (const [cameraId, camera] of this.cameras) {
            camera.streaming = false;
            camera.connected = false;
        }
        
        // Update UI
        this.updateCameraList();
        this.updateGlobalStats();
        this.updateStreamsGrid();
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
            dataSpan.textContent = JSON.stringify(data, null, 2);
            logEntry.appendChild(dataSpan);
        }
        
        this.logContainer.appendChild(logEntry);
        this.logContainer.scrollTop = this.logContainer.scrollHeight;
        
        // Keep only last 100 log entries
        while (this.logContainer.children.length > 100) {
            this.logContainer.removeChild(this.logContainer.firstChild);
        }
    }
}

// Initialize the client when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new WebRTCSignalingClient();
}); 