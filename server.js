const express = require('express');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const app = express();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// Rate limiting: Track requests per user
const userRequestTracker = new Map();
const USER_REQUEST_LIMIT = 10;
const USER_REQUEST_WINDOW = 10000;

// Request queue for short requests ONLY (not streaming)
const requestQueue = [];
let isProcessingQueue = false;
const MIN_REQUEST_INTERVAL = 200;
let lastRequestTime = 0;

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Process request queue
async function processQueue() {
  if (isProcessingQueue || requestQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;

  while (requestQueue.length > 0) {
    const { url, headers, resolve, reject } = requestQueue.shift();

    const timeSinceLastRequest = Date.now() - lastRequestTime;
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
      const delay = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    try {
      lastRequestTime = Date.now();
      const response = await fetch(url, { headers });
      resolve(response);
    } catch (error) {
      reject(error);
    }
  }

  isProcessingQueue = false;
}

function queueRequest(url, headers) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ url, headers, resolve, reject });
    processQueue();
  });
}

// ============================================
// MPEG-TS PTS Normalizer
// ============================================
class MPEGTSNormalizer {
  constructor() {
    this.firstPTS = null;
    this.firstDTS = null;
    this.ptsOffset = 0;
    this.dtsOffset = 0;
  }

  normalizePacket(packet) {
    if (packet.length !== 188 || packet[0] !== 0x47) {
      return packet;
    }

    const payloadUnitStartIndicator = (packet[1] & 0x40) !== 0;
    const adaptationFieldControl = (packet[3] & 0x30) >> 4;
    
    if (adaptationFieldControl === 2) {
      return packet;
    }

    let payloadStart = 4;
    if (adaptationFieldControl === 3) {
      const adaptationFieldLength = packet[4];
      payloadStart = 5 + adaptationFieldLength;
    }

    if (!payloadUnitStartIndicator || payloadStart + 9 >= 188) {
      return packet;
    }

    if (packet[payloadStart] !== 0x00 || 
        packet[payloadStart + 1] !== 0x00 || 
        packet[payloadStart + 2] !== 0x01) {
      return packet;
    }

    const pesHeaderDataLength = packet[payloadStart + 8];
    const ptsDtsFlags = (packet[payloadStart + 7] & 0xC0) >> 6;
    
    if (ptsDtsFlags === 0 || payloadStart + 9 + pesHeaderDataLength >= 188) {
      return packet;
    }

    const modifiedPacket = Buffer.from(packet);
    let ptsPosition = payloadStart + 9;

    if (ptsDtsFlags === 2 || ptsDtsFlags === 3) {
      const pts = this.extractPTS(packet, ptsPosition);
      
      if (pts !== null) {
        if (this.firstPTS === null) {
          this.firstPTS = pts;
          this.ptsOffset = pts;
          console.log(`[${new Date().toISOString()}] PTS Normalizer: First PTS=${pts}, offset set`);
        }

        const normalizedPTS = pts - this.ptsOffset;
        this.writePTS(modifiedPacket, ptsPosition, normalizedPTS, ptsDtsFlags === 3 ? 3 : 2);
      }

      if (ptsDtsFlags === 3 && ptsPosition + 5 + 5 <= payloadStart + 9 + pesHeaderDataLength) {
        const dtsPosition = ptsPosition + 5;
        const dts = this.extractDTS(packet, dtsPosition);
        
        if (dts !== null) {
          if (this.firstDTS === null) {
            this.firstDTS = dts;
            this.dtsOffset = dts;
          }

          const normalizedDTS = dts - this.dtsOffset;
          this.writeDTS(modifiedPacket, dtsPosition, normalizedDTS);
        }
      }
    }

    return modifiedPacket;
  }

  extractPTS(packet, position) {
    try {
      const pts = (
        ((packet[position] & 0x0E) << 29) |
        (packet[position + 1] << 22) |
        ((packet[position + 2] & 0xFE) << 14) |
        (packet[position + 3] << 7) |
        (packet[position + 4] >> 1)
      ) >>> 0;
      return pts;
    } catch (e) {
      return null;
    }
  }

  extractDTS(packet, position) {
    return this.extractPTS(packet, position);
  }

  writePTS(packet, position, pts, marker) {
    const markerBits = marker << 4;
    packet[position] = markerBits | ((pts >> 29) & 0x0E) | 0x01;
    packet[position + 1] = (pts >> 22) & 0xFF;
    packet[position + 2] = ((pts >> 14) & 0xFE) | 0x01;
    packet[position + 3] = (pts >> 7) & 0xFF;
    packet[position + 4] = ((pts << 1) & 0xFE) | 0x01;
  }

