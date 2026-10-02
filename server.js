const express = require('express');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const app = express();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// ============================================
// MPEG-TS PTS Normalizer for ExoPlayer Fix
// ============================================
class MPEGTSNormalizer {
  constructor() {
    this.firstPTS = null;
    this.firstDTS = null;
    this.ptsOffset = 0;
    this.dtsOffset = 0;
  }

  // Parse and normalize MPEG-TS packet (188 bytes)
  normalizePacket(packet) {
    if (packet.length !== 188) {
      return packet; // Invalid packet size, pass through
    }

    // Check sync byte (0x47)
    if (packet[0] !== 0x47) {
      return packet; // Not a valid TS packet
    }

    // Parse TS header
    const payloadUnitStartIndicator = (packet[1] & 0x40) !== 0;
    const adaptationFieldControl = (packet[3] & 0x30) >> 4;
    
    // Check if packet has payload (not just adaptation field)
    if (adaptationFieldControl === 2) {
      return packet; // No payload, only adaptation field
    }

    // Calculate payload start position
    let payloadStart = 4;
    if (adaptationFieldControl === 3) {
      // Has adaptation field
      const adaptationFieldLength = packet[4];
      payloadStart = 5 + adaptationFieldLength;
    }

    // Only process if this is the start of a PES packet
    if (!payloadUnitStartIndicator || payloadStart + 9 >= 188) {
      return packet; // Not PES start or not enough data
    }

    // Check for PES start code (0x000001)
    if (packet[payloadStart] !== 0x00 || 
        packet[payloadStart + 1] !== 0x00 || 
        packet[payloadStart + 2] !== 0x01) {
      return packet; // Not a PES packet
    }

    // Parse PES header
    const pesHeaderDataLength = packet[payloadStart + 8];
    const ptsDtsFlags = (packet[payloadStart + 7] & 0xC0) >> 6;
    
    // Check if PTS/DTS present
    if (ptsDtsFlags === 0 || payloadStart + 9 + pesHeaderDataLength >= 188) {
      return packet; // No PTS/DTS or not enough space
    }

    // Create a copy of the packet for modification
    const modifiedPacket = Buffer.from(packet);
    let ptsPosition = payloadStart + 9;

    // Extract and normalize PTS (if present)
    if (ptsDtsFlags === 2 || ptsDtsFlags === 3) {
      const pts = this.extractPTS(packet, ptsPosition);
      
      if (pts !== null) {
        // Initialize offset on first PTS
        if (this.firstPTS === null) {
          this.firstPTS = pts;
          this.ptsOffset = pts;
          console.log(`[${new Date().toISOString()}] PTS Normalizer: First PTS detected: ${pts}, setting offset`);
        }

        // Normalize PTS
        const normalizedPTS = pts - this.ptsOffset;
        this.writePTS(modifiedPacket, ptsPosition, normalizedPTS, ptsDtsFlags === 3 ? 3 : 2);
      }

      // If DTS also present
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

  // Extract 33-bit PTS from PES header
  extractPTS(packet, position) {
    try {
      const pts = (
        ((packet[position] & 0x0E) << 29) |
        (packet[position + 1] << 22) |
        ((packet[position + 2] & 0xFE) << 14) |
        (packet[position + 3] << 7) |
        (packet[position + 4] >> 1)
      ) >>> 0; // Ensure unsigned 32-bit

      return pts;
    } catch (e) {
      return null;
    }
  }

  // Extract DTS (same format as PTS)
  extractDTS(packet, position) {
    return this.extractPTS(packet, position);
  }

  // Write normalized PTS back to packet
  writePTS(packet, position, pts, marker) {
    const markerBits = marker << 4; // 0010 or 0011
    packet[position] = markerBits | ((pts >> 29) & 0x0E) | 0x01;
    packet[position + 1] = (pts >> 22) & 0xFF;
    packet[position + 2] = ((pts >> 14) & 0xFE) | 0x01;
    packet[position + 3] = (pts >> 7) & 0xFF;
    packet[position + 4] = ((pts << 1) & 0xFE) | 0x01;
  }

  // Write normalized DTS back to packet
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

// Rate limiting: Track requests per user to prevent portal 456 errors
const userRequestTracker = new Map();
const USER_REQUEST_LIMIT = 10; // Max 10 requests per user per 10 seconds (allows player switching)
const USER_REQUEST_WINDOW = 10000; // 10 seconds

// Request queue to prevent portal rate limiting
// Portal returns 429 if too many requests come too quickly
const requestQueue = [];
let isProcessingQueue = false;
const MIN_REQUEST_INTERVAL = 200; // 200ms between requests to portal
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

// Process request queue with rate limiting
async function processQueue() {
  if (isProcessingQueue || requestQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;

  while (requestQueue.length > 0) {
    const { url, headers, resolve, reject } = requestQueue.shift();

    // Wait if last request was too recent
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

// Add request to queue and return promise
function queueRequest(url, headers) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ url, headers, resolve, reject });
    processQueue();
  });
}

// Proxy endpoint
app.get('/proxy', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }

