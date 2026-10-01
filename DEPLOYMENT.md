# CORS Proxy Deployment Guide

## Quick Start

### Step 1: Deploy to Render.com

1. **Create GitHub Repository** (if not already done)
   ```bash
   cd cors-proxy
   git init
   git add .
   git commit -m "Initial CORS proxy"
   git remote add origin https://github.com/yourusername/streamnexus-cors-proxy.git
   git push -u origin main
   ```

2. **Deploy on Render.com**
   - Go to https://dashboard.render.com
   - Click **"New +"** → **"Web Service"**
   - Connect your GitHub account
   - Select your repository
   - Configure:
     - **Name**: `streamnexus-cors-proxy`
     - **Root Directory**: `cors-proxy` (if in monorepo) or `.` (if standalone)
     - **Environment**: Node
     - **Build Command**: `npm install`
     - **Start Command**: `npm start`
     - **Plan**: Free
   - Click **"Create Web Service"**

3. **Wait for Deployment**
   - First deploy takes 2-3 minutes
   - Watch logs for "CORS proxy server running on port 10000"
   - Note your URL: `https://streamnexus-cors-proxy.onrender.com`

### Step 2: Configure Cloudflare Workers

Add the CORS proxy URL to your Cloudflare Workers environment:

**Option A: Via Dashboard**
1. Go to https://dash.cloudflare.com
2. Select your Worker: `streamnexus-api`
3. Go to **Settings** → **Variables**
4. Add new environment variable:
   - **Variable name**: `CORS_PROXY_URL`
   - **Value**: `https://streamnexus-cors-proxy.onrender.com`
   - **Type**: Plain text (not secret)
5. Click **Save**
6. Deploy a new version (no code changes needed)

**Option B: Via wrangler.toml**
```toml
[env.production.vars]
CORS_PROXY_URL = "https://streamnexus-cors-proxy.onrender.com"
```

Then deploy:
```bash
npm run deploy
```

### Step 3: Test the Setup

1. **Test CORS Proxy Health**
   ```bash
   curl https://streamnexus-cors-proxy.onrender.com/health
   ```
   Expected: `{"status":"ok","timestamp":"..."}`

2. **Test Stream Redirect**
   - Get a stream URL from your API: `/api/users/me/stream/:channelId`
   - Open in ExoPlayer/Stremio
   - Should now play without black screen

3. **Check Logs**
   - Render Dashboard → Your Service → Logs
   - Should see: `[timestamp] Proxying: http://vpn.streamhut.xyz/play/live.php...`

## How It Works

```
User Request (ExoPlayer/Browser)
    ↓
Cloudflare Worker (/s/{token})
    ↓
302 Redirect to CORS Proxy
    ↓
CORS Proxy (Render.com)
    ↓ (fetches from portal)
Stalker Portal (vpn.streamhut.xyz)
    ↓ (adds CORS headers)
CORS Proxy
    ↓
User (plays stream with CORS headers)
```

## Before/After

### Before (Direct Redirect - No CORS)
```
Worker → 302 → http://vpn.streamhut.xyz/play/live.php
                     ↓
                  No CORS headers
                     ↓
              ExoPlayer blocked ❌
```

### After (CORS Proxy)
```
Worker → 302 → https://proxy.onrender.com/proxy?url=...
                     ↓
              Fetches from portal
                     ↓
            Adds CORS headers
                     ↓
            ExoPlayer works ✅
```

## Monitoring

### Render.com Dashboard
- **Logs**: Real-time request logs
- **Metrics**: CPU, memory, response time
- **Health**: Auto-restarts if service crashes

### Check Service Status
```bash
# Health check
curl https://your-proxy.onrender.com/health

# Test proxy (with actual stream URL)
curl -I "https://your-proxy.onrender.com/proxy?url=http%3A%2F%2Fvpn.streamhut.xyz%2Fplay%2Flive.php%3Fmac%3D..."
```

### Expected Headers
```
HTTP/2 200
access-control-allow-origin: *
access-control-allow-methods: GET, HEAD, OPTIONS
access-control-expose-headers: Content-Length, Content-Range, Content-Type
content-type: video/mp2t
cache-control: public, max-age=300
```

