class WebRTCSignalingClient {
    constructor() {
        this.socket = null;
        this.peerConnection = null;
        this.remoteVideo = document.getElementById('remoteVideo');
        this.videoPlaceholder = document.getElementById('videoPlaceholder');
        this.connectionStatus = document.getElementById('connectionStatus');
        this.cameraList = document.getElementById('cameraList');
        this.logContainer = document.getElementById('logContainer');
        
        this.cameras = new Map();
        this.currentCameraId = null;
        this.statsInterval = null;
        this.lastBytesReceived = 0;
        this.lastTimestamp = Date.now();
        
        this.initializeWebSocket();
        this.setupPeerConnection();
        this.setupStatsCollection();
    }
    
    initializeWebSocket() {
        this.socket = new WebSocket('ws://localhost:8080');
        
        this.socket.onopen = () => {
            this.log('Connected to signaling server', 'info');
            this.updateConnectionStatus(true);
            
            // Identify as web client
            this.sendMessage({
                type: 'identify',
                clientType: 'web'
            });
        };
        
        this.socket.onclose = () => {
            this.log('Disconnected from signaling server', 'error');
            this.updateConnectionStatus(false);
        };
        
        this.socket.onerror = (error) => {
            this.log(`WebSocket error: ${error}`, 'error');
        };
        
        this.socket.onmessage = (event) => {
            const message = JSON.parse(event.data);
            this.handleMessage(message);
        };
    }
    