    // Validate URL is from allowed domain
    const allowedDomain = 'vpn.streamhut.xyz';
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname !== allowedDomain) {
      return res.status(403).json({ error: 'Domain not allowed' });
    }

    console.log(`[${new Date().toISOString()}] Proxying: ${url}`);

    // Queue the request to prevent rate limiting (portal returns 429)
    // Spaces requests by at least 200ms
    const response = await queueRequest(url, {
      'User-Agent': 'StreamNexus-Proxy/1.0',
      ...(req.headers.range ? { 'Range': req.headers.range } : {})
    });

    if (!response.ok) {
      console.error(`[${new Date().toISOString()}] Upstream error: ${response.status}`);
      return res.status(response.status).json({ error: 'Upstream error' });
    }

    // Log successful response details for debugging
    console.log(`[${new Date().toISOString()}] Proxy success: ${response.status}, Content-Type: ${response.headers.get('content-type') || 'none'}`);

    // Copy relevant headers
    res.status(response.status);
    
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    } else {
      res.setHeader('Content-Type', 'video/mp2t');
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    const contentRange = response.headers.get('content-range');
    if (contentRange) {
      res.setHeader('Content-Range', contentRange);
    }

    const acceptRanges = response.headers.get('accept-ranges');
    if (acceptRanges) {
      res.setHeader('Accept-Ranges', acceptRanges);
    }

    // Cache for 5 minutes
    res.setHeader('Cache-Control', 'public, max-age=300');

    // Stream the response
    response.body.pipe(res);

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Proxy error:`, error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Proxy error' });
    }
  }
});

// ============================================
// HLS Playlist Endpoint (.m3u8)
// Returns HLS playlist pointing to normalized TS stream
// ============================================
app.get('/stream/:token.m3u8', async (req, res) => {
  try {
    let { token } = req.params;
    
    if (!token) {
      console.error(`[${new Date().toISOString()}] Missing token parameter`);
      return res.status(400).json({ error: 'Missing token' });
    }

    if (!JWT_SECRET) {
      console.error(`[${new Date().toISOString()}] JWT_SECRET not configured`);
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Validate JWT token
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      console.error(`[${new Date().toISOString()}] Invalid JWT token for m3u8:`, jwtError.message);
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    // Verify token type
    if (payload.type !== 'stream') {
      console.error(`[${new Date().toISOString()}] Invalid token type for m3u8`);
      return res.status(403).json({ error: 'Invalid token type' });
    }

    console.log(`[${new Date().toISOString()}] HLS Playlist requested: userId=${payload.userId}, channelId=${payload.channelId}`);

    // Generate HLS playlist pointing to normalized stream
    const baseUrl = req.protocol + '://' + req.get('host');
    const playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:3600
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:EVENT
#EXTINF:3600.0,
${baseUrl}/stream/${token}/live.ts
#EXT-X-ENDLIST`;

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    
    res.send(playlist);
    console.log(`[${new Date().toISOString()}] HLS Playlist sent`);

  } catch (error) {
    console.error(`[${new Date().toISOString()}] HLS playlist error:`, error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Playlist generation error' });
    }
  }
});

