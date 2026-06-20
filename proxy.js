import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FiltersEngine, Request } from '@ghostery/adblocker';
import fetch from 'node-fetch';
import { renderHtmlWithPuppeteer } from './puppeteer-browser.js';

let adblocker = null;

async function initAdblocker() {
  try {
    const engine = await FiltersEngine.fromPrebuiltAdsAndTracking(fetch);
    adblocker = engine;
    console.log('[adblocker] Initialized successfully');
  } catch (err) {
    console.warn('[adblocker] Failed to init:', err.message);
  }
}

initAdblocker();

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
];

const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

function buildInjectedScript(pageUrl) {
  const origin = new URL(pageUrl).origin.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `<script>
(function() {
  const PROXY = '/proxy?url=';
  window.__PROXY_ORIGIN__ = '${origin}';
  document.cookie = 'aika_proxy_origin=' + encodeURIComponent('${origin}') + '; path=/; SameSite=Lax';
  function proxyPath(url) {
    if (typeof url !== 'string') return url;
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#')) return url;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return PROXY + encodeURIComponent(url);
    }
    if (url.startsWith('//')) {
      return PROXY + encodeURIComponent('https:' + url);
    }
    if (url.startsWith('/') && !url.startsWith('/proxy')) {
      return PROXY + encodeURIComponent(window.__PROXY_ORIGIN__ + url);
    }
    return url;
  }
  const origFetch = window.fetch;
  window.fetch = function(url, opts) {
    if (typeof url === 'string') url = proxyPath(url);
    return origFetch(url, opts);
  };
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new OrigXHR();
    const origOpen = xhr.open;
    xhr.open = function(method, url) {
      if (typeof url === 'string') url = proxyPath(url);
      return origOpen.apply(this, [method, url, ...Array.prototype.slice.call(arguments, 2)]);
    };
    return xhr;
  };
  // Patch history.pushState / replaceState so SPA navigation
  // triggers a real proxy load instead of changing the iframe URL
  (function patchHistory() {
    var _pushState = history.pushState.bind(history);
    var _replaceState = history.replaceState.bind(history);

    function interceptState(original, state, title, url) {
      if (!url) return original(state, title, url);
      try {
        var parsed = new URL(url, window.location.href);
        if ((parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
            && !parsed.pathname.startsWith('/proxy')
            && !parsed.pathname.startsWith('/browser.html')) {
          var realUrl = window.__PROXY_ORIGIN__ + parsed.pathname + parsed.search + parsed.hash;
          window.parent.postMessage({ type: 'navigate', url: realUrl }, '*');
          return;
        }
      } catch (_) {}
      return original(state, title, url);
    }

    history.pushState = function(state, title, url) {
      return interceptState(_pushState, state, title, url);
    };
    history.replaceState = function(state, title, url) {
      return interceptState(_replaceState, state, title, url);
    };
  })();
  // Patch img src setter so JS-set image URLs go through the proxy
  (function patchImageSrc() {
    var _nativeSet = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (!_nativeSet || !_nativeSet.set) return;

    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      set: function(val) {
        _nativeSet.set.call(this, typeof val === 'string' ? proxyPath(val) : val);
      },
      get: function() {
        return _nativeSet.get.call(this);
      },
      configurable: true,
    });

    var _setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      if (typeof value === 'string') {
        var lname = name.toLowerCase();
        if (lname === 'src' || lname === 'data-src' || lname === 'data-original'
            || lname === 'data-lazy-src' || lname === 'data-srcset') {
          value = proxyPath(value);
        }
      }
      return _setAttribute.call(this, name, value);
    };
  })();
  // MutationObserver: proxy src on any newly inserted img/source/video elements
  (function observeNewImages() {
    function proxyElement(el) {
      var src = el.getAttribute('src') || el.getAttribute('data-src');
      if (src && !src.startsWith('/proxy') && !src.startsWith('data:') && !src.startsWith('blob:')) {
        var proxied = proxyPath(src);
        if (proxied !== src) {
          if (el.hasAttribute('src')) el.setAttribute('src', proxied);
          if (el.hasAttribute('data-src')) el.setAttribute('data-src', proxied);
        }
      }
    }
    var obs = new MutationObserver(function(mutations) {
      mutations.forEach(function(m) {
        m.addedNodes.forEach(function(node) {
          if (node.nodeType !== 1) return;
          if (node.tagName === 'IMG' || node.tagName === 'SOURCE' || node.tagName === 'VIDEO') {
            proxyElement(node);
          }
          node.querySelectorAll && node.querySelectorAll('img,source,video').forEach(proxyElement);
        });
      });
    });
    if (document.body) {
      obs.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', function() {
        obs.observe(document.body, { childList: true, subtree: true });
      });
    }
  })();
  document.addEventListener('click', function(e) {
    const a = e.target.closest('a');
    if (!a || !a.href) return;
    const raw = (a.getAttribute('href') || '').trim();
    if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw) || /^mailto:/i.test(raw)) return;
    let navUrl = a.href;
    try {
      const u = new URL(navUrl);
      if (u.searchParams.has('url') && (u.pathname === '/proxy' || u.pathname.endsWith('/proxy'))) {
        navUrl = decodeURIComponent(u.searchParams.get('url'));
      }
    } catch (_) {}
    if (navUrl.startsWith('http')) {
      e.preventDefault();
      try {
        const parsed = new URL(navUrl);
        if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
          navUrl = window.__PROXY_ORIGIN__ + parsed.pathname + parsed.search + parsed.hash;
        }
      } catch (_) {}
      window.parent.postMessage({ type: 'navigate', url: navUrl }, '*');
    }
  }, true);

  // Stream URL extraction from page source
  function scanPageForStreams() {
    var html = document.documentElement.innerHTML;
    var streams = [];
    var seen = {};

    function addStream(url, type) {
      try {
        url = url.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
        new URL(url);
        if (type !== 'EMBED') {
          var ext = type === 'HLS' ? 'm3u8' : type === 'DASH' ? 'mpd' : 'mp4';
          if (!/\\.[a-z0-9]+(?:\\?|$)/i.test(new URL(url).pathname + new URL(url).search)) return;
          if (!new RegExp('\\\\.' + ext + '(?:\\\\?|$)', 'i').test(new URL(url).pathname + new URL(url).search)) return;
        }
        if (!seen[url]) {
          seen[url] = true;
          streams.push({ url: url, type: type });
        }
      } catch (e) {}
    }

    var m3u8 = html.match(/https?:\\/\\/[^\\s"'<>]+\\.m3u8(?:\\?[^\\s"'<>]*)?/g) || [];
    m3u8.forEach(function(u) { addStream(u, 'HLS'); });

    var mp4 = html.match(/https?:\\/\\/[^\\s"'<>]+\\.mp4(?:\\?[^\\s"'<>]*)?/g) || [];
    mp4.forEach(function(u) { addStream(u, 'MP4'); });

    var mpd = html.match(/https?:\\/\\/[^\\s"'<>]+\\.mpd(?:\\?[^\\s"'<>]*)?/g) || [];
    mpd.forEach(function(u) { addStream(u, 'DASH'); });

    var embedPatterns = [
      /mp4upload\\.com\\/embed-[a-z0-9]+\\.html/i,
      /mp4upload\\.com\\/[a-z0-9]+$/i,
      /streamtape\\.com\\/e\\/[a-z0-9]+/i,
      /doodstream\\.com\\/e\\/[a-z0-9]+/i,
      /upstream\\.to\\/embed-[a-z0-9]+/i,
    ];
    var urlMatches = html.match(/https?:\\/\\/[^\\s"'<>]+/g) || [];
    urlMatches.forEach(function(u) {
      if (embedPatterns.some(function(p) { return p.test(u); })) {
        addStream(u, 'EMBED');
      }
    });

    streams.forEach(function(s) {
      window.parent.postMessage({
        type: 'aika-stream-detected',
        stream: {
          proxyUrl: '/proxy?url=' + encodeURIComponent(s.url),
          realUrl: s.url,
          type: s.type,
          domain: (function() { try { return new URL(s.url).hostname; } catch(e) { return ''; } })(),
          source: 'dom-scan',
        }
      }, '*');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      setTimeout(scanPageForStreams, 1000);
    });
  } else {
    setTimeout(scanPageForStreams, 1000);
  }
  setTimeout(scanPageForStreams, 3000);
})();
</script>`;
}