    setupPeerConnection() {
        const configuration = {
            iceServers: [
            ]
        };
        
        this.log(`Setting up peer connection with configuration: ${JSON.stringify(configuration)}`, 'info');
        this.peerConnection = new RTCPeerConnection(configuration);
        
        this.peerConnection.addTransceiver('video', { direction: 'recvonly' });
        
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate && this.currentCameraId) {
                this.log(`Generated ICE candidate: ${event.candidate.candidate}`, 'info');
                this.sendMessage({
                    type: 'ice-candidate',
                    cameraId: this.currentCameraId,
                    candidate: event.candidate
                });
            } else if (!event.candidate) {
                this.log('ICE candidate gathering completed', 'info');
            }
        };
        
        this.peerConnection.ontrack = (event) => {
            console.log('ontrack fired', event);
            this.log('🎥 ontrack event fired!', 'info');
            
            const stream = event.streams[0];
            const videoTracks = stream.getVideoTracks();
            const audioTracks = stream.getAudioTracks();
            
            this.log(`📺 Stream ID: ${stream.id}`, 'info');
            this.log(`📹 Video tracks: ${videoTracks.length}`, 'info');
            this.log(`🔊 Audio tracks: ${audioTracks.length}`, 'info');
            
            if (videoTracks.length > 0) {
                const videoTrack = videoTracks[0];
                this.log(`📹 Video track: ${videoTrack.id}, enabled: ${videoTrack.enabled}, readyState: ${videoTrack.readyState}`, 'info');
                this.log(`📹 Video track kind: ${videoTrack.kind}, label: ${videoTrack.label}`, 'info');
                
                // Set the stream
                this.remoteVideo.srcObject = stream;
                this.videoPlaceholder.style.display = 'none';
                
                // Add event listeners to the video element
                this.setupVideoElementDebug();
                
                // Monitor track state changes
                videoTrack.addEventListener('ended', () => {
                    this.log('📹 Video track ended', 'error');
                });
                
                videoTrack.addEventListener('mute', () => {
                    this.log('📹 Video track muted', 'info');
                });
                
                videoTrack.addEventListener('unmute', () => {
                    this.log('📹 Video track unmuted', 'info');
                });
                
            } else {
                console.warn('No video track received!');
                this.log('❌ No video track received in stream!', 'error');
            }
        };
        
        this.peerConnection.onconnectionstatechange = () => {
            this.log(`WebRTC connection state: ${this.peerConnection.connectionState}`, 'info');
            this.updateConnectionStatus(this.peerConnection.connectionState === 'connected');
            this.updateStatValue('connectionState', this.peerConnection.connectionState);
            
            // Start stats collection when connected
            if (this.peerConnection.connectionState === 'connected') {
                this.startStatsCollection();
            } else if (this.peerConnection.connectionState === 'disconnected' || this.peerConnection.connectionState === 'failed') {
                this.stopStatsCollection();
            }
        };
        
        this.peerConnection.oniceconnectionstatechange = async () => {
            this.log(`ICE connection state: ${this.peerConnection.iceConnectionState}`, 'info');
            this.updateStatValue('iceConnectionState', this.peerConnection.iceConnectionState);
            
            if (this.peerConnection.iceConnectionState === 'connected' || this.peerConnection.iceConnectionState === 'completed') {
                const stats = await this.peerConnection.getStats();
                stats.forEach(report => {
                    if (report.type === 'candidate-pair' && report.selected) {
                        console.log('Selected ICE candidate pair:', report);
                        this.log(`Selected ICE candidate pair: local=${report.localCandidateId}, remote=${report.remoteCandidateId}`, 'info');
                    }
                    if (report.type === 'local-candidate') {
                        console.log('Local candidate:', report);
                    }
                    if (report.type === 'remote-candidate') {
                        console.log('Remote candidate:', report);
                    }
                });
                this.startStatsCollection();
            }
        };
        
        this.peerConnection.onicegatheringstatechange = () => {
            this.log(`ICE gathering state: ${this.peerConnection.iceGatheringState}`, 'info');
        };
        
        this.peerConnection.onsignalingstatechange = () => {
            this.log(`Signaling state: ${this.peerConnection.signalingState}`, 'info');
        };
        
        this.peerConnection.ondatachannel = (event) => {
            this.log(`Data channel received: ${event.channel.label}`, 'info');
        };
    }
    
    handleMessage(message) {
        this.log(`Received: ${message.type}`, 'info');
        
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
                this.log(`Unknown message type: ${message.type}`, 'error');
        }
    }
    
    handleCameraRegistration(cameraId) {
        if (!this.cameras.has(cameraId)) {
            this.cameras.set(cameraId, { id: cameraId, connected: true });
            this.updateCameraList();
            this.log(`Camera registered: ${cameraId}`, 'info');
        }
    }
    
    handleCameraDisconnection(cameraId) {
        if (this.cameras.has(cameraId)) {
            this.cameras.delete(cameraId);
            this.updateCameraList();
            this.log(`Camera disconnected: ${cameraId}`, 'info');
        }
    }
    
    handleOffer(cameraId, offer) {
        this.log(`Received offer from camera ${cameraId}`, 'info');
        this.log(`Offer SDP type: ${offer.type}`, 'info');
        this.log(`Offer SDP length: ${offer.sdp.length} chars`, 'info');
        this.logSdp('RECEIVED OFFER', offer.sdp);
        this.currentCameraId = cameraId;
        
        this.log('Setting remote description (offer)...', 'info');
        this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
            .then(() => {
                this.log('Remote description set successfully', 'info');
                this.log('Creating answer...', 'info');
                return this.peerConnection.createAnswer();
            })
            .then((answer) => {
                this.log(`Created answer - SDP type: ${answer.type}`, 'info');
                this.log(`Answer SDP length: ${answer.sdp.length} chars`, 'info');
                this.logSdp('CREATED ANSWER', answer.sdp);
                this.log('Setting local description (answer)...', 'info');
                return this.peerConnection.setLocalDescription(answer);
            })
            .then(() => {
                this.log('Local description set successfully', 'info');
                this.log('Sending answer to server...', 'info');
                this.sendMessage({
                    type: 'answer',
                    cameraId: cameraId,
                    answer: this.peerConnection.localDescription
                });
            })
            .catch((error) => {
                this.log(`Error handling offer: ${error.message}`, 'error');
                this.log(`Error stack: ${error.stack}`, 'error');
            });
    }
    
    handleAnswer(cameraId, answer) {
        this.log(`Received answer from camera ${cameraId}`, 'info');
        this.log(`Answer SDP type: ${answer.type}`, 'info');
        this.log(`Answer SDP length: ${answer.sdp.length} chars`, 'info');
        this.logSdp('RECEIVED ANSWER', answer.sdp);
        
        this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer))
            .then(() => {
                this.log('Remote description (answer) set successfully', 'info');
            })
            .catch((error) => {
                this.log(`Error handling answer: ${error.message}`, 'error');
                this.log(`Error stack: ${error.stack}`, 'error');
            });
    }
    
    handleIceCandidate(cameraId, candidate) {
        this.log(`Received ICE candidate from camera ${cameraId}`, 'info');
        this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
            .catch((error) => {
                this.log(`Error adding ICE candidate: ${error}`, 'error');
            });
    }
    
    handleIceServers(iceServers) {
        this.log(`Received ICE servers: ${iceServers.length} servers`, 'info');
        // Update peer connection configuration if needed
    }
    
    callCamera(cameraId) {
        this.log(`Calling camera: ${cameraId}`, 'info');
        this.currentCameraId = cameraId;
        
        // Send call-request and wait for offer from Android
        this.log('Sending call-request to camera and waiting for offer...', 'info');
        this.sendMessage({
            type: 'call-request',
            cameraId: cameraId
        });
    }
    
    sendMessage(message) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(message));
            this.log(`Sent: ${message.type}`, 'info');
        } else {
            this.log('WebSocket not connected', 'error');
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
            emptyItem.textContent = 'No cameras registered';
            emptyItem.style.color = '#6c757d';
            emptyItem.style.fontStyle = 'italic';
            emptyItem.style.padding = '10px';
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
            callButton.className = 'call-button';
            callButton.textContent = 'Call';
            callButton.onclick = () => this.callCamera(cameraId);
            
            listItem.appendChild(cameraInfo);
            listItem.appendChild(callButton);
            this.cameraList.appendChild(listItem);
        }
    }
    
    log(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;
        logEntry.textContent = `[${timestamp}] ${message}`;
        
        this.logContainer.appendChild(logEntry);
        this.logContainer.scrollTop = this.logContainer.scrollHeight;
        
        // Keep only last 50 log entries
        while (this.logContainer.children.length > 50) {
            this.logContainer.removeChild(this.logContainer.firstChild);
        }
    }
    
    logSdp(title, sdp) {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry info';
        logEntry.style.marginBottom = '10px';
        
        const titleElement = document.createElement('div');
        titleElement.textContent = `[${timestamp}] ${title}:`;
        titleElement.style.fontWeight = 'bold';
        titleElement.style.color = '#007bff';
        
        const sdpElement = document.createElement('pre');
        sdpElement.textContent = sdp;
        sdpElement.style.fontSize = '10px';
        sdpElement.style.backgroundColor = '#f8f9fa';
        sdpElement.style.padding = '8px';
        sdpElement.style.borderRadius = '4px';
        sdpElement.style.border = '1px solid #dee2e6';
        sdpElement.style.whiteSpace = 'pre-wrap';
        sdpElement.style.wordBreak = 'break-word';
        sdpElement.style.marginTop = '4px';
        sdpElement.style.maxHeight = '200px';
        sdpElement.style.overflowY = 'auto';
        
        logEntry.appendChild(titleElement);
        logEntry.appendChild(sdpElement);
        
        this.logContainer.appendChild(logEntry);
        this.logContainer.scrollTop = this.logContainer.scrollHeight;
        
        // Keep only last 50 log entries
        while (this.logContainer.children.length > 50) {
            this.logContainer.removeChild(this.logContainer.firstChild);
                 }
     }
     
     setupStatsCollection() {
         // Initialize stats display
         this.updateStatValue('connectionState', 'new');
         this.updateStatValue('iceConnectionState', 'new');
         this.updateStatValue('bytesReceived', '0');
         this.updateStatValue('packetsReceived', '0');
         this.updateStatValue('framesReceived', '0');
         this.updateStatValue('frameRate', '0 fps');
         this.updateStatValue('resolution', '0x0');
         this.updateStatValue('codec', 'none');
         this.updateStatValue('bandwidth', '0 kbps');
     }
     
     updateStatValue(statId, value) {
         const element = document.getElementById(statId);
         if (element) {
             element.textContent = value;
         }
     }
     
     startStatsCollection() {
         if (this.statsInterval) {
             clearInterval(this.statsInterval);
         }
         
         this.log('Starting WebRTC statistics collection', 'info');
         this.statsInterval = setInterval(async () => {
             await this.collectStats();
         }, 1000); // Update every second
     }
     
     stopStatsCollection() {
         if (this.statsInterval) {
             clearInterval(this.statsInterval);
             this.statsInterval = null;
             this.log('Stopped WebRTC statistics collection', 'info');
         }
     }
     
     async collectStats() {
         try {
             const stats = await this.peerConnection.getStats();
             let inboundRtpStats = null;
             let codecStats = null;
             let candidatePairStats = null;
             
             // Detailed logging of all stats (for debugging)
             let statsLog = [];
             
             stats.forEach(report => {
                 if (report.type === 'inbound-rtp' && report.kind === 'video') {
                     inboundRtpStats = report;
                     statsLog.push(`📈 inbound-rtp: bytes=${report.bytesReceived}, packets=${report.packetsReceived}, frames=${report.framesReceived}`);
                 } else if (report.type === 'codec' && report.mimeType && report.mimeType.includes('video')) {
                     codecStats = report;
                     statsLog.push(`🎬 codec: ${report.mimeType}, payloadType=${report.payloadType}`);
                 } else if (report.type === 'candidate-pair' && report.selected) {
                     candidatePairStats = report;
                     statsLog.push(`🔗 candidate-pair: state=${report.state}, bytes sent=${report.bytesSent}, bytes received=${report.bytesReceived}`);
                 } else if (report.type === 'track' && report.kind === 'video') {
                     statsLog.push(`📹 track: ${report.trackIdentifier}, framesSent=${report.framesSent}, framesReceived=${report.framesReceived}`);
                 } else if (report.type === 'media-source' && report.kind === 'video') {
                     statsLog.push(`📺 media-source: width=${report.width}, height=${report.height}, frames=${report.frames}`);
                 }
             });
             
             // Log detailed stats every 5 seconds for debugging
             if (Date.now() % 5000 < 1000) {
                 statsLog.forEach(log => this.log(log, 'info'));
             }
             
             if (inboundRtpStats) {
                 // Update bytes and packets received
                 const bytesReceived = inboundRtpStats.bytesReceived || 0;
                 const packetsReceived = inboundRtpStats.packetsReceived || 0;
                 const framesReceived = inboundRtpStats.framesReceived || 0;
                 const packetsLost = inboundRtpStats.packetsLost || 0;
                 
                 this.updateStatValue('bytesReceived', bytesReceived.toLocaleString());
                 this.updateStatValue('packetsReceived', packetsReceived.toLocaleString());
                 this.updateStatValue('framesReceived', framesReceived.toLocaleString());
                 
                 // Calculate bandwidth
                 const currentTime = Date.now();
                 const timeDiff = (currentTime - this.lastTimestamp) / 1000; // seconds
                 const bytesDiff = bytesReceived - this.lastBytesReceived;
                 const bandwidth = timeDiff > 0 ? Math.round((bytesDiff * 8) / timeDiff / 1000) : 0; // kbps
                 
                 this.updateStatValue('bandwidth', `${bandwidth} kbps`);
                 this.lastBytesReceived = bytesReceived;
                 this.lastTimestamp = currentTime;
                 
                 // Update frame rate
                 const frameRate = inboundRtpStats.framesPerSecond || 0;
                 this.updateStatValue('frameRate', `${frameRate} fps`);
                 
                 // Update resolution
                 const width = inboundRtpStats.frameWidth || 0;
                 const height = inboundRtpStats.frameHeight || 0;
                 this.updateStatValue('resolution', `${width}x${height}`);
                 
                 // Enhanced logging for troubleshooting
                 if (bytesReceived === 0) {
                     this.log('❌ No video data received - check if sender is actually streaming', 'error');
                 } else if (packetsReceived === 0) {
                     this.log('❌ No video packets received - possible network issue', 'error');
                 } else if (framesReceived === 0) {
                     this.log('❌ No video frames received - possible codec/decoding issue', 'error');
                 } else if (packetsLost > 0) {
                     this.log(`⚠️ Packet loss detected: ${packetsLost} packets lost`, 'info');
                 }
                 
                 // Log if we're receiving data but no video
                 if (bytesReceived > 0 && bandwidth > 0) {
                     this.log(`✅ Receiving video data: ${bandwidth} kbps, ${framesReceived} frames`, 'info');
                     if (!this.remoteVideo.srcObject) {
                         this.log(`⚠️ Video data flowing but no stream set on video element!`, 'error');
                     }
                 }
             } else {
                 this.log('❌ No inbound-rtp video stats found - video track may not be established', 'error');
             }
             
             if (codecStats) {
                 const codec = codecStats.mimeType || 'unknown';
                 this.updateStatValue('codec', codec);
                 this.log(`🎬 Video codec: ${codec}`, 'info');
             }
             
             if (candidatePairStats) {
                 const pairState = candidatePairStats.state;
                 const totalBytes = candidatePairStats.bytesReceived || 0;
                 if (totalBytes === 0 && pairState === 'succeeded') {
                     this.log('⚠️ ICE connected but no bytes flowing through candidate pair', 'info');
                 }
             }
             
         } catch (error) {
             this.log(`Error collecting stats: ${error.message}`, 'error');
         }
     }
     
     setupVideoElementDebug() {
         // Add comprehensive video element event listeners
         const video = this.remoteVideo;
         
         video.addEventListener('loadstart', () => {
             this.log('📹 Video: loadstart - started loading', 'info');
         });
         
         video.addEventListener('loadedmetadata', () => {
             this.log(`📹 Video: loadedmetadata - ${video.videoWidth}x${video.videoHeight}, duration: ${video.duration}`, 'info');
         });
         
         video.addEventListener('loadeddata', () => {
             this.log('📹 Video: loadeddata - first frame loaded', 'info');
         });
         
         video.addEventListener('canplay', () => {
             this.log('📹 Video: canplay - can start playing', 'info');
         });
         
         video.addEventListener('canplaythrough', () => {
             this.log('📹 Video: canplaythrough - can play without interruption', 'info');
         });
         
         video.addEventListener('playing', () => {
             this.log('📹 Video: playing - playback started', 'info');
         });
         
         video.addEventListener('waiting', () => {
             this.log('📹 Video: waiting - buffering', 'info');
         });
         
         video.addEventListener('error', (e) => {
             this.log(`📹 Video: error - ${video.error ? video.error.message : 'unknown error'}`, 'error');
         });
         
         video.addEventListener('stalled', () => {
             this.log('📹 Video: stalled - playback stalled', 'error');
         });
         
         video.addEventListener('suspend', () => {
             this.log('📹 Video: suspend - loading suspended', 'info');
         });
         
         video.addEventListener('abort', () => {
             this.log('📹 Video: abort - loading aborted', 'error');
         });
         
         // Check video state periodically
         const checkVideoState = () => {
             const state = {
                 readyState: video.readyState,
                 networkState: video.networkState,
                 currentTime: video.currentTime,
                 buffered: video.buffered.length,
                 paused: video.paused,
                 ended: video.ended,
                 videoWidth: video.videoWidth,
                 videoHeight: video.videoHeight
             };
             this.log(`📹 Video state: readyState=${state.readyState}, networkState=${state.networkState}, size=${state.videoWidth}x${state.videoHeight}, paused=${state.paused}`, 'info');
         };
         
         // Check state every 5 seconds
         setInterval(checkVideoState, 5000);
     }
 }
 
 // Initialize the client when the page loads
 document.addEventListener('DOMContentLoaded', () => {
     new WebRTCSignalingClient();
 }); 