// ============================================
// HLS Normalized Stream Endpoint
// Applies PTS normalization for ExoPlayer
// ============================================
app.get('/stream/:token/live.ts', async (req, res) => {
  try {
    let { token } = req.params;
    
    if (!token) {
      console.error(`[${new Date().toISOString()}] Missing token parameter`);
      return res.status(400).json({ error: 'Missing token' });
    }

    if (!JWT_SECRET) {
      console.error(`[${new Date().toISOString()}] JWT_SECRET not configured`);
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Validate JWT token
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      console.error(`[${new Date().toISOString()}] Invalid JWT token:`, jwtError.message);
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    // Verify token type and required fields
    if (payload.type !== 'stream' || !payload.streamUrl) {
      console.error(`[${new Date().toISOString()}] Invalid token payload`);
      return res.status(403).json({ error: 'Invalid token payload' });
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
      const oldestRequest = Math.min(...recentRequests);
      const waitTime = Math.ceil((USER_REQUEST_WINDOW - (now - oldestRequest)) / 1000);
      
      console.warn(`[${new Date().toISOString()}] Rate limit exceeded for user ${userId}`);
      
      return res.status(429).json({ 
        error: 'Too many requests. Please wait before trying again.',
        retryAfter: waitTime
      });
    }
    
    recentRequests.push(now);
    userRequestTracker.set(userId, recentRequests);

    const streamUrl = payload.streamUrl;

    // Validate URL domain
    const allowedDomain = 'vpn.streamhut.xyz';
    const parsedUrl = new URL(streamUrl);
    if (parsedUrl.hostname !== allowedDomain) {
      console.error(`[${new Date().toISOString()}] Domain not allowed: ${parsedUrl.hostname}`);
      return res.status(403).json({ error: 'Domain not allowed' });
    }

    console.log(`[${new Date().toISOString()}] HLS Normalized Stream: userId=${payload.userId}, channelId=${payload.channelId}`);

    // Request from portal
    const response = await queueRequest(streamUrl, {
      'User-Agent': 'StreamNexus-Proxy/1.0',
      ...(req.headers.range ? { 'Range': req.headers.range } : {})
    });

    if (!response.ok) {
      console.error(`[${new Date().toISOString()}] Upstream error: ${response.status}`);
      return res.status(response.status).json({ error: 'Upstream error' });
    }

    console.log(`[${new Date().toISOString()}] Stream success, starting PTS normalization`);

    // Set response headers
    res.status(200);
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, User-Agent, Content-Type');

    // Create PTS normalizer instance for this stream
    const normalizer = new MPEGTSNormalizer();
    let packetBuffer = Buffer.alloc(0);
    let packetsProcessed = 0;

    console.log(`[${new Date().toISOString()}] Starting PTS normalization stream`);

    try {
      for await (const chunk of response.body) {
        // Append chunk to buffer
        packetBuffer = Buffer.concat([packetBuffer, chunk]);

        // Process complete 188-byte TS packets
        while (packetBuffer.length >= 188) {
          const packet = packetBuffer.slice(0, 188);
          packetBuffer = packetBuffer.slice(188);

          // Normalize PTS in packet
          const normalizedPacket = normalizer.normalizePacket(packet);
          
          // Send normalized packet to client
          res.write(normalizedPacket);
          
          packetsProcessed++;
        }
      }

      // Send any remaining partial packet (shouldn't happen with valid streams)
      if (packetBuffer.length > 0) {
        console.warn(`[${new Date().toISOString()}] Warning: ${packetBuffer.length} bytes remaining (incomplete packet)`);
      }
      
      res.end();
      console.log(`[${new Date().toISOString()}] PTS normalized stream ended. Packets processed: ${packetsProcessed}`);
      
    } catch (streamError) {
      console.error(`[${new Date().toISOString()}] PTS normalization stream error:`, streamError.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Streaming error' });
      }
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] HLS stream handler error:`, error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal error' });
    }
  }
});

// ============================================
// Token-based streaming endpoint (ExoPlayer compatible)
// Route accepts .ts extension but we strip it manually to avoid JWT parsing issues
// Original endpoint - kept for backward compatibility with MPV
// ============================================
app.get('/stream/:token', async (req, res) => {
  try {
    let { token } = req.params;
    
    // Strip .ts extension if present (added for ExoPlayer format recognition)
    if (token.endsWith('.ts')) {
      token = token.slice(0, -3);
      console.log(`[${new Date().toISOString()}] Stripped .ts extension from token`);
    }
    
    if (!token) {
      console.error(`[${new Date().toISOString()}] Missing token parameter`);
      return res.status(400).json({ error: 'Missing token' });
    }

    if (!JWT_SECRET) {
      console.error(`[${new Date().toISOString()}] JWT_SECRET not configured`);
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Validate JWT token
    console.log(`[${new Date().toISOString()}] Received token (first 100 chars):`, token.substring(0, 100));
    console.log(`[${new Date().toISOString()}] Token length:`, token.length);
    console.log(`[${new Date().toISOString()}] Token parts count:`, token.split('.').length);
    
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      console.error(`[${new Date().toISOString()}] Invalid JWT token:`, jwtError.message);
      console.error(`[${new Date().toISOString()}] Token that failed:`, token.substring(0, 100), '...');
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    // Verify token type and required fields
    if (payload.type !== 'stream' || !payload.streamUrl) {
      console.error(`[${new Date().toISOString()}] Invalid token payload:`, {
        type: payload.type,
        hasStreamUrl: !!payload.streamUrl
      });
      return res.status(403).json({ error: 'Invalid token payload' });
    }

    // Rate limiting: Prevent portal 456 errors (Load Limit Reached)
    const userId = payload.userId;
    const now = Date.now();
    
    if (!userRequestTracker.has(userId)) {
      userRequestTracker.set(userId, []);
    }
    
    const userRequests = userRequestTracker.get(userId);
    const recentRequests = userRequests.filter(time => now - time < USER_REQUEST_WINDOW);
    
    if (recentRequests.length >= USER_REQUEST_LIMIT) {
      const oldestRequest = Math.min(...recentRequests);
      const waitTime = Math.ceil((USER_REQUEST_WINDOW - (now - oldestRequest)) / 1000);
      
      console.warn(`[${new Date().toISOString()}] Rate limit exceeded for user ${userId}: ${recentRequests.length} requests in ${USER_REQUEST_WINDOW}ms`);
      
      return res.status(429).json({ 
        error: 'Too many requests. Please wait before trying again.',
        retryAfter: waitTime
      });
    }
    
    recentRequests.push(now);
    userRequestTracker.set(userId, recentRequests);

    const streamUrl = payload.streamUrl;

    // Validate URL is from allowed domain
    const allowedDomain = 'vpn.streamhut.xyz';
    const parsedUrl = new URL(streamUrl);
    if (parsedUrl.hostname !== allowedDomain) {
      console.error(`[${new Date().toISOString()}] Domain not allowed: ${parsedUrl.hostname}`);
      return res.status(403).json({ error: 'Domain not allowed' });
    }

    console.log(`[${new Date().toISOString()}] Streaming (token): userId=${payload.userId}, channelId=${payload.channelId}, url=${streamUrl.substring(0, 80)}...`);

    // Queue the request to prevent rate limiting
    const response = await queueRequest(streamUrl, {
      'User-Agent': 'StreamNexus-Proxy/1.0',
      ...(req.headers.range ? { 'Range': req.headers.range } : {})
    });

    if (!response.ok) {
      console.error(`[${new Date().toISOString()}] Upstream error: ${response.status}`);
      return res.status(response.status).json({ error: 'Upstream error' });
    }

    console.log(`[${new Date().toISOString()}] Stream success: ${response.status}, starting buffered stream`);

    // ExoPlayer-optimized headers
    res.status(200);
    
    // Simple Content-Type without codecs (more compatible)
    res.setHeader('Content-Type', 'video/mp2t');
    
    // NO Content-Length for live streams (unknown length)
    // Sending fake large value causes ExoPlayer to hang waiting for more data
    
    // No Accept-Ranges for live streams
    res.setHeader('Accept-Ranges', 'none');
    
    // Cache for 5 minutes
    res.setHeader('Cache-Control', 'public, max-age=300');

    // CORS headers (critical for ExoPlayer)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, User-Agent, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');

    // NO pre-buffering - stream immediately as data arrives from portal
    // Portal response time (495ms) + network latency is the real bottleneck
    // Pre-buffering adds unnecessary delay - stream bytes immediately
    console.log(`[${new Date().toISOString()}] Starting immediate streaming (no pre-buffer)`);

    // Stream with async iteration - send bytes immediately as received
    try {
      for await (const chunk of response.body) {
        res.write(chunk);
      }
      
      res.end();
      console.log(`[${new Date().toISOString()}] Stream ended successfully`);
      
    } catch (streamError) {
      console.error(`[${new Date().toISOString()}] Stream error:`, streamError.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Streaming error' });
      }
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Stream handler error:`, error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal error' });
    }
  }
});

app.listen(PORT, () => {
  console.log(`CORS proxy server running on port ${PORT}`);
  console.log(`JWT_SECRET configured: ${!!JWT_SECRET}`);
});