function safeSend(res, code, body) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...getProxyCrossOriginHeaders(),
  });
  res.end(body);
}

function collectSetCookieHeaders(upstream) {
  const cookies = [];
  try {
    if (typeof upstream.headers.getSetCookie === 'function') {
      cookies.push(...upstream.headers.getSetCookie());
    } else {
      const single = upstream.headers.get('set-cookie');
      if (single) cookies.push(single);
    }
  } catch (_) {
    /* ignore malformed upstream cookie headers */
  }
  return cookies;
}

function mergeResponseHeaders(base, upstream) {
  const headers = { ...base };
  const cookies = collectSetCookieHeaders(upstream);
  if (cookies.length === 1) {
    headers['Set-Cookie'] = cookies[0];
  } else if (cookies.length > 1) {
    headers['Set-Cookie'] = cookies;
  }
  return headers;
}

function parseTargetUrl(req) {
  const requestUrl = new URL(req.url, 'http://localhost');
  const raw = requestUrl.searchParams.get('url');
  if (!raw || !raw.trim()) return null;
  try {
    const target = new URL(raw.trim());
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    return target.href;
  } catch {
    return null;
  }
}

function pickUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function classifyRequest(targetUrl, req) {
  const fetchDest = (req?.headers?.['sec-fetch-dest'] || '').toLowerCase();
  if (fetchDest === 'video' || fetchDest === 'audio') return 'media';

  try {
    const path = new URL(targetUrl).pathname.toLowerCase();
    if (/\.css($|\?)/.test(path)) return 'style';
    if (/\.(js|mjs)($|\?)/.test(path)) return 'script';
    if (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff)($|\?)/.test(path)) return 'image';
    if (/\.(mp4|webm|m3u8|mpd|ts|m4s|m4v|m4a|mp3|wav|ogg)($|\?)/.test(path)) return 'media';
  } catch {
    /* fall through */
  }
  return 'document';
}

const ASSET_PATH_PREFIXES = [
  '/_app/',
  '/static/',
  '/assets/',
  '/public/',
  '/_next/',
  '/node_modules/',
  '/dist/',
  '/build/',
];

const ADBLOCKER_WHITELIST = [
  'jwplayer',
  'jwpcdn.com',
  'player.zilla-networks.com',
  'cloudfront.net',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
];

/** True for navigable pages; false for assets (fonts, images, media, etc.). */
function looksLikeHtmlPage(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (ASSET_PATH_PREFIXES.some((p) => path.startsWith(p))) return false;
    const nonHtmlExt =
      /\.(js|css|png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|eot|mp4|webm|mp3|wav|pdf|zip|json|xml|m3u8|ts|m4s|vtt|ass|srt|mpd|m4a|m4v|map|wasm|txt)$/;
    if (nonHtmlExt.test(path)) return false;
    return true;
  } catch {
    return false;
  }
}

/** True for binary assets that must be streamed, never read with .text() first. */
function looksLikeBinaryAsset(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff|woff2?|ttf|eot|otf|mp4|webm|mp3|wav|ogg|m3u8|ts|m4s|m4v|m4a|mpd|pdf|zip|wasm)(\?|$)/.test(
      path
    );
  } catch {
    return false;
  }
}

function isMediaContentType(contentType) {
  const ct = (contentType || '').toLowerCase();
  return (
    ct.startsWith('video/') ||
    ct.startsWith('audio/') ||
    ct.includes('mpegurl') ||
    ct.includes('dash+xml') ||
    ct.includes('octet-stream')
  );
}

function getUpstreamReferer(req) {
  const ref = req?.headers?.referer || '';
  const m = ref.match(/\/proxy\?url=([^&\s]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* fall through */
    }
  }
  return ref || undefined;
}

const CDN_REFERER_MAP = {
  'mp4upload.com': 'https://www.mp4upload.com/',
  'a3.mp4upload.com': 'https://www.mp4upload.com/',
  'streamtape.com': 'https://streamtape.com/',
};

