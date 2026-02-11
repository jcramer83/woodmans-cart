const { chromium } = require("playwright");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Persistent search session ---
let searchSession = null; // { browser, page, mode }

async function getSearchSession(settings, progressCallback) {
  const progress = progressCallback || (() => {});
  const mode = (settings && settings.shoppingMode) || "instore";

  // Reuse existing session if still alive and mode matches
  if (searchSession) {
    if (searchSession.mode !== mode) {
      progress("Mode changed, restarting session...");
      try { await searchSession.browser.close(); } catch {}
      searchSession = null;
    } else {
      try {
        await searchSession.page.evaluate(() => true);
        progress("Reusing existing session");
        return searchSession.page;
      } catch {
        progress("Session expired, creating new one...");
        try { await searchSession.browser.close(); } catch {}
        searchSession = null;
      }
    }
  }

  const storeUrl = (settings && settings.storeUrl) || "https://shopwoodmans.com";
  const zipCode = (settings && settings.zipCode) || "53177";
  const baseUrl = storeUrl.replace(/\/+$/, "");

  progress("Launching browser...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  progress("Loading Woodmans store page...");
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(2000);

  // Handle ZIP code / login gate
  const currentUrl = page.url();
  const needsAuth = !currentUrl.includes("/store/") || currentUrl.includes("?next=");

  if (needsAuth) {
    if (settings && settings.username && settings.password) {
      progress("Logging in...");
      const loggedIn = await autoLogin(page, settings.username, settings.password);
      if (loggedIn) await sleep(2000);
    }

    const stillNeedsAuth = !page.url().includes("/store/") || page.url().includes("?next=");
    if (stillNeedsAuth) {
      progress("Entering ZIP code...");
      const zipStrategies = [
        () => page.locator('input[placeholder*="ZIP" i]').first(),
        () => page.locator('input[placeholder*="zip" i]').first(),
        () => page.locator('input[aria-label*="ZIP" i]').first(),
        () => page.locator('input[name*="zip" i]').first(),
        () => page.locator('input[inputmode="numeric"]').first(),
        () => page.locator('input[type="text"]').first(),
      ];

      for (const strategy of zipStrategies) {
        try {
          const el = strategy();
          if (await el.isVisible({ timeout: 2000 })) {
            await el.fill(zipCode);
            await sleep(500);
            await el.press("Enter");
            await sleep(2000);
            break;
          }
        } catch {}
      }

      const shopBtnStrategies = [
        () => page.locator('button:has-text("Start Shopping")').first(),
        () => page.locator('button:has-text("Shop")').first(),
        () => page.locator('a:has-text("Start Shopping")').first(),
        () => page.locator('button[type="submit"]').first(),
      ];

      for (const strategy of shopBtnStrategies) {
        try {
          const el = strategy();
          if (await el.isVisible({ timeout: 2000 })) {
            await el.click();
            await sleep(3000);
            break;
          }
        } catch {}
      }
    }
  }

  // Dismiss shopping mode dialog FIRST so it doesn't block login elements
  progress("Setting shopping mode...");
  for (let attempt = 0; attempt < 3; attempt++) {
    const dismissed = await dismissShoppingModeDialog(page, mode);
    if (!dismissed) break;
    await sleep(1000);
  }
  await closePopups(page);
  await sleep(500);

  // Verify we're actually logged in (URL check alone isn't reliable —
  // the page may already be at /store/ without being authenticated).
  progress("Verifying login status...");
  const isLoggedIn = await page.evaluate(() => {
    const links = document.querySelectorAll('a, button');
    for (const el of links) {
      const text = (el.textContent || "").trim();
      if (/^(Log In|Sign In)/i.test(text) && text.length < 30) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return false;
      }
    }
    return true;
  }).catch(() => true);

  if (!isLoggedIn && settings && settings.username && settings.password) {
    progress("Logging in...");
    const loggedIn = await autoLogin(page, settings.username, settings.password);
    if (loggedIn) {
      await sleep(2000);
      // Login may trigger the shopping mode dialog again
      for (let attempt = 0; attempt < 3; attempt++) {
        const dismissed = await dismissShoppingModeDialog(page, mode);
        if (!dismissed) break;
        await sleep(1000);
      }
    }
  }

  await closePopups(page);
  await sleep(1000);

  // Verify actual mode before caching — if dismissal failed, the browser
  // may be in a different mode than requested. Store the ACTUAL mode so
  // the session cache doesn't mask a failed switch.
  const check = await checkCurrentMode(page);
  let storedMode = mode;
  if (check.mode.toLowerCase() === "in-store") storedMode = "instore";
  else if (check.mode.toLowerCase() === "pickup") storedMode = "pickup";
  progress(`Connected! (mode: ${check.mode})`);
  searchSession = { browser, page, mode: storedMode };
  return page;
}

function closeSearchSession() {
  if (searchSession) {
    try { searchSession.browser.close(); } catch {}
    searchSession = null;
  }
}

async function findSearchInput(page) {
  const strategies = [
    () => page.getByRole("search").locator("input").first(),
    () => page.getByPlaceholder(/search/i).first(),
    () => page.locator('input[type="search"]').first(),
    () => page.locator('input[aria-label*="search" i]').first(),
    () => page.locator('input[placeholder*="Search" i]').first(),
    () => page.locator('[data-testid*="search"] input').first(),
    () => page.locator('header input[type="text"]').first(),
  ];

  for (const strategy of strategies) {
    try {
      const el = strategy();
      if (await el.isVisible({ timeout: 2000 })) {
        return el;
      }
    } catch {
      // Try next strategy
    }
  }
  return null;
}

async function findAddButton(page, waitMs = 3000) {
  const strategies = [
    () => page.getByRole("button", { name: /^add$/i }).first(),
    () => page.getByRole("button", { name: /add to cart/i }).first(),
    () => page.locator('button:has-text("Add")').first(),
    () => page.locator('[data-testid*="add"] button').first(),
    () => page.locator('[aria-label*="Add to cart" i]').first(),
    () => page.locator('[aria-label*="add" i][role="button"]').first(),
  ];

  for (const strategy of strategies) {
    try {
      const el = strategy();
      if (await el.isVisible({ timeout: waitMs })) {
        return el;
      }
    } catch {
      // Try next strategy
    }
  }
  return null;
}

