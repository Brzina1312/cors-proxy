const express = require('express');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;
// Secrets/config resolution order: 1) real env vars, 2) .env file next to
// this file (dotenv-style key=value, no dependencies), 3) jwt_secret.txt
// (legacy fallback). Only missing env vars are taken from .env - real
// environment always wins.
function parseEnvFile(name) {
  const out = {};
  try {
    const p = path.join(__dirname, name);
    if (fs.existsSync(p)) {
      for (const rawLine of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (key) out[key] = value;
      }
    }
  } catch (e) { /* ignore parse/read errors */ }
  return out;
}

function loadSecretFile(name) {
  try {
    const p = path.join(__dirname, name);
    if (fs.existsSync(p)) {
      const value = fs.readFileSync(p, 'utf8').trim();
      if (value && value.length >= 10) return value;
      console.warn(`[${new Date().toISOString()}] ${name} exists but is too short / empty`);
    }
  } catch (e) { /* ignore read errors */ }
  return null;
}
const dotenv = parseEnvFile('.env');
const JWT_SECRET = process.env.JWT_SECRET || dotenv.JWT_SECRET || loadSecretFile('jwt_secret.txt');
// Hard cap on concurrent HLS sessions - protects small hosts (512 MB RAM,
// weak CPU ~20% load per active stream): default 10 per box, override in
// .env or env; must match worker-side proxy_endpoints.max_sessions
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || dotenv.MAX_SESSIONS, 10) || 10;

// Worker origin for failover reporting (456/458 during buffering)
const WORKER_URL = (process.env.WORKER_URL || dotenv.WORKER_URL || 'https://api.streamnexus.cc.cd').replace(/\/+$/, '');

// Rate limiting: Track requests per user
const userRequestTracker = new Map();
const USER_REQUEST_LIMIT = 50;
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
// sessions/maxSessions let the worker load balancer track per-box load
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    sessions: sessionNormalizers.size,
    maxSessions: MAX_SESSIONS,
    uptime: process.uptime()
  });
});

