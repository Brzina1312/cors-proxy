const express = require('express');
const fetch = require('node-fetch');
const app = express();

const PORT = process.env.PORT || 3000;

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

    // Fetch the stream
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'StreamNexus-Proxy/1.0',
        ...(req.headers.range ? { 'Range': req.headers.range } : {})
      }
    });

    if (!response.ok) {
      console.error(`[${new Date().toISOString()}] Upstream error: ${response.status}`);
      return res.status(response.status).json({ error: 'Upstream error' });
    }

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

app.listen(PORT, () => {
  console.log(`CORS proxy server running on port ${PORT}`);
});
