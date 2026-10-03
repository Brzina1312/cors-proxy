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

// MAC status check endpoint - used by worker to check if MAC is already streaming
// This allows the stream handler to show an informational message instead of an error
app.get('/check-mac/:macId', (req, res) => {
  const { macId } = req.params;
  
  if (!macId) {
    return res.status(400).json({ 
      error: 'Missing macId parameter',
      inUse: false 
    });
  }
  
  const macStatus = isMACAlreadyStreaming(macId);
  
  console.log(`[${new Date().toISOString()}] MAC status check: ${macId}, inUse: ${macStatus.inUse}`);
  
  res.json({
    inUse: macStatus.inUse,
    userId: macStatus.userId || null,
    startTime: macStatus.startTime || null
  });
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
// Per-Session Buffering (No Sharing Between Users)
// ============================================
// Each session maintains its own buffer of segments
// Background worker continuously creates segments from portal stream
const sessionNormalizers = new Map(); // token -> {normalizer, segments, isBuffering, ...}

// Protection: Per-user rate limiting
const userStreamLimits = new Map(); // userId -> {activeStreams: Set, lastStreamStart: timestamp, 429Until: timestamp}
const MAX_ACTIVE_STREAMS_PER_USER = 3; // Allow multiple devices per user
const MIN_STREAM_START_INTERVAL = 2000; // 2 seconds between new streams
const STREAM_START_TIMEOUT = 15000; // 15 seconds to create first segment or mark broken

// Protection: Per-MAC concurrent session blocking (one connection per MAC at a time)
const activeMACStreams = new Map(); // macId -> {token, userId, startTime}

// Protection: Broken channel detection
const brokenChannels = new Map(); // channelId -> blockedUntil timestamp
const BROKEN_CHANNEL_COOLDOWN = 5 * 60 * 1000; // 5 minutes

function canUserStartStream(userId) {
  const now = Date.now();
  const limits = userStreamLimits.get(userId);
  
  if (!limits) {
    userStreamLimits.set(userId, {
      activeStreams: new Set(),
      lastStreamStart: now,
      _429Until: null
    });
    return { allowed: true };
  }
  
  // Check if user is in 429 cooldown
  if (limits._429Until && now < limits._429Until) {
    const waitSeconds = Math.ceil((limits._429Until - now) / 1000);
    return { allowed: false, reason: `Rate limited, wait ${waitSeconds}s` };
  }
  
  // Smart cleanup: If user is at limit, check for idle streams and clean them up first
  if (limits.activeStreams.size >= MAX_ACTIVE_STREAMS_PER_USER) {
    const idleTokens = [];
    for (const token of limits.activeStreams) {
      const session = sessionNormalizers.get(token);
      // Only consider truly idle: no requests for 20s AND (not buffering OR has segments already)
      // This prevents cleaning up new sessions that are still creating initial segments
      if (session && now - session.lastAccess > 20000 && (!session.isBuffering || session.segments.length > 0)) {
        idleTokens.push(token);
      }
    }
    
    // Clean up idle streams to make room
    if (idleTokens.length > 0) {
      console.log(`[${new Date().toISOString()}] Smart cleanup: Removing ${idleTokens.length} idle streams for user ${userId}`);
      for (const token of idleTokens) {
        cleanupSession(token, 'idle stream cleanup');
      }
    }
    
    // Recheck limit after cleanup
    if (limits.activeStreams.size >= MAX_ACTIVE_STREAMS_PER_USER) {
      return { allowed: false, reason: `Max ${MAX_ACTIVE_STREAMS_PER_USER} concurrent streams` };
    }
  }
  
  // Check minimum interval between starts
  if (now - limits.lastStreamStart < MIN_STREAM_START_INTERVAL) {
    return { allowed: false, reason: 'Too many requests, slow down' };
  }
  
  limits.lastStreamStart = now;
  return { allowed: true };
}

function isMACAlreadyStreaming(macId) {
  const activeStream = activeMACStreams.get(macId);
  if (!activeStream) {
    return { inUse: false };
  }
  
  // Check if the session still exists (might have been cleaned up)
  const session = sessionNormalizers.get(activeStream.token);
  if (!session) {
    // Session no longer exists, clean up MAC tracking
    activeMACStreams.delete(macId);
    return { inUse: false };
  }
  
  return { 
    inUse: true, 
    userId: activeStream.userId,
    startTime: activeStream.startTime 
  };
}

function registerMACStream(macId, token, userId) {
  activeMACStreams.set(macId, {
    token,
    userId,
    startTime: Date.now()
  });
  console.log(`[${new Date().toISOString()}] MAC ${macId} registered for user ${userId}`);
}

function unregisterMACStream(macId) {
  if (activeMACStreams.delete(macId)) {
    console.log(`[${new Date().toISOString()}] MAC ${macId} unregistered`);
  }
}

function isChannelBroken(channelId) {
  const blockedUntil = brokenChannels.get(channelId);
  if (blockedUntil && Date.now() < blockedUntil) {
    return true;
  }
  if (blockedUntil) {
    brokenChannels.delete(channelId); // Cooldown expired
  }
  return false;
}

function markChannelBroken(channelId, reason) {
  const blockedUntil = Date.now() + BROKEN_CHANNEL_COOLDOWN;
  brokenChannels.set(channelId, blockedUntil);
  console.log(`[${new Date().toISOString()}] Channel ${channelId} marked as broken (${reason}), blocked for 5 min`);
}

function recordUser429(userId) {
  const limits = userStreamLimits.get(userId);
  if (limits) {
    limits._429Until = Date.now() + 30000; // 30 second cooldown for this user
    console.log(`[${new Date().toISOString()}] User ${userId} hit 429, cooldown 30s`);
  }
}

function registerActiveStream(userId, token) {
  const limits = userStreamLimits.get(userId);
  if (limits) {
    limits.activeStreams.add(token);
  }
}

function unregisterActiveStream(userId, token) {
  const limits = userStreamLimits.get(userId);
  if (limits) {
    limits.activeStreams.delete(token);
  }
}

// Immediately clean up a session (called on errors, disconnects, etc.)
function cleanupSession(token, reason = 'cleanup') {
  const session = sessionNormalizers.get(token);
  if (!session) return;
  
  console.log(`[${new Date().toISOString()}] Cleanup: ${reason} for session ${token.substring(0, 8)}`);
  
  // Stop buffering worker
  session.isBuffering = false;
  
  // Close portal connection
  if (session.portalResponse) {
    try {
      session.portalResponse.body.cancel();
    } catch (e) {
      // Ignore errors during cleanup
    }
  }
  
  // Unregister from user's active streams
  if (session.userId) {
    unregisterActiveStream(session.userId, token);
  }
  
  // Unregister MAC if this session is holding it
  if (session.macId) {
    const activeMAC = activeMACStreams.get(session.macId);
    if (activeMAC && activeMAC.token === token) {
      unregisterMACStream(session.macId);
    }
  }
  
  // Clear segments array explicitly to help garbage collection
  if (session.segments) {
    session.segments.length = 0;
    session.segments = null;
  }
  
  // Delete session (remaining references will be garbage collected)
  sessionNormalizers.delete(token);
}

// Cleanup inactive sessions every 30 seconds
setInterval(() => {
  const now = Date.now();
  const INACTIVE_TIMEOUT = 30 * 1000; // 30 seconds (reduced from 5 minutes)
  
  for (const [token, session] of sessionNormalizers.entries()) {
    if (now - session.lastAccess > INACTIVE_TIMEOUT) {
      cleanupSession(token, 'inactive for 30s');
    }
  }
  
  // Cleanup old user limit entries (no active streams and last activity > 10 min)
  for (const [userId, limits] of userStreamLimits.entries()) {
    if (limits.activeStreams.size === 0 && now - limits.lastStreamStart > 10 * 60 * 1000) {
      userStreamLimits.delete(userId);
    }
  }
}, 30000); // Run every 30 seconds to match INACTIVE_TIMEOUT

// ============================================
// Background Buffering Worker (Per-Session)
// ============================================
// Helper function to extract PTS from MPEG-TS packet
function extractPTSFromPacket(packet) {
  if (packet.length !== 188 || packet[0] !== 0x47) return null;
  
  const payloadUnitStartIndicator = (packet[1] & 0x40) !== 0;
  const adaptationFieldControl = (packet[3] & 0x30) >> 4;
  
  if (adaptationFieldControl === 2) return null;
  
  let payloadStart = 4;
  if (adaptationFieldControl === 3) {
    const adaptationFieldLength = packet[4];
    payloadStart = 5 + adaptationFieldLength;
  }
  
  if (!payloadUnitStartIndicator || payloadStart + 9 >= 188) return null;
  
  if (packet[payloadStart] !== 0x00 || 
      packet[payloadStart + 1] !== 0x00 || 
      packet[payloadStart + 2] !== 0x01) {
    return null;
  }
  
  const pesHeaderDataLength = packet[payloadStart + 8];
  const ptsDtsFlags = (packet[payloadStart + 7] & 0xC0) >> 6;
  
  if (ptsDtsFlags === 0 || payloadStart + 9 + pesHeaderDataLength >= 188) return null;
  
  const ptsPosition = payloadStart + 9;
  
  try {
    const pts = (
      ((packet[ptsPosition] & 0x0E) << 29) |
      (packet[ptsPosition + 1] << 22) |
      ((packet[ptsPosition + 2] & 0xFE) << 14) |
      (packet[ptsPosition + 3] << 7) |
      (packet[ptsPosition + 4] >> 1)
    ) >>> 0;
    return pts;
  } catch (e) {
    return null;
  }
}

async function startBuffering(session, token) {
  if (session.isBuffering) return;
  
  session.isBuffering = true;
  console.log(`[${new Date().toISOString()}] Starting background buffering for session ${token.substring(0, 8)}...`);
  
  let packetBuffer = Buffer.alloc(0);
  let currentSegmentPackets = [];
  let segmentStartPTS = null; // Track PTS at start of segment
  let lastPTS = null; // Track most recent PTS
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 100;
  const TARGET_SEGMENT_DURATION_PTS = 450000; // 5 seconds in 90kHz PTS units
  
  // Real-time throttling: Track segment creation rate
  let segmentCreationTimes = []; // Array of timestamps when segments were created
  const THROTTLE_WINDOW = 30000; // 30 second window for rate calculation
  const MAX_SEGMENTS_PER_WINDOW = 12; // Max 12 segments in 30s (2x real-time for 5s segments)
  
  while (session.isBuffering && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    try {
      // Connect to portal if needed
      if (!session.portalStream || !session.portalResponse) {
        console.log(`[${new Date().toISOString()}] Buffering: Connecting to portal...`);
        
        const portalResponse = await fetch(session.streamUrl, {
          headers: {
            'User-Agent': 'StreamNexus-Proxy/1.0',
            'Connection': 'keep-alive'
          },
          timeout: 30000
        });
        
        if (!portalResponse.ok) {
          console.error(`[${new Date().toISOString()}] Buffering: Portal error ${portalResponse.status}`);
          
          // Handle 429 (Too Many Requests) - user-specific cooldown
          if (portalResponse.status === 429 && session.userId) {
            recordUser429(session.userId);
            // Also mark channel as broken to prevent other users from hitting it immediately
            if (session.channelId) {
              markChannelBroken(session.channelId, '429 rate limit');
            }
            // Immediately clean up to free memory and unregister stream
            cleanupSession(token, '429 rate limit error');
            break;
          }
          
          // Handle 407 (Authentication/Connection Error) with exponential backoff
          // Prevents constant retry loops that can overload the portal
          if (portalResponse.status === 407) {
            // Exponential backoff: 5s, 10s, 20s, 40s, up to 60s max
            const backoffDelay = Math.min(5000 * Math.pow(2, reconnectAttempts), 60000);
            console.warn(`[${new Date().toISOString()}] Buffering: Error 407 (auth/connection issue), exponential backoff ${backoffDelay}ms (attempt ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
            reconnectAttempts++;
            await new Promise(resolve => setTimeout(resolve, backoffDelay));
            continue;
          }
          
          // Other errors: use standard retry delay
          reconnectAttempts++;
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        
        session.portalResponse = portalResponse;
        session.portalStream = portalResponse.body[Symbol.asyncIterator]();
        console.log(`[${new Date().toISOString()}] Buffering: Portal connected`);
      }
      
      // Read from portal
      const { value: chunk, done } = await session.portalStream.next();
      
      if (done) {
        console.log(`[${new Date().toISOString()}] Buffering: Portal disconnected, reconnecting...`);
        session.portalStream = null;
        session.portalResponse = null;
        reconnectAttempts++;
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      
      // Reset reconnect counter on successful read
      reconnectAttempts = 0;
      
      // Protection: Stop buffering if client disconnected (no requests for 10+ seconds)
      if (Date.now() - session.lastAccess > 10000 && session.segments.length > 0) {
        console.log(`[${new Date().toISOString()}] Buffering: Client inactive for 10s, stopping`);
        cleanupSession(token, 'client disconnected');
        break;
      }
      
      // Add to packet buffer
      packetBuffer = Buffer.concat([packetBuffer, chunk]);
      
      // Process complete packets
      while (packetBuffer.length >= 188) {
        const packet = packetBuffer.slice(0, 188);
        packetBuffer = packetBuffer.slice(188);
        
        // Normalize PTS/DTS
        const normalizedPacket = session.normalizer.normalizePacket(packet);
        currentSegmentPackets.push(normalizedPacket);
        
        // Extract PTS from normalized packet to track actual duration
        const pts = extractPTSFromPacket(normalizedPacket);
        if (pts !== null) {
          lastPTS = pts;
          if (segmentStartPTS === null) {
            segmentStartPTS = pts;
          }
        }
        
        // Create segment when we have enough PTS duration (5 seconds = 450000 ticks at 90kHz)
        // Or as fallback, use packet count if no PTS available
        const ptsDuration = (lastPTS !== null && segmentStartPTS !== null) 
          ? (lastPTS - segmentStartPTS) 
          : null;
        
        const shouldFinalize = 
          (ptsDuration !== null && ptsDuration >= TARGET_SEGMENT_DURATION_PTS) ||
          (ptsDuration === null && currentSegmentPackets.length >= 6000);
        
        if (shouldFinalize && currentSegmentPackets.length > 0) {
          const segmentData = Buffer.concat(currentSegmentPackets);
          
          // Calculate actual duration in seconds and clamp to reasonable range
          // Prevents PTS discontinuities from creating insane durations (e.g., 47721s)
          const rawDuration = ptsDuration !== null ? ptsDuration / 90000.0 : 5.0;
          const actualDuration = Math.min(10.0, Math.max(2.0, rawDuration));
          
          const segment = {
            seqNum: session.currentSeqNum++,
            data: segmentData,
            timestamp: Date.now(),
            duration: actualDuration
          };
          
          session.segments.push(segment);
          
          const oldestSeq = session.segments[0].seqNum;
          const newestSeq = segment.seqNum;
          console.log(`[${new Date().toISOString()}] Buffering: Segment ${segment.seqNum} created (${(segmentData.length/1024).toFixed(1)} KB, ${actualDuration.toFixed(2)}s, ${currentSegmentPackets.length} packets, buffer: ${session.segments.length} segments, range: ${oldestSeq}-${newestSeq})`);
          
          // Real-time throttling: Track segment creation and throttle if too fast
          const now = Date.now();
          segmentCreationTimes.push(now);
          
          // Remove old timestamps outside the window
          segmentCreationTimes = segmentCreationTimes.filter(t => now - t < THROTTLE_WINDOW);
          
          // If creating segments too fast (>2x real-time), throttle
          if (segmentCreationTimes.length > MAX_SEGMENTS_PER_WINDOW) {
            const throttleDelay = 2500; // 2.5 second delay to slow down
            console.log(`[${new Date().toISOString()}] Buffering: Rate too fast (${segmentCreationTimes.length} segments in ${THROTTLE_WINDOW/1000}s), throttling ${throttleDelay}ms`);
            await new Promise(resolve => setTimeout(resolve, throttleDelay));
          }
          
          // Keep only last 30 segments (2.5 minutes of buffer)
          // Reduced from 90 to save memory: 30 segments = ~150MB for HD vs 90 = ~450MB
          // This allows 3-4 concurrent HD users on 512MB RAM instead of just 1
          if (session.segments.length > 30) {
            const removed = session.segments.shift();
            console.log(`[${new Date().toISOString()}] Buffering: Dropped segment ${removed.seqNum} (keeping last 30)`);
          }
          
          // Reset for next segment
          currentSegmentPackets = [];
          segmentStartPTS = null;
          lastPTS = null;
        }
        
        // Protection: Check for broken channel (no segments created within timeout)
        // Only applies to NEW sessions that are actively trying to buffer but failing
        if (session.segments.length === 0 && session.startTime && 
            Date.now() - session.startTime > STREAM_START_TIMEOUT) {
          console.error(`[${new Date().toISOString()}] Buffering: Stream failed to create segments within ${STREAM_START_TIMEOUT/1000}s, marking as broken`);
          // Mark channel as broken BEFORE cleanup
          if (session.channelId) {
            markChannelBroken(session.channelId, 'timeout - no segments');
          }
          // Then cleanup
          cleanupSession(token, 'timeout - no segments');
          break;
        }
      }
      
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Buffering error:`, error.message);
      session.portalStream = null;
      session.portalResponse = null;
      reconnectAttempts++;
      
      if (session.isBuffering) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  
  console.log(`[${new Date().toISOString()}] Buffering stopped for session ${token.substring(0, 8)}`);
  session.isBuffering = false;
}

// ============================================
// HLS Playlist Endpoint (Buffered Segments)
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

    // Get or create session for this token
    let session = sessionNormalizers.get(token);
    if (!session) {
      // Protection: Check if user can start new stream
      const canStart = canUserStartStream(payload.userId);
      if (!canStart.allowed) {
        console.warn(`[${new Date().toISOString()}] User ${payload.userId} blocked: ${canStart.reason}`);
        return res.status(429).json({ error: canStart.reason });
      }
      
      // Protection: Check if MAC is already streaming (one connection per MAC)
      if (payload.macId) {
        const macStatus = isMACAlreadyStreaming(payload.macId);
        if (macStatus.inUse) {
          console.warn(`[${new Date().toISOString()}] MAC ${payload.macId} already streaming for user ${macStatus.userId}`);
          return res.status(409).json({ 
            error: 'Active connection detected',
            message: 'This subscription is already being used on another device. Only one device can stream at a time per subscription.'
          });
        }
      }
      
      // Protection: Check if channel is broken
      if (isChannelBroken(payload.channelId)) {
        console.warn(`[${new Date().toISOString()}] Channel ${payload.channelId} is marked as broken`);
        return res.status(503).json({ error: 'Channel temporarily unavailable' });
      }
      
      session = {
        normalizer: new MPEGTSNormalizer(),
        lastAccess: Date.now(),
        streamUrl: payload.streamUrl,
        userId: payload.userId,
        channelId: payload.channelId,
        macId: payload.macId || null, // Track MAC ID for concurrent session blocking
        segments: [], // Buffer of available segments
        currentSeqNum: 0, // Next segment number to create
        isBuffering: false,
        portalStream: null,
        portalResponse: null,
        startTime: Date.now() // Track when stream started for timeout detection
      };
      sessionNormalizers.set(token, session);
      
      // Register as active stream for this user
      registerActiveStream(payload.userId, token);
      
      // Register MAC as active if provided
      if (payload.macId) {
        registerMACStream(payload.macId, token, payload.userId);
      }
      
      console.log(`[${new Date().toISOString()}] New session created for user ${payload.userId}, channel ${payload.channelId}`);
      
      // Start background buffering
      startBuffering(session, token);
    } else {
      session.lastAccess = Date.now();
    }

    // Generate playlist from actually buffered segments
    const baseUrl = req.protocol + '://' + req.get('host');
    const SEGMENT_DURATION = 5; // seconds
    
    // Wait briefly for initial segments if buffer is empty
    if (session.segments.length === 0) {
      console.log(`[${new Date().toISOString()}] Waiting for initial segments...`);
      // Wait up to 3 seconds for first segments
      for (let i = 0; i < 30; i++) {
        if (session.segments.length >= 3) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    if (session.segments.length === 0) {
      console.warn(`[${new Date().toISOString()}] No segments available yet`);
      return res.status(503).json({ error: 'Buffering in progress, try again' });
    }
    
    const oldestSegment = session.segments[0].seqNum;
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:10',  // Max segment duration (clamped to 10s in normalizer)
      `#EXT-X-MEDIA-SEQUENCE:${oldestSegment}`
    ];
    
    // Add all buffered segments
    for (const seg of session.segments) {
      lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
      lines.push(`${baseUrl}/stream/${token}/seg/${seg.seqNum}.ts`);
    }
    
    const playlist = lines.join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    
    res.send(playlist);
    
    const newestSegment = session.segments[session.segments.length - 1].seqNum;
    console.log(`[${new Date().toISOString()}] HLS Playlist sent: ${session.segments.length} segments (${oldestSegment}-${newestSegment})`);;

  } catch (error) {
    console.error(`[${new Date().toISOString()}] HLS playlist error:`, error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Playlist error' });
    }
  }
});

// ============================================
// Buffered Segment Endpoint
// ============================================
app.get('/stream/:token/seg/:seqNum.ts', async (req, res) => {
  try {
    let { token, seqNum } = req.params;
    seqNum = parseInt(seqNum);
    
    if (!token || isNaN(seqNum) || !JWT_SECRET) {
      return res.status(400).json({ error: 'Missing parameters' });
    }

    // Validate JWT
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      console.error(`[${new Date().toISOString()}] Invalid JWT for segment:`, jwtError.message);
      return res.status(403).json({ error: 'Invalid token' });
    }

    if (payload.type !== 'stream' || !payload.streamUrl) {
      return res.status(403).json({ error: 'Invalid token type' });
    }

    // Get session
    const session = sessionNormalizers.get(token);
    if (!session) {
      console.error(`[${new Date().toISOString()}] No session found for segment ${seqNum}`);
      return res.status(404).json({ error: 'Session not found' });
    }
    
    session.lastAccess = Date.now();

    // Find segment in buffer
    const segment = session.segments.find(s => s.seqNum === seqNum);
    
    if (!segment) {
      const available = session.segments.length > 0 
        ? `${session.segments[0].seqNum}-${session.segments[session.segments.length - 1].seqNum}`
        : 'none';
      console.warn(`[${new Date().toISOString()}] Segment ${seqNum} not found (available: ${available})`);
      return res.status(404).json({ error: 'Segment not available' });
    }

    // Serve buffered segment
    console.log(`[${new Date().toISOString()}] Serving segment ${seqNum} from buffer (${(segment.data.length/1024).toFixed(1)} KB)`);
    
    res.status(200);
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Content-Length', segment.data.length);
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Segments are immutable
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(segment.data);

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Segment handler error:`, error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal error' });
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
