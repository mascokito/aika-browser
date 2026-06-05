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
  function proxyPath(url) {
    if (typeof url !== 'string') return url;
    if (url.startsWith('http')) return PROXY + encodeURIComponent(url);
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
  const __origImport = window.__origImport__ || (function(s) { return import(s); });
  window.__patchedImport = function(path) {
    if (path && path.startsWith('/') && !path.startsWith('/proxy')) {
      path = PROXY + encodeURIComponent(window.__PROXY_ORIGIN__ + path);
    }
    return __origImport(path);
  };
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
      window.parent.postMessage({ type: 'navigate', url: navUrl }, '*');
    }
  }, true);
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

function classifyRequest(targetUrl) {
  try {
    const path = new URL(targetUrl).pathname.toLowerCase();
    if (/\.css($|\?)/.test(path)) return 'style';
    if (/\.(js|mjs)($|\?)/.test(path)) return 'script';
    if (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff)($|\?)/.test(path)) return 'image';
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

function getSecFetchHeaders(kind) {
  if (kind === 'document') {
    return {
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
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
  const kind = classifyRequest(targetUrl);
  const headers = {
    'User-Agent': pickUserAgent(),
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    DNT: '1',
    ...getSecFetchHeaders(kind),
  };

  if (req.headers.cookie) {
    headers.Cookie = req.headers.cookie;
  }

  return headers;
}

async function humanDelay() {
  await new Promise((r) => setTimeout(r, 100 + Math.random() * 400));
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
      await humanDelay();

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

function shouldSkipUrl(url) {
  return !isSafeToRewrite(url);
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
    /(['"`])(\/_[a-zA-Z][^'"`\s]*\.js[^'"`\s]*)(['"`])/g,
    (match, q1, path, q2) => {
      try {
        const abs = new URL(path, pageUrl).href;
        return `${q1}/proxy?url=${encodeURIComponent(abs)}${q2}`;
      } catch {
        return match;
      }
    }
  );
}

function injectScripts(html, pageUrl) {
  const script = buildInjectedScript(pageUrl);
  if (html.includes('</body>')) {
    return html.replace(/<\/body>/i, `${script}</body>`);
  }
  return html + script;
}

function rewriteHtml(html, pageUrl, req) {
  html = html.replace(/\s+integrity="[^"]*"/gi, '');
  html = html.replace(/\s+integrity='[^']*'/gi, '');
  html = html.replace(/\s+crossorigin="[^"]*"/gi, '');
  html = html.replace(/\s+crossorigin='[^']*'/gi, '');
  html = rewriteAttrUrls(html, 'src', pageUrl);
  html = rewriteAttrUrls(html, 'href', pageUrl);
  html = rewriteAttrUrls(html, 'srcset', pageUrl);
  html = rewriteAttrUrls(html, 'action', pageUrl);
  html = rewriteInlineStyleUrls(html, pageUrl);
  html = rewriteStyleBlocks(html, pageUrl);
  html = rewriteInlineScriptUrls(html, pageUrl);
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
  const SKIP_HEADERS = new Set([
    'content-length',
    'content-encoding',
    'transfer-encoding',
    'connection',
    'keep-alive',
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
  } catch {
    /* ignore */
  }
  return null;
}

async function streamUpstreamBody(upstream, res, targetUrl, forcedTypeOverride = null) {
  const passHeaders = mergeResponseHeaders(buildPassThroughHeaders(upstream), upstream);
  const forcedType = forcedTypeOverride ?? getForcedContentType(targetUrl);
  if (forcedType) passHeaders['Content-Type'] = forcedType;

  if (!upstream.body) {
    if (res.headersSent) return;
    res.writeHead(upstream.status, passHeaders);
    res.end();
    return;
  }

  if (res.headersSent) return;
  res.writeHead(upstream.status, passHeaders);

  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (pipeErr) {
    if (!res.headersSent) {
      safeSend(res, 502, `Bad gateway: ${pipeErr.message || 'stream error'}`);
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

function sendHtmlProxyResponse(res, html, { upstream = null, render = 'puppeteer' } = {}) {
  const buffer = Buffer.from(html, 'utf8');
  const base = {
    ...getProxyCrossOriginHeaders(),
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buffer.length,
    'X-Content-Type-Options': 'nosniff',
    'X-Victoria-Render': render,
  };
  const headers = upstream ? mergeResponseHeaders(base, upstream) : base;
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
  if (upstream.status === 204 || contentLength === '0') {
    return sendEmpty204(res, upstream);
  }

  const rawContentType = upstream.headers.get('content-type');
  const contentType = rawContentType || '';
  const ctLower = contentType.toLowerCase();
  let forcedType = getForcedContentType(targetUrl);
  const isUpstreamJS = ctLower.includes('javascript') || ctLower.includes('ecmascript');
  if (isUpstreamJS && !forcedType) {
    forcedType = 'application/javascript; charset=utf-8';
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
    const modified = rewriteHtml(body, targetUrl, req);
    return sendHtmlProxyResponse(res, modified, { upstream, render: htmlRender });
  }

  if (!rawContentType && !forcedType) {
    return sniffAndServeUnknownType(upstream, targetUrl, res);
  }

  return streamUpstreamBody(upstream, res, targetUrl);
}

async function proxyHtmlDocument(targetUrl, req, res, signal) {
  if (looksLikeHtmlPage(targetUrl) && !getForcedContentType(targetUrl)) {
    try {
      const html = await renderHtmlWithPuppeteer(targetUrl, req, signal);
      const modified = rewriteHtml(html, targetUrl, req);
      return sendHtmlProxyResponse(res, modified, { render: 'puppeteer' });
    } catch (puppeteerErr) {
      console.warn('[proxy] Puppeteer failed, falling back to fetch:', puppeteerErr.message);
    }
  }

  const upstream = await fetchWithRedirects(targetUrl, signal, req);
  return respondFromUpstream(upstream, targetUrl, res, { htmlRender: 'fetch', req });
}

export async function handleProxy(req, res) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const targetUrl = parseTargetUrl(req);
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
    if (isScriptRequest) {
      const upstream = await fetchWithRedirects(targetUrl, controller.signal, req);
      return respondFromUpstream(upstream, targetUrl, res, { req });
    }

    if (looksLikeHtmlPage(targetUrl)) {
      return proxyHtmlDocument(targetUrl, req, res, controller.signal);
    }

    const upstream = await fetchWithRedirects(targetUrl, controller.signal, req);
    return respondFromUpstream(upstream, targetUrl, res, { req });
  } catch (err) {
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
    return safeSend(res, 500, `Proxy error: ${err.message || 'internal error'}`);
  } finally {
    clearTimeout(timeoutId);
  }
}
