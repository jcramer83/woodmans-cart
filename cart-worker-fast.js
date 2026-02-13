// cart-worker-fast.js — Direct GraphQL API for cart automation
// Uses HTTP calls for all operations. No browser needed.
// Login uses pure HTTP (Azure AD B2C OAuth2).

const https = require("https");
const http = require("http");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Constants ---

const HASHES = {
  SearchResultsPlacements: "27c831d17f6faaed2e46c8b5a4cafe7038f4249cc2acb527633aa1aea5dad855",
  Items: "4127a4c8f70a3caba5993d066874c95227ee4f4d5d9b3effb28373a755933c96",
  ActiveCartId: "6803f97683d706ab6faa3c658a0d6766299dbe1ff55f78b720ca2ef77de7c5c7",
  UpdateCartItemsMutation: "7c2c63093a07a61b056c09be23eba6f5790059dca8179f7af7580c0456b1049f",
  VisitShop: "d2845e5f0022f6d080bf14cd78dbcce9be2a277f12c468e7c43ff0d99a78e77a",
};

const SHOP_IDS = { instore: "755261", pickup: "755260" };
const ZONE_ID = "1022";

// --- GraphQL helpers ---

function gqlGet(cookieString, operationName, variables, sha256Hash) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      operationName,
      variables: JSON.stringify(variables),
      extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash } }),
    });
    const req = https.request({
      hostname: "shopwoodmans.com",
      path: `/graphql?${params.toString()}`,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
        Cookie: cookieString,
        Referer: "https://shopwoodmans.com/store/woodmans-food-markets/storefront",
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("Timeout")));
    req.end();
  });
}

function gqlPost(cookieString, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname: "shopwoodmans.com",
      path: "/graphql",
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        Cookie: cookieString,
        Referer: "https://shopwoodmans.com/store/woodmans-food-markets/storefront",
        Origin: "https://shopwoodmans.com",
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("Timeout")));
    req.write(bodyStr);
    req.end();
  });
}

// Retry wrapper: retries once with 500ms delay on network errors
async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    await sleep(500);
    return await fn();
  }
}

// Check if a GraphQL response indicates an expired/invalid session
function isSessionExpired(res) {
  return res.status === 401 || res.status === 403;
}

// --- HTTP helpers for pure HTTP login (no browser) ---

const httpCookieJar = {}; // hostname -> { name: value }

function parseCookiesFromHeaders(headers, url) {
  const setCookies = headers["set-cookie"];
  if (!setCookies) return;
  const hostname = new URL(url).hostname;
  if (!httpCookieJar[hostname]) httpCookieJar[hostname] = {};
  const items = Array.isArray(setCookies) ? setCookies : [setCookies];
  for (const item of items) {
    const parts = item.split(";")[0];
    const eqIdx = parts.indexOf("=");
    if (eqIdx > 0) {
      const name = parts.substring(0, eqIdx).trim();
      const value = parts.substring(eqIdx + 1).trim();
      httpCookieJar[hostname][name] = value;
    }
  }
}

function getJarCookieString(hostname) {
  const cookies = httpCookieJar[hostname];
  if (!cookies) return "";
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ...(options.headers || {}),
      },
    };
    const jarCookies = getJarCookieString(parsed.hostname);
    if (jarCookies) {
      reqOptions.headers["Cookie"] = jarCookies;
    }
    const req = mod.request(reqOptions, (res) => {
      parseCookiesFromHeaders(res.headers, url);
      let data = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("Timeout")));
    if (options.body) req.write(options.body);
    req.end();
  });
}

// --- Session management ---

let cachedSession = null; // { cookies, cartId, shopId, mode }