  writeDTS(packet, position, dts) {
    packet[position] = 0x11 | ((dts >> 29) & 0x0E);
    packet[position + 1] = (dts >> 22) & 0xFF;
    packet[position + 2] = ((dts >> 14) & 0xFE) | 0x01;
    packet[position + 3] = (dts >> 7) & 0xFF;
    packet[position + 4] = ((dts << 1) & 0xFE) | 0x01;
  }

  reset() {
    this.firstPTS = null;
    this.firstDTS = null;
    this.ptsOffset = 0;
    this.dtsOffset = 0;
  }
}

// ============================================
// Simple HLS Streaming (No Shared State)
// ============================================
// StreamManager removed - each request gets independent stream

// ============================================
// HLS Playlist Endpoint (Simplified - No StreamManager)
// ============================================
app.get('/stream/:token.m3u8', async (req, res) => {
  try {
    let { token } = req.params;
    
    if (!token || !JWT_SECRET) {
      return res.status(400).json({ error: 'Missing token or JWT secret' });
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      console.error(`[${new Date().toISOString()}] Invalid JWT for m3u8:`, jwtError.message);
      return res.status(403).json({ error: 'Invalid token' });
    }

    if (payload.type !== 'stream' || !payload.streamUrl) {
      return res.status(403).json({ error: 'Invalid token type' });
    }

    console.log(`[${new Date().toISOString()}] HLS Playlist request: userId=${payload.userId}, ch=${payload.channelId}`);

    // Simple static playlist pointing to continuous live.ts stream
    const baseUrl = req.protocol + '://' + req.get('host');
    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:3600',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:3600.000,',
      `${baseUrl}/stream/${token}/live.ts`
    ].join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    
    res.send(playlist);
    console.log(`[${new Date().toISOString()}] HLS Playlist sent (simple continuous stream)`);

  } catch (error) {
    console.error(`[${new Date().toISOString()}] HLS playlist error:`, error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Playlist error' });
    }
  }
});