async function incrementQuantity(page, targetQty) {
  for (let i = 1; i < targetQty; i++) {
    const strategies = [
      () => page.getByRole("button", { name: /increment/i }).first(),
      () => page.getByRole("button", { name: /increase/i }).first(),
      () => page.locator('button[aria-label*="increment" i]').first(),
      () => page.locator('button[aria-label*="increase" i]').first(),
      () => page.locator('button:has-text("+")').first(),
    ];

    let clicked = false;
    for (const strategy of strategies) {
      try {
        const el = strategy();
        if (await el.isVisible({ timeout: 2000 })) {
          await el.click();
          await sleep(300);
          clicked = true;
          break;
        }
      } catch {
        // Try next
      }
    }
    if (!clicked) {
      return i;
    }
  }
  return targetQty;
}

async function closePopups(page) {
  const dismissStrategies = [
    () => page.locator('button[aria-label="Close"]').first(),
    () => page.locator('button:has-text("Close")').first(),
    () => page.locator('button:has-text("Not now")').first(),
    () => page.locator('button:has-text("Dismiss")').first(),
    () => page.locator('[data-testid="modal-close"]').first(),
    () => page.locator('button:has-text("Got it")').first(),
    () => page.locator('button:has-text("Confirm")').first(),
    () => page.locator('.__reakit-portal button[aria-label="Close"]').first(),
  ];

  for (const strategy of dismissStrategies) {
    try {
      const el = strategy();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click({ force: true });
        await sleep(500);
      }
    } catch {
      // No popup to close
    }
  }
}

async function searchAndAdd(page, item, index, total, progressCallback) {
  const searchTerm = item.productName || item.item;
  const qty = item.quantity || 1;
  const label = item.note ? `${item.item} (${item.note})` : item.item;
  const progress = progressCallback || (() => {});

  progress(`[${index + 1}/${total}] Searching for: ${label}`);

  // Dismiss any blocking overlays (reakit portals, shopping mode dialogs, popups)
  const sessionMode = (searchSession && searchSession.mode) || "instore";
  await dismissShoppingModeDialog(page, sessionMode);
  await closePopups(page);
  // Force-close any remaining reakit portal overlays that block the search bar
  await page.evaluate(() => {
    const portals = document.querySelectorAll('.__reakit-portal');
    for (const p of portals) {
      const closeBtn = p.querySelector('button[aria-label="Close"], button[aria-label="close"]');
      if (closeBtn) closeBtn.click();
    }
  }).catch(() => {});
  await sleep(300);

  const searchInput = await findSearchInput(page);
  if (!searchInput) {
    progress(`  SKIP - Could not find search bar`);
    return { item: label, status: "skip", reason: "search bar not found" };
  }

  try {
    await searchInput.click({ force: true });
    await searchInput.fill("");
    await sleep(100);
    await searchInput.fill(searchTerm);
    await searchInput.press("Enter");

    // Wait for search results to load instead of fixed 5s sleep
    try {
      await page.waitForSelector('a[href*="/products/"]', { timeout: 8000 });
    } catch {
      // Fallback: wait a bit more then check
      await sleep(2000);
    }
    await sleep(500);

    const addButton = await findAddButton(page, 2000);
    if (!addButton) {
      progress(`  FAIL - No "Add" button found in results`);
      return { item: label, status: "fail", reason: "no Add button found" };
    }

    await addButton.click();
    progress(`  Added to cart!`);
    await sleep(500);

    if (qty > 1) {
      progress(`  Setting quantity to ${qty}...`);
      await incrementQuantity(page, qty);
    }

    await closePopups(page);

    return { item: label, status: "ok" };
  } catch (err) {
    progress(`  ERROR - ${err.message}`);
    return { item: label, status: "fail", reason: err.message };
  }
}

async function launchBrowser(url, { headless = true } = {}) {
  const launchOpts = headless
    ? { headless: true }
    : { headless: false, args: ["--start-maximized"] };

  const browser = await chromium.launch(launchOpts);

  const contextOpts = headless
    ? { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }
    : { viewport: null };

  const context = await browser.newContext(contextOpts);

  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });

  return { browser, context, page };
}

