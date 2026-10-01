# CORS Proxy - Quick Reference

## Problem Identified ✅
Portal (`vpn.streamhut.xyz`) sends **ZERO CORS headers**, causing ExoPlayer to show black screen.

**Confirmed:**
- Codec: H.264 (universally supported) ✅
- Issue: Missing `Access-Control-Allow-Origin` header ❌

## Solution Created ✅
CORS proxy server that adds proper headers to portal streams.

## Files Created
```
cors-proxy/
├── server.js          # Express proxy server (172 lines)
├── package.json       # Dependencies + scripts
├── render.yaml        # Render.com deployment config
├── test.js            # Test suite (4 tests)
├── .gitignore         # Node modules ignore
├── README.md          # Full documentation
└── DEPLOYMENT.md      # Step-by-step deployment guide
```

## Deploy to Render.com (5 minutes)

### Option 1: Quick Deploy
1. Push `cors-proxy` folder to GitHub
2. Go to https://dashboard.render.com
3. New + → Web Service → Connect repo
4. Settings:
   - **Root Directory**: `cors-proxy`
   - **Build**: `npm install`
   - **Start**: `npm start`
   - **Plan**: Free
5. Click "Create Web Service"
6. Copy URL: `https://streamnexus-cors-proxy.onrender.com`

### Option 2: Blueprint Deploy
Render auto-detects `render.yaml` and configures everything.

## Configure Cloudflare Workers

Add environment variable to your worker:

**Dashboard Method:**
1. Cloudflare Dashboard → Workers → streamnexus-api
2. Settings → Variables → Add variable
3. Name: `CORS_PROXY_URL`
4. Value: `https://streamnexus-cors-proxy.onrender.com`
5. Save & Deploy

**wrangler.toml Method:**
```toml
[env.production.vars]
CORS_PROXY_URL = "https://streamnexus-cors-proxy.onrender.com"
```

Deploy: `npm run deploy`

## Test Locally (Optional)

```bash
cd cors-proxy
npm install
npm start

# In another terminal
npm test
```

Expected: 4/4 tests passed ✅

## How It Works

**Before (Broken):**
```
Worker → 302 → Portal (no CORS) → ExoPlayer blocked ❌
```

**After (Fixed):**
```
Worker → 302 → CORS Proxy → Portal → CORS Proxy (adds headers) → ExoPlayer works ✅
```

## Verify Deployment

1. **Health Check:**
   ```bash
   curl https://your-proxy.onrender.com/health
   ```
   Expected: `{"status":"ok","timestamp":"..."}`

2. **CORS Headers:**
   ```bash
   curl -I "https://your-proxy.onrender.com/proxy?url=http%3A%2F%2Fvpn.streamhut.xyz%2F..."
   ```
   Expected: `access-control-allow-origin: *`

3. **Stream in Stremio:**
   - Open Stremio
   - Play any channel
   - Should play immediately (no black screen)

## Free Tier Details

**Render.com Free:**
- 750 hours/month (enough for 24/7)
- Unlimited bandwidth
- Sleeps after 15 min inactivity
- Cold start: ~30 seconds
- **Cost: $0/month**

**To Prevent Sleep (Optional):**
- Use UptimeRobot to ping `/health` every 5 minutes (free)
- Or upgrade to Starter plan ($7/month) for always-on

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Streams still black | Check `CORS_PROXY_URL` is set in Workers |
| Proxy returns 403 | URL domain not whitelisted (check `server.js` line 38) |
| Proxy returns 500 | Portal timeout, retry in 1 minute |
| Slow cold starts | Use UptimeRobot ping or upgrade to Starter plan |

## Production Checklist

- [ ] Deploy CORS proxy to Render.com
- [ ] Get proxy URL (e.g., `https://streamnexus-cors-proxy.onrender.com`)
- [ ] Add `CORS_PROXY_URL` to Cloudflare Workers
- [ ] Deploy worker: `npm run deploy`
- [ ] Test health: `curl https://your-proxy.onrender.com/health`
- [ ] Test stream in Stremio/ExoPlayer
- [ ] Monitor logs for 24 hours
- [ ] (Optional) Setup UptimeRobot ping to prevent sleep

## Monitoring

**Render Dashboard:**
- Logs: Real-time proxy requests
- Metrics: Response time, memory usage
- Auto-restart: On crashes

**Check Worker Logs:**
Should see: `Using CORS proxy for stream`

## Cost

- **Render Free**: $0/month (recommended for testing)
- **Render Starter**: $7/month (always-on, no cold starts)
- **Cloudflare Workers**: Already on free tier

**Total Cost: $0/month** (free tier)

## Alternative: Oracle Cloud

If you need more control:
- Oracle Cloud Free Tier
- Forever free VM
- 10 TB bandwidth/month
- $0/month

See DEPLOYMENT.md for Oracle setup guide.

## Support

**Issues?**
1. Check Render logs
2. Test proxy health endpoint
3. Verify `CORS_PROXY_URL` is set
4. Check Worker logs for "Using CORS proxy"

**Still stuck?**
Check DEPLOYMENT.md for detailed troubleshooting guide.
