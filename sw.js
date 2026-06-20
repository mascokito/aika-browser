// sw.js — Aika Browser Service Worker
// Intercepts all proxy requests and detects video stream URLs

const VERSION = 'aika-v1';

// URL patterns that indicate a video stream
const STREAM_PATTERNS = [
  /\.m3u8(\?|$)/i,
  /\.mpd(\?|$)/i,
  /\.mp4(\?|$)/i,
  /\.webm(\?|$)/i,
  /\.m4v(\?|$)/i,
  /\.m4s(\?|$)/i,
];

// Content-type patterns for video
const VIDEO_CONTENT_TYPES = [
  'application/x-mpegurl',
  'application/vnd.apple.mpegurl',
  'application/dash+xml',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/x-m4v',
];

// Domains to ignore (ads, trackers, thumbnails)
const IGNORE_DOMAINS = [
  'googletagmanager.com',
  'cloudflareinsights.com',
  'doubleclick.net',
  'googlesyndication.com',
  'yweakelandorde.org',
  'oundhertobeconsist.org',
];

function isIgnored(url) {
  try {
    const host = new URL(url).hostname;
    return IGNORE_DOMAINS.some(d => host.includes(d));
  } catch { return false; }
}

function looksLikeStream(url, contentType) {
  if (isIgnored(url)) return false;
  // Check URL patterns
  const urlMatch = STREAM_PATTERNS.some(p => p.test(url));
  if (urlMatch) return true;
  // Check content type
  if (contentType) {
    const ct = contentType.toLowerCase();
    return VIDEO_CONTENT_TYPES.some(t => ct.includes(t));
  }
  return false;
}

function extractRealUrl(proxyUrl) {
  // Extract the actual URL from /proxy?url=<encoded>
  try {
    const u = new URL(proxyUrl);
    const encoded = u.searchParams.get('url');
    if (encoded) return decodeURIComponent(encoded);
  } catch {}
  return proxyUrl;
}

function getStreamType(url) {
  const u = url.toLowerCase();
  if (u.includes('.m3u8')) return 'HLS';
  if (u.includes('.mpd')) return 'DASH';
  if (u.includes('.mp4')) return 'MP4';
  if (u.includes('.webm')) return 'WebM';
  return 'VIDEO';
}

function getStreamDomain(url) {
  try { return new URL(url).hostname; } catch { return url.slice(0, 40); }
}

// Notify all clients about a detected stream
async function notifyClients(streamInfo) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({
      type: 'aika-stream-detected',
      stream: streamInfo,
    });
  }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = req.url;

  // Only watch requests going through our proxy
  if (!url.includes('/proxy?url=')) return;

  // Extract the real target URL
  const realUrl = extractRealUrl(url);

  // Check URL pattern first (fast path, no response needed)
  if (STREAM_PATTERNS.some(p => p.test(realUrl)) && !isIgnored(realUrl)) {
    // Don't intercept — let it pass through normally
    // Just notify about the detected stream URL
    const streamInfo = {
      proxyUrl: url,
      realUrl: realUrl,
      type: getStreamType(realUrl),
      domain: getStreamDomain(realUrl),
      timestamp: Date.now(),
    };
    notifyClients(streamInfo);
    return; // Let fetch proceed normally
  }

  // For other requests, check the response content-type
  event.respondWith(
    fetch(req).then(response => {
      const ct = response.headers.get('content-type') || '';
      if (looksLikeStream(realUrl, ct)) {
        const streamInfo = {
          proxyUrl: url,
          realUrl: realUrl,
          type: getStreamType(realUrl),
          domain: getStreamDomain(realUrl),
          contentType: ct,
          timestamp: Date.now(),
        };
        notifyClients(streamInfo);
      }
      return response;
    }).catch(() => fetch(req))
  );
});
