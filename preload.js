const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Settings
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),

  // Staples
  loadStaples: () => ipcRenderer.invoke("staples:load"),
  saveStaples: (staples) => ipcRenderer.invoke("staples:save", staples),

  // Recipes
  loadRecipes: () => ipcRenderer.invoke("recipes:load"),
  saveRecipes: (recipes) => ipcRenderer.invoke("recipes:save", recipes),

  // Cart automation
  startCart: (data) => ipcRenderer.invoke("cart:start", data),
  stopCart: () => ipcRenderer.invoke("cart:stop"),

  // Product search
  searchProducts: (query) => ipcRenderer.invoke("product:search", query),

  // AI recipe generation
  generateRecipe: (data) => ipcRenderer.invoke("recipe:generate", data),

  // Fetch current online cart
  fetchCurrentCart: () => ipcRenderer.invoke("cart:fetch"),

  // Remove all items from online cart
  removeAllCartItems: () => ipcRenderer.invoke("cart:remove-all"),

  // Server info (port, addresses)
  serverInfo: () => ipcRenderer.invoke("server:info"),

  // Open URL in default browser (Chrome etc.)
  openExternal: (url) => ipcRenderer.invoke("open-external", url),

  // Progress listener
  onCartProgress: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("cart:progress", listener);
    return () => ipcRenderer.removeListener("cart:progress", listener);
  },

  // Per-item completion listener (sent as each item is added)
  onCartItemDone: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("cart:item-done", listener);
    return () => ipcRenderer.removeListener("cart:item-done", listener);
  },

  // Online cart update listener (sent after cart automation completes)
  onOnlineCartUpdate: (callback) => {
    const listener = (_event, items) => callback(items);
    ipcRenderer.on("cart:online-update", listener);
    return () => ipcRenderer.removeListener("cart:online-update", listener);
  },
});