// MAC status check endpoint - used by worker to check if MAC is already streaming
// This allows the stream handler to show an informational message instead of an error
// If userId is provided and matches existing stream, check if old session is inactive (channel switching)
app.get('/check-mac/:macId', (req, res) => {
  const { macId } = req.params;
  const requestUserId = req.query.userId; // Optional: user requesting the stream
  
  if (!macId) {
    return res.status(400).json({ 
      error: 'Missing macId parameter',
      inUse: false 
    });
  }
  
  const macStatus = isMACAlreadyStreaming(macId);
  
  // If MAC is in use AND requesting user is the same user → Check if old session is inactive
  if (macStatus.inUse && requestUserId && macStatus.userId === requestUserId) {
    const activeStream = activeMACStreams.get(macId);
    const session = activeStream ? sessionNormalizers.get(activeStream.token) : null;
    
    if (session) {
      const timeSinceLastAccess = Date.now() - session.lastAccess;
      const INACTIVE_THRESHOLD = 3000; // 3 seconds - if no activity for 3s, consider it inactive (player closed)
      
      if (timeSinceLastAccess > INACTIVE_THRESHOLD) {
        // Old session is inactive (player was closed) - allow channel switching
        console.log(`[${new Date().toISOString()}] MAC ${macId}: Same user ${requestUserId} switching channels - old session inactive (${Math.round(timeSinceLastAccess/1000)}s), forcing cleanup`);
        
        cleanupSession(activeStream.token, 'force takeover - inactive session, channel switching');
        
        return res.json({
          inUse: false,
          forcedTakeover: true,
          reason: 'inactive_session'
        });
      } else {
        // Old session is still active (player is playing) - this is concurrent streaming attempt
        console.log(`[${new Date().toISOString()}] MAC ${macId}: Same user ${requestUserId} tried concurrent stream - old session active (${Math.round(timeSinceLastAccess/1000)}s ago), blocking`);
        
        return res.json({
          inUse: true,
          userId: macStatus.userId,
          startTime: macStatus.startTime,
          reason: 'active_session'
        });
      }
    } else {
      // Session doesn't exist (race condition?) - allow takeover
      console.log(`[${new Date().toISOString()}] MAC ${macId}: Session not found but MAC registered - cleaning up`);
      activeMACStreams.delete(macId);
      
      return res.json({
        inUse: false,
        forcedTakeover: true,
        reason: 'session_not_found'
      });
    }
  }
  
  // MAC not in use, or different user (block multi-device)
  console.log(`[${new Date().toISOString()}] MAC status check: ${macId}, inUse: ${macStatus.inUse}, userId: ${macStatus.userId || 'none'}, requestUserId: ${requestUserId || 'none'}`);
  
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
const STREAM_START_TIMEOUT = 30000; // 30 seconds to create first segment or mark broken (gives slow channels more time)

// Playback buffer management (env-overridable so a bigger box later is an env change, not code)
// Design: window DEPTH is the invariant (seconds of content held), bytes are the guardrail.
// RAM per user = windowSeconds x measured mux bitrate -> SD automatically gets a deep
// window, 4K gets a shorter one, and no single user can exceed the per-session cap.
const SESSION_WINDOW_TARGET_S = parseInt(process.env.BUFFER_WINDOW_S || '45', 10);
const SESSION_FLOOR_BYTES = parseInt(process.env.BUFFER_FLOOR_MB || '12', 10) * 1024 * 1024;
const SESSION_HARD_CAP_BYTES = parseInt(process.env.BUFFER_CAP_MB || '64', 10) * 1024 * 1024;
const GLOBAL_BUFFER_BYTES = parseInt(process.env.GLOBAL_BUFFER_MB || '224', 10) * 1024 * 1024;
const SEGMENT_MAX_AGE_MS = parseInt(process.env.BUFFER_MAX_AGE_MS || '100000', 10);
const KEEP_BEHIND = 2; // segments of rewind history kept behind the player's position

// LIVE-EDGE HOLD-BACK: the newest HOLD_BACK_SEGS segments are kept in RAM but
// NOT advertised in the playlist. Players glue themselves to the advertised
// "live edge", so this gives every join a ready-made cushion of content that
// is already buffered locally (fetched instantly, no portal dependency) and
// keeps the seek bar away from the right edge of the window. Cost: playback
// runs HOLD_BACK_SEGS x ~5s behind the portal's live edge (user-approved).
const HOLD_BACK_SEGS = parseInt(process.env.HOLD_BACK_SEGS || '3', 10);

// WINDOW DEPTH CAP: behind-client eviction only starts once the advertised
// window is deeper than this, so the window GROWS from ~10-15s at join to this
// depth instead of being trimmed lean immediately (right side of the seek bar
// increments as new segments are advertised). RAM stays bounded by the byte
// budget/backpressure; this is the second guard (and the main one for
// low-bitrate channels where the byte floor dominates).
const MAX_WINDOW_SEGS = parseInt(process.env.MAX_WINDOW_SEGS || '12', 10);

// JOIN PHASE: many players (ExoPlayer/VLC family) ignore #EXT-X-START and
// glue onto the NEWEST advertised segment when they join. On a deep window
// that lands the playhead near the buffered edge with nothing ahead of it -
// the "starts at 00:35 of a 00:40 bar, hits the right side fast" bug on
// slow-loading channels. Until the player actually fetches its first
// advertised segment, the playlist therefore contains ONLY the oldest
// JOIN_WINDOW_SEGS segments: the "live edge" such a player can glue on IS
// ~00:00, and the right side of the seek bar then grows as the window
// extends. RAM/backpressure keep bounding the buffer while it stockpiles
// behind the tiny advertised window.
const JOIN_WINDOW_SEGS = parseInt(process.env.JOIN_WINDOW_SEGS || '2', 10);
const JOIN_PROBE_MAX_MS = parseInt(process.env.JOIN_PROBE_MAX_MS || '30000', 10);

let globalBufferedBytes = 0; // total segment bytes held across all live sessions

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

// Compute this session's buffer byte budget from its measured mux bitrate:
// clamp(windowTarget x bitrate, FLOOR, min(HARD_CAP, fair share of the global pool)).
// Bitrate is only trusted once ~10s of segments exist; before that the hard cap
// applies (safe: fast fill of the initial buffer, backpressure + max-age bound it).
function computeSessionBudget(session, activeCount) {
  let budget = SESSION_HARD_CAP_BYTES;
  const durTotal = session.segmentDurationTotal || 0;
  const bytesTotal = session.segmentBytesTotal || 0;
  if (durTotal > 10 && bytesTotal > 0) {
    budget = Math.round((bytesTotal / durTotal) * SESSION_WINDOW_TARGET_S);
  }
  budget = Math.max(SESSION_FLOOR_BYTES, Math.min(budget, SESSION_HARD_CAP_BYTES));
  const n = Math.max(1, activeCount || 1);
  const fairShare = Math.floor(GLOBAL_BUFFER_BYTES / n * 1.5);
  return Math.min(budget, Math.max(SESSION_FLOOR_BYTES, fairShare));
}

function countBufferingSessions() {
  let n = 0;
  for (const s of sessionNormalizers.values()) {
    if (s.isBuffering) n++;
  }
  return n;
}

// Playback-aware buffer trim: a segment is ONLY dropped when the client has
// already fetched it (or it aged out). Dropping a segment the player still
// needs caused the 404 -> infinite stall loop on weak connections and slow
// provider channels; unfetched content is never evicted here - byte
// budget/backpressure handles slow fetchers. Returns dropped counters for
// logging (nullish when nothing was evicted).
function trimSessionBuffer(session) {
  const clientPos = session.lastServedSeqNum ?? -1;
  const budget = computeSessionBudget(session, countBufferingSessions());
  let droppedBehind = 0, droppedAged = 0, droppedPressure = 0;
  while (session.segments.length > 0) {
    const oldest = session.segments[0];
    let reason = null;
    // Behind-client eviction is normally DEFERRED until the advertised
    // window is deeper than MAX_WINDOW_SEGS: the window first grows from
    // ~10-15s at join to the cap (right side of the seek bar increments),
    // then slides. BUT under session byte pressure it must fire immediately:
    // the session's byte budget can hold fewer than MAX_WINDOW_SEGS segments
    // on high-bitrate channels, so depth 12 would never be reached and
    // bufferedBytes could never shrink -> backpressure never releases and
    // playback starves behind a frozen published edge (the "play/pause
    // forever at 00:19" deadlock). Only player-fetched segments ever go
    // this way - safe. Oldest -> newest keeps seq order contiguous.
    if (clientPos >= 0 && oldest.seqNum <= clientPos - KEEP_BEHIND
        && ((session.segments[session.segments.length - 1].seqNum - oldest.seqNum) >= MAX_WINDOW_SEGS
            || (session.bufferedBytes || 0) > budget)) {
      reason = 'behind-client'; // safe: player already consumed it
    } else if (Date.now() - oldest.timestamp > SEGMENT_MAX_AGE_MS) {
      reason = 'max-age'; // stale backstop: fetched-then-vanished clients
    } else if (globalBufferedBytes > GLOBAL_BUFFER_BYTES && (session.bufferedBytes || 0) > SESSION_FLOOR_BYTES && clientPos >= 0 && oldest.seqNum <= clientPos) {
      // Global pool exceeded -> fair-share valve. Only release bytes
      // the client already fetched, and only until we hit the floor.
      reason = 'global-pressure';
    } else {
      break;
    }
    const removed = session.segments.shift();
    session.bufferedBytes -= removed.data.length;
    globalBufferedBytes = Math.max(0, globalBufferedBytes - removed.data.length);
    if (removed.data) removed.data = null;
    if (reason === 'behind-client') droppedBehind++;
    else if (reason === 'max-age') droppedAged++;
    else droppedPressure++;
  }
  if (droppedBehind || droppedAged || droppedPressure) {
    console.log(`[${new Date().toISOString()}] Buffering: Evicted segs (behind-client:${droppedBehind}, max-age:${droppedAged}, global-pressure:${droppedPressure}) | buffer: ${session.segments.length} segs, ${(session.bufferedBytes / 1048576).toFixed(1)}MB (budget ${Math.round(budget / 1048576)}MB), client at ${clientPos}, global pool ${(globalBufferedBytes / 1048576).toFixed(1)}/${Math.round(GLOBAL_BUFFER_BYTES / 1048576)}MB`);
  }
  return { droppedBehind, droppedAged, droppedPressure, budget, clientPos };
}

// Immediately clean up a session (called on errors, disconnects, etc.)
function cleanupSession(token, reason = 'cleanup') {
  const session = sessionNormalizers.get(token);
  if (!session) return;
  
  console.log(`[${new Date().toISOString()}] Cleanup: ${reason} for session ${token.substring(0, 8)}`);
  
  // Stop buffering worker FIRST
  session.isBuffering = false;
  
  // Abort the fetch connection to forcefully stop data flow
  if (session.abortController) {
    try {
      session.abortController.abort();
    } catch (e) {
      // Ignore errors
    }
    session.abortController = null;
  }
  
  // Aggressively destroy portal connection and streams
  if (session.portalResponse) {
    try {
      if (session.portalResponse.body) {
        session.portalResponse.body.cancel();
        // Also try to destroy the stream if available
        if (typeof session.portalResponse.body.destroy === 'function') {
          session.portalResponse.body.destroy();
        }
      }
    } catch (e) {
      // Ignore errors during cleanup
    }
    session.portalResponse = null; // CRITICAL: Clear the reference to free memory
  }
  
  // Clear portal stream if exists
  if (session.portalStream) {
    try {
      // Properly close async iterator by calling return() method
      // This signals the iterator to clean up internal state and buffers
      // Don't await - cleanupSession is synchronous, but return() will still trigger cleanup
      if (typeof session.portalStream.return === 'function') {
        session.portalStream.return().catch(() => {});
      }
      // Also try destroy() as fallback for streams that support it
      if (typeof session.portalStream.destroy === 'function') {
        session.portalStream.destroy();
      }
    } catch (e) {
      // Ignore errors during cleanup
    }
    session.portalStream = null;
  }
  
  // Clear normalizer to free PTS state
  if (session.normalizer) {
    session.normalizer = null;
  }
  
  // Clear segments array explicitly to help garbage collection
  if (session.segments) {
    // Explicitly null out each segment buffer before clearing array
    for (let i = 0; i < session.segments.length; i++) {
      if (session.segments[i] && session.segments[i].data) {
        session.segments[i].data = null;
      }
    }
    session.segments.length = 0;
    session.segments = null;
  }
  // Release this session's bytes from the global pool accounting
  globalBufferedBytes = Math.max(0, globalBufferedBytes - (session.bufferedBytes || 0));
  
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
  
  // Delete session (remaining references will be garbage collected)
  sessionNormalizers.delete(token);
  
  // Force garbage collection if available (helps release memory faster)
  if (global.gc) {
    // Run 4 GC passes with staggered timing to aggressively compact heap
    // This helps reduce RSS after large buffer allocations (3+ MB segments)
    global.gc();
    
    setTimeout(() => {
      if (global.gc && sessionNormalizers.size === 0) {
        global.gc(); // 2nd pass at 1s
        setTimeout(() => {
          if (global.gc && sessionNormalizers.size === 0) {
            global.gc(); // 3rd pass at 3s
            setTimeout(() => {
              if (global.gc && sessionNormalizers.size === 0) {
                global.gc(); // 4th pass at 6s
              }
            }, 3000);
          }
        }, 2000);
      }
    }, 1000);
  }
  
  // Log memory usage after cleanup for debugging
  const memUsage = process.memoryUsage();
  console.log(`[${new Date().toISOString()}] Memory after cleanup: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap, ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${sessionNormalizers.size} active sessions`);
}

// Cleanup inactive sessions periodically
setInterval(() => {
  const now = Date.now();
  const INACTIVE_TIMEOUT = 15 * 1000; // 15 seconds - 3x segment duration for HLS buffering, but fast enough for memory cleanup
  
  for (const [token, session] of sessionNormalizers.entries()) {
    if (now - session.lastAccess > INACTIVE_TIMEOUT) {
      cleanupSession(token, 'inactive for 15s');
    }
  }
  
  // Cleanup old user limit entries (no active streams and last activity > 10 min)
  for (const [userId, limits] of userStreamLimits.entries()) {
    if (limits.activeStreams.size === 0 && now - limits.lastStreamStart > 10 * 60 * 1000) {
      // Clear the Set object before deletion to help GC
      if (limits.activeStreams) {
        limits.activeStreams.clear();
      }
      userStreamLimits.delete(userId);
    }
  }
  
  // MEMORY LEAK FIX: Cleanup old userRequestTracker entries
  // Remove entries where all timestamps are older than the request window (10s)
  for (const [userId, timestamps] of userRequestTracker.entries()) {
    const recentRequests = timestamps.filter(time => now - time < USER_REQUEST_WINDOW);
    if (recentRequests.length === 0) {
      // No recent requests, remove entry completely
      userRequestTracker.delete(userId);
    } else if (recentRequests.length < timestamps.length) {
      // Some old timestamps, update array with only recent ones
      userRequestTracker.set(userId, recentRequests);
    }
  }
  
  // Cleanup stale MAC entries (where session no longer exists)
  for (const [macId, activeStream] of activeMACStreams.entries()) {
    if (!sessionNormalizers.has(activeStream.token)) {
      activeMACStreams.delete(macId);
      console.log(`[${new Date().toISOString()}] Cleaned up stale MAC entry: ${macId}`);
    }
  }
  
  // Cleanup expired brokenChannels entries
  for (const [channelId, blockedUntil] of brokenChannels.entries()) {
    if (now >= blockedUntil) {
      brokenChannels.delete(channelId);
    }
  }
  
  // AGGRESSIVE MEMORY MANAGEMENT: Force GC periodically to release memory back to OS
  // This helps prevent the "high water mark" issue where RSS stays at peak usage
  // Always run memory checks - moved outside gc block
  const memUsage = process.memoryUsage();
  const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const rssMB = Math.round(memUsage.rss / 1024 / 1024);
  const externalMB = Math.round(memUsage.external / 1024 / 1024);
  
  // Always log memory stats when sessions are active
  if (rssMB > 100 || sessionNormalizers.size > 0) {
    console.log(`[${new Date().toISOString()}] Memory stats: ${heapMB}MB heap, ${rssMB}MB RSS, ${externalMB}MB external, ${sessionNormalizers.size} active sessions, segment buffers ${(globalBufferedBytes / 1048576).toFixed(1)}MB (pool cap ${Math.round(GLOBAL_BUFFER_BYTES / 1048576)}MB)`);
  }
  
  // RSS threshold: trigger aggressive GC and trim buffers if memory is getting high
  // Render free tier has 512MB, paid has 1GB - stay well under to prevent OOM kills
  const RSS_THRESHOLD_MB = 400;
  if (rssMB > RSS_THRESHOLD_MB) {
    console.warn(`[${new Date().toISOString()}] RSS ${rssMB}MB exceeds threshold ${RSS_THRESHOLD_MB}MB, trimming buffers`);
    // Trim buffers regardless of GC availability
    for (const [tkn, sess] of sessionNormalizers.entries()) {
      if (sess.segments && sess.segments.length > 4) {
        const before = sess.segments.length;
        let freed = 0;
        while (sess.segments.length > 4) {
          const removed = sess.segments.shift();
          if (removed && removed.data) {
            freed += removed.data.length;
            removed.data = null;
          }
        }
        // Emergency backstop only. Normal operation never reaches this because
        // the byte-budget allocator + backpressure keep us under threshold.
        sess.bufferedBytes = Math.max(0, (sess.bufferedBytes || 0) - freed);
        globalBufferedBytes = Math.max(0, globalBufferedBytes - freed);
        sess.playlistCache = null; // Invalidate playlist cache after trim
        console.log(`[${new Date().toISOString()}] Memory pressure: Trimmed session ${tkn.substring(0, 8)} from ${before} to ${sess.segments.length} segments, freed ${(freed / 1048576).toFixed(1)}MB`);
      }
    }
  }
  
  // Only run GC when sessions are active (optimization)
  if (global.gc && sessionNormalizers.size > 0) {
    global.gc();
  }
}, 5000); // Run every 5 seconds for faster channel switching

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

// Report a persistent 456/458 from buffering to the worker failover endpoint.
// Returns 'wait' | 'switched' | 'error'. On 'switched' the session keeps
// streaming with a new portal URL (backup MAC) - the client never notices.
// hard458: 458 has been continuous for >=12s with zero successful reads -
// portal wind-down cannot last that long, so the worker must not answer
// "wait" (switch-lag) or repeated channel zaps would keep the session stuck.
async function reportFailureToWorker(session, hard458 = false) {
  if (!session.userId) return 'error';
  try {
    const res = await fetch(`${WORKER_URL}/api/streaming-failure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: session.userId,
        channelId: String(session.channelId || ''),
        errorCode: '458',
        attemptCount: 8,
        continuousSeconds: hard458 ? Math.round((Date.now() - session.first458At) / 1000) : 0,
        hard458
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      console.error(`[${new Date().toISOString()}] Failover report rejected: HTTP ${res.status}`);
      return 'error';
    }
    const data = await res.json();
    if (data.wait) {
      console.log(`[${new Date().toISOString()}] Failover report: portal wind-down detected, keep retrying (${data.waitSeconds || 12}s)`);
      return 'wait';
    }
    if (data.success && data.streamUrl) {
      const parsed = new URL(data.streamUrl);
      if (parsed.hostname !== 'vpn.streamhut.xyz') {
        console.error(`[${new Date().toISOString()}] Failover stream URL has unexpected host`);
        return 'error';
      }
      console.log(`[${new Date().toISOString()}] Failover: worker assigned backup MAC - switching session stream URL`);
      session.streamUrl = data.streamUrl;
      session.portalStream = null;
      session.portalResponse = null;
      if (session.macId && data.backupMac && data.backupMac.id) {
        session.macId = data.backupMac.id;
      }
      return 'switched';
    }
    return 'error';
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Failover report failed: ${e.message}`);
    return 'error';
  }
}

async function startBuffering(session, token) {
  if (session.isBuffering) return;
  
  session.isBuffering = true;
  console.log(`[${new Date().toISOString()}] Starting background buffering for session ${token.substring(0, 8)}...`);
  
  // Create AbortController to forcefully stop fetch
  const abortController = new AbortController();
  session.abortController = abortController;
  
  let packetBuffer = Buffer.alloc(0);
  let currentSegmentPackets = [];
  let segmentStartPTS = null; // Track PTS at start of segment
  let lastPTS = null; // Track most recent PTS
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 100;
  const TARGET_SEGMENT_DURATION_PTS = 450000; // 5 seconds in 90kHz PTS units
  
  // Diagnostics: Track buffering progress
  let totalBytesReceived = 0;
  let totalPacketsExtracted = 0;
  let ptsFoundCount = 0;
  let lastProgressLog = Date.now();
  let lastChunkReceived = Date.now();
  let lastSegmentCreated = Date.now();
  let chunkCount = 0;
  let bpLogging = false; // avoid spamming backpressure logs

  try {
    while (session.isBuffering && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    try {
      // Backpressure: if the buffer is still over budget after an eviction
      // sweep, stop pulling from the portal for a beat. TCP backpressure
      // slows production naturally instead of dropping data the player
      // needs. The sweep runs FIRST - it releases consumed-chain bytes so a
      // momentary pile-up (e.g. a backlog gush from the portal at connect)
      // resolves without ever pausing the stream.
      let bpOver = session.segments && session.segments.length > 0 &&
        (session.bufferedBytes || 0) > computeSessionBudget(session, countBufferingSessions());
      if (bpOver) {
        trimSessionBuffer(session);
        bpOver = session.segments.length > 0 &&
          (session.bufferedBytes || 0) > computeSessionBudget(session, countBufferingSessions());
      }
      if (bpOver) {
        if (!bpLogging) {
          bpLogging = true;
          console.log(`[${new Date().toISOString()}] Buffering: Backpressure ON (${((session.bufferedBytes || 0) / 1048576).toFixed(1)}MB > budget ${Math.round(computeSessionBudget(session, countBufferingSessions()) / 1048576)}MB, ${session.segments.length} segs), pausing portal reads`);
        }
        // Client gone while paused? Free the session.
        if (Date.now() - session.lastAccess > 15000) {
          cleanupSession(token, 'client disconnected (backpressure pause)');
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
        if (!session.isBuffering) break;
        continue;
      } else if (bpLogging) {
        bpLogging = false;
        console.log(`[${new Date().toISOString()}] Buffering: Backpressure OFF (${((session.bufferedBytes || 0) / 1048576).toFixed(1)}MB, ${session.segments.length} segs), resuming portal reads`);
      }

      // Connect to portal if needed
      if (!session.portalStream || !session.portalResponse) {
        console.log(`[${new Date().toISOString()}] Buffering: Connecting to portal...`);
        console.log(`[${new Date().toISOString()}] DEBUG: Stream URL: ${session.streamUrl}`);
        console.log(`[${new Date().toISOString()}] DEBUG: User-Agent: Lavf/58.29.100`);
        console.log(`[${new Date().toISOString()}] DEBUG: UserId: ${session.userId}, ChannelId: ${session.channelId}`);
        
        const portalResponse = await fetch(session.streamUrl, {
          headers: {
            'User-Agent': 'Lavf/58.29.100',
            'Connection': 'keep-alive'
          },
          timeout: 30000,
          signal: abortController.signal
        });
        
        // Check immediately after await - session might have been cleaned up
        if (!session.isBuffering) {
          console.log(`[${new Date().toISOString()}] Buffering stopped during fetch for session ${token.substring(0, 8)}`);
          break;
        }
        
        if (!portalResponse.ok) {
          console.error(`[${new Date().toISOString()}] Buffering: Portal error ${portalResponse.status}`);
          console.error(`[${new Date().toISOString()}] DEBUG ERROR: URL: ${session.streamUrl}`);
          console.error(`[${new Date().toISOString()}] DEBUG ERROR: Status: ${portalResponse.status} ${portalResponse.statusText}`);
          console.error(`[${new Date().toISOString()}] DEBUG ERROR: Response headers:`, JSON.stringify(Object.fromEntries(portalResponse.headers)));
          
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
            // Check after await
            if (!session.isBuffering) break;
            continue;
          }
          
          // Handle 458 (stream slot occupied for this MAC) - happens right
          // after a channel switch while the portal releases the MAC's old
          // stream (~5-8s). Fast fixed-interval retries so the new stream
          // grabs the slot the moment it frees (no growing backoff).
          if (portalResponse.status === 458) {
            reconnectAttempts++;
            if (!session.first458At) session.first458At = Date.now();
            const hard458 = (Date.now() - session.first458At) >= 12000; // wind-down never lasts this long
            const fastDelay = 600 + Math.floor(Math.random() * 400); // 600-1000ms
            console.warn(`[${new Date().toISOString()}] Buffering: Error 458 (portal slot busy for MAC), fast retry ${fastDelay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}${hard458 ? ', CONTINUOUS>12s - cannot be switch lag' : ''})`);

            // First ~8s of fast retries cover the portal's own wind-down.
            // Past that, report to the worker each round: it classifies
            // switch-lag vs real occupation and can re-point the session at a
            // backup MAC. Player must still be polling (session alive).
            // hard458 tells the worker the 458 has been continuous for >12s,
            // which portal wind-down alone cannot produce - it must be a real
            // occupation (box in use outside our service), so the worker must
            // fail over instead of answering "wait" again. Without this,
            // repeated channel zaps keep renewing the takeover-marker rows and
            // the worker waits forever.
            if (reconnectAttempts % 8 === 0 && Date.now() - session.lastAccess < 15000) {
              const action = await reportFailureToWorker(session, hard458);
              if (action === 'switched') {
                reconnectAttempts = 0; // fresh portal URL: reset attempts
                session.first458At = null; // new URL gets its own lag window
                if (!session.isBuffering) break;
                continue; // portalStream/portalResponse already nulled -> fresh connect
              }
              // 'wait' or 'error': keep the fast retry loop from above
            }

            await new Promise(resolve => setTimeout(resolve, fastDelay));
            if (!session.isBuffering) break;
            continue;
          }

          // Other errors: exponential backoff with jitter to prevent thundering herd
          reconnectAttempts++;
          const baseDelay = Math.min(2000 * Math.pow(1.5, reconnectAttempts - 1), 30000);
          const jitter = Math.random() * 1000;
          const retryDelay = Math.round(baseDelay + jitter);
          console.warn(`[${new Date().toISOString()}] Buffering: Error ${portalResponse.status}, backoff ${retryDelay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          // Check after await
          if (!session.isBuffering) break;
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
        // Properly close iterator before nulling
        if (session.portalStream && typeof session.portalStream.return === 'function') {
          try {
            await session.portalStream.return();
          } catch (e) {
            // Ignore errors during cleanup
          }
        }
        session.portalStream = null;
        session.portalResponse = null;
        reconnectAttempts++;
        await new Promise(resolve => setTimeout(resolve, 100));
        // Check after await
        if (!session.isBuffering) break;
        continue;
      }
      
      // Reset reconnect counter on successful read
      reconnectAttempts = 0;
      // Healthy read ends any running 458 streak - the next 458 starts a
      // fresh continuous-failure window
      session.first458At = null;
      
      // Check if session was stopped by cleanup - CRITICAL: check immediately after receiving data
      if (!session.isBuffering) {
        console.log(`[${new Date().toISOString()}] Buffering stopped for session ${token.substring(0, 8)}`);
        break;
      }
      
      // Protection: Stop buffering if client disconnected (no requests for 15+ seconds)
      // Increased from 3s to 15s to allow normal HLS buffering (segments are 5s, clients buffer ahead)
      if (session.segments && Date.now() - session.lastAccess > 15000 && session.segments.length > 0) {
        console.log(`[${new Date().toISOString()}] Buffering: Client inactive for 15s, stopping`);
        cleanupSession(token, 'client disconnected');
        break;
      }
      
      // Track bytes received
      totalBytesReceived += chunk.length;
      chunkCount++;
      const timeSinceLastChunk = Date.now() - lastChunkReceived;
      lastChunkReceived = Date.now();
      
      // Log first data received
      if (totalBytesReceived === chunk.length) {
        console.log(`[${new Date().toISOString()}] Buffering: First data received (${chunk.length} bytes)`);
      }
      
      // Log chunks after first segment to diagnose stalled streams
      if (session.segments && session.segments.length > 0 && chunkCount <= 20) {
        console.log(`[${new Date().toISOString()}] Buffering: Chunk ${chunkCount} received (${chunk.length} bytes, ${timeSinceLastChunk}ms since last chunk)`);
      }
      
      // Periodic logging for stalled streams (every 10s after first segment)
      const timeSinceLastSegment = Date.now() - lastSegmentCreated;
      if (session.segments && session.segments.length > 0 && timeSinceLastSegment > 10000 && Date.now() - lastProgressLog > 10000) {
        console.log(`[${new Date().toISOString()}] Buffering STALLED: ${currentSegmentPackets.length} packets accumulated, ${timeSinceLastSegment}ms since last segment, waiting for 6000 packets or 5s PTS`);
        lastProgressLog = Date.now();
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
        totalPacketsExtracted++;
        
        // Extract PTS from normalized packet to track actual duration
        const pts = extractPTSFromPacket(normalizedPacket);
          if (pts !== null) {
            ptsFoundCount++;
            lastPTS = pts;
            if (segmentStartPTS === null) {
              segmentStartPTS = pts;
              // Reduced logging: only log for first segment
              if (session.segments.length === 0) {
                console.log(`[${new Date().toISOString()}] Buffering: First PTS found (${pts}) after ${totalPacketsExtracted} packets`);
              }
            }
          }
        
        // Progress logging every 5 seconds for NEW sessions with no segments yet
        const now = Date.now();
        if (session.segments && session.segments.length === 0 && now - lastProgressLog > 5000) {
          const ptsDuration = (lastPTS !== null && segmentStartPTS !== null) ? (lastPTS - segmentStartPTS) : null;
          console.log(`[${new Date().toISOString()}] Buffering progress: ${totalBytesReceived} bytes, ${totalPacketsExtracted} packets, ${ptsFoundCount} PTS found, ${currentSegmentPackets.length} in current segment, PTS duration: ${ptsDuration ? (ptsDuration / 90000).toFixed(2) + 's' : 'N/A'}`);
          lastProgressLog = now;
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
          
          // Safety check: if session was cleaned up while we were buffering, exit immediately
          if (!session.segments || !session.isBuffering) {
            console.log(`[${new Date().toISOString()}] Buffering: Session cleaned up, stopping buffering worker`);
            break;
          }
          
          session.segments.push(segment);
          
          // Invalidate playlist cache so next request gets the new segment
          session.playlistCache = null;
          
          const oldestSeq = session.segments[0].seqNum;
          const newestSeq = segment.seqNum;
          console.log(`[${new Date().toISOString()}] Buffering: Segment ${segment.seqNum} created (${(segmentData.length/1024).toFixed(1)} KB, ${actualDuration.toFixed(2)}s, ${currentSegmentPackets.length} packets, buffer: ${session.segments.length} segments, range: ${oldestSeq}-${newestSeq})`);
          
          // Track segment creation time for stall detection
          lastSegmentCreated = Date.now();

          // Byte accounting for buffer management (global + per-session)
          session.bufferedBytes = (session.bufferedBytes || 0) + segmentData.length;
          session.segmentBytesTotal = (session.segmentBytesTotal || 0) + segmentData.length;
          session.segmentDurationTotal = (session.segmentDurationTotal || 0) + actualDuration;
          globalBufferedBytes += segmentData.length;

          // Playback-aware buffer management: trim only player-fetched or
          // aged-out segments (see trimSessionBuffer - drops nothing the
          // player still needs).
          trimSessionBuffer(session);
          
          // Reset for next segment
          currentSegmentPackets = [];
          segmentStartPTS = null;
          lastPTS = null;
        }
        
        // Protection: Check for broken channel (no segments created within timeout)
        // Only applies to NEW sessions that are actively trying to buffer but failing
        if (session.segments && session.segments.length === 0 && session.startTime && 
            Date.now() - session.startTime > STREAM_START_TIMEOUT) {
          const ptsDuration = (lastPTS !== null && segmentStartPTS !== null) ? (lastPTS - segmentStartPTS) : null;
          console.error(`[${new Date().toISOString()}] Buffering: Stream failed to create segments within ${STREAM_START_TIMEOUT/1000}s, marking as broken`);
          console.error(`[${new Date().toISOString()}] Buffering diagnostics: ${totalBytesReceived} bytes received, ${totalPacketsExtracted} packets extracted, ${ptsFoundCount} PTS found, ${currentSegmentPackets.length} packets in current segment, PTS duration: ${ptsDuration ? (ptsDuration / 90000).toFixed(2) + 's (need 5.0s)' : 'N/A (fallback: need 6000 packets)'}`);
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
        // Properly close iterator before nulling on error
        if (session.portalStream && typeof session.portalStream.return === 'function') {
          try {
            await session.portalStream.return();
          } catch (e) {
            // Ignore errors during cleanup
          }
        }
        session.portalStream = null;
        session.portalResponse = null;
        reconnectAttempts++;
        
        // Clear segment buffer on error to prevent memory accumulation
        if (currentSegmentPackets && currentSegmentPackets.length > 0) {
          currentSegmentPackets = [];
        }
        
        if (session.isBuffering) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
  } finally {
    // CRITICAL: Aggressively clean up local variables to help GC release memory
    // These variables can hold 40-80MB of buffers during active streaming
    console.log(`[${new Date().toISOString()}] Buffering stopped for session ${token.substring(0, 8)}`);
    session.isBuffering = false;
    
    // Explicitly null out all buffer-holding variables
    if (currentSegmentPackets && currentSegmentPackets.length > 0) {
      for (let i = 0; i < currentSegmentPackets.length; i++) {
        currentSegmentPackets[i] = null;
      }
      currentSegmentPackets.length = 0;
    }
    currentSegmentPackets = null;
    packetBuffer = null;
    
    // Force immediate GC to release memory
    if (global.gc) {
      global.gc();
      
      // Schedule a delayed GC to catch heap fragmentation from Buffer allocations
      // Without this, RSS stays high (~160MB) even after streams close
      setTimeout(() => {
        if (global.gc) {
          global.gc();
          const memUsage = process.memoryUsage();
          console.log(`[${new Date().toISOString()}] Delayed GC complete: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap, ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS`);
        }
      }, 1000);
    }
  }
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
      // Hard session-cap protection (RAM guard for small hosts)
      if (sessionNormalizers.size >= MAX_SESSIONS) {
        console.warn(`[${new Date().toISOString()}] REJECTED: session capacity reached (${sessionNormalizers.size}/${MAX_SESSIONS})`);
        return res.status(503).json({
          error: 'Server at capacity',
          message: 'This streaming server is at its maximum concurrent session limit. Please try again in a moment.'
        });
      }

      // Protection: Check if user can start new stream
      const canStart = canUserStartStream(payload.userId);
      if (!canStart.allowed) {
        console.warn(`[${new Date().toISOString()}] User ${payload.userId} blocked: ${canStart.reason}`);
        return res.status(429).json({ error: canStart.reason });
      }
      
      // Protection: Check if MAC is already streaming (one connection per MAC)
      // BUT allow instant channel switching for same user if old session is inactive
      if (payload.macId) {
        const macStatus = isMACAlreadyStreaming(payload.macId);
        if (macStatus.inUse) {
          // Check if it's the SAME user trying to switch channels
          if (macStatus.userId === payload.userId) {
            // Same user - check if old session is inactive (instant channel switching)
            const activeStream = activeMACStreams.get(payload.macId);
            const oldSession = activeStream ? sessionNormalizers.get(activeStream.token) : null;
            
            if (oldSession) {
              const timeSinceLastAccess = Date.now() - oldSession.lastAccess;
              const INACTIVE_THRESHOLD = 3000; // 3 seconds
              
              if (timeSinceLastAccess > INACTIVE_THRESHOLD) {
                // Old session inactive - allow instant channel switching
                console.log(`[${new Date().toISOString()}] MAC ${payload.macId}: Same user ${payload.userId} switching channels - old session inactive (${Math.round(timeSinceLastAccess/1000)}s), forcing cleanup`);
                cleanupSession(activeStream.token, 'instant channel switch - inactive session');
                // Continue to create new session
              } else {
                // Old session still active - this is a concurrent streaming attempt
                console.warn(`[${new Date().toISOString()}] MAC ${payload.macId}: Same user ${payload.userId} tried concurrent stream - old session active (${Math.round(timeSinceLastAccess/1000)}s ago), blocking`);
                return res.status(409).json({ 
                  error: 'Stream still active',
                  message: 'Your previous stream is still active. Please wait a few seconds and try again.'
                });
              }
            } else {
              // Session not found but MAC registered - cleanup and allow
              console.log(`[${new Date().toISOString()}] MAC ${payload.macId}: Session not found but MAC registered - cleaning up`);
              activeMACStreams.delete(payload.macId);
            }
          } else {
            // Different user - block concurrent device
            console.warn(`[${new Date().toISOString()}] MAC ${payload.macId} already streaming for different user ${macStatus.userId}, requested by ${payload.userId}`);
            return res.status(409).json({ 
              error: 'Active connection detected',
              message: 'This subscription is already being used on another device. Only one device can stream at a time per subscription.'
            });
          }
        }
      }
      
      // Protection: Check if channel is broken
      if (isChannelBroken(payload.channelId)) {
        console.warn(`[${new Date().toISOString()}] Channel ${payload.channelId} is marked as broken`);
        return res.status(503).json({ error: 'Channel temporarily unavailable' });
      }
      
      // Smart channel switching: instantly cleanup user's previous sessions
      // When user clicks new channel, immediately close their old session for instant switching
      const userLimits = userStreamLimits.get(payload.userId);
      if (userLimits && userLimits.activeStreams && userLimits.activeStreams.size > 0) {
        for (const oldToken of userLimits.activeStreams) {
          if (oldToken !== token) { // Don't cleanup the current token
            console.log(`[${new Date().toISOString()}] Smart cleanup: User switching channels, closing previous session ${oldToken.substring(0, 8)}`);
            cleanupSession(oldToken, 'user switched channels');
          }
        }
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
        startTime: Date.now(), // Track when stream started for timeout detection
        lastServedSeqNum: -1, // Highest segment number served to client (for buffer management)
        publishedThrough: -1, // Highest seqNum ever advertised in a playlist (monotone, never retracted)
        joinWindow: true, // Join phase: advertise only the oldest JOIN_WINDOW_SEGS until the player fetches a segment
        joinStartAt: 0, // Wall-clock when the join mini-window was first served (probe safety)
        first458At: null, // Start of the current continuous-458 streak (for hard458 failover signal)
        bufferedBytes: 0, // Live bytes held in segments[] (per-session buffer accounting)
        segmentBytesTotal: 0, // All segment bytes produced (for bitrate measurement)
        segmentDurationTotal: 0, // All segment seconds produced (for bitrate measurement)
        playlistCache: null,  // Cached HLS playlist string
        playlistCacheTime: 0  // Timestamp of cached playlist
      };
      sessionNormalizers.set(token, session);
      
      // Register as active stream for this user
      registerActiveStream(payload.userId, token);
      
      // Register MAC as active if provided
      if (payload.macId) {
        registerMACStream(payload.macId, token, payload.userId);
      }
      
      console.log(`[${new Date().toISOString()}] DEBUG SESSION: New session created`);
      console.log(`[${new Date().toISOString()}] DEBUG SESSION: UserId: ${payload.userId}`);
      console.log(`[${new Date().toISOString()}] DEBUG SESSION: ChannelId: ${payload.channelId}`);
      console.log(`[${new Date().toISOString()}] DEBUG SESSION: MacId: ${payload.macId}`);
      console.log(`[${new Date().toISOString()}] DEBUG SESSION: StreamUrl: ${payload.streamUrl}`);
      
      // Start background buffering
      startBuffering(session, token);
    } else {
      session.lastAccess = Date.now();
    }

    // Check playlist cache (reduces regeneration on rapid HLS refreshes)
    // ExoPlayer refreshes every 3-5s; caching for 2s cuts requests by ~50%
    const PLAYLIST_CACHE_TTL = 2000; // 2 seconds
    if (session.playlistCache && Date.now() - session.playlistCacheTime < PLAYLIST_CACHE_TTL && session.segments.length > 0) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      console.log(`[${new Date().toISOString()}] HLS Playlist sent (cached): ${session.segments.length} segments`);
      return res.send(session.playlistCache);
    }

    // Generate playlist from actually buffered segments
    const baseUrl = req.protocol + '://' + req.get('host');
    const SEGMENT_DURATION = 5; // seconds

    // JOIN PHASE management. Goals:
    // 1. Live-edge-glued players must land at ~00:00 - while joinWindow is
    //    active the playlist only contains the oldest JOIN_WINDOW_SEGS
    //    segments, so the newest entry such a player latches onto IS the
    //    window start. The buffer keeps stockpiling in the background.
    // 2. The phase ends the moment the player fetches its first advertised
    //    segment (healthy players fetch immediately), or after
    //    JOIN_PROBE_MAX_MS as a safety valve so a playlist-only client can
    //    never starve on a frozen tiny window.
    if (session.joinWindow === undefined) session.joinWindow = true;
    if (session.joinWindow && (session.lastServedSeqNum ?? -1) >= 0) {
      session.joinWindow = false; // player took the first segments - expand
      session.playlistCache = null;
    }
    if (session.joinWindow && !session.joinStartAt) {
      session.joinStartAt = Date.now();
    } else if (session.joinWindow && session.joinStartAt
        && Date.now() - session.joinStartAt > JOIN_PROBE_MAX_MS) {
      console.warn(`[${new Date().toISOString()}] HLS Playlist: join probe expired without segment fetch, expanding window`);
      session.joinWindow = false;
      session.playlistCache = null;
    }

    // Wait briefly for initial segments if the join window can't be filled
    // yet. Up to 12s: on channel switches, the portal needs ~5-8s to release
    // the MAC's old stream slot (458) - waiting here lets the player's FIRST
    // playlist request come back WITH segments instead of the 503 retry loop.
    // Join-phase gate: JOIN_WINDOW (what the playing edge sits on) +
    // HOLD_BACK (reserve the hold-back rule will never publish early) + 2
    // (immediate progression). Below that, a live-edge-glued player would
    // exit the join with zero content published beyond its anchor, hug the
    // right edge and stall - the exact bug this join phase fixes.
    const minSegsNeeded = session.joinWindow
      ? JOIN_WINDOW_SEGS + HOLD_BACK_SEGS + 2
      : 1;
    if (session.segments.length < minSegsNeeded) {
      console.log(`[${new Date().toISOString()}] Waiting for initial segments... (join=${session.joinWindow}, have ${session.segments.length}/${minSegsNeeded})`);
      const waitStart = Date.now();
      const WAIT_WINDOW = 12000; // up to 12s total
      while (session.segments.length < minSegsNeeded && Date.now() - waitStart < WAIT_WINDOW && session.isBuffering) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }

    if (session.segments.length < minSegsNeeded) {
      console.warn(`[${new Date().toISOString()}] No segments available yet`);
      return res.status(503).json({ error: 'Buffering in progress, try again' });
    }

    // LIVE-EDGE HOLD-BACK (monotone publishing): advertise only segments at
    // least HOLD_BACK_SEGS behind the buffer head, and NEVER retract a
    // segment once advertised - live-edge-glued players break when the
    // advertised edge regresses (bar glitch/stall). While the buffer is too
    // young to hold anything back, advertise everything (an empty playlist
    // is worse than no hold-back); publishedThrough only ever grows.
    if (session.publishedThrough === undefined) session.publishedThrough = -1;
    if (session.joinWindow) {
      for (const seg of session.segments.slice(0, JOIN_WINDOW_SEGS)) {
        if (seg.seqNum > session.publishedThrough) session.publishedThrough = seg.seqNum;
      }
    } else if (session.segments.length > HOLD_BACK_SEGS) {
      const edgeSeq = session.segments[session.segments.length - 1 - HOLD_BACK_SEGS].seqNum;
      if (edgeSeq > session.publishedThrough) session.publishedThrough = edgeSeq;
    } else {
      const newestSeq = session.segments[session.segments.length - 1].seqNum;
      if (newestSeq > session.publishedThrough) session.publishedThrough = newestSeq;
    }
    const advertisedSegs = session.joinWindow
      ? session.segments.slice(0, JOIN_WINDOW_SEGS)
      : session.segments.filter(seg => seg.seqNum <= session.publishedThrough);

    const oldestSegment = advertisedSegs[0].seqNum;
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:10',  // Max segment duration (clamped to 10s in normalizer)
      // Start at the beginning of the advertised window (position 00:00) -
      // honored by spec-compliant players, ignored harmlessly by the rest.
      '#EXT-X-START:TIME-OFFSET=0',
      `#EXT-X-MEDIA-SEQUENCE:${oldestSegment}`
    ];
    
    // Add all advertised segments
    for (const seg of advertisedSegs) {
      lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
      lines.push(`${baseUrl}/stream/${token}/seg/${seg.seqNum}.ts`);
    }
    
    const playlist = lines.join('\n');
    
    // Cache the generated playlist (invalidated when new segments are created)
    session.playlistCache = playlist;
    session.playlistCacheTime = Date.now();

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    
    res.send(playlist);
    
    const newestSegment = session.segments[session.segments.length - 1].seqNum;
    console.log(`[${new Date().toISOString()}] HLS Playlist sent: ${advertisedSegs.length} advertised of ${session.segments.length} buffered (join=${session.joinWindow ? 'mini-window' : 'full'}, ${oldestSegment}-${advertisedSegs[advertisedSegs.length - 1].seqNum}${session.joinWindow ? '' : `, held back to ${newestSegment}`})`);

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
    // Track playback position for intelligent buffer management
    // Buffer only drops segments the client has already fetched
    session.lastServedSeqNum = Math.max(session.lastServedSeqNum || -1, seqNum);

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

// ============================================
// Worker-Directed Session Cleanup (cross-box channel switching)
// ============================================
// The worker load balancer calls this BEFORE issuing a new play token for a
// user whose old session lives on THIS box: without it, the portal keeps
// serving the old stream for the MAC (only 1 stream per MAC is allowed) and
// the new stream hits 458 until the real inactivity timer runs out.
// Auth: the caller must present the full session token (JWT) itself - it
// cannot be forged without the shared secret, and it only ever cleans the
// session it references.
app.post('/cleanup/:token', (req, res) => {
  const { token } = req.params;
  if (!token || !JWT_SECRET) {
    return res.status(400).json({ error: 'Missing token or JWT secret' });
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (jwtError) {
    console.error(`[${new Date().toISOString()}] Invalid JWT for cleanup:`, jwtError.message);
    return res.status(403).json({ error: 'Invalid token' });
  }
  // Optional strictness: ?userId= must match the token's user
  const requestUserId = req.query.userId;
  if (requestUserId && payload.userId && requestUserId !== payload.userId) {
    console.warn(`[${new Date().toISOString()}] Cleanup refused: user mismatch (${requestUserId} vs token user ${payload.userId})`);
    return res.status(403).json({ error: 'User mismatch' });
  }
  const session = sessionNormalizers.get(token);
  if (!session) {
    return res.json({ cleaned: false, reason: 'not_found' });
  }
  console.log(`[${new Date().toISOString()}] Worker-directed cleanup: user=${payload.userId} ch=${session.channelId}`);
  cleanupSession(token, 'worker-directed cleanup (channel switch)');
  res.json({ cleaned: true });
});

// ============================================
// Active Sessions Endpoint (for Worker cleanup cron)
// ============================================
// Returns list of active streaming sessions for database sync
app.get('/api/active-sessions', (req, res) => {
  try {
    const now = Date.now();
    const activeSessions = [];
    
    // Iterate through all active sessions
    for (const [token, session] of sessionNormalizers.entries()) {
      // Only include sessions that are still alive (activity within last 90 seconds)
      const inactiveDuration = now - session.lastAccess;
      if (inactiveDuration < 90000) {
        activeSessions.push({
          token: token.substring(0, 16) + '...', // Truncate for privacy in logs
          tokenFull: token, // Full token for database lookup
          userId: session.userId,
          channelId: session.channelId,
          lastAccess: session.lastAccess,
          startTime: session.startTime,
          inactiveSeconds: Math.round(inactiveDuration / 1000),
          segmentCount: session.segments.length,
          isBuffering: session.isBuffering
        });
      }
    }
    
    console.log(`[${new Date().toISOString()}] Active sessions report: ${activeSessions.length} sessions`);
    
    res.json({
      timestamp: now,
      count: activeSessions.length,
      sessions: activeSessions
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Active sessions endpoint error:`, error.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.listen(PORT, () => {
  console.log(`CORS proxy with improved HLS running on port ${PORT}`);
  console.log(`JWT_SECRET configured: ${!!JWT_SECRET} (source: ${JWT_SECRET ? (process.env.JWT_SECRET ? 'env' : (dotenv.JWT_SECRET ? '.env' : 'jwt_secret.txt')) : 'MISSING'})`);
  console.log(`MAX_SESSIONS: ${MAX_SESSIONS}`);
});
