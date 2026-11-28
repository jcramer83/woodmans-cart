// api-adapter.js — Web API layer using fetch() + WebSocket

(function () {
  // WebSocket connection with auto-reconnect
  let ws = null;
  let wsReady = false;
  const wsListeners = { progress: [], itemDone: [], onlineUpdate: [], manualItemsUpdate: [] };

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
        } else if (msg.type === "manual-items-update") {
          wsListeners.manualItemsUpdate.forEach(function (cb) { cb(msg.items); });
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
    try {
      const res = await fetch(path);
      return res.json();
    } catch (e) {
      throw new Error("Connection lost — check that the server is running");
    }
  }

  async function apiPost(path, body) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(function () {
      if (controller) controller.abort();
    }, 4 * 60 * 1000);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body == null ? {} : body),
        signal: controller ? controller.signal : undefined,
      });
      return res.json();
    } catch (e) {
      if (e && e.name === "AbortError") {
        const err = new Error("Send timed out — check your cart");
        err.timedOut = true;
        throw err;
      }
      throw new Error("Connection lost — check that the server is running");
    } finally {
      clearTimeout(timer);
    }
  }

  window.appApi = {
    // Settings
    loadSettings: function () { return apiGet("/api/settings"); },
    saveSettings: function (settings) { return apiPost("/api/settings", settings); },

    // Staples
    loadStaples: function () { return apiGet("/api/staples"); },
    saveStaples: function (staples) { return apiPost("/api/staples", staples); },

    // Cart automation
    startCart: function (data) { return apiPost("/api/cart/start", data); },
    stopCart: function () { return apiPost("/api/cart/stop"); },

    // Product search
    searchProducts: function (query) { return apiGet("/api/products/search?q=" + encodeURIComponent(query)); },

    // Fetch current online cart
    fetchCurrentCart: function (mode) { return apiPost("/api/cart/fetch", { shoppingMode: mode }); },

    // Remove items from online cart
    removeOnlineCartItem: function (itemId, mode) { return apiPost("/api/cart/remove", { itemId: itemId, shoppingMode: mode }); },
    removeAllCartItems: function (mode) { return apiPost("/api/cart/remove-all", { shoppingMode: mode }); },

    // Copy cart between shopping modes
    copyCart: function (data) { return apiPost("/api/cart/copy", data); },

    // Manual cart items
    loadManualItems: function () { return apiGet("/api/cart/manual"); },
    addManualItem: function (item) { return apiPost("/api/cart/manual/add", item); },
    removeManualItem: function (id) { return fetch("/api/cart/manual/" + id, { method: "DELETE" }).then(function (r) { return r.json(); }); },
    updateManualItem: function (id, data) { return fetch("/api/cart/manual/" + id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(function (r) { return r.json(); }); },
    clearManualItems: function () { return apiPost("/api/cart/manual/clear"); },

    // Checkout (read-only — never places orders)
    fetchCheckoutPreview: function (mode) { return apiPost("/api/checkout/preview", { shoppingMode: mode }); },
    fetchTimeSlots: function (mode) { return apiPost("/api/checkout/timeslots", { shoppingMode: mode }); },
    fetchServiceOptions: function () { return apiPost("/api/checkout/service-options"); },
    selectTimeSlot: function (optionId, mode) { return apiPost("/api/checkout/select-timeslot", { optionId: optionId, shoppingMode: mode }); },
    placeOrder: function (mode, slotId) { return apiPost("/api/checkout/place-order", { shoppingMode: mode, slotId: slotId }); },

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

    // Manual items update listener (from other clients / API)
    onManualItemsUpdate: function (callback) {
      wsListeners.manualItemsUpdate.push(callback);
      return function () {
        var idx = wsListeners.manualItemsUpdate.indexOf(callback);
        if (idx !== -1) wsListeners.manualItemsUpdate.splice(idx, 1);
      };
    },

    // In-store shopping list, trip timer, and history
    getStoreLayout: function () { return apiGet("/api/store-layout"); },
    saveStoreLayout: function (layout) { return apiPost("/api/store-layout", layout); },
    prepareShoppingList: function (items) { return apiPost("/api/shopping/prepare", { items: items }); },
    getActiveTrip: function () { return apiGet("/api/shopping/active"); },
    startShopping: function () { return apiPost("/api/shopping/start", {}); },
    setShoppingCheck: function (itemId, checked) { return apiPost("/api/shopping/check", { itemId: itemId, checked: checked }); },
    endShopping: function () { return apiPost("/api/shopping/end", {}); },
    getShoppingHistory: function () { return apiGet("/api/shopping/history"); },

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
