# StreamNexus CORS Proxy

CORS proxy server for streaming IPTV content from Stalker portal to ExoPlayer/web clients.

## Problem
The Stalker portal (`vpn.streamhut.xyz`) doesn't send CORS headers, causing ExoPlayer and web browsers to block stream playback.

## Solution
This proxy server fetches streams from the portal and adds proper CORS headers, enabling playback on all clients.

## Features
- Full CORS support (all origins)
- Range request support for seeking
- Domain whitelist security
- Health check endpoint
- Request logging
- 5-minute cache headers

## Deployment on Render.com

### Method 1: Dashboard Deploy
1. Go to https://dashboard.render.com
2. Click "New +" → "Web Service"
3. Connect your GitHub repository
4. Select `cors-proxy` directory
5. Use these settings:
   - **Name**: streamnexus-cors-proxy
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
6. Click "Create Web Service"

### Method 2: Blueprint Deploy
1. Push this code to GitHub
2. Go to https://dashboard.render.com
3. Click "New +" → "Blueprint"
4. Connect your repository
5. Render will detect `render.yaml` and configure automatically

## Usage

### Proxy Endpoint
```
GET /proxy?url=<encoded_stream_url>
```

### Example
```bash
# Original portal URL (no CORS)
http://vpn.streamhut.xyz/play/live.php?mac=...&stream=...

# Proxied URL (with CORS)
https://your-proxy.onrender.com/proxy?url=http%3A%2F%2Fvpn.streamhut.xyz%2Fplay%2Flive.php%3Fmac%3D...%26stream%3D...
```

### Health Check
```bash
GET /health
```

## Local Development
```bash
npm install
npm run dev
```

Server runs on http://localhost:3000

## Environment Variables
- `PORT`: Server port (default: 3000, Render sets automatically)
- `NODE_ENV`: Environment (production/development)

## Security
- Only allows proxying from `vpn.streamhut.xyz` domain
- Blocks all other domains (403 Forbidden)
- No URL validation bypass possible

## Monitoring
- Check logs in Render dashboard
- Health endpoint: `https://your-proxy.onrender.com/health`
- All proxy requests are logged with timestamps

## Free Tier Limits (Render.com)
- 750 hours/month free runtime
- Sleeps after 15 minutes of inactivity
- First request after sleep takes ~30 seconds (cold start)
- Unlimited bandwidth on free tier

## Cost Estimation
- **Free tier**: $0/month (recommended for testing)
- **Starter ($7/month)**: No sleep, always-on, better performance

## Integration with StreamNexus API
Update `streamRedirect.js` to use proxy URL instead of direct portal URL.
