// server-standalone.js — Standalone entry point for Docker (no Electron)
// Provides the same deps to server.js that main.js does, with env var overlay.

const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const STAPLES_PATH = path.join(DATA_DIR, "staples.json");
const RECIPES_PATH = path.join(DATA_DIR, "recipes.json");

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
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    // Overlay environment variables onto settings
    if (filePath === SETTINGS_PATH) {
      if (process.env.WOODMANS_USERNAME) data.username = process.env.WOODMANS_USERNAME;
      if (process.env.WOODMANS_PASSWORD) data.password = process.env.WOODMANS_PASSWORD;
      if (process.env.ANTHROPIC_API_KEY) data.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
      if (process.env.ZIP_CODE) data.zipCode = process.env.ZIP_CODE;
      if (process.env.STORE_URL) data.storeUrl = process.env.STORE_URL;
      if (process.env.SHOPPING_MODE) data.shoppingMode = process.env.SHOPPING_MODE;
      // Default to fast mode in standalone/Docker (no Playwright available)
      if (data.fastMode === undefined) data.fastMode = true;
      if (process.env.FAST_MODE !== undefined) data.fastMode = process.env.FAST_MODE !== "false";
    }
    return data;
  } catch {
    return null;
  }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// --- Start ---

ensureDataFiles();

const { startServer } = require("./server");

startServer({
  readJSON,
  writeJSON,
  SETTINGS_PATH,
  STAPLES_PATH,
  RECIPES_PATH,
  sendProgressToElectron: function (message) {
    console.log("[progress]", message);
  },
  getMainWindow: function () {
    return null;
  },
});

console.log("Woodmans Cart standalone server starting...");
