import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { renderHtmlWithPuppeteer } from './puppeteer-browser.js';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
];

const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

const INJECTED_SCRIPT = `<script>
(function() {
  const PROXY = '/proxy?url=';
  const origFetch = window.fetch;
  window.fetch = function(url, opts) {
    if (typeof url === 'string' && url.startsWith('http')) {
      url = PROXY + encodeURIComponent(url);
    }
    return origFetch(url, opts);
  };
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new OrigXHR();
    const origOpen = xhr.open;
    xhr.open = function(method, url) {
      if (typeof url === 'string' && url.startsWith('http')) {
        url = PROXY + encodeURIComponent(url);
      }
      return origOpen.apply(this, [method, url, ...Array.prototype.slice.call(arguments, 2)]);
    };
    return xhr;
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

function safeSend(res, code, body) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
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

/** True for navigable pages; false for assets (fonts, images, media, etc.). */
function looksLikeHtmlPage(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const nonHtmlExt =
      /\.(js|css|png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|eot|mp4|webm|mp3|wav|pdf|zip|json|xml)$/;
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
    'Accept-Encoding': 'gzip, deflate, br',
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

async function fetchWithRedirects(url, signal, req) {
  let current = url;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await humanDelay();

    const response = await fetch(current, {
      method: 'GET',
      headers: buildOutboundHeaders(req, current),
      redirect: 'manual',
      signal,
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) return response;
      current = new URL(location, current).href;
      continue;
    }

    return response;
  }

  throw new Error('Too many redirects');
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

function injectScripts(html) {
  if (html.includes('</body>')) {
    return html.replace(/<\/body>/i, `${INJECTED_SCRIPT}</body>`);
  }
  return html + INJECTED_SCRIPT;
}

function rewriteHtml(html, pageUrl) {
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
  html = injectScripts(html);
  return html;
}

function buildPassThroughHeaders(upstream) {
  const out = { 'Access-Control-Allow-Origin': '*' };
  const ct = upstream.headers.get('content-type');
  const cl = upstream.headers.get('content-length');
  const cc = upstream.headers.get('cache-control');
  const et = upstream.headers.get('etag');
  const lm = upstream.headers.get('last-modified');
  if (ct) out['Content-Type'] = ct;
  if (cl) out['Content-Length'] = cl;
  if (cc) out['Cache-Control'] = cc;
  if (et) out['ETag'] = et;
  if (lm) out['Last-Modified'] = lm;
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
    if (/\.json($|\?)/.test(path)) {
      return 'application/json; charset=utf-8';
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function streamUpstreamBody(upstream, res, targetUrl) {
  const passHeaders = mergeResponseHeaders(buildPassThroughHeaders(upstream), upstream);
  const forcedType = getForcedContentType(targetUrl);
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
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buffer.length,
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    'X-Victoria-Render': render,
  };
  const headers = upstream ? mergeResponseHeaders(base, upstream) : base;
  if (res.headersSent) return;
  res.writeHead(200, headers);
  res.end(buffer);
}

function sendEmpty204(res, upstream) {
  const headers = mergeResponseHeaders(
    { 'Access-Control-Allow-Origin': '*' },
    upstream
  );
  if (res.headersSent) return;
  res.writeHead(204, headers);
  res.end();
}

async function respondFromUpstream(upstream, targetUrl, res, { htmlRender = 'fetch' } = {}) {
  const contentLength = upstream.headers.get('content-length');
  if (upstream.status === 204 || contentLength === '0') {
    return sendEmpty204(res, upstream);
  }

  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const ctLower = contentType.toLowerCase();
  const forcedType = getForcedContentType(targetUrl);

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

  if (
    forcedType === 'application/javascript; charset=utf-8' ||
    forcedType === 'application/json; charset=utf-8'
  ) {
    return streamUpstreamBody(upstream, res, targetUrl);
  }

  if (!forcedType && ctLower.includes('text/html')) {
    const body = await upstream.text();
    const modified = rewriteHtml(body, targetUrl);
    return sendHtmlProxyResponse(res, modified, { upstream, render: htmlRender });
  }

  return streamUpstreamBody(upstream, res, targetUrl);
}

async function proxyHtmlDocument(targetUrl, req, res, signal) {
  if (looksLikeHtmlPage(targetUrl)) {
    try {
      const html = await renderHtmlWithPuppeteer(targetUrl, req);
      const modified = rewriteHtml(html, targetUrl);
      return sendHtmlProxyResponse(res, modified, { render: 'puppeteer' });
    } catch (puppeteerErr) {
      console.warn('[proxy] Puppeteer failed, falling back to fetch:', puppeteerErr.message);
    }
  }

  const upstream = await fetchWithRedirects(targetUrl, signal, req);
  return respondFromUpstream(upstream, targetUrl, res, { htmlRender: 'fetch' });
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

    if (looksLikeHtmlPage(targetUrl)) {
      return proxyHtmlDocument(targetUrl, req, res, controller.signal);
    }

    const upstream = await fetchWithRedirects(targetUrl, controller.signal, req);
    return respondFromUpstream(upstream, targetUrl, res);
  } catch (err) {
    if (err.name === 'AbortError') {
      return safeSend(res, 504, 'Gateway timeout: upstream request timed out');
    }
    if (err.message === 'Too many redirects') {
      return safeSend(res, 502, 'Bad gateway: too many redirects');
    }
    const code = err.cause?.code || err.code;
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