async function autoLogin(page, username, password) {
  try {
    // Find and click the login/sign-in link
    const loginLinkStrategies = [
      () => page.locator('a:has-text("Log In")').first(),
      () => page.locator('a:has-text("Sign In")').first(),
      () => page.locator('button:has-text("Log In")').first(),
      () => page.locator('button:has-text("Sign In")').first(),
      () => page.locator('[data-testid*="login"]').first(),
      () => page.locator('[data-testid*="signin"]').first(),
      () => page.locator('a[href*="login"]').first(),
      () => page.locator('a[href*="signin"]').first(),
      () => page.locator('a[href*="sign-in"]').first(),
    ];

    let loginClicked = false;
    for (const strategy of loginLinkStrategies) {
      try {
        const el = strategy();
        if (await el.isVisible({ timeout: 3000 })) {
          await el.click();
          // Wait for login form to appear instead of fixed sleep
          try {
            await page.waitForSelector('input[type="email"], input[name="email"], input[type="password"]', { timeout: 5000 });
          } catch {
            await sleep(1500);
          }
          loginClicked = true;
          break;
        }
      } catch {
        // Try next
      }
    }

    if (!loginClicked) {
      return false;
    }

    // Find and fill email field
    const emailStrategies = [
      () => page.locator('input[type="email"]').first(),
      () => page.locator('input[name="email"]').first(),
      () => page.locator('input[name="username"]').first(),
      () => page.locator('input[id*="email" i]').first(),
      () => page.locator('input[id*="user" i]').first(),
      () => page.locator('input[placeholder*="email" i]').first(),
      () => page.locator('input[autocomplete="email"]').first(),
      () => page.locator('input[autocomplete="username"]').first(),
    ];

    let emailFilled = false;
    for (const strategy of emailStrategies) {
      try {
        const el = strategy();
        if (await el.isVisible({ timeout: 3000 })) {
          await el.fill(username);
          emailFilled = true;
          break;
        }
      } catch {
        // Try next
      }
    }

    if (!emailFilled) {
      return false;
    }

    // Find and fill password field
    const passwordStrategies = [
      () => page.locator('input[type="password"]').first(),
      () => page.locator('input[name="password"]').first(),
      () => page.locator('input[id*="password" i]').first(),
      () => page.locator('input[autocomplete="current-password"]').first(),
    ];

    let passwordFilled = false;
    for (const strategy of passwordStrategies) {
      try {
        const el = strategy();
        if (await el.isVisible({ timeout: 3000 })) {
          await el.fill(password);
          passwordFilled = true;
          break;
        }
      } catch {
        // Try next
      }
    }

    if (!passwordFilled) {
      return false;
    }

    // Find and click submit button
    const submitStrategies = [
      () => page.locator('button[type="submit"]').first(),
      () => page.locator('button:has-text("Log In")').first(),
      () => page.locator('button:has-text("Sign In")').first(),
      () => page.locator('input[type="submit"]').first(),
      () => page.locator('button:has-text("Submit")').first(),
    ];

    for (const strategy of submitStrategies) {
      try {
        const el = strategy();
        if (await el.isVisible({ timeout: 3000 })) {
          await el.click();
          // Wait for login to complete (page navigation or form disappearing)
          try {
            await page.waitForURL(/\/store\//, { timeout: 10000 });
          } catch {
            await sleep(3000);
          }
          return true;
        }
      } catch {
        // Try next
      }
    }

    return false;
  } catch {
    return false;
  }
}

async function dismissShoppingModeDialog(page, mode) {
  // Instacart shows a "How would you like to shop?" dialog after ZIP entry
  // with Delivery/Pickup/In-Store options and a Confirm button.
  // IMPORTANT: All selectors are scoped to the dialog to avoid clicking
  // page-level mode buttons that have the same text labels.

  const modeLabel = mode === "pickup" ? "Pickup" : "In-Store";

  // Wait for the shopping mode dialog to appear
  try {
    await page.waitForSelector('text="How would you like to shop?"', { timeout: 5000 });
  } catch {
    return false; // No dialog appeared
  }

  // Find the dialog scope
  let scopeLocator = null;
  const dialog = page.locator('[role="dialog"]:has-text("How would you like to shop")');
  if (await dialog.isVisible({ timeout: 1000 }).catch(() => false)) {
    scopeLocator = dialog;
  } else {
    // Try reakit portal fallback
    const portal = page.locator('.__reakit-portal:has-text("How would you like to shop")');
    if (await portal.isVisible({ timeout: 1000 }).catch(() => false)) {
      scopeLocator = portal;
    }
  }
  if (!scopeLocator) return false;

  // Click the mode button WITHIN the dialog
  try {
    const modeBtn = scopeLocator.locator(`button:has-text("${modeLabel}")`).first();
    if (await modeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await modeBtn.click({ force: true });
      await sleep(1000);
    }
  } catch {}

  // Click Confirm WITHIN the dialog
  const confirmStrats = [
    () => scopeLocator.locator('button:has-text("Confirm")').first(),
    () => scopeLocator.locator('button:has-text("Continue")').first(),
  ];

  for (const strategy of confirmStrats) {
    try {
      const el = strategy();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        await el.click({ force: true });
        // Wait for dialog to disappear
        try {
          await page.waitForFunction(
            () => {
              const dialogs = document.querySelectorAll('[role="dialog"]');
              for (const d of dialogs) {
                if ((d.innerText || "").includes("How would you like to shop")) return false;
              }
              return true;
            },
            { timeout: 5000 }
          );
        } catch {
          await sleep(2000);
        }
        return true;
      }
    } catch {}
  }

  // Close button fallback
  try {
    const closeBtn = scopeLocator.locator('button[aria-label="Close"]').first();
    if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeBtn.click({ force: true });
      await sleep(500);
      return true;
    }
  } catch {}

  return false;
}

async function searchProducts(query, settings) {
  try {
    const page = await getSearchSession(settings);

    // Find the search bar
    let searchInput = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const knownInput = page.locator("#search-bar-input");
        if (await knownInput.isVisible({ timeout: 3000 })) {
          searchInput = knownInput;
          break;
        }
      } catch {}
      if (!searchInput) {
        searchInput = await findSearchInput(page);
        if (searchInput) break;
      }
      await dismissShoppingModeDialog(page, (settings && settings.shoppingMode) || "instore");
      await closePopups(page);
      await sleep(1000);
    }

    if (!searchInput) {
      // Session may be stale, kill it so next search creates a fresh one
      closeSearchSession();
      return { error: "Could not find search bar. Try searching again." };
    }

    // Clear previous search, type new query
    await searchInput.click({ force: true });
    await sleep(300);
    await searchInput.fill("");
    await sleep(200);
    await searchInput.fill(query);
    await sleep(300);
    await searchInput.press("Enter");

    // Wait for search results page
    try {
      await page.waitForURL(/\/s\?/, { timeout: 10000 });
    } catch {
      await sleep(3000);
    }

    // Wait for product links to appear
    try {
      await page.waitForSelector('a[href*="/products/"]', { timeout: 8000 });
    } catch {}
    await sleep(1500);
    await closePopups(page);

    // Scrape products
    const products = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      const productLinks = document.querySelectorAll('a[href*="/products/"]');
      for (const link of productLinks) {
        if (results.length >= 12) break;

        const hrefMatch = link.href.match(/\/products\/\d+-(.+)$/);
        let name = "";
        if (hrefMatch) {
          name = hrefMatch[1].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        }
        if (!name || name.length < 3 || seen.has(name)) continue;
        seen.add(name);

        const parent = link.closest("li") || link.parentElement;
        let price = "";
        let size = "";
        if (parent) {
          const allText = parent.innerText || "";
          const priceMatch = allText.match(/\$\d+\.\d{2}/);
          if (priceMatch) price = priceMatch[0];
          const sizeMatch = allText.match(/\d+(?:\.\d+)?\s*(?:oz|fl oz|lb|gal|ct|pk|ml|l|qt|pt)/i);
          if (sizeMatch) size = sizeMatch[0];
        }

        results.push({ name, price, size });
      }

      return results;
    });

    if (products.length === 0) {
      return { error: "No products found. Try a different search term." };
    }

    return products;
  } catch (err) {
    // Kill the session on error so next search starts fresh
    closeSearchSession();
    return { error: `Search failed: ${err.message}` };
  }
}

