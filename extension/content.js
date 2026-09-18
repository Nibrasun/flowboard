/**
 * Content script — bridge between background.js and injected.js.
 * Injects injected.js into MAIN world and forwards GET_CAPTCHA messages.
 */
(function () {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('injected.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
})();

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type === 'PAGE_FETCH') {
    // Relay from whichever Flow frame answers first (top page or
    // editor frame). The UI itself uploads cross-origin from these
    // frames, so the server accepts their preflight.
    // Same-origin relay: runs in page origin, so no CORS preflight —
    // custom X-Goog-Upload-* headers go out verbatim with cookies.
    (async () => {
      try {
        const { url, method, headers, bodyB64, bodyText } = msg.params || {};
        let body;
        if (bodyB64) {
          const bin = atob(bodyB64);
          body = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) body[i] = bin.charCodeAt(i);
        } else if (typeof bodyText === 'string') {
          // batchexecute needs the page's XSRF token (WIZ_global_data.SNlM0e).
          // It lives in a MAIN-world variable we can't touch from here, but
          // the same value is in the inline bootstrap script in the DOM.
          const at = (document.documentElement.innerHTML
            .match(/"SNlM0e":"([^"]+)"/) || [])[1];
          if (!at && bodyText.includes('__FLOWBOARD_AT__')) {
            reply({ status: 500, error: 'NO_XSRF_TOKEN_ON_PAGE' });
            return;
          }
          body = bodyText.split('__FLOWBOARD_AT__').join(encodeURIComponent(at || ''));
        }
        const resp = await fetch(url, {
          method: method || 'POST',
          headers: { ...(headers || {}) },
          credentials: 'include',
          body: method === 'GET' ? undefined : body,
        });
        const text = await resp.text();
        const respHeaders = {};
        resp.headers.forEach((v, k) => { respHeaders[k] = v; });
        reply({ status: resp.status, data: text, headers: respHeaders,
                dbgSentBytes: body ? body.length : 0,
                dbgGotHeaders: Object.keys(headers || {}) });
      } catch (e) {
        reply({ status: 500, error: e.message || 'PAGE_FETCH_FAILED' });
      }
    })();
    return true; // keep channel open for async reply
  }
  if (msg.type !== 'GET_CAPTCHA') return;

  const { requestId, pageAction } = msg;

  const handler = (e) => {
    if (e.detail?.requestId === requestId) {
      window.removeEventListener('CAPTCHA_RESULT', handler);
      clearTimeout(timer);
      reply({ token: e.detail.token, error: e.detail.error });
    }
  };

  const timer = setTimeout(() => {
    window.removeEventListener('CAPTCHA_RESULT', handler);
    reply({ error: 'CONTENT_TIMEOUT' });
  }, 25000);

  window.addEventListener('CAPTCHA_RESULT', handler);

  window.dispatchEvent(new CustomEvent('GET_CAPTCHA', {
    detail: { requestId, pageAction },
  }));

  return true; // keep channel open for async reply
});
