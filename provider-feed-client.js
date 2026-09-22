const PROVIDER_ORIGIN = 'https://globalbet.virtual-horizon.com';
const isFeed = url => url.origin === PROVIDER_ORIGIN && url.pathname.startsWith('/engine/shop/feed/');

// Attach before navigation. Never save or log the native feed credential.
function createProviderFeedClient(page, {timeoutMs = 15000} = {}) {
  let authorization = null;
  const onNavigation = frame => {if (frame === page.mainFrame()) authorization = null;};
  const onResponse = response => {
    if (response.status() !== 200 || !isFeed(new URL(response.url()))) return;
    authorization = response.request().headers().authorization || authorization;
  };
  page.on('response', onResponse);
  page.on('framenavigated', onNavigation);
  return {
    async fetch(url) {
      if (!isFeed(new URL(url))) throw new Error('Provider feed URL required');
      const deadline = Date.now() + timeoutMs;
      while (!authorization && Date.now() < deadline) await new Promise(resolve=>setTimeout(resolve,50));
      if (!authorization) throw new Error('No authenticated native feed observed; log in again before scraping');
      let response;
      try {
        response = await page.evaluate(async ({url, authorization, origin, timeoutMs}) => {
          if (location.origin !== origin) throw new Error('Provider origin unavailable');
          const controller = new AbortController();
          const timer = setTimeout(()=>controller.abort(),timeoutMs);
          try {
            const result = await fetch(url, {credentials:'include', redirect:'error', signal:controller.signal,
              headers:{accept:'application/json, text/plain, */*', authorization}});
            return {status:result.status, body:await result.text()};
          } finally {clearTimeout(timer);}
        }, {url, authorization, origin:PROVIDER_ORIGIN, timeoutMs});
      } catch {
        throw new Error('Provider feed request failed; check login and provider connectivity');
      }
      if (response.status === 401 || response.status === 403) authorization = null;
      if (response.status !== 200) throw new Error(`Provider feed HTTP ${response.status}`);
      try {return {status:response.status, json:JSON.parse(response.body)};}
      catch {throw new Error(`Provider feed returned invalid JSON (HTTP ${response.status})`);}
    },
    dispose() {
      authorization = null;
      page.off('response',onResponse);page.off('framenavigated',onNavigation);
    },
  };
}
module.exports = {createProviderFeedClient};