// ============================================
// HLS Normalized Stream Endpoint (IMPROVED)
// ============================================
app.get('/stream/:token/live.ts', async (req, res) => {
  try {
    let { token } = req.params;
    
    if (!token || !JWT_SECRET) {
      return res.status(400).json({ error: 'Missing parameters' });
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      console.error(`[${new Date().toISOString()}] Invalid JWT:`, jwtError.message);
      return res.status(403).json({ error: 'Invalid token' });
    }

    if (payload.type !== 'stream' || !payload.streamUrl) {
      return res.status(403).json({ error: 'Invalid payload' });
    }

    // Rate limiting
    const userId = payload.userId;
    const now = Date.now();
    
    if (!userRequestTracker.has(userId)) {
      userRequestTracker.set(userId, []);
    }
    
    const userRequests = userRequestTracker.get(userId);
    const recentRequests = userRequests.filter(time => now - time < USER_REQUEST_WINDOW);
    
    if (recentRequests.length >= USER_REQUEST_LIMIT) {
      console.warn(`[${new Date().toISOString()}] Rate limit: user ${userId}`);
      return res.status(429).json({ error: 'Too many requests' });
    }
    
    recentRequests.push(now);
    userRequestTracker.set(userId, recentRequests);

    const streamUrl = payload.streamUrl;
    const allowedDomain = 'vpn.streamhut.xyz';
    const parsedUrl = new URL(streamUrl);
    
    if (parsedUrl.hostname !== allowedDomain) {
      console.error(`[${new Date().toISOString()}] Domain not allowed: ${parsedUrl.hostname}`);
      return res.status(403).json({ error: 'Domain not allowed' });
    }

    console.log(`[${new Date().toISOString()}] HLS Stream START: user=${payload.userId}, ch=${payload.channelId}`);

    // Response headers (set before streaming starts)
    res.status(200);
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Create normalizer (persists across reconnections for continuous timestamps)
    const normalizer = new MPEGTSNormalizer();
    let packetBuffer = Buffer.alloc(0);
    let totalPacketsProcessed = 0;
    let totalBytesReceived = 0;
    let lastLogTime = Date.now();
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 20;
    let keepStreaming = true;

    // Handle client disconnect
    req.on('close', () => {
      console.log(`[${new Date().toISOString()}] Client disconnected`);
      keepStreaming = false;
    });

    console.log(`[${new Date().toISOString()}] Starting streaming with auto-reconnect`);

    // Reconnection loop
    while (keepStreaming && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      try {
        // Connect to portal
        const portalResponse = await fetch(streamUrl, {
          headers: {
            'User-Agent': 'StreamNexus-Proxy/1.0',
            'Connection': 'keep-alive',
            ...(req.headers.range ? { 'Range': req.headers.range } : {})
          },
          timeout: 30000
        });

        if (!portalResponse.ok) {
          console.error(`[${new Date().toISOString()}] Portal error: ${portalResponse.status}, reconnecting...`);
          reconnectAttempts++;
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }

        console.log(`[${new Date().toISOString()}] Portal connected (attempt ${reconnectAttempts + 1})`);
        
        let sessionPackets = 0;
        let sessionBytes = 0;

        // Process stream
        for await (const chunk of portalResponse.body) {
          if (!keepStreaming) break;

          sessionBytes += chunk.length;
          totalBytesReceived += chunk.length;
          packetBuffer = Buffer.concat([packetBuffer, chunk]);

          // Process complete 188-byte packets
          while (packetBuffer.length >= 188) {
            const packet = packetBuffer.slice(0, 188);
            packetBuffer = packetBuffer.slice(188);

            const normalizedPacket = normalizer.normalizePacket(packet);
            
            // Send to client with back pressure handling
            if (!res.write(normalizedPacket)) {
              await new Promise(resolve => res.once('drain', resolve));
            }
            
            sessionPackets++;
            totalPacketsProcessed++;

            // Log progress every 5 seconds
            if (Date.now() - lastLogTime > 5000) {
              console.log(`[${new Date().toISOString()}] Streaming: ${totalPacketsProcessed} packets (${sessionPackets} this session), ${(totalBytesReceived/1024/1024).toFixed(2)} MB`);
              lastLogTime = Date.now();
            }
          }
        }

        // Portal disconnected, attempt reconnect
        if (keepStreaming) {
          console.log(`[${new Date().toISOString()}] Portal disconnected after ${sessionPackets} packets (${(sessionBytes/1024/1024).toFixed(2)} MB), reconnecting...`);
          reconnectAttempts++;
          await new Promise(resolve => setTimeout(resolve, 100)); // Brief delay before reconnect
        }
        
      } catch (streamError) {
        console.error(`[${new Date().toISOString()}] Stream error:`, streamError.message);
        if (!keepStreaming) break;
        
        reconnectAttempts++;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Stream ended
    console.log(`[${new Date().toISOString()}] Stream ended. Total: ${totalPacketsProcessed} packets, ${(totalBytesReceived/1024/1024).toFixed(2)} MB, ${reconnectAttempts} reconnections`);
    res.end();

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Handler error:`, error.message, error.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal error' });
    }
  }
});

// ============================================
// Original .ts endpoint (for MPV compatibility)
// ============================================
app.get('/stream/:token', async (req, res) => {
  try {
    let { token } = req.params;
    
    if (token.endsWith('.ts')) {
      token = token.slice(0, -3);
    }
    
    if (!token || !JWT_SECRET) {
      return res.status(400).json({ error: 'Missing parameters' });
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      console.error(`[${new Date().toISOString()}] Invalid JWT:`, jwtError.message);
      return res.status(403).json({ error: 'Invalid token' });
    }

    if (payload.type !== 'stream' || !payload.streamUrl) {
      return res.status(403).json({ error: 'Invalid payload' });
    }

    // Rate limiting
    const userId = payload.userId;
    const now = Date.now();
    
    if (!userRequestTracker.has(userId)) {
      userRequestTracker.set(userId, []);
    }
    
    const userRequests = userRequestTracker.get(userId);
    const recentRequests = userRequests.filter(time => now - time < USER_REQUEST_WINDOW);
    
    if (recentRequests.length >= USER_REQUEST_LIMIT) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    
    recentRequests.push(now);
    userRequestTracker.set(userId, recentRequests);

    const streamUrl = payload.streamUrl;
    const allowedDomain = 'vpn.streamhut.xyz';
    const parsedUrl = new URL(streamUrl);
    
    if (parsedUrl.hostname !== allowedDomain) {
      return res.status(403).json({ error: 'Domain not allowed' });
    }

    console.log(`[${new Date().toISOString()}] Direct stream (MPV): user=${payload.userId}, ch=${payload.channelId}`);

    // Direct streaming with keep-alive (no queue, no normalization)
    const response = await fetch(streamUrl, {
      headers: {
        'User-Agent': 'StreamNexus-Proxy/1.0',
        'Connection': 'keep-alive',
        ...(req.headers.range ? { 'Range': req.headers.range } : {})
      }
    });

    if (!response.ok) {
      console.error(`[${new Date().toISOString()}] Portal error: ${response.status}`);
      return res.status(response.status).json({ error: 'Portal error' });
    }

    console.log(`[${new Date().toISOString()}] Direct stream started`);

    res.status(200);
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Stream directly without modification
    try {
      for await (const chunk of response.body) {
        res.write(chunk);
      }
      res.end();
      console.log(`[${new Date().toISOString()}] Direct stream ended`);
    } catch (streamError) {
      console.error(`[${new Date().toISOString()}] Stream error:`, streamError.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Streaming error' });
      }
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Handler error:`, error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal error' });
    }
  }
});

app.listen(PORT, () => {
  console.log(`CORS proxy with improved HLS running on port ${PORT}`);
  console.log(`JWT_SECRET configured: ${!!JWT_SECRET}`);
});