## Free Tier Limits

### Render.com Free Tier
- **Runtime**: 750 hours/month (enough for 24/7)
- **Sleep**: After 15 minutes inactivity
- **Cold Start**: ~30 seconds first request after sleep
- **Bandwidth**: Unlimited
- **Cost**: $0/month

### Solutions for Cold Starts
1. **External Ping Service** (free)
   - UptimeRobot: Ping every 5 minutes
   - Prevents sleep completely

2. **Upgrade to Starter Plan** ($7/month)
   - No sleep
   - Always-on
   - Faster cold starts

## Troubleshooting

### Proxy Returns 403
**Cause**: URL domain not whitelisted
**Fix**: Check `allowedDomain` in `server.js` (line 38)

### Proxy Returns 500
**Cause**: Portal timeout or network error
**Check**: Render logs for error details
**Fix**: Portal might be down, retry in 1-2 minutes

### Streams Still Black Screen
**Cause**: CORS_PROXY_URL not set in Workers
**Fix**: Add environment variable in Cloudflare dashboard
**Verify**: Check Worker logs for "Using CORS proxy for stream"

### High Latency
**Cause**: Render.com sleeping (free tier)
**Fix**: 
- Use UptimeRobot to ping `/health` every 5 minutes
- Or upgrade to Starter plan ($7/month)

### Render Service Won't Start
**Check**: Build logs in Render dashboard
**Common Issues**:
- `npm install` failed → Check `package.json`
- Port binding error → Render sets PORT automatically
- Syntax error → Check `server.js`

## Security

### Domain Whitelist
Only `vpn.streamhut.xyz` is allowed to be proxied. All other domains return 403.

```javascript
// server.js line 35-39
const allowedDomain = 'vpn.streamhut.xyz';
const parsedUrl = new URL(url);
if (parsedUrl.hostname !== allowedDomain) {
  return res.status(403).json({ error: 'Domain not allowed' });
}
```

### No Token Validation
Proxy doesn't validate StreamNexus tokens - that's handled by the Worker before redirect.

## Cost Analysis

### Bandwidth Usage
- Average IPTV stream: 5 Mbps (2.25 GB/hour)
- 10 concurrent users: 22.5 GB/hour
- 1000 hours/month: 22.5 TB/month

### Render.com Free Tier
- **Bandwidth**: Unlimited ✅
- **Cost**: $0/month
- **Perfect for**: Testing, low traffic

### Render.com Starter ($7/month)
- **Bandwidth**: Unlimited ✅
- **No sleep**: Always-on
- **Cost**: $7/month
- **Perfect for**: Production, medium traffic

### Alternative: Oracle Cloud Free Tier
If Render.com becomes too slow or you need more control:
- **Cost**: $0/month forever
- **Bandwidth**: 10 TB/month
- **Compute**: AMD VM (1-4 OCPUs)
- **Guide**: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm

## Updates

### Update Proxy Code
1. Edit `cors-proxy/server.js`
2. Commit and push to GitHub
3. Render auto-deploys (if auto-deploy enabled)
4. Or manually trigger deploy in Render dashboard

### Change Allowed Domain
Edit `server.js` line 38:
```javascript
const allowedDomain = 'your-new-portal.xyz';
```

### Add Authentication
If you want to restrict proxy access, add token validation:
```javascript
const authToken = req.headers['x-auth-token'];
if (authToken !== process.env.PROXY_AUTH_TOKEN) {
  return res.status(401).json({ error: 'Unauthorized' });
}
```

Then set `PROXY_AUTH_TOKEN` in Render environment variables.

## Next Steps

1. ✅ Deploy CORS proxy to Render.com
2. ✅ Add `CORS_PROXY_URL` to Cloudflare Workers
3. ✅ Test stream playback in ExoPlayer/Stremio
4. 🔄 Monitor logs for 24 hours
5. 🔄 Consider UptimeRobot ping if cold starts are annoying
6. 🔄 Upgrade to Starter plan if you need always-on reliability
