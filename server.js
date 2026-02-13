// server.js — Express + WebSocket server for web clients

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const fs = require("fs");

const PORT = 3456;

function startServer(deps) {
  const { readJSON, writeJSON, SETTINGS_PATH, STAPLES_PATH, RECIPES_PATH } = deps;

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

  // --- REST API endpoints ---

  // Settings
  app.get("/api/settings", function (req, res) {
    const settings = readJSON(SETTINGS_PATH) || {};
    // Omit sensitive fields for web clients
    const safe = Object.assign({}, settings);
    delete safe.password;
    delete safe.anthropicApiKey;
    res.json(safe);
  });

  app.post("/api/settings", function (req, res) {
    const current = readJSON(SETTINGS_PATH) || {};
    const incoming = req.body;
    // Merge: keep existing password/apiKey if not provided
    if (!incoming.password && current.password) {
      incoming.password = current.password;
    }
    if (!incoming.anthropicApiKey && current.anthropicApiKey) {
      incoming.anthropicApiKey = current.anthropicApiKey;
    }
    writeJSON(SETTINGS_PATH, incoming);
    res.json({ ok: true });
  });

  // Staples
  app.get("/api/staples", function (req, res) {
    res.json(readJSON(STAPLES_PATH) || []);
  });

  app.post("/api/staples", function (req, res) {
    writeJSON(STAPLES_PATH, req.body);
    res.json({ ok: true });
  });

  // Recipes
  app.get("/api/recipes", function (req, res) {
    res.json(readJSON(RECIPES_PATH) || []);
  });

  app.post("/api/recipes", function (req, res) {
    writeJSON(RECIPES_PATH, req.body);
    res.json({ ok: true });
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
    const { items, settings: clientSettings } = req.body;
    const serverSettings = readJSON(SETTINGS_PATH) || {};
    // Use server-side credentials, but allow client to override non-sensitive fields
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
    var fastWorker = require("./cart-worker-fast");
    try {
      var session = await fastWorker.getFastSession(currentSettings, sendProgress);
      await fastWorker.ensureShoppingMode(session, currentSettings.shoppingMode || "instore", sendProgress);
      var items = await fastWorker.fetchCart(session, sendProgress);
      return res.json(items);
    } catch (err) {
      return res.json({ error: err.message });
    }
  });

  // Remove all online cart items
  app.post("/api/cart/remove-all", async function (req, res) {
    var currentSettings = readJSON(SETTINGS_PATH) || {};
    var fastWorker = require("./cart-worker-fast");
    try {
      var session = await fastWorker.getFastSession(currentSettings, sendProgress);
      await fastWorker.ensureShoppingMode(session, currentSettings.shoppingMode || "instore", sendProgress);
      var result = await fastWorker.removeAllCartItems(session, sendProgress);
      return res.json(result);
    } catch (err) {
      return res.json({ error: err.message });
    }
  });

  // AI recipe generation
  app.post("/api/recipe/generate", async function (req, res) {
    const { prompt, servings, glutenFree, dairyFree, preferOrganic, pickyEater } = req.body;
    const currentSettings = readJSON(SETTINGS_PATH) || {};
    const apiKey = currentSettings.anthropicApiKey;

    if (!apiKey) {
      return res.json({ error: "No Claude API key configured. Add it in Settings." });
    }

    const httpsModule = require("https");

    var dietaryRules = "";
    if (glutenFree) {
      dietaryRules += '\n- GLUTEN FREE REQUIRED: Every ingredient must be gluten free. For items that commonly contain gluten (pasta, flour, bread, soy sauce, breadcrumbs, etc.), ALWAYS include "gluten free" in the search term (e.g. "gluten free pasta", "gluten free soy sauce", "gluten free flour"). Only use naturally gluten-free ingredients or certified gluten-free products.';
    }
    if (dairyFree) {
      dietaryRules += '\n- DAIRY FREE REQUIRED: No milk, butter, cheese, cream, yogurt, or any dairy products. Use dairy-free alternatives and include "dairy free" in search terms (e.g. "dairy free butter", "dairy free shredded cheese", "oat milk", "coconut cream").';
    }
    if (preferOrganic) {
      dietaryRules += '\n- PREFER ORGANIC: Include "organic" in search terms when possible (e.g. "organic chicken breast", "organic baby spinach", "organic diced tomatoes"). This helps the store search show organic options first.';
    }
    if (pickyEater) {
      dietaryRules += '\n- PICKY EATER FRIENDLY: Stick to familiar, crowd-pleasing ingredients. Avoid unusual spices, exotic vegetables, strong flavors (anchovies, blue cheese, liver, etc.), overly spicy food, or adventurous textures. Keep it simple and approachable — the kind of food even a selective eater would enjoy.';
    }

    const systemPrompt = 'You are a recipe assistant for a grocery shopping app. Generate a recipe with a list of ingredients that can be found at a grocery store called Woodman\'s. The "item" field is used as a SEARCH QUERY on the store\'s website to find and add products to a cart.\n\nReturn ONLY valid JSON in this exact format, no other text:\n{\n  "name": "Recipe Name",\n  "servings": 4,\n  "instructions": ["Step 1...", "Step 2..."],\n  "items": [\n    {"item": "search term for store website", "quantity": 1, "note": "size or detail"}\n  ]\n}\n\nRules:\n- "servings" is the number of servings the recipe makes\n- "instructions" is an array of step-by-step cooking instructions. Be concise but complete.\n- "item" is a SEARCH QUERY typed into the store\'s search bar. Use names a shopper would type to find the exact product, e.g. "boneless skinless chicken thighs" not "chicken" or "2 lbs chicken thighs"\n- Do NOT put amounts, measurements, or cooking units in the "item" field (no "2 cups flour", no "1 lb ground beef"). Put only the product name.\n- "quantity" is how many times to ADD this item to the cart. Each add gives you one store unit (1 can, 1 bag, 1 bunch, 1 individual fruit/vegetable, etc.). If the recipe needs 2 tomatoes, quantity is 2. If it needs 2 cans of diced tomatoes, quantity is 2. If it needs 2 cups of flour, quantity is still 1 because one bag of flour is enough. Think about what the shopper actually needs to put in their cart.\n- Use the "note" field for the recipe amount, size preference, or preparation details (e.g. "need 2 cups", "1 lb", "diced")\n- Be specific with product names (e.g. "sharp cheddar cheese block" not just "cheese")\n- Skip pantry staples most people already have (salt, black pepper, olive oil, water) unless the recipe uses an unusual amount' + dietaryRules;

    const userMessage = "Generate a recipe for: " + prompt + "\nServings: " + servings;

    const body = JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    try {
      const result = await new Promise(function (resolve, reject) {
        const reqObj = httpsModule.request(
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
          function (apiRes) {
            let data = "";
            apiRes.on("data", function (chunk) { data += chunk; });
            apiRes.on("end", function () {
              try {
                const parsed = JSON.parse(data);
                if (parsed.error) {
                  reject(new Error(parsed.error.message || "API error"));
                  return;
                }
                const text = (parsed.content && parsed.content[0] && parsed.content[0].text) || "";
                resolve(text);
              } catch (e) {
                reject(new Error("Failed to parse API response"));
              }
            });
          }
        );
        reqObj.on("error", reject);
        reqObj.write(body);
        reqObj.end();
      });

      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return res.json({ error: "Could not parse recipe from AI response." });
      }

      const recipe = JSON.parse(jsonMatch[0]);
      res.json(recipe);
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // AI recipe suggestions
  app.post("/api/recipe/suggest", async function (req, res) {
    const { prompt, glutenFree, dairyFree, preferOrganic, pickyEater } = req.body;
    const currentSettings = readJSON(SETTINGS_PATH) || {};
    const apiKey = currentSettings.anthropicApiKey;

    if (!apiKey) {
      return res.json({ error: "No Claude API key configured. Add it in Settings." });
    }

    const httpsModule = require("https");

    var dietaryNote = "";
    var flags = [];
    if (glutenFree) flags.push("gluten-free");
    if (dairyFree) flags.push("dairy-free");
    if (preferOrganic) flags.push("organic-preferred");
    if (pickyEater) flags.push("picky-eater-friendly (simple, familiar, crowd-pleasing ingredients only)");
    if (flags.length > 0) {
      dietaryNote = "\nDietary requirements: " + flags.join(", ") + ". All suggestions must respect these constraints.";
    }

    var userContent;
    if (prompt) {
      userContent = 'The user wants to make: "' + prompt + '". Suggest 4 specific recipe variations based on this. For example, if they said "pizza", suggest things like "Classic Pepperoni Pizza", "BBQ Chicken Flatbread", "Margherita Pizza", "Supreme Meat Lovers Pizza". Return a JSON array of objects with "name" (specific recipe title, 2-5 words) and "description" (one short enticing sentence, max 12 words).' + dietaryNote;
    } else {
      userContent = "Suggest 6 diverse dinner recipe ideas. Mix cuisines and styles (e.g. comfort food, healthy, quick weeknight, slow-cooked, international). Return a JSON array of objects with \"name\" (recipe title, 2-5 words) and \"description\" (one short enticing sentence, max 12 words)." + dietaryNote;
    }

    const body = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: "You suggest dinner recipe ideas. Return ONLY valid JSON, no other text.",
      messages: [{
        role: "user",
        content: userContent
      }],
    });

    try {
      const result = await new Promise(function (resolve, reject) {
        const reqObj = httpsModule.request(
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
          function (apiRes) {
            let data = "";
            apiRes.on("data", function (chunk) { data += chunk; });
            apiRes.on("end", function () {
              try {
                const parsed = JSON.parse(data);
                if (parsed.error) {
                  reject(new Error(parsed.error.message || "API error"));
                  return;
                }
                const text = (parsed.content && parsed.content[0] && parsed.content[0].text) || "";
                resolve(text);
              } catch (e) {
                reject(new Error("Failed to parse API response"));
              }
            });
          }
        );
        reqObj.on("error", reject);
        reqObj.write(body);
        reqObj.end();
      });

      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return res.json({ error: "Could not parse suggestions from AI response." });
      }

      const suggestions = JSON.parse(jsonMatch[0]);
      res.json({ suggestions: suggestions });
    } catch (err) {
      res.json({ error: err.message });
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