async function checkCurrentMode(page) {
  // Returns { mode: "Pickup"|"In-Store"|"Delivery"|"unknown", buttons: [...] }
  return await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    const found = [];
    let activeMode = "unknown";

    for (const btn of btns) {
      const text = btn.textContent.trim();
      if (/^(Delivery|Pickup|In-Store)/i.test(text) && text.length < 60) {
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const ariaCurrent = btn.getAttribute("aria-current");
        const isActive = ariaCurrent === "true" || ariaCurrent === "page";
        const label = text.match(/^(Delivery|Pickup|In-Store)/i)[0];
        found.push({ label, isActive, ariaCurrent, top: Math.round(rect.top), left: Math.round(rect.left) });
        if (isActive) activeMode = label;
      }
    }
    return { mode: activeMode, buttons: found };
  }).catch(() => ({ mode: "unknown", buttons: [] }));
}

async function ensureShoppingMode(page, mode, progressCallback) {
  const progress = progressCallback || (() => {});
  const desiredLabel = mode === "pickup" ? "Pickup" : "In-Store";

  // Step 1: Dismiss any blocking dialog first
  await dismissShoppingModeDialog(page, mode);
  await closePopups(page);

  // Step 2: Check current mode
  let check = await checkCurrentMode(page);
  progress(`Mode buttons: ${JSON.stringify(check.buttons)}`);
  progress(`Current mode: ${check.mode}, desired: ${desiredLabel}`);

  if (check.mode.toLowerCase() === desiredLabel.toLowerCase()) {
    return;
  }

  // Step 3: Simply click the desired mode button next to the search bar
  progress(`Clicking ${desiredLabel} button...`);
  let clicked = false;

  // Try clicking by aria-current=false button matching desired label
  try {
    const desiredBtn = page.locator(`button:has-text("${desiredLabel}")`).first();
    if (await desiredBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await desiredBtn.click({ force: true });
      clicked = true;
      await sleep(2000);
    }
  } catch {}

  if (!clicked) {
    progress(`Could not find ${desiredLabel} button`);
    return;
  }

  // Step 4: If a dialog appeared, dismiss it with correct mode
  const dismissed = await dismissShoppingModeDialog(page, mode);
  if (dismissed) {
    progress("Confirmed mode in dialog");
    await sleep(2000);
  }
  await closePopups(page);

  // Step 5: Verify
  check = await checkCurrentMode(page);
  progress(`Mode after click: ${check.mode}`);

  if (check.mode.toLowerCase() === desiredLabel.toLowerCase()) {
    return;
  }

  // Step 6: If still wrong, the click may have toggled to a different mode.
  // Try clicking the desired button one more time.
  progress(`Retrying ${desiredLabel} click...`);
  try {
    const desiredBtn = page.locator(`button:has-text("${desiredLabel}")`).first();
    if (await desiredBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await desiredBtn.click({ force: true });
      await sleep(2000);
    }
  } catch {}

  await dismissShoppingModeDialog(page, mode);
  await closePopups(page);
  await sleep(1000);

  check = await checkCurrentMode(page);
  progress(`Final mode: ${check.mode}`);
}

