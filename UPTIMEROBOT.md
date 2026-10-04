# UptimeRobot Setup Guide

## Why UptimeRobot?
Render.com free tier sleeps after 15 minutes of inactivity. UptimeRobot pings your service every 5 minutes to keep it awake, preventing 30-second cold starts.

## Step 1: Create Account
1. Go to https://uptimerobot.com
2. Click **"Sign Up Free"**
3. Use your email (no credit card required)
4. Verify email

## Step 2: Add Monitor
1. Click **"+ Add New Monitor"**
2. Configure:
   - **Monitor Type**: HTTP(s)
   - **Friendly Name**: StreamNexus CORS Proxy
   - **URL**: `https://cors-proxy-t04o.onrender.com/health`
   - **Monitoring Interval**: 5 minutes
   - **Monitor Timeout**: 30 seconds
   - **Alert Contacts**: Your email (auto-added)
3. Click **"Create Monitor"**

## Step 3: Verify
- Status should show "Up" within 1 minute
- Check "Response Time" graph (should be 50-200ms when warm)
- Click on monitor to see uptime history

## What It Does
```
Every 5 minutes:
UptimeRobot → GET /health → Render.com stays awake
```

**Result**: No more cold starts, streams load instantly

## Free Tier Limits
- **Monitors**: 50 (you only need 1)
- **Interval**: 5 minutes minimum
- **Alerts**: Unlimited email alerts
- **Cost**: $0/month

## Alerts
UptimeRobot will email you if:
- Proxy goes down (2 consecutive failures)
- Proxy comes back up
- Response time exceeds 30 seconds

## Dashboard
- **Uptime %**: Should be 99.9%+
- **Response Time**: 50-200ms when warm, 5000-30000ms on cold start
- **Status**: Green = Up, Red = Down

## Optional: Slack/Discord Alerts
1. In UptimeRobot dashboard → **"My Settings"**
2. Click **"Add Alert Contact"**
3. Choose Slack or Discord webhook
4. Get notified in your server when proxy goes down

## Testing
After setup, wait 20 minutes then check:
```bash
curl https://cors-proxy-t04o.onrender.com/health
```
Should respond instantly (< 500ms), not 30 seconds.

## Troubleshooting

### Monitor Shows "Down"
- Check Render.com dashboard for errors
- Verify `/health` endpoint works manually
- Check Render logs for crashes

### Response Time > 5 seconds
- Normal on first ping after deployment
- Should drop to 50-200ms after warmup
- If consistently slow, Render might be overloaded

### Monitor Paused
- UptimeRobot pauses monitors after 7 days of downtime
- Manually unpause in dashboard
- Fix underlying issue in Render

## Cost Comparison

### Without UptimeRobot (Render sleeps)
- First request after 15 min: 30 seconds ❌
- User experience: Poor

### With UptimeRobot (Always warm)
- All requests: < 500ms ✅
- User experience: Excellent
- Cost: $0/month

## Pro Tip
Add a second monitor for your main API to keep it warm too:
- URL: `https://api.streamnexus.workers.dev/health`
- Interval: 5 minutes

This keeps both services responsive 24/7.
