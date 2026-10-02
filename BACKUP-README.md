# CORS Proxy Backup - MPV Working Version

**Backup Date:** 2026-10-02T10:06:34Z

## Working Configuration

This backup contains the CORS proxy configuration that successfully streams IPTV channels to MPV player.

### What Works

- ✅ **MPV Desktop:** Perfect playback, 25-60fps, no issues
- ✅ **Zero pre-buffering:** Streams immediately as data arrives from portal
- ✅ **JWT token authentication:** Secure token-based access
- ✅ **Rate limiting:** 10 requests per 10 seconds per user
- ✅ **Request queueing:** 200ms minimum interval between portal requests
- ✅ **CORS headers:** Proper cross-origin support

### What Doesn't Work

- ❌ **ExoPlayer (Stremio Android):** Decodes frames but doesn't display them
  - Issue: Portal sends MPEG-TS with absolute PTS timestamps (3+ hours)
  - ExoPlayer can't synchronize playback with these large timestamps
  - MediaCodec renders 300 frames/5sec but ExoPlayer drops them all
  - Result: Black screen or placeholder image, no video playback

### Files in This Backup

- `server-mpv-working-backup.js` - Working proxy server (original `server.js`)

### Restoration

To restore this working version:

```bash
cd cors-proxy
cp server-mpv-working-backup.js server.js
git add server.js
git commit -m "Restore MPV working version"
git push origin master
```

Wait 2 minutes for Render to deploy, then MPV will work again.

### Technical Details

**Configuration:**
- Pre-buffer size: 0 bytes (immediate streaming)
- Rate limit: 10 requests per 10 seconds
- Queue interval: 200ms between portal requests
- Port: 3000 (or Render assigned)
- JWT validation: Enabled

**Performance:**
- Portal response time: ~495ms average
- Network latency: ~200-300ms round-trip
- Total startup: ~700-1000ms to first byte
- Continuous streaming: Perfect once started

**Known Issues:**
1. Portal timestamps are absolute (not relative to stream start)
2. PTS values represent ~3 hours of uptime (not normalized)
3. ExoPlayer strictly enforces PTS synchronization
4. MPV/VLC ignore timestamp issues and play anyway

### Next Steps

After this backup, we're implementing **HLS wrapper with PTS normalization** to make ExoPlayer work:

1. Parse MPEG-TS packets
2. Normalize PTS timestamps (first PTS = 0)
3. Serve as HLS playlist
4. ExoPlayer should handle normalized timestamps

If HLS wrapper fails, restore this backup to return to MPV working state.

---

**Deployment:** Render.com  
**Repository:** https://github.com/Brzina1312/cors-proxy  
**Commit:** b16e0aa (Remove pre-buffering entirely)
