// sw.js — Aika Browser Service Worker
// Intercepts all proxy requests and detects video stream URLs

const CACHE_NAME = 'aika-v4';
const APP_SHELL = [
  '/browser.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

const VERSION = 'aika-v4';

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
  const urlMatch = STREAM_PATTERNS.some(p => p.test(url));
  if (urlMatch) return true;
  if (contentType) {
    const ct = contentType.toLowerCase();
    return VIDEO_CONTENT_TYPES.some(t => ct.includes(t));
  }
  return false;
}

function extractRealUrl(proxyUrl) {
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

async function notifyClients(streamInfo) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({
      type: 'aika-stream-detected',
      stream: streamInfo,
    });
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k !== CACHE_NAME)
        .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Network-first for app shell — always try network, fall back to cache
  if (APP_SHELL.some(path => url.endsWith(path))) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  const req = event.request;

  if (!url.includes('/proxy?url=')) return;

  const realUrl = extractRealUrl(url);

  if (STREAM_PATTERNS.some(p => p.test(realUrl)) && !isIgnored(realUrl)) {
    const streamInfo = {
      proxyUrl: url,
      realUrl,
      type: getStreamType(realUrl),
      domain: getStreamDomain(realUrl),
      timestamp: Date.now(),
    };
    notifyClients(streamInfo);
    return;
  }

  const ext = realUrl.split('?')[0].split('.').pop().toLowerCase();
  const skipExts = new Set(['html', 'htm', 'js', 'mjs', 'css', 'json', 'png',
    'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'woff', 'woff2', 'ttf', 'xml',
    'txt', 'map', 'ts', 'm4s', 'm4a']);
  if (skipExts.has(ext)) return;

  event.respondWith(
    fetch(req).then(response => {
      const ct = response.headers.get('content-type') || '';
      if (looksLikeStream(realUrl, ct)) {
        const streamInfo = {
          proxyUrl: url,
          realUrl,
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