async function scrapeCartFromPage(page, mode, progressCallback) {
  const progress = progressCallback || (() => {});

  // Click the cart button to open the sidebar - try multiple selectors with retries
  let cartBtn = null;
  const cartSelectors = [
    '[aria-label*="View Cart" i]',
    'button[aria-label*="cart" i]',
    '[aria-label*="cart" i]',
  ];

  for (let retry = 0; retry < 2; retry++) {
    for (const sel of cartSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 5000 })) {
          cartBtn = el;
          break;
        }
      } catch {}
    }
    if (cartBtn) break;
    // Retry: dismiss any blocking dialogs and wait
    await closePopups(page);
    await dismissShoppingModeDialog(page, mode);
    await sleep(2000);
  }

  if (!cartBtn) {
    return { error: "Could not find cart button." };
  }

  const cartLabel = await cartBtn.getAttribute("aria-label");
  progress(`Cart button label: "${cartLabel}"`);
  const countMatch = cartLabel && cartLabel.match(/(\d+)/);
  const itemCount = countMatch ? parseInt(countMatch[1]) : -1;

  if (itemCount === 0) {
    progress("Cart aria-label shows 0 (may not reflect current mode — continuing anyway)");
  }

  await cartBtn.click({ force: true });
  progress("Clicked cart button, waiting for sidebar content...");

  // Wait for cart sidebar content to appear (product links or images)
  try {
    await page.waitForSelector(
      '[role="dialog"] a[href*="/products/"], .__reakit-portal a[href*="/products/"], [role="dialog"] img[src*="product"], [role="dialog"] li',
      { timeout: 8000 }
    );
    progress("Sidebar content detected");
  } catch {
    progress("No sidebar content detected by selector, waiting extra...");
    await sleep(3000);
  }
  await sleep(2000);

  // Scrape the cart sidebar dialog
  const scrapeResult = await page.evaluate((stopHeadersArg) => {
    const diag = [];
    const results = [];

    // --- Find the cart container ---
    let cartContainer = null;

    // Try 1: role="dialog" elements matched by cart text
    const dialogs = document.querySelectorAll('[role="dialog"]');
    diag.push(`[role="dialog"] count: ${dialogs.length}`);

    const cartTextPatterns = ["Shopping list", "Your cart", "Pickup order", "Your order", "Quantity:", "checkout", "Subtotal"];
    for (const d of dialogs) {
      const t = d.innerText || "";
      if (cartTextPatterns.some(p => t.toLowerCase().includes(p.toLowerCase())) || (t.includes("$") && t.length > 100)) {
        cartContainer = d;
        diag.push(`Found cart dialog by text match (text length: ${t.length})`);
        break;
      }
    }

    // Try 2: Last dialog fallback
    if (!cartContainer && dialogs.length > 0) {
      cartContainer = dialogs[dialogs.length - 1];
      diag.push(`Using last dialog fallback (text length: ${(cartContainer.innerText || "").length})`);
    }

    // Try 3: Reakit portals (Instacart uses these)
    if (!cartContainer) {
      const portals = document.querySelectorAll('.__reakit-portal');
      diag.push(`Reakit portals: ${portals.length}`);
      for (const p of portals) {
        const t = p.innerText || "";
        if (t.includes("$") && t.length > 50) {
          cartContainer = p;
          diag.push(`Using reakit portal (text length: ${t.length})`);
          break;
        }
      }
    }

    // Try 4: Sidebar/drawer/panel elements
    if (!cartContainer) {
      const candidates = document.querySelectorAll('aside, [class*="sidebar" i], [class*="drawer" i], [class*="SlideOver" i], [class*="cart-panel" i], [class*="rightPanel" i]');
      diag.push(`Sidebar/drawer candidates: ${candidates.length}`);
      for (const c of candidates) {
        const t = c.innerText || "";
        if (t.includes("$") && t.length > 100) {
          cartContainer = c;
          diag.push(`Using sidebar element (tag: ${c.tagName}, text length: ${t.length})`);
          break;
        }
      }
    }

    if (!cartContainer) {
      diag.push("FAILED: No cart container found anywhere");
      diag.push(`Page title: ${document.title}`);
      diag.push(`URL: ${window.location.href}`);
      return { items: [], diag };
    }

    const fullText = cartContainer.innerText || "";

    // Check for empty cart indicators before parsing
    if (/your (personal )?cart is empty|cart is empty|no items in your cart/i.test(fullText)) {
      diag.push("Cart is empty (found empty cart message)");
      return { items: [], diag };
    }

    const allLines = fullText.split("\n").map(s => s.trim()).filter(s => s.length > 0);
    diag.push(`Container total lines: ${allLines.length}`);
    diag.push(`First 15 lines: ${allLines.slice(0, 15).join(" | ")}`);

    const stopHeaders = stopHeadersArg;

    // Find recommendation cutoff
    const cutoffIdx = allLines.findIndex(line => stopHeaders.some(h => line.toLowerCase().includes(h.toLowerCase())));
    const cartLines = cutoffIdx >= 0 ? allLines.slice(0, cutoffIdx) : allLines;
    diag.push(`Recommendation cutoff at line: ${cutoffIdx}, cart lines: ${cartLines.length}`);

    // --- Strategy 1: Text pattern parsing ---
    // Handles two formats:
    //   In-Store: "Quantity: 1 item" on one line
    //   Pickup:   "Quantity:" on one line, "N ct" on the next
    // Walk backwards from each Quantity line to find name and price.
    const skipNames = ["Shopping Cart", "Shopping list", "Your cart", "Pickup order",
      "Your order", "Manage", "Woodman's Food Markets", "Shopping"];

    for (let qi = 0; qi < cartLines.length; qi++) {
      const line = cartLines[qi];
      let quantity = 1;

      // Match "Quantity: N item" (same line) or just "Quantity:" (next line has count)
      if (/^Quantity:/i.test(line)) {
        const sameLine = line.match(/Quantity:\s*(\d+)/i);
        if (sameLine) {
          quantity = parseInt(sameLine[1]);
        } else if (qi + 1 < cartLines.length) {
          const nextLine = cartLines[qi + 1];
          const ctMatch = nextLine.match(/^(\d+)\s*(ct|item|ea|each|pk|lb|oz)?/i);
          if (ctMatch) {
            quantity = parseInt(ctMatch[1]);
          }
        }

        // Walk backwards to find price and name
        let price = "";
        let name = "";
        let back = qi - 1;
        const pricesFound = []; // diagnostic: all prices encountered

        // Skip UI labels, price lines, count lines, and replacement options.
        // Always overwrite price — we want the CURRENT price (closest to name),
        // not the ORIGINAL price (which appears between current price and Quantity).
        while (back >= 0) {
          const bl = cartLines[back];
          if (/^(Replace with|Choose replacement|Choose a replacement|Original price|Current price|Sale price|On sale|Save \$)/i.test(bl)) {
            back--;
            continue;
          }
          if (/^\$\d/.test(bl)) {
            pricesFound.push(bl);
            price = bl; // Overwrite each time — last found = current price
            back--;
            continue;
          }
          // Skip count/unit lines like "1 ct", "16 fl oz", "1 gal", "Half Gallon", etc.
          if (/^\d+(?:\.\d+)?\s*(?:fl\s*oz|oz|ct|item|items|ea|each|pk|lb|lbs|gal|gallon|ml|l|qt|pt|count|kg|g)\s*$/i.test(bl)) {
            back--;
            continue;
          }
          // Skip standalone size descriptions like "Half Gallon", "1/2 Gallon", "16 oz", etc.
          if (/^(?:half|quarter|whole)?\s*(?:gallon|pint|quart|liter|litre)\s*$/i.test(bl)) {
            back--;
            continue;
          }
          break;
        }

        // The line at `back` should be the product name (possibly with size in parens)
        if (back >= 0) {
          const candidate = cartLines[back];
          if (candidate.length >= 3 && !skipNames.includes(candidate) &&
              !candidate.startsWith("$") && !candidate.startsWith("Est.") &&
              !/^(Shopper|Checkout|Subtotal|Shopping|Woodman|Choose|\d+\s*(am|pm))/i.test(candidate) &&
              !/^\d+$/.test(candidate) &&
              // Reject pure size/unit strings that slipped through
              !/^\d+(?:\.\d+)?\s*(?:fl\s*oz|oz|ct|ea|pk|lb|lbs|gal|ml|l|qt|pt|kg|g|count|item|items|each)\s*$/i.test(candidate) &&
              !/^(?:half|quarter|whole)\s*(?:gallon|pint|quart|liter|litre)\s*$/i.test(candidate)) {
            name = candidate;
          }
        }

        if (name) {
          // Extract size from name if present: "Product Name (16 oz)" -> size="16 oz"
          let size = "";
          const sizeInName = name.match(/\((\d+(?:\.\d+)?\s*(?:oz|fl oz|lb|gal|ct|pk|ml|l|qt|pt)[^)]*)\)/i);
          if (sizeInName) size = sizeInName[1];
          // If multiple prices found and qty > 1, the price closest to name
          // (last overwrite) might be per-unit or line total. If there's a
          // smaller price that divides evenly, use that as per-unit.
          if (quantity > 1 && pricesFound.length >= 2) {
            const parsed = pricesFound.map(p => {
              const m = p.match(/\$?([\d]+\.?\d*)/);
              return m ? { raw: p, val: parseFloat(m[1]) } : null;
            }).filter(Boolean).sort((a, b) => a.val - b.val);
            if (parsed.length >= 2) {
              const smallest = parsed[0];
              const largest = parsed[parsed.length - 1];
              // If largest ≈ smallest * quantity, smallest is per-unit
              if (Math.abs(largest.val - smallest.val * quantity) < 0.02) {
                price = smallest.raw;
              }
            }
          }
          diag.push(`  Item: "${name}" price=${price} qty=${quantity} allPrices=[${pricesFound.join(", ")}]`);
          results.push({ name, size, price, quantity });
        }
      }
    }
    diag.push(`Strategy 1 (text pattern) found: ${results.length}`);

    // --- Strategy 2: DOM product links from URL slugs ---
    if (results.length === 0) {
      const seen = new Set();

      // Find recommendation boundary element
      let recBoundary = null;
      const headingEls = cartContainer.querySelectorAll("h1, h2, h3, h4, span, div, p");
      for (const el of headingEls) {
        // Only match elements whose OWN text (not children) matches
        const ownText = Array.from(el.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => n.textContent.trim())
          .join("");
        if (stopHeaders.some(h => ownText.toLowerCase() === h.toLowerCase())) {
          recBoundary = el;
          break;
        }
        // Also check full textContent for leaf-like elements
        if (el.children.length <= 1) {
          const t = (el.textContent || "").trim();
          if (stopHeaders.some(h => t.toLowerCase() === h.toLowerCase())) {
            recBoundary = el;
            break;
          }
        }
      }
      diag.push(`Strategy 2: recBoundary found: ${!!recBoundary}`);

      const productLinks = cartContainer.querySelectorAll('a[href*="/products/"]');
      diag.push(`Strategy 2: ${productLinks.length} product links in container`);

      let skippedBoundary = 0;
      for (const link of productLinks) {
        if (recBoundary) {
          const position = recBoundary.compareDocumentPosition(link);
          if (position & Node.DOCUMENT_POSITION_CONTAINED_BY || position & Node.DOCUMENT_POSITION_FOLLOWING) {
            skippedBoundary++;
            continue;
          }
        }
        const hrefMatch = link.href.match(/\/products\/\d+-(.+)$/);
        let name = "";
        if (hrefMatch) {
          name = hrefMatch[1].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        }
        if (!name || name.length < 3 || seen.has(name)) continue;
        seen.add(name);

        const parent = link.closest("li") || link.closest('[class*="item"]') || link.parentElement?.parentElement?.parentElement;
        let price = "";
        let size = "";
        let quantity = 1;
        if (parent) {
          const allText = parent.innerText || "";
          const priceMatch = allText.match(/\$\d+\.\d{2}/);
          if (priceMatch) price = priceMatch[0];
          const sizeMatch = allText.match(/\d+(?:\.\d+)?\s*(?:oz|fl oz|lb|gal|ct|pk|ml|l|qt|pt)/i);
          if (sizeMatch) size = sizeMatch[0];
          const qtyMatch = allText.match(/(?:Quantity|Qty)[:\s]*(\d+)/i);
          if (qtyMatch) {
            quantity = parseInt(qtyMatch[1]);
          } else {
            // Look for standalone number between stepper buttons
            const numBtns = parent.querySelectorAll('button');
            for (const btn of numBtns) {
              const prev = btn.previousElementSibling;
              if (prev && /^\d+$/.test((prev.textContent || "").trim())) {
                quantity = parseInt(prev.textContent.trim());
                break;
              }
              const next = btn.nextElementSibling;
              if (next && /^\d+$/.test((next.textContent || "").trim())) {
                quantity = parseInt(next.textContent.trim());
                break;
              }
            }
            // Also check for input[type="number"] or [role="spinbutton"]
            if (quantity === 1) {
              const qtyInput = parent.querySelector('input[type="number"], [role="spinbutton"]');
              if (qtyInput && qtyInput.value) {
                quantity = parseInt(qtyInput.value) || 1;
              }
            }
          }
        }

        results.push({ name, size, price, quantity });
      }
      diag.push(`Strategy 2 found: ${results.length} (skipped ${skippedBoundary} by boundary)`);
    }

    // --- Strategy 3: Stepper/quantity controls (find items by their +/- buttons) ---
    if (results.length === 0) {
      const seen = new Set();
      const stepperBtns = cartContainer.querySelectorAll(
        'button[aria-label*="ncrement" i], button[aria-label*="ncrease" i], button[aria-label*="ecrease" i], button[aria-label*="elete" i], button[aria-label*="emove" i]'
      );
      diag.push(`Strategy 3: ${stepperBtns.length} stepper/remove buttons`);

      const containers = new Set();
      for (const btn of stepperBtns) {
        const container = btn.closest('li') || btn.closest('[class*="item" i]') || btn.closest('[data-testid]') || btn.parentElement?.parentElement?.parentElement;
        if (container && container !== cartContainer) containers.add(container);
      }
      diag.push(`Strategy 3: ${containers.size} unique item containers`);

      for (const container of containers) {
        let name = "";
        const nameLink = container.querySelector('a[href*="/products/"]');
        if (nameLink) {
          const hrefMatch = nameLink.href.match(/\/products\/\d+-(.+)$/);
          if (hrefMatch) {
            name = hrefMatch[1].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
          }
        }
        if (!name) {
          // Find the longest meaningful text (likely product name)
          const textEls = container.querySelectorAll('span, a, p, div');
          let bestName = "";
          for (const el of textEls) {
            const t = (el.textContent || "").trim();
            if (t.length > bestName.length && t.length > 3 && t.length < 120 &&
                !t.startsWith("$") && !/^\d+$/.test(t) &&
                !/Quantity|Remove|Increment|Decrement|Delete|Edit|Manage/i.test(t) &&
                el.children.length <= 2) {
              bestName = t;
            }
          }
          name = bestName;
        }

        if (!name || name.length < 3 || seen.has(name)) continue;
        seen.add(name);

        const allText = container.innerText || "";
        let price = "";
        const priceMatch = allText.match(/\$\d+\.\d{2}/);
        if (priceMatch) price = priceMatch[0];

        let size = "";
        const sizeMatch = allText.match(/\d+(?:\.\d+)?\s*(?:oz|fl oz|lb|gal|ct|pk|ml|l|qt|pt)/i);
        if (sizeMatch) size = sizeMatch[0];

        let quantity = 1;
        const qtyMatch = allText.match(/(?:Quantity|Qty)[:\s]*(\d+)/i);
        if (qtyMatch) {
          quantity = parseInt(qtyMatch[1]);
        } else {
          const btns = container.querySelectorAll('button');
          for (const btn of btns) {
            const next = btn.nextElementSibling;
            if (next && /^\d+$/.test((next.textContent || "").trim())) {
              quantity = parseInt(next.textContent.trim());
              break;
            }
            const prev = btn.previousElementSibling;
            if (prev && /^\d+$/.test((prev.textContent || "").trim())) {
              quantity = parseInt(prev.textContent.trim());
              break;
            }
          }
          if (quantity === 1) {
            const qtyInput = container.querySelector('input[type="number"], [role="spinbutton"]');
            if (qtyInput && qtyInput.value) {
              quantity = parseInt(qtyInput.value) || 1;
            }
          }
        }

        results.push({ name, size, price, quantity });
      }
      diag.push(`Strategy 3 found: ${results.length}`);
    }

    // --- Strategy 4: Price-line text parsing (generic fallback) ---
    if (results.length === 0) {
      const seen = new Set();
      for (let li = 0; li < cartLines.length; li++) {
        const line = cartLines[li];
        if (/^\$\d+\.\d{2}/.test(line)) {
          let name = "";
          for (let back = 1; back <= 4 && (li - back) >= 0; back++) {
            const candidate = cartLines[li - back];
            if (/^\$/.test(candidate)) continue;
            if (/^Quantity/i.test(candidate)) continue;
            if (/^\d+\s*(oz|fl|lb|gal|ct|pk|ml|l|qt|pt)/i.test(candidate)) continue;
            if (/^(Remove|Edit|Manage|Save|Checkout|Subtotal|Est\.|Shopper|Shopping|Your\s)/i.test(candidate)) continue;
            if (candidate.length < 3) continue;
            name = candidate;
            break;
          }

          if (name && !seen.has(name)) {
            seen.add(name);
            results.push({ name, size: "", price: line, quantity: 1 });
          }
        }
      }
      diag.push(`Strategy 4 (price-line) found: ${results.length}`);
    }

    return { items: results, diag };
  }, ["Complete your cart", "Buy it again", "You might also like", "Recommended for you", "Customers also bought"]);

  // Log diagnostics
  for (const msg of (scrapeResult.diag || [])) {
    progress(`  ${msg}`);
  }

  const items = scrapeResult.items || [];
  progress(`Cart scrape: ${items.length} items found`);

  // Close the cart sidebar
  const closeBtnSelectors = [
    '[role="dialog"] button[aria-label="Close"]',
    '.__reakit-portal button[aria-label="Close"]',
    '[role="dialog"] button[aria-label*="close" i]',
    'button[aria-label="Close cart"]',
  ];
  for (const sel of closeBtnSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click({ force: true });
        await sleep(1000);
        break;
      }
    } catch {}
  }

  return items;
}

