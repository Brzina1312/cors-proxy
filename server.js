const express = require('express');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const app = express();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// Rate limiting: Track requests per user to prevent portal 456 errors
const userRequestTracker = new Map();
const USER_REQUEST_LIMIT = 3; // Max 3 requests per user per 10 seconds
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

// Token-based streaming endpoint (ExoPlayer compatible)
// Route accepts .ts extension but we strip it manually to avoid JWT parsing issues
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
    
    // Dummy Content-Length for live stream (ExoPlayer expects this)
    res.setHeader('Content-Length', '999999999999999');
    
    // No Accept-Ranges for live streams
    res.setHeader('Accept-Ranges', 'none');
    
    // Cache for 5 minutes
    res.setHeader('Cache-Control', 'public, max-age=300');

    // CORS headers (critical for ExoPlayer)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, User-Agent, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');

    // Pre-buffer strategy: Buffer 64KB before streaming to prevent 0-byte reads
    const PRE_BUFFER_SIZE = 65536; // 64KB
    const chunks = [];
    let bufferedSize = 0;
    let streamStarted = false;

    console.log(`[${new Date().toISOString()}] Pre-buffering ${PRE_BUFFER_SIZE} bytes before streaming`);

    // Stream with async iteration (no direct pipe, no chunked encoding)
    try {
      for await (const chunk of response.body) {
        if (!streamStarted) {
          // Still pre-buffering
          chunks.push(chunk);
          bufferedSize += chunk.length;
          
          // Once we have enough buffered, start streaming
          if (bufferedSize >= PRE_BUFFER_SIZE) {
            console.log(`[${new Date().toISOString()}] Pre-buffer full (${bufferedSize} bytes), starting stream`);
            
            // Send all buffered data
            for (const bufferedChunk of chunks) {
              res.write(bufferedChunk);
            }
            
            chunks.length = 0; // Clear buffer
            streamStarted = true;
          }
        } else {
          // Stream directly after pre-buffer
          res.write(chunk);
        }
      }
      
      // If stream ended before pre-buffer was full, send what we have
      if (!streamStarted && chunks.length > 0) {
        console.log(`[${new Date().toISOString()}] Stream ended during pre-buffer, sending ${bufferedSize} bytes`);
        for (const bufferedChunk of chunks) {
          res.write(bufferedChunk);
        }
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
