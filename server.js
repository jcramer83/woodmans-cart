// server.js — Express + WebSocket server for web clients

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const fs = require("fs");

const PORT = 3456;

function startServer(deps) {
  const { readJSON, writeJSON, SETTINGS_PATH, STAPLES_PATH, RECIPES_PATH, MANUAL_ITEMS_PATH } = deps;

  const app = express();
  app.use(express.json());

  // Serve renderer/ as static files, and assets/ for favicon etc.
  app.use(express.static(path.join(__dirname, "renderer")));
  app.use("/assets", express.static(path.join(__dirname, "assets")));
  app.use("/data/recipe-images", express.static(path.join(__dirname, "data", "recipe-images")));

  const server = http.createServer(app);

  // WebSocket server on same port
  const wss = new WebSocketServer({ server });

  // Broadcast to all connected WebSocket clients
  function broadcast(data) {
    const msg = JSON.stringify(data);
    wss.clients.forEach(function (client) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(msg);
      }
    });
  }

  function sendProgress(message) {
    broadcast({ type: "progress", message: message });
  }

  function sendItemDone(data) {
    broadcast({ type: "item-done", data: data });
  }

  function sendOnlineUpdate(items) {
    broadcast({ type: "online-update", items: items });
  }

  // --- Helpers ---

  // Quick product lookup: search Woodmans for the first match, return { name, price, image, size }
  async function lookupProduct(query) {
    try {
      var currentSettings = readJSON(SETTINGS_PATH) || {};
      var fastWorker = require("./cart-worker-fast");
      var session = await fastWorker.getFastSession(currentSettings);
      var results = await fastWorker.searchProducts(query, session);
      return results && results[0] ? results[0] : null;
    } catch (e) {
      return null;
    }
  }

  // --- REST API endpoints ---

  // Settings
  app.get("/api/settings", function (req, res) {
    const settings = readJSON(SETTINGS_PATH) || {};
    // Omit sensitive fields for web clients
    const safe = Object.assign({}, settings);
    delete safe.password;
    res.json(safe);
  });

  app.post("/api/settings", function (req, res) {
    const current = readJSON(SETTINGS_PATH) || {};
    const incoming = req.body;
    // Merge: keep existing password if not provided
    if (!incoming.password && current.password) {
      incoming.password = current.password;
    }
    // Drop legacy AI key if present
    delete incoming.anthropicApiKey;
    writeJSON(SETTINGS_PATH, incoming);
    res.json({ ok: true });
  });

  // Staples
  app.get("/api/staples", function (req, res) {
    res.json(readJSON(STAPLES_PATH) || []);
  });

  app.post("/api/staples", async function (req, res) {
    // If body is an array, replace all staples. If object, add a single staple.
    if (Array.isArray(req.body)) {
      writeJSON(STAPLES_PATH, req.body);
      return res.json({ ok: true });
    }
    var staples = readJSON(STAPLES_PATH) || [];
    var newStaple = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      item: req.body.item || "",
      quantity: req.body.quantity || 1,
      note: req.body.note || "",
      productName: req.body.productName || "",
      brand: req.body.brand || "",
      price: req.body.price || "",
      image: req.body.image || "",
    };
    if (!newStaple.item) return res.json({ error: "item is required" });
    // Auto-enrich with Woodmans product data if missing
    if (!newStaple.image || !newStaple.price) {
      var product = await lookupProduct(newStaple.item);
      if (product) {
        if (!newStaple.price && product.price) newStaple.price = product.price;
        if (!newStaple.image && product.image) newStaple.image = product.image;
        if (!newStaple.productName && product.name) newStaple.productName = product.name;
      }
    }
    staples.push(newStaple);
    writeJSON(STAPLES_PATH, staples);
    res.json({ ok: true, staple: newStaple });
  });

  app.patch("/api/staples/:id", function (req, res) {
    var staples = readJSON(STAPLES_PATH) || [];
    var staple = staples.find(function (s) { return s.id === req.params.id; });
    if (!staple) return res.json({ error: "Staple not found" });
    if (req.body.quantity !== undefined) staple.quantity = req.body.quantity;
    if (req.body.item !== undefined) staple.item = req.body.item;
    if (req.body.note !== undefined) staple.note = req.body.note;
    writeJSON(STAPLES_PATH, staples);
    res.json({ ok: true, staple: staple });
  });

  app.delete("/api/staples/:id", function (req, res) {
    var staples = readJSON(STAPLES_PATH) || [];
    staples = staples.filter(function (s) { return s.id !== req.params.id; });
    writeJSON(STAPLES_PATH, staples);
    res.json({ ok: true });
  });

  // Recipes
  app.get("/api/recipes", function (req, res) {
    res.json(readJSON(RECIPES_PATH) || []);
  });

  app.get("/api/recipes/active", function (req, res) {
    var recipes = readJSON(RECIPES_PATH) || [];
    var active = recipes.filter(function (r) { return r.enabled; }).map(function (r) {
      return { id: r.id, name: r.name, items: r.items || [] };
    });
    res.json(active);
  });

  app.post("/api/recipes", function (req, res) {
    writeJSON(RECIPES_PATH, req.body);
    res.json({ ok: true });
  });

  // Get combined internal shopping cart (staples + enabled recipes + manual items)
  app.get("/api/cart", function (req, res) {
    var staplesData = readJSON(STAPLES_PATH) || [];
    var recipesData = readJSON(RECIPES_PATH) || [];
    var manualData = readJSON(MANUAL_ITEMS_PATH) || [];
    var items = [];
    var estimate = 0;
    for (var i = 0; i < staplesData.length; i++) {
      var s = staplesData[i];
      var sp = parseFloat(String(s.price || "").replace("$", "")) || 0;
      items.push({ id: "staple-" + s.id, item: s.item, quantity: s.quantity || 1, price: s.price || "", source: "staple" });
      if (sp > 0) estimate += sp * (s.quantity || 1);
    }
    for (var j = 0; j < recipesData.length; j++) {
      var r = recipesData[j];
      if (!r.enabled) continue;
      for (var k = 0; k < (r.items || []).length; k++) {
        var ri = r.items[k];
        var rp = parseFloat(String(ri.price || "").replace("$", "")) || 0;
        items.push({ id: "recipe-" + r.id + "-" + (ri.item || ""), item: ri.item, quantity: ri.quantity || 1, price: ri.price || "", source: r.name });
        if (rp > 0) estimate += rp * (ri.quantity || 1);
      }
    }
    for (var m = 0; m < manualData.length; m++) {
      var mi = manualData[m];
      var mp = parseFloat(String(mi.price || "").replace("$", "")) || 0;
      items.push({ id: "manual-" + mi.id, item: mi.item, quantity: mi.quantity || 1, price: mi.price || "", source: "manual" });
      if (mp > 0) estimate += mp * (mi.quantity || 1);
    }
    res.json({ items: items, itemCount: items.length, estimatedTotal: "$" + estimate.toFixed(2) });
  });

  // Manual cart items
  app.get("/api/cart/manual", function (req, res) {
    res.json(readJSON(MANUAL_ITEMS_PATH) || []);
  });

  app.post("/api/cart/manual/add", function (req, res) {
    var items = readJSON(MANUAL_ITEMS_PATH) || [];
    var newItem = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      item: req.body.item || "",
      quantity: req.body.quantity || 1,
      price: req.body.price || "",
      image: req.body.image || "",
    };
    items.push(newItem);
    writeJSON(MANUAL_ITEMS_PATH, items);
    broadcast({ type: "manual-items-update", items: items });
    res.json(newItem);
  });

  app.delete("/api/cart/manual/:id", function (req, res) {
    var items = readJSON(MANUAL_ITEMS_PATH) || [];
    items = items.filter(function (m) { return m.id !== req.params.id; });
    writeJSON(MANUAL_ITEMS_PATH, items);
    broadcast({ type: "manual-items-update", items: items });
    res.json({ ok: true });
  });

  app.post("/api/cart/manual/clear", function (req, res) {
    writeJSON(MANUAL_ITEMS_PATH, []);
    broadcast({ type: "manual-items-update", items: [] });
    res.json({ ok: true });
  });

  app.patch("/api/cart/manual/:id", function (req, res) {
    var items = readJSON(MANUAL_ITEMS_PATH) || [];
    var item = items.find(function (m) { return m.id === req.params.id; });
    if (!item) return res.json({ error: "Item not found" });
    if (req.body.quantity !== undefined) item.quantity = req.body.quantity;
    if (req.body.item !== undefined) item.item = req.body.item;
    writeJSON(MANUAL_ITEMS_PATH, items);
    broadcast({ type: "manual-items-update", items: items });
    res.json(item);
  });

  // Product search
  app.get("/api/products/search", async function (req, res) {
    const query = req.query.q;
    if (!query) return res.json({ error: "No query provided" });

    const currentSettings = readJSON(SETTINGS_PATH) || {};
    var fastWorker = require("./cart-worker-fast");
    try {
      var session = await fastWorker.getFastSession(currentSettings, sendProgress);
      var results = await fastWorker.searchProducts(query, session);
      return res.json(results);
    } catch (err) {
      return res.json({ error: err.message });
    }
  });

  // Cart automation
  let cartWorkerInstance = null;

  app.post("/api/cart/start", async function (req, res) {
    var body = req.body || {};
    var clientSettings = body.settings || {};
    var items = body.items;

    // If no items provided, build from internal cart (staples + enabled recipes + manual items)
    if (!items || items.length === 0) {
      var staplesData = readJSON(STAPLES_PATH) || [];
      var recipesData = readJSON(RECIPES_PATH) || [];
      var manualData = readJSON(MANUAL_ITEMS_PATH) || [];
      items = [];
      for (var si = 0; si < staplesData.length; si++) {
        var s = staplesData[si];
        items.push({ id: "staple-" + s.id, item: s.item, productName: s.productName || "", quantity: s.quantity || 1, note: s.note || "" });
      }
      for (var ri = 0; ri < recipesData.length; ri++) {
        var r = recipesData[ri];
        if (!r.enabled) continue;
        for (var rj = 0; rj < (r.items || []).length; rj++) {
          var rItem = r.items[rj];
          items.push({ id: "recipe-" + r.id + "-" + (rItem.item || ""), item: rItem.item, productName: rItem.productName || "", quantity: rItem.quantity || 1, note: rItem.note || "" });
        }
      }
      for (var mi = 0; mi < manualData.length; mi++) {
        var m = manualData[mi];
        items.push({ id: "manual-" + m.id, item: m.item, quantity: m.quantity || 1 });
      }
    }

    if (items.length === 0) {
      return res.json({ error: "No items in cart. Add staples, enable recipes, or add manual items first." });
    }

    const serverSettings = readJSON(SETTINGS_PATH) || {};
    const mergedSettings = Object.assign({}, serverSettings, {
      shoppingMode: clientSettings.shoppingMode || serverSettings.shoppingMode,
      delayBetweenItems: clientSettings.delayBetweenItems || serverSettings.delayBetweenItems,
    });
    const shoppingMode = mergedSettings.shoppingMode || "instore";

    var fastWorker = require("./cart-worker-fast");
    try {
      var session = await fastWorker.getFastSession(mergedSettings, sendProgress);
      cartWorkerInstance = { active: true };
      await fastWorker.ensureShoppingMode(session, shoppingMode, sendProgress);

      var fastResult = await fastWorker.searchAndAddAll(
        session, items, sendProgress,
        function (itemDoneData) { sendItemDone(itemDoneData); },
        function () { return !cartWorkerInstance; }
      );

      var ok = fastResult.results.filter(function (r) { return r.status === "ok"; }).length;
      var failed = fastResult.results.filter(function (r) { return r.status === "fail"; }).length;
      var skipped = fastResult.results.filter(function (r) { return r.status === "skip"; }).length;
      sendProgress("Done! Added: " + ok + ", Failed: " + failed + ", Skipped: " + skipped);

      // Refresh the online cart after adding items — use cart items from the add response first
      if (ok > 0) {
        if (fastResult.cartItems && fastResult.cartItems.length > 0) {
          sendOnlineUpdate(fastResult.cartItems);
          sendProgress("Online cart updated (" + fastResult.cartItems.length + " items).");
        } else {
          try {
            sendProgress("Fetching updated Woodmans cart...");
            var cartItems = await fastWorker.fetchCart(session, sendProgress);
            if (cartItems && Array.isArray(cartItems) && cartItems.length > 0) {
              sendOnlineUpdate(cartItems);
              sendProgress("Online cart updated (" + cartItems.length + " items).");
            }
          } catch (fetchErr) {
            sendProgress("Could not fetch online cart: " + fetchErr.message);
          }
        }
      }

      cartWorkerInstance = null;
      return res.json({ ok: ok, failed: failed, skipped: skipped, results: fastResult.results });
    } catch (err) {
      sendProgress("Error: " + err.message);
      cartWorkerInstance = null;
      return res.json({ ok: 0, failed: 0, skipped: 0, error: err.message });
    }
  });

  app.post("/api/cart/stop", function (req, res) {
    if (cartWorkerInstance) {
      cartWorkerInstance = null;
      sendProgress("Cart automation stopped.");
    }
    res.json({ ok: true });
  });

  // Fetch current online cart
  app.post("/api/cart/fetch", async function (req, res) {
    var currentSettings = readJSON(SETTINGS_PATH) || {};
    var mode = (req.body && req.body.shoppingMode) || currentSettings.shoppingMode || "instore";
    var fastWorker = require("./cart-worker-fast");
    try {
      var session = await fastWorker.getFastSession(currentSettings, sendProgress);
      await fastWorker.ensureShoppingMode(session, mode, sendProgress);
      var items = await fastWorker.fetchCart(session, sendProgress);
      return res.json(items);
    } catch (err) {
      return res.json({ error: err.message });
    }
  });

  // Add item to the internal shopping cart (manual items list)
  // Auto-searches Woodmans for image and price if not provided
  app.post("/api/cart/add", async function (req, res) {
    var itemName = req.body && req.body.item;
    var quantity = (req.body && req.body.quantity) || 1;
    if (!itemName) return res.json({ error: "item is required (product name)" });
    var items = readJSON(MANUAL_ITEMS_PATH) || [];
    var newItem = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      item: itemName,
      quantity: quantity,
      price: req.body.price || "",
      image: req.body.image || "",
    };
    // Auto-enrich with Woodmans product data if missing image/price
    if (!newItem.image || !newItem.price) {
      var product = await lookupProduct(itemName);
      if (product) {
        if (!newItem.price && product.price) newItem.price = product.price;
        if (!newItem.image && product.image) newItem.image = product.image;
        if (product.name) newItem.item = product.name; // Use exact Woodmans name
      }
    }
    items.push(newItem);
    writeJSON(MANUAL_ITEMS_PATH, items);
    broadcast({ type: "manual-items-update", items: items });
    res.json({ ok: true, item: newItem });
  });

  // Remove a single item from the online cart by itemId
  app.post("/api/cart/remove", async function (req, res) {
    var currentSettings = readJSON(SETTINGS_PATH) || {};
    var mode = (req.body && req.body.shoppingMode) || currentSettings.shoppingMode || "instore";
    var itemId = req.body && req.body.itemId;
    if (!itemId) return res.json({ error: "itemId is required" });
    var fastWorker = require("./cart-worker-fast");
    try {
      var session = await fastWorker.getFastSession(currentSettings, sendProgress);
      await fastWorker.ensureShoppingMode(session, mode, sendProgress);
      var result = await fastWorker.removeCartItem(session, itemId, sendProgress);
      return res.json(result);
    } catch (err) {
      return res.json({ error: err.message });
    }
  });

  // Remove all online cart items
  app.post("/api/cart/remove-all", async function (req, res) {
    var currentSettings = readJSON(SETTINGS_PATH) || {};
    var mode = (req.body && req.body.shoppingMode) || currentSettings.shoppingMode || "instore";
    var fastWorker = require("./cart-worker-fast");
    try {
      var session = await fastWorker.getFastSession(currentSettings, sendProgress);
      await fastWorker.ensureShoppingMode(session, mode, sendProgress);
      var result = await fastWorker.removeAllCartItems(session, sendProgress);
      return res.json(result);
    } catch (err) {
      return res.json({ error: err.message });
    }
  });

  // Copy cart between shopping modes
  app.post("/api/cart/copy", async function (req, res) {
    var { fromMode, toMode, clearSource } = req.body;
    if (!fromMode || !toMode || fromMode === toMode) return res.json({ error: "Invalid mode parameters" });
    if (!["instore", "pickup"].includes(fromMode) || !["instore", "pickup"].includes(toMode)) return res.json({ error: "Mode must be 'instore' or 'pickup'" });

    var currentSettings = readJSON(SETTINGS_PATH) || {};
    var fastWorker = require("./cart-worker-fast");
    try {
      var session = await fastWorker.getFastSession(currentSettings, sendProgress);
      var result = await fastWorker.copyCart(session, fromMode, toMode, !!clearSource, sendProgress);
      // Fetch destination cart for UI update
      var cartItems = await fastWorker.fetchCart(session, sendProgress);
      if (cartItems && Array.isArray(cartItems)) sendOnlineUpdate(cartItems);
      return res.json(result);
    } catch (err) {
      sendProgress("Error: " + err.message);
      return res.json({ error: err.message });
    }
  });

  // Recipe image search (web) — search DuckDuckGo images, download & cache
  app.post("/api/recipe/image", async function (req, res) {
    const { recipeId, recipeName } = req.body;
    if (!recipeId || !recipeName) {
      return res.json({ error: "Missing recipeId or recipeName" });
    }

    const httpsModule = require("https");
    const httpModule = require("http");
    const imgDir = path.join(__dirname, "data", "recipe-images");
    fs.mkdirSync(imgDir, { recursive: true });

    // Helper: HTTP(S) GET returning a Buffer, follows redirects
    var browserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    function httpGet(url, maxRedirects) {
      if (maxRedirects === undefined) maxRedirects = 5;
      return new Promise(function (resolve, reject) {
        if (maxRedirects <= 0) return reject(new Error("Too many redirects"));
        var mod = url.startsWith("https") ? httpsModule : httpModule;
        var headers = { "User-Agent": browserUA, "Accept": "image/*,*/*;q=0.8" };
        var req = mod.get(url, { headers: headers, timeout: 15000 }, function (resp) {
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            var next = resp.headers.location;
            if (next.startsWith("/")) {
              var parsed = new URL(url);
              next = parsed.protocol + "//" + parsed.host + next;
            }
            resolve(httpGet(next, maxRedirects - 1));
            return;
          }
          if (resp.statusCode !== 200) {
            resp.resume();
            return reject(new Error("HTTP " + resp.statusCode));
          }
          var chunks = [];
          resp.on("data", function (c) { chunks.push(c); });
          resp.on("end", function () { resolve(Buffer.concat(chunks)); });
          resp.on("error", reject);
        });
        req.on("error", reject);
        req.on("timeout", function () { req.destroy(); reject(new Error("Timeout")); });
      });
    }

    var query = recipeName + " recipe";

    try {
      // Step 1: Search Bing Images for recipe photos
      var bingUrl = "https://www.bing.com/images/search?q=" + encodeURIComponent(query) + "&form=HDRSC3&first=1";
      var pageData = await httpGet(bingUrl);
      var pageStr = pageData.toString("utf-8");

      // Extract image URLs from Bing results (embedded as escaped JSON murl fields)
      var urlMatches = pageStr.match(/murl&quot;:&quot;(https?:\/\/[^&]+?)&quot;/g) || [];
      var imageUrls = urlMatches.map(function (m) {
        return m.replace(/^murl&quot;:&quot;/, "").replace(/&quot;$/, "");
      });

      if (imageUrls.length === 0) {
        return res.json({ error: "No images found" });
      }

      // Step 2: Try downloading until one works
      var imageData = null;
      for (var i = 0; i < Math.min(imageUrls.length, 10); i++) {
        try {
          imageData = await httpGet(imageUrls[i]);
          if (imageData && imageData.length > 5000) break;
          imageData = null;
        } catch (e) {
          imageData = null;
        }
      }

      if (!imageData) {
        return res.json({ error: "Could not download any image" });
      }

      // Detect extension from content (JPEG starts with FFD8, PNG with 8950)
      var ext = "jpg";
      if (imageData[0] === 0x89 && imageData[1] === 0x50) ext = "png";
      else if (imageData[0] === 0x52 && imageData[1] === 0x49) ext = "webp";

      var imgPath = path.join(imgDir, recipeId + "." + ext);
      fs.writeFileSync(imgPath, imageData);

      var imageUrl = "/data/recipe-images/" + recipeId + "." + ext;
      res.json({ ok: true, imageUrl: imageUrl });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // Delete recipe image
  app.post("/api/recipe/image/delete", function (req, res) {
    const { recipeId } = req.body;
    if (!recipeId) return res.json({ ok: true });

    const imgPath = path.join(__dirname, "data", "recipe-images", recipeId + ".png");
    try {
      if (fs.existsSync(imgPath)) {
        fs.unlinkSync(imgPath);
      }
    } catch (e) {
      // ignore cleanup errors
    }
    res.json({ ok: true });
  });

  // Checkout preview (fetch cart + service options — NEVER places order)
  app.post("/api/checkout/preview", async function (req, res) {
    var currentSettings = readJSON(SETTINGS_PATH) || {};
    var mode = (req.body && req.body.shoppingMode) || currentSettings.shoppingMode || "instore";
    var fastWorker = require("./cart-worker-fast");
    try {
      var session = await fastWorker.getFastSession(currentSettings, sendProgress);
      await fastWorker.ensureShoppingMode(session, mode, sendProgress);
      var preview = await fastWorker.fetchCheckoutPreview(session, mode, sendProgress);
      return res.json(preview);
    } catch (err) {
      return res.json({ error: err.message });
    }
  });

  // Fetch pickup/delivery time slots
  app.post("/api/checkout/timeslots", async function (req, res) {
    var currentSettings = readJSON(SETTINGS_PATH) || {};
    var mode = (req.body && req.body.shoppingMode) || currentSettings.shoppingMode || "instore";
    var fastWorker = require("./cart-worker-fast");
    try {
      var session = await fastWorker.getFastSession(currentSettings, sendProgress);
      await fastWorker.ensureShoppingMode(session, mode, sendProgress);
      await fastWorker.ensureCheckoutServiceType(session, mode, sendProgress);
      // Use pickup_options for pickup mode, delivery_options for delivery
      var options = mode === "pickup"
        ? await fastWorker.fetchPickupOptions(session, sendProgress)
        : await fastWorker.fetchDeliveryOptions(session, sendProgress);
      if (!options) {
        // API returned non-200 — fall back to service chooser summary
        var serviceChooser = await fastWorker.fetchServiceChooser(session, sendProgress);
        return res.json({ _pickupFromServiceChooser: true, serviceChooser: serviceChooser });
      }
      var svcOptions = options?.service_options || options;
      var days = svcOptions?.days || [];
      if (days.length === 0) {
        // API returned OK but no slots — pass through the error_module text if present
        var errorMsg = svcOptions?.error_module?.title || null;
        var serviceChooser2 = await fastWorker.fetchServiceChooser(session, sendProgress);
        return res.json({ _pickupFromServiceChooser: true, serviceChooser: serviceChooser2, _errorMsg: errorMsg });
      }
      return res.json(svcOptions);
    } catch (err) {
      return res.json({ error: err.message });
    }
  });

  // Select a pickup/delivery time slot
  app.post("/api/checkout/select-timeslot", async function (req, res) {
    var currentSettings = readJSON(SETTINGS_PATH) || {};
    var mode = (req.body && req.body.shoppingMode) || currentSettings.shoppingMode || "instore";
    var optionId = req.body && req.body.optionId;
    if (!optionId) return res.json({ error: "No optionId provided" });
    var fastWorker = require("./cart-worker-fast");
    try {
      var session = await fastWorker.getFastSession(currentSettings, sendProgress);
      await fastWorker.ensureShoppingMode(session, mode, sendProgress);
      await fastWorker.ensureCheckoutServiceType(session, mode, sendProgress);
      var result = await fastWorker.selectDeliveryOption(session, optionId, sendProgress);
      return res.json({ ok: true, result: result });
    } catch (err) {
      return res.json({ error: err.message });
    }
  });

  // Place order (ACTUALLY charges and creates the order)
  app.post("/api/checkout/place-order", async function (req, res) {
    var currentSettings = readJSON(SETTINGS_PATH) || {};
    var mode = (req.body && req.body.shoppingMode) || currentSettings.shoppingMode || "instore";
    var slotId = req.body && req.body.slotId;
    if (!slotId) return res.json({ error: "No time slot selected" });
    var fastWorker = require("./cart-worker-fast");
    try {
      var session = await fastWorker.getFastSession(currentSettings, sendProgress);
      await fastWorker.ensureShoppingMode(session, mode, sendProgress);
      await fastWorker.ensureCheckoutServiceType(session, mode, sendProgress);
      var result = await fastWorker.placeOrder(session, mode, slotId, currentSettings, sendProgress);
      return res.json({ ok: true, result: result });
    } catch (err) {
      // Retry once with fresh session on any failure
      sendProgress("Order failed (" + err.message + "), retrying with fresh session...");
      fastWorker.closeFastSession();
      try {
        var session2 = await fastWorker.getFastSession(currentSettings, sendProgress);
        await fastWorker.ensureShoppingMode(session2, mode, sendProgress);
        await fastWorker.ensureCheckoutServiceType(session2, mode, sendProgress);
        var result2 = await fastWorker.placeOrder(session2, mode, slotId, currentSettings, sendProgress);
        return res.json({ ok: true, result: result2 });
      } catch (err2) {
        return res.json({ error: err2.message });
      }
    }
  });

  // Get current shopping mode
  app.get("/api/shopping-mode", function (req, res) {
    var currentSettings = readJSON(SETTINGS_PATH) || {};
    return res.json({ shoppingMode: currentSettings.shoppingMode || "instore" });
  });

  // Switch shopping mode (pickup or instore)
  app.post("/api/shopping-mode", function (req, res) {
    var mode = req.body && req.body.shoppingMode;
    if (mode !== "pickup" && mode !== "instore") {
      return res.json({ error: "shoppingMode must be 'pickup' or 'instore'" });
    }
    var currentSettings = readJSON(SETTINGS_PATH) || {};
    currentSettings.shoppingMode = mode;
    writeJSON(SETTINGS_PATH, currentSettings);
    return res.json({ ok: true, shoppingMode: mode });
  });

  // Fetch service chooser (delivery vs pickup options)
  app.post("/api/checkout/service-options", async function (req, res) {
    var currentSettings = readJSON(SETTINGS_PATH) || {};
    var fastWorker = require("./cart-worker-fast");
    try {
      var session = await fastWorker.getFastSession(currentSettings, sendProgress);
      var options = await fastWorker.fetchServiceChooser(session, sendProgress);
      return res.json(options);
    } catch (err) {
      return res.json({ error: err.message });
    }
  });

  // Collect local network addresses
  const os = require("os");
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        addresses.push("http://" + iface.address + ":" + PORT);
      }
    }
  }

  // Start listening
  server.listen(PORT, "0.0.0.0", function () {
    console.log("Web server running on port " + PORT);
    addresses.forEach(function (addr) { console.log("  " + addr); });
  });

  return { server, wss, broadcast, sendProgress, sendItemDone, sendOnlineUpdate, port: PORT, addresses: addresses };
}

module.exports = { startServer };