async function getFastSession(settings, progressCallback) {
  const progress = progressCallback || (() => {});
  const mode = (settings && settings.shoppingMode) || "instore";
  const shopId = SHOP_IDS[mode] || SHOP_IDS.instore;

  // Reuse cached session if available and mode matches
  if (cachedSession) {
    try {
      const testRes = await gqlGet(cachedSession.cookies, "ActiveCartId", { addressId: null, shopId }, HASHES.ActiveCartId);
      if (!isSessionExpired(testRes) && testRes.body?.data) {
        if (cachedSession.mode === mode) {
          progress("Reusing existing fast session");
          return cachedSession;
        }
        progress("Session valid, switching mode...");
        return cachedSession;
      }
    } catch {}
    progress("Fast session expired, creating new one...");
    cachedSession = null;
  }

  if (!settings || !settings.username || !settings.password) {
    throw new Error("No username/password configured.");
  }

  const storeUrl = (settings.storeUrl || "https://shopwoodmans.com").replace(/\/+$/, "");

  // Clear cookie jar for fresh login
  for (const key of Object.keys(httpCookieJar)) delete httpCookieJar[key];

  // Step 1: Initiate SSO redirect to Azure AD B2C
  progress("Authenticating (HTTP)...");
  const ssoRes = await httpRequest(`${storeUrl}/rest/sso/auth/woodmans/init`);
  if (ssoRes.status !== 302 || !ssoRes.headers.location) {
    throw new Error(`SSO init failed (status ${ssoRes.status})`);
  }
  const b2cAuthorizeUrl = ssoRes.headers.location;

  // Step 2: Load B2C login page — extract CSRF token
  progress("Loading login page...");
  const b2cPageRes = await httpRequest(b2cAuthorizeUrl);
  if (b2cPageRes.status !== 200) {
    throw new Error(`B2C login page failed (status ${b2cPageRes.status})`);
  }

  // Extract CSRF token
  const csrfMatch = b2cPageRes.body.match(/csrf["'\s]*[:=]["'\s]*["']([^"']+)["']/i)
    || b2cPageRes.body.match(/"csrf"\s*:\s*"([^"]+)"/)
    || b2cPageRes.body.match(/var\s+CSRF_TOKEN\s*=\s*["']([^"']+)["']/)
    || b2cPageRes.body.match(/[A-Za-z0-9+/=]{20,}/).toString().includes("==") && null;

  let csrfToken = null;
  if (csrfMatch) {
    csrfToken = csrfMatch[1];
  } else {
    // Broader search for base64-ish CSRF value
    const broadMatch = b2cPageRes.body.match(/csrf[^"]*":\s*"([A-Za-z0-9+/=]{20,})"/);
    if (broadMatch) csrfToken = broadMatch[1];
  }
  if (!csrfToken) {
    const settingsMatch = b2cPageRes.body.match(/var\s+SETTINGS\s*=\s*(\{[^;]+\});/);
    if (settingsMatch) {
      try { csrfToken = JSON.parse(settingsMatch[1]).csrf; } catch {}
    }
  }
  if (!csrfToken) {
    throw new Error("Could not extract CSRF token from login page.");
  }

  // Extract transaction ID
  const txMatch = b2cPageRes.body.match(/"transId"\s*:\s*"([^"]+)"/)
    || b2cPageRes.body.match(/transId["'\s]*[:=]["'\s]*["']([^"']+)["']/);
  const txValue = txMatch ? txMatch[1] : "";
  if (!txValue) {
    throw new Error("Could not extract transaction ID from login page.");
  }

  // Step 3: Submit credentials
  progress("Signing in...");
  const b2cBase = "https://mywoodmans.b2clogin.com/mywoodmans.onmicrosoft.com/B2C_1_signup_signin";
  const selfAssertedUrl = `${b2cBase}/SelfAsserted?tx=${encodeURIComponent(txValue)}&p=B2C_1_signup_signin`;
  const formBody = `request_type=RESPONSE&email=${encodeURIComponent(settings.username)}&password=${encodeURIComponent(settings.password)}`;

  const selfAssertedRes = await httpRequest(selfAssertedUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-CSRF-TOKEN": csrfToken,
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Referer": b2cAuthorizeUrl,
      "Origin": "https://mywoodmans.b2clogin.com",
    },
    body: formBody,
  });

  // Check response — B2C returns {"status":"200"} on success
  try {
    const selfBody = JSON.parse(selfAssertedRes.body);
    if (selfBody.status !== "200") {
      throw new Error("Login failed: " + (selfBody.message || "invalid credentials"));
    }
  } catch (e) {
    if (e.message.startsWith("Login failed")) throw e;
    if (selfAssertedRes.status !== 200) {
      throw new Error(`Login submission failed (status ${selfAssertedRes.status})`);
    }
  }

  // Step 4: Confirm login — get redirect with auth code
  progress("Confirming session...");
  const confirmedUrl = `${b2cBase}/api/CombinedSigninAndSignup/confirmed?rememberMe=false&csrf_token=${encodeURIComponent(csrfToken)}&tx=${encodeURIComponent(txValue)}&p=B2C_1_signup_signin`;
  const confirmedRes = await httpRequest(confirmedUrl, {
    headers: { "Referer": b2cAuthorizeUrl },
  });

  if (confirmedRes.status !== 302 || !confirmedRes.headers.location) {
    throw new Error("Login confirmation failed — no redirect received.");
  }

  // Step 5: Follow callback to ShopWoodmans — sets session cookies
  const callbackUrl = confirmedRes.headers.location;
  const callbackRes = await httpRequest(callbackUrl);

  // Follow the final redirect to storefront (captures remaining cookies)
  if (callbackRes.status === 302 && callbackRes.headers.location) {
    let nextUrl = callbackRes.headers.location;
    if (!nextUrl.startsWith("http")) {
      nextUrl = `${storeUrl}${nextUrl}`;
    }
    await httpRequest(nextUrl);
  }

  // Build cookie string from jar
  const cookieString = getJarCookieString("shopwoodmans.com");
  if (!cookieString) {
    throw new Error("Login succeeded but no session cookies received.");
  }

  // Verify with GraphQL
  progress("Verifying session...");
  const cartRes = await gqlGet(cookieString, "ActiveCartId", { addressId: null, shopId }, HASHES.ActiveCartId);
  if (isSessionExpired(cartRes)) {
    throw new Error("Login failed — could not authenticate with store.");
  }
  const cartId = cartRes.body?.data?.shopBasket?.cartId;
  if (!cartId) {
    throw new Error("Could not retrieve cart ID. Login may have failed.");
  }

  progress(`Fast session ready (cart: ${cartId.substring(0, 8)}...)`);

  cachedSession = { cookies: cookieString, cartId, shopId, mode };
  return cachedSession;
}

function closeFastSession() {
  cachedSession = null;
}

// --- Helper: extract name/price/size from an Items response ---

function parseItemDetails(itemsArray) {
  const map = {};
  for (const item of itemsArray) {
    if (!item.id) continue;
    const viewPrice = item.viewSection?.pricing?.price?.text || "";
    let price = viewPrice;
    if (!price) {
      const s = JSON.stringify(item);
      const m = s.match(/\$[\d.]+/);
      if (m) price = m[0];
    }
    map[item.id] = { name: item.name || "", price, size: item.size || "" };
  }
  return map;
}

// --- Product search via GraphQL ---

async function searchProducts(query, session) {
  const shopId = session.shopId || SHOP_IDS.instore;
  const postalCode = "53177";

  // Search for products
  const searchRes = await withRetry(() => gqlGet(session.cookies, "SearchResultsPlacements", {
    filters: [], action: null, query,
    pageViewId: "fast-" + Date.now(),
    retailerInventorySessionToken: "",
    elevatedProductId: null, searchSource: "search",
    disableReformulation: false, disableLlm: false, forceInspiration: false,
    orderBy: "bestMatch", clusterId: null, includeDebugInfo: false,
    clusteringStrategy: null,
    contentManagementSearchParams: { itemGridColumnCount: 5 },
    shopId, postalCode, zoneId: ZONE_ID, first: 12,
  }, HASHES.SearchResultsPlacements));

  if (isSessionExpired(searchRes)) {
    closeFastSession();
    throw new Error("Session expired");
  }

  // Extract item IDs from response
  const rawStr = JSON.stringify(searchRes.body);
  const idPattern = new RegExp(`items_\\d+-\\d+`, "g");
  const itemIds = [...new Set(rawStr.match(idPattern) || [])].slice(0, 12);

  if (itemIds.length === 0) {
    return [];
  }

  // Get item details (names, prices, sizes)
  const itemsRes = await withRetry(() => gqlGet(session.cookies, "Items", {
    ids: itemIds, shopId, zoneId: ZONE_ID, postalCode,
  }, HASHES.Items));

  if (isSessionExpired(itemsRes)) {
    closeFastSession();
    throw new Error("Session expired");
  }

  const items = itemsRes.body?.data?.items || [];
  const detailMap = parseItemDetails(items);
  return Object.values(detailMap);
}

// --- Shopping mode switch via GraphQL ---

async function ensureShoppingMode(session, mode, progressCallback) {
  const progress = progressCallback || (() => {});
  const desiredShopId = SHOP_IDS[mode] || SHOP_IDS.instore;

  if (session.mode === mode && session.shopId === desiredShopId) {
    return; // Already in correct mode
  }

  progress(`Switching to ${mode === "pickup" ? "Pickup" : "In-Store"} mode...`);

  const res = await withRetry(() => gqlPost(session.cookies, {
    operationName: "VisitShop",
    variables: { shopId: desiredShopId },
    extensions: { persistedQuery: { version: 1, sha256Hash: HASHES.VisitShop } },
  }));

  if (isSessionExpired(res)) {
    closeFastSession();
    throw new Error("Session expired");
  }

  // Refetch cart ID (cart changes with mode)
  const cartRes = await gqlGet(session.cookies, "ActiveCartId", { addressId: null, shopId: desiredShopId }, HASHES.ActiveCartId);
  if (isSessionExpired(cartRes)) {
    closeFastSession();
    throw new Error("Session expired");
  }

  const newCartId = cartRes.body?.data?.shopBasket?.cartId;
  if (newCartId) {
    session.cartId = newCartId;
  }
  session.shopId = desiredShopId;
  session.mode = mode;

  progress(`Switched to ${mode === "pickup" ? "Pickup" : "In-Store"} mode`);
}

// --- Main automation: search and add all items ---

async function searchAndAddAll(session, items, progressCallback, itemDoneCallback, stopCheck) {
  const progress = progressCallback || (() => {});
  const itemDone = itemDoneCallback || (() => {});
  const shouldStop = stopCheck || (() => false);

  const shopId = session.shopId || SHOP_IDS.instore;
  const postalCode = "53177";
  const results = [];

  // Phase 1: Search all items in parallel (batches of 5)
  progress("Searching for all items...");
  const searchResults = []; // { item, itemId, searchText, index }

  for (let batchStart = 0; batchStart < items.length; batchStart += 5) {
    if (shouldStop()) break;

    const batch = items.slice(batchStart, batchStart + 5);
    const searchPromises = batch.map((item, batchIdx) => {
      const globalIdx = batchStart + batchIdx;
      const searchText = item.productName || item.item;
      progress(`Searching: ${item.item} (${globalIdx + 1}/${items.length})`);

      return withRetry(() => gqlGet(session.cookies, "SearchResultsPlacements", {
        filters: [], action: null, query: searchText,
        pageViewId: "fast-" + Date.now() + "-" + globalIdx,
        retailerInventorySessionToken: "",
        elevatedProductId: null, searchSource: "search",
        disableReformulation: false, disableLlm: false, forceInspiration: false,
        orderBy: "bestMatch", clusterId: null, includeDebugInfo: false,
        clusteringStrategy: null,
        contentManagementSearchParams: { itemGridColumnCount: 5 },
        shopId, postalCode, zoneId: ZONE_ID, first: 4,
      }, HASHES.SearchResultsPlacements)).then((res) => {
        if (isSessionExpired(res)) {
          closeFastSession();
          throw new Error("Session expired");
        }
        const rawStr = JSON.stringify(res.body);
        const idPattern = new RegExp(`items_\\d+-\\d+`, "g");
        const ids = [...new Set(rawStr.match(idPattern) || [])];
        return { item, itemId: ids[0] || null, searchText, index: globalIdx };
      }).catch((err) => {
        return { item, itemId: null, searchText, index: globalIdx, error: err.message };
      });
    });

    const batchResults = await Promise.all(searchPromises);
    searchResults.push(...batchResults);
  }

  if (shouldStop()) {
    return { results: [], cartItems: [] };
  }

  // Phase 2: Get item details for all found items
  const foundIds = searchResults.filter((r) => r.itemId).map((r) => r.itemId);
  let itemDetails = {};

  if (foundIds.length > 0) {
    progress("Fetching product details...");
    const detailsRes = await withRetry(() => gqlGet(session.cookies, "Items", {
      ids: foundIds, shopId, zoneId: ZONE_ID, postalCode,
    }, HASHES.Items));

    if (!isSessionExpired(detailsRes) && detailsRes.body?.data?.items) {
      itemDetails = parseItemDetails(detailsRes.body.data.items);
    }
  }

  // Phase 3: Add items individually (for per-item progress)
  progress("Adding items to cart...");
  let lastAddResponse = null;

  // Pickup mode uses "grocery" cart type; In-Store uses "list"
  const cartType = (session.mode === "pickup") ? "grocery" : "list";

  for (let i = 0; i < searchResults.length; i++) {
    if (shouldStop()) break;

    const sr = searchResults[i];
    const item = sr.item;

    if (!sr.itemId) {
      // No search results for this item
      const reason = sr.error || "no search results";
      results.push({ item: item.item, status: "fail", reason });
      itemDone({ id: item.id, index: sr.index, total: items.length, status: "fail" });
      progress(`Failed: ${item.item} (${reason})`);
      continue;
    }

    const detail = itemDetails[sr.itemId];
    const displayName = (detail && detail.name) || sr.searchText;

    try {
      // Build cart item updates — one entry per quantity unit
      const qty = item.quantity || 1;
      const addRes = await withRetry(() => gqlPost(session.cookies, {
        operationName: "UpdateCartItemsMutation",
        variables: {
          cartItemUpdates: [{
            itemId: sr.itemId,
            quantity: qty,
            quantityType: "each",
            trackingParams: {},
          }],
          cartType: cartType,
          requestTimestamp: Date.now(),
          cartId: session.cartId,
        },
        extensions: { persistedQuery: { version: 1, sha256Hash: HASHES.UpdateCartItemsMutation } },
      }));

      if (isSessionExpired(addRes)) {
        closeFastSession();
        throw new Error("Session expired");
      }

      if (addRes.body?.errors) {
        const errMsg = addRes.body.errors[0]?.message || "add failed";
        results.push({ item: item.item, status: "fail", reason: errMsg });
        itemDone({ id: item.id, index: sr.index, total: items.length, status: "fail" });
        progress(`Failed: ${displayName} (${errMsg})`);
      } else {
        lastAddResponse = addRes;
        results.push({ item: item.item, status: "ok" });
        itemDone({ id: item.id, index: sr.index, total: items.length, status: "ok" });
        progress(`Added: ${displayName} x${qty} (${sr.index + 1}/${items.length})`);
      }
    } catch (err) {
      results.push({ item: item.item, status: "fail", reason: err.message });
      itemDone({ id: item.id, index: sr.index, total: items.length, status: "fail" });
      progress(`Failed: ${displayName} (${err.message})`);
    }
  }

  // Phase 4: Build cart state from the last add response
  let cartItems = [];
  const lastCart = lastAddResponse?.body?.data?.updateCartItems?.cart;
  const lastRawItems = lastCart?.cartItemCollection?.cartItems || lastCart?.items || lastCart?.cartItems;
  if (lastRawItems) {
    const rawCartItems = lastRawItems;
    const cartItemIds = rawCartItems.map((ci) => ci.itemId).filter(Boolean);

    if (cartItemIds.length > 0) {
      progress("Fetching final cart details...");
      const cartDetailsRes = await withRetry(() => gqlGet(session.cookies, "Items", {
        ids: cartItemIds, shopId, zoneId: ZONE_ID, postalCode,
      }, HASHES.Items)).catch(() => null);

      const cartDetailMap = (cartDetailsRes && cartDetailsRes.body?.data?.items)
        ? parseItemDetails(cartDetailsRes.body.data.items) : {};

      cartItems = rawCartItems.map((ci) => {
        const detail = cartDetailMap[ci.itemId] || {};
        return {
          name: detail.name || ci.itemId,
          price: detail.price || "",
          size: detail.size || "",
          quantity: ci.quantity || 1,
        };
      });
    }
  }

  return { results, cartItems };
}

// --- GraphQL cart fetch ---

async function fetchCartViaGraphQL(session, progressCallback) {
  const progress = progressCallback || (() => {});
  const shopId = session.shopId || SHOP_IDS.instore;
  const postalCode = "53177";
  const cartType = (session.mode === "pickup") ? "grocery" : "list";

  progress("Fetching cart via GraphQL...");

  // Send UpdateCartItemsMutation with a no-op update to get full cart state
  // (empty cartItemUpdates was rejected as invalidInput since ~Feb 2026)
  const res = await withRetry(() => gqlPost(session.cookies, {
    operationName: "UpdateCartItemsMutation",
    variables: {
      cartItemUpdates: [{ itemId: "0", quantity: 0, quantityType: "each", trackingParams: {} }],
      cartType,
      requestTimestamp: Date.now(),
      cartId: session.cartId,
    },
    extensions: { persistedQuery: { version: 1, sha256Hash: HASHES.UpdateCartItemsMutation } },
  }));

  if (isSessionExpired(res)) {
    closeFastSession();
    throw new Error("Session expired");
  }

  if (res.body?.errors) {
    throw new Error("GraphQL error: " + (res.body.errors[0]?.message || "unknown"));
  }

  // Try known response paths — Instacart may restructure these
  const cart = res.body?.data?.updateCartItems?.cart;
  const rawCartItems = cart?.cartItemCollection?.cartItems
    || cart?.items
    || cart?.cartItems;
  if (!rawCartItems || !Array.isArray(rawCartItems)) {
    // Dump enough of the response shape to diagnose remotely
    const snippet = JSON.stringify(res.body, null, 2)?.substring(0, 800) || "(empty)";
    progress(`Debug: status=${res.status}, response:\n${snippet}`);
    throw new Error("Unexpected response structure — no cartItems found");
  }

  if (rawCartItems.length === 0) {
    progress("Cart is empty.");
    return [];
  }

  // Enrich with Items query for name/price/size
  const cartItemIds = rawCartItems.map((ci) => ci.itemId).filter(Boolean);
  let detailMap = {};

  if (cartItemIds.length > 0) {
    progress(`Fetching details for ${cartItemIds.length} cart item(s)...`);
    const detailsRes = await withRetry(() => gqlGet(session.cookies, "Items", {
      ids: cartItemIds, shopId, zoneId: ZONE_ID, postalCode,
    }, HASHES.Items));

    if (!isSessionExpired(detailsRes) && detailsRes.body?.data?.items) {
      detailMap = parseItemDetails(detailsRes.body.data.items);
    }
  }

  const cartItems = rawCartItems.map((ci) => {
    const detail = detailMap[ci.itemId] || {};
    return {
      name: detail.name || ci.itemId,
      price: detail.price || "",
      size: detail.size || "",
      quantity: ci.quantity || 1,
    };
  });

  progress(`Found ${cartItems.length} item(s) in cart.`);
  return cartItems;
}

// --- GraphQL cart removal ---

async function removeAllCartItemsViaGraphQL(session, progressCallback) {
  const progress = progressCallback || (() => {});
  const cartType = (session.mode === "pickup") ? "grocery" : "list";

  // Step 1: Fetch current cart items via no-op update
  progress("Fetching cart contents for removal...");
  const fetchRes = await withRetry(() => gqlPost(session.cookies, {
    operationName: "UpdateCartItemsMutation",
    variables: {
      cartItemUpdates: [{ itemId: "0", quantity: 0, quantityType: "each", trackingParams: {} }],
      cartType,
      requestTimestamp: Date.now(),
      cartId: session.cartId,
    },
    extensions: { persistedQuery: { version: 1, sha256Hash: HASHES.UpdateCartItemsMutation } },
  }));

  if (isSessionExpired(fetchRes)) {
    closeFastSession();
    throw new Error("Session expired");
  }

  if (fetchRes.body?.errors) {
    throw new Error("GraphQL error: " + (fetchRes.body.errors[0]?.message || "unknown"));
  }

  const fetchCart = fetchRes.body?.data?.updateCartItems?.cart;
  const rawCartItems = fetchCart?.cartItemCollection?.cartItems
    || fetchCart?.items
    || fetchCart?.cartItems;
  if (!rawCartItems || rawCartItems.length === 0) {
    progress("Cart is already empty.");
    return { removed: 0 };
  }

  // Step 2: Batch remove — set quantity:0 for all items
  progress(`Removing ${rawCartItems.length} item(s) from cart...`);
  const removeUpdates = rawCartItems
    .filter((ci) => ci.itemId)
    .map((ci) => ({
      itemId: ci.itemId,
      quantity: 0,
      quantityType: "each",
      trackingParams: {},
    }));

  const removeRes = await withRetry(() => gqlPost(session.cookies, {
    operationName: "UpdateCartItemsMutation",
    variables: {
      cartItemUpdates: removeUpdates,
      cartType,
      requestTimestamp: Date.now(),
      cartId: session.cartId,
    },
    extensions: { persistedQuery: { version: 1, sha256Hash: HASHES.UpdateCartItemsMutation } },
  }));

  if (isSessionExpired(removeRes)) {
    closeFastSession();
    throw new Error("Session expired");
  }

  // Step 3: Verify — check if any items remain
  const removeCart = removeRes.body?.data?.updateCartItems?.cart;
  const remaining = removeCart?.cartItemCollection?.cartItems || removeCart?.items || removeCart?.cartItems || [];

  if (remaining.length > 0) {
    // Fallback: remove stragglers one by one
    progress(`${remaining.length} item(s) remain — removing individually...`);
    for (const ci of remaining) {
      if (!ci.itemId) continue;
      await withRetry(() => gqlPost(session.cookies, {
        operationName: "UpdateCartItemsMutation",
        variables: {
          cartItemUpdates: [{ itemId: ci.itemId, quantity: 0, quantityType: "each", trackingParams: {} }],
          cartType,
          requestTimestamp: Date.now(),
          cartId: session.cartId,
        },
        extensions: { persistedQuery: { version: 1, sha256Hash: HASHES.UpdateCartItemsMutation } },
      })).catch(() => {});
    }
  }

  const removed = rawCartItems.length;
  progress(`Removed ${removed} item(s) from cart.`);
  return { removed };
}

async function fetchCart(session, progressCallback) {
  return await fetchCartViaGraphQL(session, progressCallback);
}

async function removeAllCartItems(session, progressCallback) {
  return await removeAllCartItemsViaGraphQL(session, progressCallback);
}

module.exports = {
  getFastSession,
  closeFastSession,
  searchProducts,
  ensureShoppingMode,
  searchAndAddAll,
  fetchCart,
  removeAllCartItems,
  sleep,
};
