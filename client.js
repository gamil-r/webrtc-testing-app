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
        
        // Connection management
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 1000; // Start with 1 second
        this.maxReconnectDelay = 30000; // Max 30 seconds
        this.pingInterval = null;
        this.pongTimeout = null;
        this.lastPongTime = Date.now();
        this.connectionTimeout = 60000; // 60 seconds
        
        this.initializeWebSocket();
        this.setupGlobalStats();
        this.startGlobalStatsUpdate();
        this.initializeFloatingStats();
    }
    
    initializeWebSocket() {
        // Close existing connection if any
        if (this.socket) {
            this.socket.close();
        }
        
        this.socket = new WebSocket('wss://d7f131a4e1eb.ngrok-free.app');
        
        this.socket.onopen = () => {
            this.log('WebSocket connection established', 'success', {
                url: 'wss://d7f131a4e1eb.ngrok-free.app',
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
            this.cameras.get(cameraId).streamId = stream.id;
        }
        
        // Create or update video element
        this.createOrUpdateStreamElement(cameraId, stream);
        
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
        this.log(`Updating streams grid`, 'info', {
            activeStreams: Array.from(this.activeStreams),
            streamElements: Array.from(this.streamElements.keys()),
            timestamp: new Date().toISOString()
        });
        
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
                
                // Send offer to server
                this.sendMessage({
                    type: 'offer',
                    cameraId: cameraId,
                    offer: offer
                });
                
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
        
        // Send ping every 25 seconds (server pings every 30)
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
        }, 25000);
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
            
            const buttonContainer = document.createElement('div');
            buttonContainer.style.display = 'flex';
            buttonContainer.style.gap = '8px';
            
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
                requestCallButton.className = 'call-button';
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
            const camera = this.cameras.get(cameraId);
            if (!stats || !camera) return;
            
            const streamDiv = document.createElement('div');
            streamDiv.className = 'floating-stats-camera';
            
            // Stream header with stream ID
            const headerDiv = document.createElement('div');
            headerDiv.className = 'floating-stats-camera-title';
            
            const statusDiv = document.createElement('div');
            statusDiv.className = 'floating-stats-camera-status';
            
            const titleContainer = document.createElement('div');
            titleContainer.innerHTML = `
                <div style="font-size: 14px; font-weight: bold;">Video Stream</div>
                <div style="font-size: 11px; color: #6c757d; margin-top: 2px;">
                    Camera: ${cameraId} | Stream: ${camera.streamId ? camera.streamId.substring(0, 8) + '...' : 'N/A'}
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
}

// Initialize the client when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new WebRTCSignalingClient();
}); 