async function removeAllCartItems(settings, progressCallback) {
  const progress = progressCallback || (() => {});
  const mode = (settings && settings.shoppingMode) || "instore";

  if (!(settings && settings.username && settings.password)) {
    return { error: "Credentials required. Configure them in Settings." };
  }

  try {
    const page = await getSearchSession(settings, progress);
    await ensureShoppingMode(page, mode, progress);

    // Open the cart sidebar
    progress("Opening cart...");
    let cartBtn = null;
    const cartSelectors = [
      '[aria-label*="View Cart" i]',
      'button[aria-label*="cart" i]',
      '[aria-label*="cart" i]',
      '[data-testid*="cart"]',
      'a[href*="cart"]',
    ];

    for (let retry = 0; retry < 2; retry++) {
      for (const sel of cartSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 5000 })) {
            cartBtn = el;
            break;
          }
        } catch {}
      }
      if (cartBtn) break;
      await closePopups(page);
      await ensureShoppingMode(page, mode);
      await sleep(2000);
    }

    if (!cartBtn) {
      return { error: "Could not find cart button." };
    }

    const cartLabel = await cartBtn.getAttribute("aria-label");
    const countMatch = cartLabel && cartLabel.match(/(\d+)/);
    const itemCount = countMatch ? parseInt(countMatch[1]) : -1;

    if (itemCount === 0) {
      progress("Cart is already empty.");
      return { removed: 0 };
    }

    progress(`Found ${itemCount > 0 ? itemCount : "some"} item(s) in cart. Opening sidebar...`);
    await cartBtn.click({ force: true });
    await sleep(3000);

    // Strategy A: Click "Manage" / "Edit" → "Remove all items" (bulk remove)
    let bulkRemoved = false;
    const manageStrategies = [
      () => page.locator('button:has-text("Manage")').first(),
      () => page.locator('a:has-text("Manage")').first(),
      () => page.locator('button:has-text("Edit")').first(),
      () => page.locator('a:has-text("Edit")').first(),
    ];

    for (const strategy of manageStrategies) {
      try {
        const el = strategy();
        if (await el.isVisible({ timeout: 3000 })) {
          progress("Found Manage button, trying bulk remove...");
          await el.click({ force: true });
          await sleep(2000);

          const removeAllStrategies = [
            () => page.locator('button:has-text("Remove all items")').first(),
            () => page.locator('button:has-text("Remove all")').first(),
          ];

          for (const rmStrategy of removeAllStrategies) {
            try {
              const rmEl = rmStrategy();
              if (await rmEl.isVisible({ timeout: 3000 })) {
                await rmEl.click({ force: true });
                await sleep(3000);

                // Handle confirmation dialog
                const confirmStrategies = [
                  () => page.locator('button:has-text("Remove all")').first(),
                  () => page.locator('button:has-text("Confirm")').first(),
                  () => page.locator('button:has-text("Yes")').first(),
                  () => page.locator('[role="dialog"] button:has-text("Remove")').first(),
                ];
                for (const cfm of confirmStrategies) {
                  try {
                    const cfmEl = cfm();
                    if (await cfmEl.isVisible({ timeout: 2000 })) {
                      await cfmEl.click({ force: true });
                      await sleep(2000);
                      break;
                    }
                  } catch {}
                }

                bulkRemoved = true;
                break;
              }
            } catch {}
          }
          break;
        }
      } catch {}
    }

    // Strategy B: Remove items one at a time by clicking Remove/Decrement buttons.
    // Instacart Pickup mode uses "Decrement quantity of <item>" at qty > 1,
    // then swaps to "Remove <item>" at qty = 1.
    if (!bulkRemoved) {
      progress("Removing items individually...");
      let clickCount = 0;
      const maxClicks = (itemCount > 0 ? itemCount * 15 : 100);
      let lastItemName = "";

      // Combined selectors: both Remove and Decrement buttons
      const itemBtnSelectors = [
        '[role="dialog"] button[aria-label^="Remove " i]',
        'button[aria-label^="Decrement quantity" i]',
      ];

      while (clickCount < maxClicks) {
        let targetBtn = null;
        for (let wait = 0; wait < 4; wait++) {
          for (const sel of itemBtnSelectors) {
            try {
              const btn = page.locator(sel).first();
              if (await btn.isVisible({ timeout: 1500 })) {
                targetBtn = btn;
                break;
              }
            } catch {}
          }
          if (targetBtn) break;
          await sleep(1000);
        }

        if (!targetBtn) break;

        const label = await targetBtn.getAttribute("aria-label").catch(() => "");
        const itemName = label
          .replace(/^Decrement quantity of\s*/i, "")
          .replace(/^Remove\s*/i, "") || "item";

        if (itemName !== lastItemName) {
          progress(`  Removing: ${itemName}...`);
          lastItemName = itemName;
        }

        try {
          await targetBtn.click({ force: true });
        } catch {
          try {
            await targetBtn.scrollIntoViewIfNeeded();
            await sleep(500);
            await targetBtn.click({ force: true });
          } catch { break; }
        }
        clickCount++;
        await sleep(2500);

        // Handle confirmation popups (use specific selectors to avoid re-clicking item buttons)
        for (const cfmSel of [
          '[role="alertdialog"] button:has-text("Remove")',
          '[role="alertdialog"] button:has-text("Confirm")',
          '[role="alertdialog"] button:has-text("Yes")',
        ]) {
          try {
            const cfm = page.locator(cfmSel).first();
            if (await cfm.isVisible({ timeout: 1000 }).catch(() => false)) {
              await cfm.click({ force: true });
              await sleep(2000);
              break;
            }
          } catch {}
        }
      }

      // Check final cart count
      let finalCount = -1;
      try {
        await closePopups(page);
        await sleep(1000);
        const cartBtnFinal = page.locator('[aria-label*="View Cart" i]').first();
        const finalLabel = await cartBtnFinal.getAttribute("aria-label").catch(() => "");
        const match = finalLabel.match(/(\d+)/);
        finalCount = match ? parseInt(match[1]) : -1;
      } catch {}

      const removed = finalCount >= 0 ? Math.max(0, itemCount - finalCount) : clickCount;
      progress(`Removed ${removed} item(s) from Woodmans cart.${finalCount > 0 ? ` (${finalCount} remaining)` : ""}`);
      await closePopups(page);
      return { removed };
    }

    // Close the cart sidebar
    await closePopups(page);

    progress(`Done! Removed ${itemCount > 0 ? itemCount : ""} item(s) from Woodmans cart.`);
    return { removed: itemCount > 0 ? itemCount : 1 };
  } catch (err) {
    closeSearchSession();
    return { error: `Failed to remove cart items: ${err.message}` };
  }
}

async function fetchCurrentCart(settings, progressCallback) {
  const progress = progressCallback || (() => {});
  if (!(settings && settings.username && settings.password)) {
    return { error: "Credentials required to fetch cart. Configure them in Settings." };
  }

  const mode = (settings && settings.shoppingMode) || "instore";

  try {
    // Reuse the persistent search session (already logged in, correct mode)
    const page = await getSearchSession(settings, progress);
    // Verify we're in the correct shopping mode before scraping
    progress(`Ensuring ${mode} mode...`);
    await ensureShoppingMode(page, mode, progress);
    progress("Scraping cart...");
    const items = await scrapeCartFromPage(page, mode, progress);
    return items;
  } catch (err) {
    // Kill the session on error so next attempt starts fresh
    closeSearchSession();
    return { error: `Failed to fetch cart: ${err.message}` };
  }
}

module.exports = {
  sleep,
  getSearchSession,
  findSearchInput,
  findAddButton,
  incrementQuantity,
  closePopups,
  dismissShoppingModeDialog,
  ensureShoppingMode,
  searchAndAdd,
  launchBrowser,
  autoLogin,
  searchProducts,
  fetchCurrentCart,
  removeAllCartItems,
  scrapeCartFromPage,
  closeSearchSession,
};
