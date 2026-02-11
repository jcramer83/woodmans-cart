const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell } = require("electron");
const path = require("path");
const fs = require("fs");

const ICON_PATH = path.join(__dirname, "assets", "icon.png");

const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const STAPLES_PATH = path.join(DATA_DIR, "staples.json");
const RECIPES_PATH = path.join(DATA_DIR, "recipes.json");

let mainWindow = null;
let tray = null;
let cartWorkerInstance = null;
let wsBroadcast = null; // Set when web server starts
let serverInfo = null; // { port, addresses } — set when web server starts

// --- Data helpers ---

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const defaults = {
    [SETTINGS_PATH]: {
      username: "",
      password: "",
      storeUrl: "https://shopwoodmans.com",
      delayBetweenItems: 2000,
      searchResultWait: 5000,
      addButtonWait: 3000,
      shoppingMode: "instore",
    },
    [STAPLES_PATH]: [],
    [RECIPES_PATH]: [],
  };
  for (const [filePath, defaultData] of Object.entries(defaults)) {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2), "utf-8");
    }
  }
}

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// --- Window ---

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 1000,
    minHeight: 600,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: ICON_PATH,
    title: "Woodmans Cart",
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Minimize to system tray instead of taskbar
  mainWindow.on("minimize", (event) => {
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Woodmans Cart");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: "Quit",
      click: () => {
        if (mainWindow) mainWindow.destroy();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// --- IPC: Settings ---

ipcMain.handle("settings:load", () => {
  return readJSON(SETTINGS_PATH);
});

ipcMain.handle("settings:save", (_event, settings) => {
  writeJSON(SETTINGS_PATH, settings);
  return true;
});

// --- IPC: Staples ---

ipcMain.handle("staples:load", () => {
  return readJSON(STAPLES_PATH) || [];
});

ipcMain.handle("staples:save", (_event, staples) => {
  writeJSON(STAPLES_PATH, staples);
  return true;
});

// --- IPC: Recipes ---

ipcMain.handle("recipes:load", () => {
  return readJSON(RECIPES_PATH) || [];
});

ipcMain.handle("recipes:save", (_event, recipes) => {
  writeJSON(RECIPES_PATH, recipes);
  return true;
});

// --- IPC: Cart automation ---

ipcMain.handle("cart:start", async (_event, { items, settings }) => {
  const shoppingMode = settings.shoppingMode || "instore";

  // --- Fast mode: direct GraphQL API ---
  if (settings.fastMode) {
    const fastWorker = require("./cart-worker-fast");
    try {
      const session = await fastWorker.getFastSession(settings, sendProgress);
      cartWorkerInstance = { active: true };
      await fastWorker.ensureShoppingMode(session, shoppingMode, sendProgress);

      const { results, cartItems } = await fastWorker.searchAndAddAll(
        session, items, sendProgress,
        (itemDoneData) => {
          if (mainWindow && !mainWindow.isDestroyed())
            mainWindow.webContents.send("cart:item-done", itemDoneData);
          if (wsBroadcast)
            wsBroadcast({ type: "item-done", data: itemDoneData });
        },
        () => !cartWorkerInstance // stop check
      );

      const ok = results.filter((r) => r.status === "ok").length;
      const failed = results.filter((r) => r.status === "fail").length;
      const skipped = results.filter((r) => r.status === "skip").length;
      sendProgress(`Done! Added: ${ok}, Failed: ${failed}, Skipped: ${skipped}`);

      // Refresh the online cart after adding items
      if (ok > 0) {
        try {
          sendProgress("Fetching updated Woodmans cart...");
          const freshCartItems = await fastWorker.fetchCart(session, sendProgress);
          if (freshCartItems && Array.isArray(freshCartItems) && freshCartItems.length > 0) {
            if (mainWindow && !mainWindow.isDestroyed())
              mainWindow.webContents.send("cart:online-update", freshCartItems);
            if (wsBroadcast)
              wsBroadcast({ type: "online-update", items: freshCartItems });
            sendProgress(`Online cart updated (${freshCartItems.length} items).`);
          }
        } catch (fetchErr) {
          sendProgress(`Could not fetch online cart: ${fetchErr.message}`);
        }
      }

      cartWorkerInstance = null;
      return { ok, failed, skipped, results };
    } catch (err) {
      sendProgress(`Error: ${err.message}`);
      cartWorkerInstance = null;
      return { ok: 0, failed: 0, skipped: 0, error: err.message };
    }
  }

  // --- Standard mode: browser automation ---
  const cartWorker = require("./cart-worker");
  try {
    const page = await cartWorker.getSearchSession(settings, sendProgress);
    cartWorkerInstance = { active: true };

    await cartWorker.ensureShoppingMode(page, shoppingMode, sendProgress);

    // Process items
    const results = [];
    for (let i = 0; i < items.length; i++) {
      if (!cartWorkerInstance) {
        sendProgress("Cart automation stopped by user.");
        break;
      }
      const result = await cartWorker.searchAndAdd(
        page,
        items[i],
        i,
        items.length,
        sendProgress
      );
      results.push(result);
      // Notify renderer of per-item completion
      const itemDoneData = {
        id: items[i].id,
        index: i,
        total: items.length,
        status: result.status,
      };
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("cart:item-done", itemDoneData);
      }
      if (wsBroadcast) {
        wsBroadcast({ type: "item-done", data: itemDoneData });
      }
      if (i < items.length - 1) {
        await cartWorker.sleep(settings.delayBetweenItems || 2000);
      }
    }

    // Summary
    const ok = results.filter((r) => r.status === "ok").length;
    const failed = results.filter((r) => r.status === "fail").length;
    const skipped = results.filter((r) => r.status === "skip").length;
    sendProgress(`Done! Added: ${ok}, Failed: ${failed}, Skipped: ${skipped}`);

    // Scrape the current cart
    sendProgress("Fetching updated Woodmans cart...");
    await cartWorker.ensureShoppingMode(page, shoppingMode, sendProgress);
    try {
      const cartItems = await cartWorker.scrapeCartFromPage(page, shoppingMode, sendProgress);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("cart:online-update", cartItems);
      }
      if (wsBroadcast) {
        wsBroadcast({ type: "online-update", items: cartItems });
      }
      sendProgress(`Online cart updated (${Array.isArray(cartItems) ? cartItems.length : 0} items).`);
    } catch (scrapeErr) {
      sendProgress(`Could not fetch online cart: ${scrapeErr.message}`);
    }

    cartWorkerInstance = null;
    return { ok, failed, skipped, results };
  } catch (err) {
    sendProgress(`Error: ${err.message}`);
    cartWorkerInstance = null;
    return { ok: 0, failed: 0, skipped: 0, error: err.message };
  }
});

ipcMain.handle("cart:stop", async () => {
  if (cartWorkerInstance) {
    cartWorkerInstance = null;
    sendProgress("Cart automation stopped.");
  }
  return true;
});

// --- IPC: Product search ---

ipcMain.handle("product:search", async (_event, query) => {
  const currentSettings = readJSON(SETTINGS_PATH) || {};

  if (currentSettings.fastMode) {
    const fastWorker = require("./cart-worker-fast");
    try {
      const session = await fastWorker.getFastSession(currentSettings, sendProgress);
      return await fastWorker.searchProducts(query, session);
    } catch (err) {
      return { error: err.message };
    }
  }

  const cartWorker = require("./cart-worker");
  try {
    const results = await cartWorker.searchProducts(query, currentSettings);
    return results;
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: Fetch current online cart ---

ipcMain.handle("cart:fetch", async () => {
  const currentSettings = readJSON(SETTINGS_PATH) || {};

  if (currentSettings.fastMode) {
    const fastWorker = require("./cart-worker-fast");
    try {
      const session = await fastWorker.getFastSession(currentSettings, sendProgress);
      await fastWorker.ensureShoppingMode(session, currentSettings.shoppingMode || "instore", sendProgress);
      return await fastWorker.fetchCart(session, sendProgress);
    } catch (err) {
      return { error: err.message };
    }
  }

  const cartWorker = require("./cart-worker");
  try {
    const items = await cartWorker.fetchCurrentCart(currentSettings, sendProgress);
    return items;
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: Remove all items from online cart ---

ipcMain.handle("cart:remove-all", async () => {
  const currentSettings = readJSON(SETTINGS_PATH) || {};

  if (currentSettings.fastMode) {
    const fastWorker = require("./cart-worker-fast");
    try {
      const session = await fastWorker.getFastSession(currentSettings, sendProgress);
      await fastWorker.ensureShoppingMode(session, currentSettings.shoppingMode || "instore", sendProgress);
      return await fastWorker.removeAllCartItems(session, sendProgress);
    } catch (err) {
      return { error: err.message };
    }
  }

  const cartWorker = require("./cart-worker");
  try {
    const result = await cartWorker.removeAllCartItems(currentSettings, sendProgress);
    return result;
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: AI recipe generation ---

ipcMain.handle("recipe:generate", async (_event, { prompt, servings, glutenFree, dairyFree, preferOrganic }) => {
  const currentSettings = readJSON(SETTINGS_PATH) || {};
  const apiKey = currentSettings.anthropicApiKey;

  if (!apiKey) {
    return { error: "No Claude API key configured. Add it in Settings." };
  }

  let dietaryRules = "";
  if (glutenFree) {
    dietaryRules += '\n- GLUTEN FREE REQUIRED: Every ingredient must be gluten free. For items that commonly contain gluten (pasta, flour, bread, soy sauce, breadcrumbs, etc.), ALWAYS include "gluten free" in the search term (e.g. "gluten free pasta", "gluten free soy sauce", "gluten free flour"). Only use naturally gluten-free ingredients or certified gluten-free products.';
  }
  if (dairyFree) {
    dietaryRules += '\n- DAIRY FREE REQUIRED: No milk, butter, cheese, cream, yogurt, or any dairy products. Use dairy-free alternatives and include "dairy free" in search terms (e.g. "dairy free butter", "dairy free shredded cheese", "oat milk", "coconut cream").';
  }
  if (preferOrganic) {
    dietaryRules += '\n- PREFER ORGANIC: Include "organic" in search terms when possible (e.g. "organic chicken breast", "organic baby spinach", "organic diced tomatoes"). This helps the store search show organic options first.';
  }

  const systemPrompt = `You are a recipe assistant for a grocery shopping app. Generate a recipe with a list of ingredients that can be found at a grocery store called Woodman's. The "item" field is used as a SEARCH QUERY on the store's website to find and add products to a cart.

Return ONLY valid JSON in this exact format, no other text:
{
  "name": "Recipe Name",
  "items": [
    {"item": "search term for store website", "quantity": 1, "note": "size or detail"}
  ]
}

Rules:
- "item" is a SEARCH QUERY typed into the store's search bar. Use names a shopper would type to find the exact product, e.g. "boneless skinless chicken thighs" not "chicken" or "2 lbs chicken thighs"
- Do NOT put amounts, measurements, or cooking units in the "item" field (no "2 cups flour", no "1 lb ground beef"). Put only the product name.
- "quantity" is how many times to ADD this item to the cart. Each add gives you one store unit (1 can, 1 bag, 1 bunch, 1 individual fruit/vegetable, etc.). If the recipe needs 2 tomatoes, quantity is 2. If it needs 2 cans of diced tomatoes, quantity is 2. If it needs 2 cups of flour, quantity is still 1 because one bag of flour is enough. Think about what the shopper actually needs to put in their cart.
- Use the "note" field for the recipe amount, size preference, or preparation details (e.g. "need 2 cups", "1 lb", "diced")
- Be specific with product names (e.g. "sharp cheddar cheese block" not just "cheese")
- Skip pantry staples most people already have (salt, black pepper, olive oil, water) unless the recipe uses an unusual amount${dietaryRules}`;

  const userMessage = `Generate a recipe for: ${prompt}\nServings: ${servings}`;

  try {
    const https = require("https");

    const body = JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const result = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "api.anthropic.com",
          path: "/v1/messages",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) {
                reject(new Error(parsed.error.message || "API error"));
                return;
              }
              const text = parsed.content?.[0]?.text || "";
              resolve(text);
            } catch (e) {
              reject(new Error("Failed to parse API response"));
            }
          });
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    // Parse the JSON from Claude's response
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { error: "Could not parse recipe from AI response." };
    }

    const recipe = JSON.parse(jsonMatch[0]);
    return recipe;
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: Server info ---

ipcMain.handle("server:info", () => {
  return serverInfo;
});

// --- IPC: Open external URL in default browser ---

ipcMain.handle("open-external", (_event, url) => {
  return shell.openExternal(url);
});

function sendProgress(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("cart:progress", message);
  }
  if (wsBroadcast) {
    wsBroadcast({ type: "progress", message: message });
  }
}

// --- App lifecycle ---

app.whenReady().then(() => {
  ensureDataFiles();
  createTray();
  createWindow();

  // Start web server for remote access
  try {
    const { startServer } = require("./server");
    const serverInstance = startServer({
      readJSON,
      writeJSON,
      SETTINGS_PATH,
      STAPLES_PATH,
      RECIPES_PATH,
      sendProgressToElectron: function (message) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("cart:progress", message);
        }
      },
      getMainWindow: function () { return mainWindow; },
    });
    wsBroadcast = serverInstance.broadcast;
    serverInfo = { port: serverInstance.port, addresses: serverInstance.addresses };
  } catch (err) {
    console.error("Failed to start web server:", err.message);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  try { require("./cart-worker").closeSearchSession(); } catch {}
  try { require("./cart-worker-fast").closeFastSession(); } catch {}
  if (process.platform !== "darwin") {
    app.quit();
  }
});
