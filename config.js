// WebRTC Signaling Client Configuration
const CONFIG = {
    // WebSocket Server Configuration
    WEBSOCKET: {
        // Default to localhost for local development
        URL: 'ws://192.168.68.56:8080',
        
        // Alternative URLs for different environments
        // Uncomment the one you want to use:
        
        // For local development (default)
        // URL: 'ws://localhost:8080',
        
        // For ngrok tunneling (replace with your ngrok URL)
        // URL: 'wss://your-ngrok-url.ngrok-free.app',
        
        // For production deployment
        // URL: 'wss://your-domain.com',
        
        // Connection settings
        RECONNECT_ATTEMPTS: 10,
        RECONNECT_BASE_DELAY: 1000, // 1 second
        RECONNECT_MAX_DELAY: 30000, // 30 seconds
        PING_INTERVAL: 25000, // 25 seconds
        CONNECTION_TIMEOUT: 60000 // 60 seconds
    },
    
    // ICE servers used for gathering candidates (STUN/TURN)
    // Add your TURN servers here for better connectivity behind restrictive NATs
    ICE_SERVERS: [
        // Google STUN servers
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        // Additional STUN servers to get more server reflexive candidates
        { urls: 'stun:stun.services.mozilla.com' },
        { urls: 'stun:stun.stunprotocol.org:3478' }

        // Example TURN configuration (replace with real TURN server and credentials)
        // Without TURN, you'll only get host and srflx candidates
        // ,{
        //     urls: 'turn:your-turn-server:3478',
        //     username: 'user',
        //     credential: 'pass'
        // }
    ],

    // Video Quality Settings
    VIDEO: {
        // Preferred codec order (H.265 first for better compression)
        PREFERRED_CODECS: ['H265', 'HEVC', 'H264', 'VP9', 'VP8'],
        
        // Statistics collection interval
        STATS_INTERVAL: 1000, // 1 second
        
        // Quality thresholds for color coding
        THRESHOLDS: {
            PACKET_LOSS: {
                GOOD: 0,
                WARNING: 1,
                ERROR: 2
            },
            FREEZE_RATE: {
                GOOD: 0,
                WARNING: 1,
                ERROR: 3
            },
            PLI_RATE: {
                GOOD: 0,
                WARNING: 1,
                ERROR: 3
            },
            NACK_RATE: {
                GOOD: 0,
                WARNING: 1,
                ERROR: 5
            }
        }
    },
    
    // UI Settings
    UI: {
        // Floating stats panel settings
        FLOATING_STATS: {
            COLLAPSED_ON_MOBILE: true,
            UPDATE_INTERVAL: 1000
        },
        
        // Log settings
        LOG: {
            MAX_ENTRIES: 100,
            DETAILED_STATS_INTERVAL: 5000
        }
    },
    
    // Development settings
    DEV: {
        // Enable detailed logging
        VERBOSE_LOGGING: true,
        
        // Show all WebRTC internals stats
        SHOW_ALL_STATS: false
    }
};

// Make config available globally
if (typeof window !== 'undefined') {
    window.CONFIG = CONFIG;
} else if (typeof module !== 'undefined' && module.exports) {
    module.exports = CONFIG;
} 
