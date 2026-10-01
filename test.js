#!/usr/bin/env node

/**
 * Test script for CORS proxy
 * Tests health endpoint and proxy functionality
 */

const fetch = require('node-fetch');

const PROXY_URL = process.env.PROXY_URL || 'http://localhost:3000';
const TEST_STREAM_URL = 'http://vpn.streamhut.xyz:80/play/live.php?mac=00:1A:79:83:fe:97&stream=45597&extension=ts&play_token=lpzQUelpDi';

console.log('🧪 Testing CORS Proxy\n');
console.log(`Proxy URL: ${PROXY_URL}\n`);

async function testHealth() {
  console.log('1️⃣  Testing health endpoint...');
  try {
    const response = await fetch(`${PROXY_URL}/health`);
    const data = await response.json();
    
    if (response.ok && data.status === 'ok') {
      console.log('✅ Health check passed');
      console.log(`   Status: ${data.status}`);
      console.log(`   Time: ${data.timestamp}\n`);
      return true;
    } else {
      console.log('❌ Health check failed');
      console.log(`   Status: ${response.status}\n`);
      return false;
    }
  } catch (error) {
    console.log('❌ Health check error:', error.message, '\n');
    return false;
  }
}

async function testCORS() {
  console.log('2️⃣  Testing CORS headers...');
  try {
    const response = await fetch(`${PROXY_URL}/proxy?url=${encodeURIComponent(TEST_STREAM_URL)}`, {
      method: 'HEAD'
    });
    
    const cors = response.headers.get('access-control-allow-origin');
    const methods = response.headers.get('access-control-allow-methods');
    const expose = response.headers.get('access-control-expose-headers');
    
    if (cors === '*' && methods && expose) {
      console.log('✅ CORS headers present');
      console.log(`   Origin: ${cors}`);
      console.log(`   Methods: ${methods}`);
      console.log(`   Expose: ${expose}\n`);
      return true;
    } else {
      console.log('❌ CORS headers missing');
      console.log(`   Origin: ${cors || 'missing'}`);
      console.log(`   Methods: ${methods || 'missing'}\n`);
      return false;
    }
  } catch (error) {
    console.log('❌ CORS test error:', error.message, '\n');
    return false;
  }
}

async function testProxy() {
  console.log('3️⃣  Testing proxy functionality...');
  try {
    const response = await fetch(`${PROXY_URL}/proxy?url=${encodeURIComponent(TEST_STREAM_URL)}`, {
      method: 'HEAD'
    });
    
    const contentType = response.headers.get('content-type');
    
    if (response.ok) {
      console.log('✅ Proxy working');
      console.log(`   Status: ${response.status}`);
      console.log(`   Content-Type: ${contentType || 'not set'}\n`);
      return true;
    } else {
      console.log('❌ Proxy failed');
      console.log(`   Status: ${response.status}`);
      console.log(`   Message: ${await response.text()}\n`);
      return false;
    }
  } catch (error) {
    console.log('❌ Proxy test error:', error.message, '\n');
    return false;
  }
}

async function testInvalidDomain() {
  console.log('4️⃣  Testing domain whitelist security...');
  try {
    const response = await fetch(`${PROXY_URL}/proxy?url=${encodeURIComponent('http://evil.com/stream.m3u8')}`);
    
    if (response.status === 403) {
      console.log('✅ Domain whitelist working (403 for invalid domain)\n');
      return true;
    } else {
      console.log('⚠️  Domain whitelist may not be working');
      console.log(`   Expected 403, got ${response.status}\n`);
      return false;
    }
  } catch (error) {
    console.log('❌ Security test error:', error.message, '\n');
    return false;
  }
}

async function runTests() {
  const results = {
    health: await testHealth(),
    cors: await testCORS(),
    proxy: await testProxy(),
    security: await testInvalidDomain()
  };
  
  const passed = Object.values(results).filter(r => r).length;
  const total = Object.keys(results).length;
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 Results: ${passed}/${total} tests passed\n`);
  
  if (passed === total) {
    console.log('🎉 All tests passed! CORS proxy is ready.\n');
    console.log('Next steps:');
    console.log('1. Deploy to Render.com');
    console.log('2. Add CORS_PROXY_URL to Cloudflare Workers');
    console.log('3. Test streaming in ExoPlayer/Stremio');
  } else {
    console.log('⚠️  Some tests failed. Check the output above.\n');
    process.exit(1);
  }
}

runTests();