function getCdnReferer(targetUrl) {
  try {
    const host = new URL(targetUrl).hostname;
    for (const [cdn, referer] of Object.entries(CDN_REFERER_MAP)) {
      if (host.includes(cdn)) return referer;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function getSecFetchHeaders(kind, req) {
  const fetchDest = (req?.headers?.['sec-fetch-dest'] || '').toLowerCase();
  if (kind === 'document') {
    return {
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    };
  }
  if (kind === 'media') {
    return {
      'Sec-Fetch-Dest': fetchDest === 'audio' ? 'audio' : 'video',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
    };
  }
  const dest = kind === 'style' ? 'style' : kind === 'script' ? 'script' : 'image';
  return {
    'Sec-Fetch-Dest': dest,
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'cross-site',
  };
}

function buildOutboundHeaders(req, targetUrl) {
  const kind = classifyRequest(targetUrl, req);
  const headers = {
    'User-Agent': pickUserAgent(),
    Accept:
      kind === 'media'
        ? '*/*'
        : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    DNT: '1',
    ...getSecFetchHeaders(kind, req),
  };

  if (req.headers.cookie) {
    headers.Cookie = req.headers.cookie;
  }

  const cdnReferer = getCdnReferer(targetUrl);
  if (cdnReferer) {
    headers.Referer = cdnReferer;
    headers.Origin = new URL(cdnReferer).origin;
  } else {
    const referer = getUpstreamReferer(req);
    if (referer) {
      headers.Referer = referer;
    }
  }

  if (req.headers.range) {
    headers.Range = req.headers.range;
  }
  if (req.headers['if-range']) {
    headers['If-Range'] = req.headers['if-range'];
  }

  return headers;
}

function isSslNetworkError(err) {
  const code = err?.cause?.code || err?.code || '';
  return (
    String(code).startsWith('ERR_SSL') ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED'
  );
}

function mapFetchDestToRequestType(dest) {
  const d = (dest || '').toLowerCase();
  const map = {
    document: 'main_frame',
    empty: 'other',
    audio: 'media',
    video: 'media',
    track: 'media',
    embed: 'sub_frame',
    iframe: 'sub_frame',
    font: 'font',
    image: 'image',
    script: 'script',
    style: 'stylesheet',
    worker: 'script',
    sharedworker: 'script',
    manifest: 'other',
  };
  return map[d] || 'other';
}

function sendAdblockBlockResponse(res, req) {
  const fetchDest = (req.headers['sec-fetch-dest'] || '').toLowerCase();
  const isScript =
    fetchDest === 'script' || fetchDest === 'worker' || fetchDest === 'sharedworker';
  if (isScript) {
    const body = '/* blocked by adblocker */';
    if (res.headersSent) return;
    res.writeHead(200, {
      ...getProxyCrossOriginHeaders(),
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
    });
    res.end(body);
    return;
  }
  if (res.headersSent) return;
  res.writeHead(204, getProxyCrossOriginHeaders());
  res.end();
}

function sendSslFailureResponse(res, req) {
  const fetchDest = (req.headers['sec-fetch-dest'] || '').toLowerCase();
  const isScript =
    fetchDest === 'script' || fetchDest === 'worker' || fetchDest === 'sharedworker';
  const body = '/* empty */';
  if (isScript) {
    if (res.headersSent) return;
    res.writeHead(200, {
      ...getProxyCrossOriginHeaders(),
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
    });
    res.end(body);
    return;
  }
  if (res.headersSent) return;
  res.writeHead(204, getProxyCrossOriginHeaders());
  res.end();
}

async function fetchWithRedirects(url, signal, req) {
  let current = url;

  try {
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      let response;
      try {
        response = await fetch(current, {
          method: 'GET',
          headers: buildOutboundHeaders(req, current),
          redirect: 'manual',
          signal,
        });
      } catch (err) {
        if (isSslNetworkError(err)) {
          err._proxySslFailure = true;
        }
        throw err;
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) return response;
        current = new URL(location, current).href;
        continue;
      }

      return response;
    }

    throw new Error('Too many redirects');
  } catch (err) {
    if (isSslNetworkError(err) || err._proxySslFailure) {
      const sslErr = new Error(err.message || 'SSL network error');
      sslErr.code = err.code || err.cause?.code;
      sslErr._proxySslFailure = true;
      throw sslErr;
    }
    throw err;
  }
}

function isSafeToRewrite(url) {
  if (!url) return false;
  const t = String(url).trim();
  if (!t) return false;
  if (t.startsWith('data:')) return false;
  if (t.startsWith('javascript:')) return false;
  if (t.startsWith('blob:')) return false;
  if (t.startsWith('#')) return false;
  if (t.startsWith('mailto:')) return false;
  if (t.startsWith('tel:')) return false;
  if (t.startsWith('/proxy')) return false;
  return true;
}

function resolveAbsoluteUrl(raw, baseUrl) {
  const trimmed = (raw || '').trim();
  if (!isSafeToRewrite(trimmed)) return null;

  try {
    if (trimmed.startsWith('//')) {
      return new URL(`https:${trimmed}`).href;
    }
    if (/^https?:\/\//i.test(trimmed)) {
      return new URL(trimmed).href;
    }
    const base = new URL(baseUrl);
    if (trimmed.startsWith('/')) {
      return new URL(trimmed, base.origin).href;
    }
    return new URL(trimmed, baseUrl).href;
  } catch {
    return null;
  }
}

function toProxyPath(absoluteUrl) {
  return `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
}

function rewriteUrlToProxy(raw, baseUrl) {
  try {
    if (!isSafeToRewrite(raw)) return raw;
    const absolute = resolveAbsoluteUrl(raw, baseUrl);
    if (!absolute) return raw;
    new URL(absolute);
    return toProxyPath(absolute);
  } catch {
    return raw;
  }
}

function rewriteManifestLine(line, baseUrl) {
  const trimmed = line.trim();
  if (!trimmed) return line;
  if (/^https?:\/\//i.test(trimmed)) {
    return rewriteUrlToProxy(trimmed, baseUrl);
  }
  const absolute = resolveAbsoluteUrl(trimmed, baseUrl);
  if (!absolute) return line;
  return toProxyPath(absolute);
}

function rewriteM3u8(text, baseUrl) {
  return text
    .split('\n')
    .map((line) => {
      if (line.startsWith('#')) return line;
      if (!line.trim()) return line;
      return rewriteManifestLine(line, baseUrl);
    })
    .join('\n');
}

function rewriteMpd(text, baseUrl) {
  return text
    .split('\n')
    .map((line) => {
      if (line.startsWith('#')) return line;
      if (!line.trim()) return line;
      return rewriteManifestLine(line, baseUrl);
    })
    .join('\n');
}

function rewriteCssUrls(css, baseUrl) {
  return css.replace(/url\s*\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, urlPart) => {
    try {
      const proxied = rewriteUrlToProxy(urlPart.trim(), baseUrl);
      return `url(${quote}${proxied}${quote})`;
    } catch {
      return match;
    }
  });
}

function rewriteSrcset(value, baseUrl) {
  return value
    .split(',')
    .map((part) => {
      try {
        const trimmed = part.trim();
        if (!trimmed) return part;
        const spaceIdx = trimmed.search(/\s/);
        const urlPart = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
        const descriptor = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx);
        const proxied = rewriteUrlToProxy(urlPart, baseUrl);
        return proxied + descriptor;
      } catch {
        return part;
      }
    })
    .join(', ');
}

function rewriteAttrUrls(html, attr, baseUrl) {
  const pattern = new RegExp(`\\b${attr}\\s*=\\s*(["'])([^"']*)\\1`, 'gi');
  return html.replace(pattern, (match, quote, value) => {
    try {
      const trimmed = value.trim();
      if (!isSafeToRewrite(trimmed)) return match;
      if (attr.toLowerCase() === 'srcset') {
        return `${attr}=${quote}${rewriteSrcset(trimmed, baseUrl)}${quote}`;
      }
      const proxied = rewriteUrlToProxy(trimmed, baseUrl);
      return `${attr}=${quote}${proxied}${quote}`;
    } catch {
      return match;
    }
  });
}

function rewriteInlineStyleUrls(html, baseUrl) {
  return html.replace(/\bstyle\s*=\s*(["'])([^"']*)\1/gi, (match, quote, styleBody) => {
    const rewritten = rewriteCssUrls(styleBody, baseUrl);
    return `style=${quote}${rewritten}${quote}`;
  });
}

function rewriteStyleBlocks(html, baseUrl) {
  return html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (match, attrs, css) => {
    return `<style${attrs}>${rewriteCssUrls(css, baseUrl)}</style>`;
  });
}

function rewriteInlineScriptUrls(html, pageUrl) {
  return html.replace(
    /(['"`])((?:\.\.\/|\.\/)+\.?[^'"`\s]+\.js(?:\?[^'"`\s]*)?|\/[^'"`\s]+\.js(?:\?[^'"`\s]*)?)(['"`])/g,
    (match, q1, path, q2) => {
      const abs = resolveAbsoluteUrl(path, pageUrl);
      if (!abs) return match;
      return `${q1}/proxy?url=${encodeURIComponent(abs)}${q2}`;
    }
  );
}

/** Rewrite relative ES module imports inside proxied .js files. */
function rewriteJsModuleUrls(js, moduleUrl) {
  function proxyQuotedPath(q1, path, q2) {
    if (path.startsWith('/proxy')) return null;
    const abs = resolveAbsoluteUrl(path, moduleUrl);
    if (!abs) return null;
    return `${q1}/proxy?url=${encodeURIComponent(abs)}${q2}`;
  }

  let out = js.replace(
    /(\bfrom\s*|import\s*\(\s*|import\s*)(['"])((?:\.\.\/|\.\/)+\.?[^'"\s]+\.(?:js|css|mjs)(?:\?[^'"\s]*)?)(['"]\)?)/g,
    (match, prefix, q1, path, suffix) => {
      const rewritten = proxyQuotedPath(q1, path, suffix);
      return rewritten ? `${prefix}${rewritten}` : match;
    }
  );
  out = out.replace(
    /(['"])((?:\.\.\/|\.\/)+\.?[^'"]+\.(?:js|css|mjs|woff2?)(?:\?[^'"]*)?)(['"])/g,
    (match, q1, path, q2) => proxyQuotedPath(q1, path, q2) || match
  );
  return out;
}

const AIKA_OVERLAY_SCRIPT = `<script>
(function() {
  var DENSITY = ' .:-=+*#%@\u2588\u2593\u2592\u2591';
  window.__aika = window.__aika || { enabled:true, size:8, brightness:1.4, color:'viridian', volume:0.8, speed:1 };

  function thermalColor(t) {
    var stops=[[0,[0,0,0]],[0.25,[80,0,128]],[0.5,[200,0,0]],[0.75,[255,120,0]],[1,[255,255,255]]];
    var x=Math.max(0,Math.min(1,t));
    for(var i=0;i<stops.length-1;i++){var t0=stops[i][0],c0=stops[i][1],t1=stops[i+1][0],c1=stops[i+1][1];if(x>=t0&&x<=t1){var f=(x-t0)/(t1-t0);return 'rgb('+Math.round(c0[0]+(c1[0]-c0[0])*f)+','+Math.round(c0[1]+(c1[1]-c0[1])*f)+','+Math.round(c0[2]+(c1[2]-c0[2])*f)+')';}}
    return 'rgb(255,255,255)';
  }

  function colorForLuma(luma,cfg) {
    var t=Math.max(0,Math.min(1,luma*cfg.brightness)),c=(cfg.color||'viridian').toLowerCase();
    if(c==='thermal') return thermalColor(t);
    if(c==='nightvision') return 'rgb(0,'+Math.round(t*255)+',65)';
    if(c==='amber') return 'rgb('+Math.round(212*t)+','+Math.round(132*t)+','+Math.round(42*t)+')';
    if(c==='midnight') return 'rgb(5,16,'+Math.round(27+t*80)+')';
    if(c==='crimson') return 'rgb('+Math.round(40+t*200)+',8,24)';
    if(c==='ghost'){var gv=Math.round(120+t*120);return 'rgb('+gv+','+gv+','+(gv+8)+')';}
    return 'rgb('+Math.round(46+t*79)+','+Math.round(125+t*43)+','+Math.round(107+t*35)+')';
  }

  function quantizeColor(r,g,b,br) {
    return 'rgb('+Math.min(255,Math.round(Math.min(255,r*br)/32)*32)+','+Math.min(255,Math.round(Math.min(255,g*br)/32)*32)+','+Math.min(255,Math.round(Math.min(255,b*br)/32)*32)+')';
  }

  function ensureSampleCanvas(media,vw,vh) {
    var W=320,H=Math.max(1,Math.round(W*(vh/vw)));
    if(!media._aikaSC){media._aikaSC=document.createElement('canvas');media._aikaCX=media._aikaSC.getContext('2d',{willReadFrequently:true});}
    if(media._aikaSC.width!==W||media._aikaSC.height!==H){media._aikaSC.width=W;media._aikaSC.height=H;}
    return {w:W,h:H,ctx:media._aikaCX};
  }

  function renderLoop(media,canvas) {
    var ctx=canvas.getContext('2d'),running=true,lastFrame=0;
    media.__aikaStop=function(){running=false;};
    function syncSize(){var wrap=media.parentElement;if(wrap&&wrap.classList.contains('aika-wrap')){var w=media.offsetWidth||media.clientWidth,h=media.offsetHeight||media.clientHeight;if(w>0)wrap.style.width=w+'px';if(h>0)wrap.style.height=h+'px';canvas.style.width='100%';canvas.style.height='100%';}}
    function loop(ts){
      requestAnimationFrame(loop);
      if(!running)return;
      ts=ts||performance.now();
      var cfg=window.__aika;
      if(!cfg.enabled){canvas.style.visibility='hidden';return;}
      canvas.style.visibility='visible';
      syncSize();
      var isVideo=media.tagName==='VIDEO';
      if(isVideo){media.volume=cfg.volume;media.playbackRate=cfg.speed;if(media.paused||media.ended)return;}
      var vw=isVideo?(media.videoWidth||0):(media.naturalWidth||media.width||0);
      var vh=isVideo?(media.videoHeight||0):(media.naturalHeight||media.height||0);
      if(!vw||!vh)return;
      if(lastFrame>0&&ts-lastFrame<33)return;
      lastFrame=ts;
      var colorMode=(cfg.color||'viridian').toLowerCase();
      var cell=Math.max(colorMode==='halftone'?2:4,cfg.size|0);
      canvas.width=vw;canvas.height=vh;
      var s=ensureSampleCanvas(media,vw,vh);
      try{s.ctx.drawImage(media,0,0,s.w,s.h);}catch(e){return;}
      var img=s.ctx.getImageData(0,0,s.w,s.h),data=img.data,sx=s.w/vw,sy=s.h/vh;
      ctx.fillStyle='#1A1A2E';ctx.fillRect(0,0,vw,vh);
      if(colorMode==='halftone'){
        var br=cfg.brightness,maxR=cell/2,buckets={};
        for(var cy=0;cy<vh;cy+=cell){for(var cx2=0;cx2<vw;cx2+=cell){var px=Math.min(s.w-1,((cx2+cell/2)*sx)|0),py=Math.min(s.h-1,((cy+cell/2)*sy)|0),ii=(py*s.w+px)*4,aa=data[ii+3];if(aa<10)continue;var luma=(data[ii]*0.299+data[ii+1]*0.587+data[ii+2]*0.114)/255;if(luma<0.04)continue;var rad=Math.max(0.5,maxR*(0.2+luma*0.8)),ck=quantizeColor(data[ii],data[ii+1],data[ii+2],br);if(!buckets[ck])buckets[ck]=[];buckets[ck].push({x:cx2+cell/2,y:cy+cell/2,r:rad});}}
        for(var col in buckets){var dots=buckets[col];ctx.fillStyle=col;ctx.beginPath();for(var di=0;di<dots.length;di++){var dd=dots[di];ctx.moveTo(dd.x+dd.r,dd.y);ctx.arc(dd.x,dd.y,dd.r,0,Math.PI*2);}ctx.fill();}
      } else {
        var charB={};ctx.font=cell+'px "Share Tech Mono",monospace';ctx.textBaseline='top';
        for(var y=0;y<vh;y+=cell){for(var x=0;x<vw;x+=cell){var spx=Math.min(s.w-1,((x+cell/2)*sx)|0),spy=Math.min(s.h-1,((y+cell/2)*sy)|0),si2=(spy*s.w+spx)*4;if(data[si2+3]<10)continue;var avg=(data[si2]*0.299+data[si2+1]*0.587+data[si2+2]*0.114)/255;if(avg<0.04)continue;var ch=DENSITY[DENSITY.length-1-Math.min(DENSITY.length-1,Math.floor(avg*(DENSITY.length-1)))],fc=colorForLuma(avg,cfg);if(!charB[fc])charB[fc]=[];charB[fc].push({x:x,y:y,ch:ch});}}
        for(var fc2 in charB){var gs=charB[fc2];ctx.fillStyle=fc2;for(var gi=0;gi<gs.length;gi++)ctx.fillText(gs[gi].ch,gs[gi].x,gs[gi].y);}
      }
    }
    requestAnimationFrame(loop);
  }

  function applyOverlay(media) {
    if(media.getAttribute('data-aika')==='true')return;
    media.setAttribute('data-aika','true');
    var canvas=document.createElement('canvas');
    canvas.style.cssText='position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:999999;';
    var parent=media.parentNode;
    if(parent&&parent.classList&&parent.classList.contains('aika-wrap')){parent.appendChild(canvas);}
    else{var wrap=document.createElement('div');wrap.className='aika-wrap';wrap.style.cssText='position:relative;display:inline-block;';var w=media.offsetWidth||media.clientWidth,h=media.offsetHeight||media.clientHeight;if(w>0)wrap.style.width=w+'px';if(h>0)wrap.style.height=h+'px';parent.insertBefore(wrap,media);wrap.appendChild(media);wrap.appendChild(canvas);}
    renderLoop(media,canvas);
  }

  function scanMedia() {
    document.querySelectorAll('video:not([data-aika])').forEach(applyOverlay);
    document.querySelectorAll('img:not([data-aika])').forEach(function(img){var src=(img.getAttribute('src')||img.currentSrc||'').split('?')[0].toLowerCase();if(src.endsWith('.gif')||img.id==='mainImage')applyOverlay(img);});
    document.querySelectorAll('video').forEach(function(v){v.volume=window.__aika.volume;v.playbackRate=window.__aika.speed;});
  }

  function init() {
    scanMedia();
    if(window.__aikaObserver)return;
    window.__aikaObserver=new MutationObserver(scanMedia);
    if(document.body)window.__aikaObserver.observe(document.body,{childList:true,subtree:true});
  }

  window.addEventListener('message',function(e){
    var d=e.data;if(!d||typeof d!=='object')return;
    if(d.type==='aika-settings'){if(d.size!=null)window.__aika.size=d.size;if(d.brightness!=null)window.__aika.brightness=d.brightness;if(d.color!=null)window.__aika.color=String(d.color).toLowerCase();if(d.volume!=null)window.__aika.volume=d.volume;if(d.speed!=null)window.__aika.speed=d.speed;if(d.enabled!=null)window.__aika.enabled=!!d.enabled;}
    if(d.type==='aika-toggle')window.__aika.enabled=!!d.enabled;
    if(d.type==='aika-init')init();
    if(d.type==='aika-transport'){document.querySelectorAll('video').forEach(function(v){if(d.volume!=null)v.volume=d.volume;if(d.speed!=null)v.playbackRate=d.speed;if(d.action==='play')v.play().catch(function(){});if(d.action==='pause')v.pause();if(d.action==='seek'&&d.time!=null){try{v.currentTime=d.time;}catch(e){}}});}
  });

  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}else{setTimeout(init,0);}
})();
<\/script>`;

function injectScripts(html, pageUrl) {
  const navScript = buildInjectedScript(pageUrl);
  if (html.includes('<head>')) {
    html = html.replace(/<head>/i, `<head>\n${navScript}`);
  } else if (/<head\s/i.test(html)) {
    html = html.replace(/<head\s[^>]*>/i, (m) => `${m}\n${navScript}`);
  }
  if (html.includes('</body>')) {
    return html.replace(/<\/body>/i, `${AIKA_OVERLAY_SCRIPT}</body>`);
  }
  return html + AIKA_OVERLAY_SCRIPT;
}

const EMBED_PAGE_PATTERNS = [
  /mp4upload\.com\/embed-[a-z0-9]+\.html/i,
  /mp4upload\.com\/[a-z0-9]+$/i,
  /streamtape\.com\/e\/[a-z0-9]+/i,
  /doodstream\.com\/e\/[a-z0-9]+/i,
  /upstream\.to\/embed-[a-z0-9]+/i,
];

function isEmbedPageUrl(url) {
  return EMBED_PAGE_PATTERNS.some((p) => p.test(url));
}

function hasVideoExtension(url, ext) {
  try {
    const u = new URL(url);
    return new RegExp(`\\.${ext}(?:\\?|$)`, 'i').test(u.pathname + u.search);
  } catch {
    return false;
  }
}

function extractDirectStreamsFromHtml(html) {
  const streams = [];
  const seen = new Set();

  function addStream(url, type) {
    try {
      url = url.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
      new URL(url);
      const ext = type === 'HLS' ? 'm3u8' : type === 'DASH' ? 'mpd' : 'mp4';
      if (!hasVideoExtension(url, ext)) return;
      if (!seen.has(url) && !url.includes('/embed')) {
        seen.add(url);
        streams.push({ url, type });
      }
    } catch {
      /* invalid URL */
    }
  }

  const m3u8 = html.match(/https?:\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]*)?/g) || [];
  m3u8.forEach((u) => addStream(u, 'HLS'));

  const mp4 = html.match(/https?:\/\/[^\s"'<>\\]+\.mp4(?:\?[^\s"'<>\\]*)?/g) || [];
  mp4.forEach((u) => addStream(u, 'MP4'));

  const mpd = html.match(/https?:\/\/[^\s"'<>\\]+\.mpd(?:\?[^\s"'<>\\]*)?/g) || [];
  mpd.forEach((u) => addStream(u, 'DASH'));

  const srcMatches = html.matchAll(
    /"(?:src|file|url|source)"\s*[=:]\s*["']?(https?:\/\/[^"'<>\s]+\.(?:mp4|m3u8)[^"'<>\s]*)/g
  );
  for (const m of srcMatches) {
    addStream(m[1], m[1].includes('.m3u8') ? 'HLS' : 'MP4');
  }

  const cdnMatches =
    html.match(/https?:\/\/(?:cdn\d*|a\d+|s\d+)\.[a-z0-9.-]+\/[a-z0-9/._-]+\.mp4[^\s"'<>]*/gi) ||
    [];
  cdnMatches.forEach((u) => addStream(u, 'MP4'));

  return streams;
}

function extractStreamUrls(html, pageUrl) {
  const streams = [];
  const embeds = [];
  const seen = new Set();
  const seenEmbeds = new Set();

  function addStream(url, type) {
    try {
      url = url.replace(/\\u002F/g, '/').replace(/\\\//g, '/');
      new URL(url);
      const ext = type === 'HLS' ? 'm3u8' : type === 'DASH' ? 'mpd' : 'mp4';
      if ((type === 'MP4' || type === 'HLS' || type === 'DASH') && !hasVideoExtension(url, ext)) return;
      if (!seen.has(url)) {
        seen.add(url);
        streams.push({ url, type });
      }
    } catch {
      /* invalid URL */
    }
  }

  function addEmbed(url) {
    try {
      url = url.replace(/\\u002F/g, '/').replace(/\\\//g, '/');
      new URL(url);
      if (!seenEmbeds.has(url) && isEmbedPageUrl(url)) {
        seenEmbeds.add(url);
        embeds.push(url);
      }
    } catch {
      /* invalid URL */
    }
  }

  const m3u8Matches = html.matchAll(/["'`](https?:\/\/[^"'`\s]+\.m3u8(?:\?[^"'`\s]*)?)["'`]/g);
  for (const m of m3u8Matches) addStream(m[1], 'HLS');

  const mp4Matches = html.matchAll(/["'`](https?:\/\/[^"'`\s]+\.mp4(?:\?[^"'`\s]*)?)["'`]/g);
  for (const m of mp4Matches) addStream(m[1], 'MP4');

  const mpdMatches = html.matchAll(/["'`](https?:\/\/[^"'`\s]+\.mpd(?:\?[^"'`\s]*)?)["'`]/g);
  for (const m of mpdMatches) addStream(m[1], 'DASH');

  const fileMatches = html.matchAll(
    /"(?:file|src|source|url|stream|hls|video)"\s*:\s*"(https?:\/\/[^"]+\.(?:m3u8|mp4|mpd)[^"]*)"/g
  );
  for (const m of fileMatches) {
    const url = m[1].replace(/\\\//g, '/');
    const type = url.includes('.m3u8') ? 'HLS' : url.includes('.mpd') ? 'DASH' : 'MP4';
    addStream(url, type);
  }

  const embedMatches = html.matchAll(/["'`](https?:\/\/[^"'`\s]+?)["'`]/g);
  for (const m of embedMatches) {
    addEmbed(m[1]);
  }

  return { streams, embeds };
}

function rewriteHtml(html, pageUrl) {
  if (!html.trimStart().toLowerCase().startsWith('<!doctype')) {
    html = '<!DOCTYPE html>\n' + html;
  }
  html = html.replace(/\s+integrity="[^"]*"/gi, '');
  html = html.replace(/\s+integrity='[^']*'/gi, '');
  html = html.replace(/\s+crossorigin="[^"]*"/gi, '');
  html = html.replace(/\s+crossorigin='[^']*'/gi, '');
  html = rewriteAttrUrls(html, 'src', pageUrl);
  html = rewriteAttrUrls(html, 'href', pageUrl);
  html = rewriteAttrUrls(html, 'srcset', pageUrl);
  html = rewriteAttrUrls(html, 'action', pageUrl);
  html = rewriteAttrUrls(html, 'data-src', pageUrl);
  html = rewriteAttrUrls(html, 'data-srcset', pageUrl);
  html = rewriteAttrUrls(html, 'data-original', pageUrl);
  html = rewriteAttrUrls(html, 'data-lazy-src', pageUrl);
  html = rewriteAttrUrls(html, 'poster', pageUrl);
  html = rewriteInlineStyleUrls(html, pageUrl);
  html = rewriteStyleBlocks(html, pageUrl);
  html = rewriteInlineScriptUrls(html, pageUrl);

  const { streams, embeds } = extractStreamUrls(html, pageUrl);
  const detected = [
    ...streams.map((s) => ({ ...s, source: 'page-extract' })),
    ...embeds.map((url) => ({ url, type: 'EMBED', source: 'page-extract' })),
  ];
  if (detected.length > 0) {
    const streamScript = `<script>
(function() {
  var detected = ${JSON.stringify(detected)};
  detected.forEach(function(s) {
    window.parent.postMessage({
      type: 'aika-stream-detected',
      stream: {
        proxyUrl: '/proxy?url=' + encodeURIComponent(s.url),
        realUrl: s.url,
        type: s.type,
        domain: (function() { try { return new URL(s.url).hostname; } catch(e) { return s.url; } })(),
        source: s.source || 'page-extract',
      }
    }, '*');
  });
  window.__aikaStreams = detected;
})();
<\/script>`;

    if (html.includes('</head>')) {
      html = html.replace(/<\/head>/i, streamScript + '</head>');
    } else {
      html = streamScript + html;
    }
  }

  html = injectScripts(html, pageUrl);
  return html;
}

function getProxyCrossOriginHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cross-Origin-Opener-Policy': 'unsafe-none',
  };
}

function buildPassThroughHeaders(upstream) {
  const out = { ...getProxyCrossOriginHeaders() };
  const preserveLength = upstream?.status === 206;
  const SKIP_HEADERS = new Set([
    ...(preserveLength ? [] : ['content-length']),
    'content-encoding',
    'transfer-encoding',
    'connection',
    'keep-alive',
    'content-security-policy',
    'content-security-policy-report-only',
    'x-frame-options',
    'permissions-policy',
    'x-content-type-options',
  ]);
  for (const [k, v] of upstream.headers.entries()) {
    if (!SKIP_HEADERS.has(k.toLowerCase())) {
      out[k] = v;
    }
  }
  return out;
}

function isCssResponse(contentType, targetUrl) {
  if (getForcedContentType(targetUrl) === 'text/css; charset=utf-8') return true;
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('text/css')) return true;
  try {
    return new URL(targetUrl).pathname.toLowerCase().endsWith('.css');
  } catch {
    return false;
  }
}

function getForcedContentType(targetUrl) {
  try {
    const path = new URL(targetUrl).pathname.toLowerCase();
    if (/\.mjs($|\?)/.test(path) || /\.js($|\?)/.test(path)) {
      return 'application/javascript; charset=utf-8';
    }
    if (/\.css($|\?)/.test(path)) {
      return 'text/css; charset=utf-8';
    }
    if (/\.json($|\?)/.test(path) || /\.map($|\?)/.test(path)) {
      return 'application/json; charset=utf-8';
    }
    if (/\.wasm($|\?)/.test(path)) {
      return 'application/wasm';
    }
    if (/\.txt($|\?)/.test(path)) {
      return 'text/plain; charset=utf-8';
    }
    if (/\.xml($|\?)/.test(path)) {
      return 'application/xml; charset=utf-8';
    }
    if (/\.mp4($|\?)/.test(path) || /\.m4v($|\?)/.test(path)) {
      return 'video/mp4';
    }
    if (/\.webm($|\?)/.test(path)) {
      return 'video/webm';
    }
    if (/\.m3u8($|\?)/.test(path)) {
      return 'application/vnd.apple.mpegurl';
    }
    if (/\.mpd($|\?)/.test(path)) {
      return 'application/dash+xml';
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** node-fetch v3 returns a Node.js stream; native fetch returns a Web ReadableStream. */
function toNodeReadableStream(body) {
  if (!body) return null;
  if (typeof body.pipe === 'function') return body;
  if (typeof body.getReader === 'function') return Readable.fromWeb(body);
  return null;
}

async function streamUpstreamBody(upstream, res, targetUrl, forcedTypeOverride = null) {
  const passHeaders = mergeResponseHeaders(buildPassThroughHeaders(upstream), upstream);
  const forcedType = forcedTypeOverride ?? getForcedContentType(targetUrl);
  if (forcedType) passHeaders['Content-Type'] = forcedType;

  const nodeBody = toNodeReadableStream(upstream.body);

  if (!nodeBody) {
    if (res.headersSent) return;
    res.writeHead(upstream.status, passHeaders);
    res.end();
    return;
  }

  if (res.headersSent) return;
  res.writeHead(upstream.status, passHeaders);

  try {
    await pipeline(nodeBody, res);
  } catch (pipeErr) {
    if (!res.headersSent) {
      safeSend(res, 502, `Bad gateway: ${pipeErr.message || 'stream error'}`);
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

function appendProxyOriginCookie(headers, targetUrl) {
  if (!targetUrl) return;
  try {
    const origin = encodeURIComponent(new URL(targetUrl).origin);
    const cookie = `aika_proxy_origin=${origin}; Path=/; SameSite=Lax`;
    const existing = headers['Set-Cookie'];
    if (!existing) {
      headers['Set-Cookie'] = cookie;
    } else if (Array.isArray(existing)) {
      headers['Set-Cookie'] = [...existing, cookie];
    } else {
      headers['Set-Cookie'] = [existing, cookie];
    }
  } catch {
    /* ignore invalid targetUrl */
  }
}

function sendHtmlProxyResponse(res, html, { upstream = null, render = 'puppeteer', targetUrl = null } = {}) {
  const buffer = Buffer.from(html, 'utf8');
  const base = {
    ...getProxyCrossOriginHeaders(),
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buffer.length,
    'X-Content-Type-Options': 'nosniff',
    'X-Victoria-Render': render,
  };
  // upstream is headers-only (Set-Cookie); html string is written directly — never read upstream.body
  const headers = upstream ? mergeResponseHeaders(base, upstream) : base;
  appendProxyOriginCookie(headers, targetUrl);
  if (res.headersSent) return;
  res.writeHead(200, headers);
  res.end(buffer);
}

function sendEmpty204(res, upstream) {
  const headers = mergeResponseHeaders(getProxyCrossOriginHeaders(), upstream);
  if (res.headersSent) return;
  res.writeHead(204, headers);
  res.end();
}

function looksLikeJavaScriptSnippet(preview) {
  if (!preview) return false;
  if (/^#!\s*\/usr\/bin\/env node/.test(preview)) return true;
  if (
    /^\s*(\(function|\(async function|function\s*\(|import\s+|export\s+|const\s+|let\s+|var\s+|\/\/|\/\*|window\.|document\.|self\.)/.test(
      preview
    )
  ) {
    return true;
  }
  if (/jwplayer|define\s*\(|__webpack|webpackJsonp/.test(preview)) return true;
  return false;
}

function looksLikeHtmlSnippet(preview) {
  if (!preview) return true;
  return /^\s*<!DOCTYPE/i.test(preview) || /^\s*<html/i.test(preview) || preview.startsWith('<');
}

async function sniffAndServeUnknownType(upstream, targetUrl, res) {
  const MAX_SNIFF_SIZE = 5 * 1024 * 1024;
  const buffer = Buffer.from(await upstream.arrayBuffer());
  if (buffer.length > MAX_SNIFF_SIZE) {
    const headers = mergeResponseHeaders(
      {
        ...getProxyCrossOriginHeaders(),
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(buffer.length),
      },
      upstream
    );
    if (res.headersSent) return;
    res.writeHead(upstream.status, headers);
    res.end(buffer);
    return;
  }
  const preview = buffer.subarray(0, 256).toString('utf8').trim();
  const emptyJs = '/* empty */';

  if (buffer.length === 0 || looksLikeHtmlSnippet(preview)) {
    const headers = mergeResponseHeaders(
      {
        ...getProxyCrossOriginHeaders(),
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(emptyJs)),
      },
      upstream
    );
    if (res.headersSent) return;
    res.writeHead(upstream.status, headers);
    res.end(emptyJs);
    return;
  }

  if (looksLikeJavaScriptSnippet(preview)) {
    const headers = mergeResponseHeaders(
      {
        ...buildPassThroughHeaders(upstream),
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Length': String(buffer.length),
      },
      upstream
    );
    if (res.headersSent) return;
    res.writeHead(upstream.status, headers);
    res.end(buffer);
    return;
  }

  const headers = mergeResponseHeaders(
    {
      ...buildPassThroughHeaders(upstream),
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(buffer.length),
    },
    upstream
  );
  if (res.headersSent) return;
  res.writeHead(upstream.status, headers);
  res.end(buffer);
}

async function respondFromUpstream(upstream, targetUrl, res, { htmlRender = 'fetch', req = null } = {}) {
  const contentLength = upstream.headers.get('content-length');
  if (upstream.status === 204 || (contentLength === '0' && upstream.status !== 206)) {
    return sendEmpty204(res, upstream);
  }

  // 206 Partial Content / 416 Range Not Satisfiable — pass through as-is
  if (upstream.status === 206 || upstream.status === 416) {
    return streamUpstreamBody(upstream, res, targetUrl);
  }

  const rawContentType = upstream.headers.get('content-type');
  const contentType = rawContentType || '';
  const ctLower = contentType.toLowerCase();
  let forcedType = getForcedContentType(targetUrl);
  const isUpstreamJS = ctLower.includes('javascript') || ctLower.includes('ecmascript');
  if (isUpstreamJS && !forcedType) {
    forcedType = 'application/javascript; charset=utf-8';
  }

  // Video/audio and range requests must stream — never buffer or sniff
  if (isMediaContentType(contentType) || req?.headers?.range || looksLikeBinaryAsset(targetUrl)) {
    return streamUpstreamBody(upstream, res, targetUrl, forcedType || undefined);
  }

  if (forcedType?.includes('javascript') || isUpstreamJS) {
    const js = await upstream.text();
    const modified = rewriteJsModuleUrls(js, targetUrl);
    const buffer = Buffer.from(modified, 'utf8');
    const headers = mergeResponseHeaders(
      {
        ...buildPassThroughHeaders(upstream),
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Length': String(buffer.length),
      },
      upstream
    );
    if (res.headersSent) return;
    res.writeHead(upstream.status, headers);
    res.end(buffer);
    return;
  }

  if (forcedType) {
    return streamUpstreamBody(upstream, res, targetUrl, forcedType);
  }

  if (isCssResponse(contentType, targetUrl)) {
    const css = await upstream.text();
    const modified = rewriteCssUrls(css, targetUrl);
    const buffer = Buffer.from(modified, 'utf8');
    const headers = mergeResponseHeaders(
      {
        ...buildPassThroughHeaders(upstream),
        'Content-Type': 'text/css; charset=utf-8',
        'Content-Length': String(buffer.length),
      },
      upstream
    );
    if (res.headersSent) return;
    res.writeHead(upstream.status, headers);
    res.end(buffer);
    return;
  }

  let pathLower = '';
  try {
    pathLower = new URL(targetUrl).pathname.toLowerCase();
  } catch {
    /* ignore */
  }
  const isM3u8 = pathLower.endsWith('.m3u8') || ctLower.includes('mpegurl');
  const isMpd = pathLower.endsWith('.mpd') || ctLower.includes('dash+xml');

  if (isM3u8) {
    const text = await upstream.text();
    const modified = rewriteM3u8(text, targetUrl);
    const buffer = Buffer.from(modified, 'utf8');
    const headers = mergeResponseHeaders(
      {
        ...buildPassThroughHeaders(upstream),
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': String(buffer.length),
      },
      upstream
    );
    if (res.headersSent) return;
    res.writeHead(upstream.status, headers);
    res.end(buffer);
    return;
  }

  if (isMpd) {
    const text = await upstream.text();
    const modified = rewriteMpd(text, targetUrl);
    const buffer = Buffer.from(modified, 'utf8');
    const headers = mergeResponseHeaders(
      {
        ...buildPassThroughHeaders(upstream),
        'Content-Type': 'application/dash+xml',
        'Content-Length': String(buffer.length),
      },
      upstream
    );
    if (res.headersSent) return;
    res.writeHead(upstream.status, headers);
    res.end(buffer);
    return;
  }

  if (ctLower.includes('text/html')) {
    const body = await upstream.text();
    const modified = rewriteHtml(body, targetUrl);
    return sendHtmlProxyResponse(res, modified, { upstream, render: htmlRender, targetUrl });
  }

  if (!rawContentType && !forcedType) {
    if (req?.headers?.range) {
      return streamUpstreamBody(upstream, res, targetUrl);
    }
    return sniffAndServeUnknownType(upstream, targetUrl, res);
  }

  return streamUpstreamBody(upstream, res, targetUrl);
}

// Minimum content length for a "real" SSR page.
// If fetch returns less than this, try Puppeteer (page likely needs JS).
const SSR_MIN_BYTES = 5_000;

async function proxyHtmlDocument(targetUrl, req, res, signal, clearFetchTimeout) {
  if (!looksLikeHtmlPage(targetUrl) || getForcedContentType(targetUrl)) {
    const upstream = await fetchWithRedirects(targetUrl, signal, req);
    clearFetchTimeout?.();
    return respondFromUpstream(upstream, targetUrl, res, { htmlRender: 'fetch', req });
  }

  let upstream;
  try {
    upstream = await fetchWithRedirects(targetUrl, signal, req);
    clearFetchTimeout?.();
  } catch (fetchErr) {
    console.warn('[proxy] fetch failed:', fetchErr.message);
    try {
      const html = await renderHtmlWithPuppeteer(targetUrl, req, signal);
      const modified = rewriteHtml(html, targetUrl);
      return sendHtmlProxyResponse(res, modified, { render: 'puppeteer', targetUrl });
    } catch (puppeteerErr) {
      console.warn('[proxy] Puppeteer also failed:', puppeteerErr.message);
      throw fetchErr;
    }
  }

  const ct = (upstream.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('text/html')) {
    return respondFromUpstream(upstream, targetUrl, res, { htmlRender: 'fetch', req });
  }

  const body = await upstream.text();
  const isShellOnly = body.length < SSR_MIN_BYTES ||
    (body.includes('<div id="app"></div>') && !body.includes('__NUXT__') && !body.includes('__NEXT_DATA__'));

  if (isShellOnly) {
    console.log('[proxy] Fetch returned SPA shell, trying Puppeteer for:', targetUrl);
    try {
      const html = await renderHtmlWithPuppeteer(targetUrl, req, signal);
      const modified = rewriteHtml(html, targetUrl);
      return sendHtmlProxyResponse(res, modified, { render: 'puppeteer', targetUrl });
    } catch (puppeteerErr) {
      console.warn('[proxy] Puppeteer failed, using fetch shell:', puppeteerErr.message);
    }
  }

  const modified = rewriteHtml(body, targetUrl);
  return sendHtmlProxyResponse(res, modified, { render: 'fetch', targetUrl });
}

export async function handleProxy(req, res) {
  const controller = new AbortController();
  let timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const clearFetchTimeout = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  let targetUrl = null;
  try {
    targetUrl = parseTargetUrl(req);
    console.log('[proxy] request:', req.method, targetUrl?.slice(0, 120));

    if (!targetUrl) {
      return safeSend(
        res,
        400,
        'Bad request: missing or invalid url parameter (http/https required)'
      );
    }

    let hostname = '';
    try {
      hostname = new URL(targetUrl).hostname;
    } catch {
      /* ignore */
    }
    const isWhitelisted = ADBLOCKER_WHITELIST.some(
      (w) => hostname.includes(w) || targetUrl.includes(w)
    );

    if (!isWhitelisted && adblocker) {
      const { match } = adblocker.match(
        Request.fromRawDetails({
          url: targetUrl,
          type: mapFetchDestToRequestType(req.headers['sec-fetch-dest']),
          sourceUrl: req.headers.referer || '',
        })
      );
      if (match) {
        console.log('[adblocker] Blocked:', targetUrl);
        return sendAdblockBlockResponse(res, req);
      }
    }

    const fetchDest = (req.headers['sec-fetch-dest'] || '').toLowerCase();
    const isScriptRequest =
      fetchDest === 'script' || fetchDest === 'worker' || fetchDest === 'sharedworker';
    const isMediaRequest = fetchDest === 'video' || fetchDest === 'audio';

    if (isScriptRequest) {
      const upstream = await fetchWithRedirects(targetUrl, controller.signal, req);
      clearFetchTimeout();
      return respondFromUpstream(upstream, targetUrl, res, { req });
    }

    if (isMediaRequest || looksLikeBinaryAsset(targetUrl)) {
      const upstream = await fetchWithRedirects(targetUrl, controller.signal, req);
      clearFetchTimeout();
      return respondFromUpstream(upstream, targetUrl, res, { req });
    }

    if (looksLikeHtmlPage(targetUrl)) {
      return proxyHtmlDocument(targetUrl, req, res, controller.signal, clearFetchTimeout);
    }

    const upstream = await fetchWithRedirects(targetUrl, controller.signal, req);
    clearFetchTimeout();
    return respondFromUpstream(upstream, targetUrl, res, { req });
  } catch (err) {
    console.error('[proxy] error for', targetUrl?.slice(0, 120), ':', err.message);
    if (err.name === 'AbortError') {
      return safeSend(res, 504, 'Gateway timeout: upstream request timed out');
    }
    if (err.message === 'Too many redirects') {
      return safeSend(res, 502, 'Bad gateway: too many redirects');
    }
    const code = err.cause?.code || err.code;
    if (err._proxySslFailure || (code && String(code).startsWith('ERR_SSL'))) {
      return sendSslFailureResponse(res, req);
    }
    if (
      code === 'ENOTFOUND' ||
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'EAI_AGAIN' ||
      err.name === 'TypeError'
    ) {
      return safeSend(res, 502, `Bad gateway: ${err.message || 'network error'}`);
    }
    if (!res.headersSent) {
      return safeSend(res, 500, `Proxy error: ${err.message || 'internal error'}`);
    }
  } finally {
    clearFetchTimeout();
  }
}

export async function handleEmbedExtract(req, res) {
  const targetUrl = new URL(req.url, 'http://localhost').searchParams.get('url');
  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no url' }));
    return;
  }

  try {
    const referer = getCdnReferer(targetUrl) || new URL(targetUrl).origin + '/';
    const upstream = await fetch(targetUrl, {
      headers: {
        'User-Agent': pickUserAgent(),
        Referer: referer,
        Origin: new URL(referer).origin,
        Accept: 'text/html,application/xhtml+xml,*/*',
        'Accept-Encoding': 'identity',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const html = await upstream.text();
    const streams = extractDirectStreamsFromHtml(html);

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ streams, embedUrl: targetUrl }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}
