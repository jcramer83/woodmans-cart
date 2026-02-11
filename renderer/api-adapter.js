// api-adapter.js — Environment-aware API layer
// In Electron: proxies to window.api (IPC)
// In browser:  uses fetch() + WebSocket

(function () {
  const isElectron = !!window.api;

  if (isElectron) {
    // Electron — just use the existing preload bridge
    window.appApi = window.api;
    return;
  }

  // --- Web browser mode ---

  // WebSocket connection with auto-reconnect
  let ws = null;
  let wsReady = false;
  const wsListeners = { progress: [], itemDone: [], onlineUpdate: [] };

  function connectWebSocket() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = function () {
      wsReady = true;
    };

    ws.onmessage = function (event) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "progress") {
          wsListeners.progress.forEach(function (cb) { cb(msg.message); });
        } else if (msg.type === "item-done") {
          wsListeners.itemDone.forEach(function (cb) { cb(msg.data); });
        } else if (msg.type === "online-update") {
          wsListeners.onlineUpdate.forEach(function (cb) { cb(msg.items); });
        }
      } catch (e) {
        // ignore parse errors
      }
    };

    ws.onclose = function () {
      wsReady = false;
      // Auto-reconnect after 3 seconds
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = function () {
      ws.close();
    };
  }

  connectWebSocket();

  async function apiGet(path) {
    const res = await fetch(path);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  window.appApi = {
    // Settings
    loadSettings: function () { return apiGet("/api/settings"); },
    saveSettings: function (settings) { return apiPost("/api/settings", settings); },

    // Staples
    loadStaples: function () { return apiGet("/api/staples"); },
    saveStaples: function (staples) { return apiPost("/api/staples", staples); },

    // Recipes
    loadRecipes: function () { return apiGet("/api/recipes"); },
    saveRecipes: function (recipes) { return apiPost("/api/recipes", recipes); },

    // Cart automation
    startCart: function (data) { return apiPost("/api/cart/start", data); },
    stopCart: function () { return apiPost("/api/cart/stop"); },

    // Product search
    searchProducts: function (query) { return apiGet("/api/products/search?q=" + encodeURIComponent(query)); },

    // AI recipe generation
    generateRecipe: function (data) { return apiPost("/api/recipe/generate", data); },

    // Fetch current online cart
    fetchCurrentCart: function () { return apiPost("/api/cart/fetch"); },

    // Remove all items from online cart
    removeAllCartItems: function () { return apiPost("/api/cart/remove-all"); },

    // Server info (not needed in web — already on the web)
    serverInfo: function () { return Promise.resolve(null); },

    // Open URL in new tab (web browser)
    openExternal: function (url) { window.open(url, "_blank"); return Promise.resolve(); },

    // Progress listener
    onCartProgress: function (callback) {
      wsListeners.progress.push(callback);
      return function () {
        var idx = wsListeners.progress.indexOf(callback);
        if (idx !== -1) wsListeners.progress.splice(idx, 1);
      };
    },

    // Per-item completion listener
    onCartItemDone: function (callback) {
      wsListeners.itemDone.push(callback);
      return function () {
        var idx = wsListeners.itemDone.indexOf(callback);
        if (idx !== -1) wsListeners.itemDone.splice(idx, 1);
      };
    },

    // Online cart update listener
    onOnlineCartUpdate: function (callback) {
      wsListeners.onlineUpdate.push(callback);
      return function () {
        var idx = wsListeners.onlineUpdate.indexOf(callback);
        if (idx !== -1) wsListeners.onlineUpdate.splice(idx, 1);
      };
    },
  };
})();
