// --- State ---
let staples = [];
let recipes = [];
let manualItems = [];
let settings = {};
let editingStapleId = null;
let editingRecipeId = null;
let recipeItemsDraft = [];
let excludedCartIds = new Set();
let cartRunning = false;
let removeProgressListener = null;
let cartItemResults = {}; // { itemId: "ok"|"fail"|"skip" } — tracks per-item status during automation

// --- Activity bar helpers ---

function showActivity(barId, statusId, message) {
  const bar = document.getElementById(barId);
  const status = document.getElementById(statusId);
  if (bar) bar.classList.add("active");
  if (status) {
    status.textContent = message || "";
    status.className = "activity-status active";
  }
}

function hideActivity(barId, statusId, message, type) {
  const bar = document.getElementById(barId);
  const status = document.getElementById(statusId);
  if (bar) bar.classList.remove("active");
  if (status) {
    if (message) {
      status.textContent = message;
      status.className = "activity-status active" + (type ? " " + type : "");
      // Auto-clear success messages after 5s
      if (type === "success") {
        setTimeout(() => {
          status.className = "activity-status";
          status.textContent = "";
        }, 5000);
      }
    } else {
      status.className = "activity-status";
      status.textContent = "";
    }
  }
}

function updateProgressLogVisibility() {
  const show = settings.showProgressLog !== false;
  const logs = document.querySelectorAll(".progress-log");
  logs.forEach((el) => { el.style.display = show ? "" : "none"; });
}

// --- Init ---

document.addEventListener("DOMContentLoaded", init);

async function init() {
  settings = (await appApi.loadSettings()) || {};
  staples = (await appApi.loadStaples()) || [];
  recipes = (await appApi.loadRecipes()) || [];

  // Exclude all staples from cart on launch — user clicks "Add All to Cart" to include them
  for (const s of staples) {
    excludedCartIds.add("staple-" + s.id);
  }

  initDarkMode();
  renderStaples();
  renderRecipes();
  renderCart();
  updateModeBadge();
  updateProgressLogVisibility();
  bindEvents();

  // Listen for online cart updates pushed after automation completes
  appApi.onOnlineCartUpdate((items) => {
    renderOnlineCart(items);
  });

  // Show server status bar (desktop Electron only)
  try {
    const info = await appApi.serverInfo();
    if (info && info.addresses && info.addresses.length > 0) {
      const bar = document.getElementById("server-bar");
      const link = document.getElementById("server-url");
      if (bar && link) {
        const url = info.addresses[0];
        link.href = "#";
        link.textContent = url;
        link.onclick = function (e) { e.preventDefault(); openExternalUrl(url); };
        bar.style.display = "flex";
      }
    }
  } catch (e) {
    // Not available — web client or server not running
  }
}

// --- Event binding ---

function bindEvents() {
  // Settings
  document.getElementById("btn-settings").addEventListener("click", openSettingsModal);
  document.getElementById("btn-save-settings").addEventListener("click", saveSettings);

  // Staples
  document.getElementById("btn-add-staple").addEventListener("click", () => openStapleModal(null));
  document.getElementById("btn-add-all-staples").addEventListener("click", addAllStaplesToCart);

  // Recipes
  document.getElementById("btn-add-recipe").addEventListener("click", () => openRecipeModal(null));

  // Staple modal - product search
  document.getElementById("btn-find-product").addEventListener("click", toggleProductSearch);
  document.getElementById("btn-product-search-go").addEventListener("click", doProductSearch);
  document.getElementById("btn-save-staple").addEventListener("click", saveStaple);

  // Recipe modal
  document.getElementById("btn-add-recipe-item").addEventListener("click", addRecipeItemRow);
  document.getElementById("btn-save-recipe").addEventListener("click", saveRecipe);

  // AI recipe
  document.getElementById("btn-ai-recipe").addEventListener("click", openAiRecipeModal);
  document.getElementById("btn-ai-generate").addEventListener("click", generateAiRecipe);
  document.getElementById("ai-recipe-prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter") generateAiRecipe();
  });

  // Recipe item modal - product search
  document.getElementById("btn-recipe-item-find").addEventListener("click", toggleRecipeItemSearch);
  document.getElementById("btn-recipe-item-search-go").addEventListener("click", doRecipeItemSearch);
  document.getElementById("btn-save-recipe-item").addEventListener("click", saveRecipeItem);
  document.getElementById("recipe-item-search-query").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doRecipeItemSearch();
  });

  // Online cart viewer
  document.getElementById("btn-import-cart").addEventListener("click", fetchOnlineCart);
  document.getElementById("btn-remove-all-online").addEventListener("click", removeAllOnlineCartItems);

  // Clear cart
  document.getElementById("btn-clear-cart").addEventListener("click", clearCart);

  // Manual cart add
  document.getElementById("btn-manual-add").addEventListener("click", addManualItem);
  document.getElementById("manual-item-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addManualItem();
  });
  document.getElementById("btn-manual-search").addEventListener("click", toggleManualSearch);
  document.getElementById("btn-manual-search-go").addEventListener("click", doManualSearch);
  document.getElementById("manual-search-query").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doManualSearch();
  });

  // Cart automation
  document.getElementById("btn-start-cart").addEventListener("click", startCartAutomation);
  document.getElementById("btn-stop-cart").addEventListener("click", stopCartAutomation);

  // Modal close buttons
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const modalId = btn.getAttribute("data-close");
      document.getElementById(modalId).style.display = "none";
    });
  });

  // Make modals draggable by their header
  document.querySelectorAll(".modal").forEach((modal) => {
    const header = modal.querySelector(".modal-header");
    if (!header) return;
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    header.addEventListener("mousedown", (e) => {
      if (e.target.closest(".btn-close")) return;
      isDragging = true;
      const rect = modal.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      // Switch to fixed positioning on first drag
      if (!modal.style.left) {
        modal.style.position = "fixed";
        modal.style.left = rect.left + "px";
        modal.style.top = rect.top + "px";
      }
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      modal.style.position = "fixed";
      modal.style.left = (e.clientX - offsetX) + "px";
      modal.style.top = (e.clientY - offsetY) + "px";
    });

    document.addEventListener("mouseup", () => {
      isDragging = false;
    });
  });

  // Reset modal position when opened so it starts centered
  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    const observer = new MutationObserver(() => {
      if (overlay.style.display === "flex") {
        const modal = overlay.querySelector(".modal");
        if (modal) {
          modal.style.position = "";
          modal.style.left = "";
          modal.style.top = "";
        }
      }
    });
    observer.observe(overlay, { attributes: true, attributeFilter: ["style"] });
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll(".modal-overlay").forEach((m) => (m.style.display = "none"));
    }
  });

  // Enter to submit in product search
  document.getElementById("product-search-query").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doProductSearch();
  });
}

// --- Settings ---

function openSettingsModal() {
  document.getElementById("setting-username").value = settings.username || "";
  document.getElementById("setting-password").value = settings.password || "";
  document.getElementById("setting-zip").value = settings.zipCode || "53177";
  document.getElementById("setting-shopping-mode").value = settings.shoppingMode || "instore";
  document.getElementById("setting-store-url").value = settings.storeUrl || "https://shopwoodmans.com";
  document.getElementById("setting-delay").value = settings.delayBetweenItems || 3000;
  document.getElementById("setting-api-key").value = settings.anthropicApiKey || "";
  document.getElementById("setting-show-log").checked = settings.showProgressLog !== false;
  document.getElementById("modal-settings").style.display = "flex";
}

async function saveSettings() {
  const oldMode = settings.shoppingMode || "instore";
  settings.username = document.getElementById("setting-username").value.trim();
  settings.password = document.getElementById("setting-password").value;
  settings.zipCode = document.getElementById("setting-zip").value.trim() || "53177";
  settings.shoppingMode = document.getElementById("setting-shopping-mode").value || "instore";
  settings.storeUrl = document.getElementById("setting-store-url").value.trim() || "https://shopwoodmans.com";
  settings.delayBetweenItems = parseInt(document.getElementById("setting-delay").value) || 3000;
  settings.anthropicApiKey = document.getElementById("setting-api-key").value.trim();
  settings.showProgressLog = document.getElementById("setting-show-log").checked;
  await appApi.saveSettings(settings);
  updateModeBadge();
  updateProgressLogVisibility();
  // If mode changed, clear stale online cart display
  if (settings.shoppingMode !== oldMode) {
    renderOnlineCart([]);
  }
  document.getElementById("modal-settings").style.display = "none";
}

function updateModeBadge() {
  const mode = settings.shoppingMode || "instore";
  const label = mode === "pickup" ? "Pickup" : "In-Store";
  const badge = document.getElementById("shopping-mode-badge");
  if (badge) badge.textContent = label;
}

async function toggleShoppingMode() {
  const oldMode = settings.shoppingMode || "instore";
  settings.shoppingMode = oldMode === "pickup" ? "instore" : "pickup";
  await appApi.saveSettings(settings);
  updateModeBadge();
  // Clear stale online cart since mode changed
  renderOnlineCart([]);
}

// --- Dark Mode ---

function toggleDarkMode() {
  const isDark = document.body.classList.toggle("dark");
  localStorage.setItem("darkMode", isDark ? "1" : "0");
  const btn = document.getElementById("btn-dark-mode");
  if (btn) btn.title = isDark ? "Switch to light mode" : "Switch to dark mode";
}

function initDarkMode() {
  if (localStorage.getItem("darkMode") === "1") {
    document.body.classList.add("dark");
  }
}

// --- Staples ---

function renderStaples() {
  const list = document.getElementById("staples-list");
  if (staples.length === 0) {
    list.innerHTML = '<p class="empty-state">No staples yet. Click "+ Add" to get started.</p>';
    return;
  }

  list.innerHTML = staples
    .map(
      (s) => `
    <div class="item-row" data-id="${s.id}">
      <div class="item-info">
        <div class="item-name">${esc(s.item)}</div>
        <div class="item-detail">${esc(s.productName || "")}${s.brand ? " - " + esc(s.brand) : ""}${s.note ? " (" + esc(s.note) + ")" : ""}</div>
      </div>
      <span class="item-qty">x${s.quantity || 1}</span>
      <div class="item-actions">
        <button onclick="openStapleModal('${s.id}')" title="Edit">&#9998;</button>
        <button class="btn-del" onclick="deleteStaple('${s.id}')" title="Delete">&#10005;</button>
      </div>
    </div>`
    )
    .join("");
}

function openStapleModal(id) {
  editingStapleId = id;
  const staple = id ? staples.find((s) => s.id === id) : null;

  document.getElementById("staple-modal-title").textContent = staple ? "Edit Staple" : "Add Staple";
  document.getElementById("staple-item").value = staple ? staple.item : "";
  document.getElementById("staple-quantity").value = staple ? staple.quantity || 1 : 1;
  document.getElementById("staple-note").value = staple ? staple.note || "" : "";
  document.getElementById("staple-product-name").value = staple ? staple.productName || "" : "";
  document.getElementById("staple-brand").value = staple ? staple.brand || "" : "";
  document.getElementById("staple-price").value = staple ? staple.price || "" : "";
  document.getElementById("product-search-area").style.display = "none";
  document.getElementById("product-search-results").innerHTML =
    '<p class="empty-state">Enter a search term and click Search.</p>';

  document.getElementById("modal-staple").style.display = "flex";
  document.getElementById("staple-item").focus();
}

async function saveStaple() {
  const item = document.getElementById("staple-item").value.trim();
  if (!item) return;

  const data = {
    item,
    quantity: parseInt(document.getElementById("staple-quantity").value) || 1,
    note: document.getElementById("staple-note").value.trim(),
    productName: document.getElementById("staple-product-name").value.trim(),
    brand: document.getElementById("staple-brand").value.trim(),
    price: document.getElementById("staple-price").value.trim(),
  };

  if (editingStapleId) {
    const idx = staples.findIndex((s) => s.id === editingStapleId);
    if (idx !== -1) {
      staples[idx] = { ...staples[idx], ...data };
    }
  } else {
    data.id = generateId();
    staples.push(data);
  }

  await appApi.saveStaples(staples);
  renderStaples();
  renderCart();
  document.getElementById("modal-staple").style.display = "none";
}

async function deleteStaple(id) {
  if (!confirm("Delete this staple item?")) return;
  staples = staples.filter((s) => s.id !== id);
  await appApi.saveStaples(staples);
  renderStaples();
  renderCart();
}

function addAllStaplesToCart() {
  // Re-add any excluded staple items back into the cart
  for (const s of staples) {
    excludedCartIds.delete("staple-" + s.id);
  }
  renderCart();
}

// --- Product search ---

function toggleProductSearch() {
  const area = document.getElementById("product-search-area");
  area.style.display = area.style.display === "none" ? "block" : "none";
  if (area.style.display === "block") {
    const itemName = document.getElementById("staple-item").value.trim();
    document.getElementById("product-search-query").value = itemName;
    document.getElementById("product-search-query").focus();
  }
}

async function doProductSearch() {
  const query = document.getElementById("product-search-query").value.trim();
  if (!query) return;

  const resultsDiv = document.getElementById("product-search-results");
  resultsDiv.innerHTML = '<p class="empty-state">Searching...</p>';
  document.getElementById("btn-product-search-go").disabled = true;
  showActivity("cart-activity", "cart-activity-status", "Searching Woodmans for \"" + query + "\"...");

  try {
    const products = await appApi.searchProducts(query);

    if (products.error) {
      resultsDiv.innerHTML = `<p class="empty-state">Error: ${esc(products.error)}</p>`;
      hideActivity("cart-activity", "cart-activity-status", "Search failed: " + products.error, "error");
      return;
    }

    if (!products || products.length === 0) {
      resultsDiv.innerHTML = '<p class="empty-state">No products found. Try a different search term.</p>';
      hideActivity("cart-activity", "cart-activity-status", "No products found", "error");
      return;
    }

    resultsDiv.innerHTML = products
      .map(
        (p, i) => `
      <div class="product-result-row" onclick="selectProduct(${i})">
        <div class="product-result-name">${esc(p.name)}</div>
        <div class="product-result-meta">${esc(p.price)}${p.size ? " - " + esc(p.size) : ""}</div>
      </div>`
      )
      .join("");

    window._productSearchResults = products;
    hideActivity("cart-activity", "cart-activity-status", "Found " + products.length + " products", "success");
  } catch (err) {
    resultsDiv.innerHTML = `<p class="empty-state">Error: ${esc(err.message)}</p>`;
    hideActivity("cart-activity", "cart-activity-status", "Search error: " + err.message, "error");
  } finally {
    document.getElementById("btn-product-search-go").disabled = false;
  }
}

function selectProduct(index) {
  const products = window._productSearchResults;
  if (!products || !products[index]) return;

  const p = products[index];
  document.getElementById("staple-product-name").value = p.name;
  document.getElementById("staple-price").value = p.price || "";
  // Auto-fill item name with product name if empty
  const itemNameField = document.getElementById("staple-item");
  if (!itemNameField.value.trim()) {
    itemNameField.value = p.name;
  }
  document.getElementById("product-search-area").style.display = "none";
}

// --- Recipes ---

function renderRecipes() {
  const list = document.getElementById("recipes-list");
  if (recipes.length === 0) {
    list.innerHTML = '<p class="empty-state">No recipes yet. Click "+ Add" to create one.</p>';
    return;
  }

  list.innerHTML = recipes
    .map(
      (r) => `
    <div class="item-row" data-id="${r.id}">
      <label class="toggle">
        <input type="checkbox" ${r.enabled ? "checked" : ""} onchange="toggleRecipe('${r.id}', this.checked)" />
        <span class="toggle-slider"></span>
      </label>
      <div class="item-info">
        <div class="item-name">${esc(r.name)}</div>
        <div class="item-detail">${(r.items || []).length} item${(r.items || []).length !== 1 ? "s" : ""}</div>
      </div>
      <div class="item-actions">
        <button onclick="openRecipeModal('${r.id}')" title="Edit">&#9998;</button>
        <button class="btn-del" onclick="deleteRecipe('${r.id}')" title="Delete">&#10005;</button>
      </div>
    </div>`
    )
    .join("");
}

async function toggleRecipe(id, enabled) {
  const recipe = recipes.find((r) => r.id === id);
  if (recipe) {
    recipe.enabled = enabled;
    // Clear exclusions for this recipe's items so they reappear in cart
    if (enabled) {
      for (const item of recipe.items || []) {
        excludedCartIds.delete("recipe-" + id + "-" + (item.item || ""));
      }
    }
    await appApi.saveRecipes(recipes);
    renderCart();
  }
}

function openRecipeModal(id) {
  editingRecipeId = id;
  const recipe = id ? recipes.find((r) => r.id === id) : null;

  document.getElementById("recipe-modal-title").textContent = recipe ? "Edit Recipe" : "Add Recipe";
  document.getElementById("recipe-name").value = recipe ? recipe.name : "";

  recipeItemsDraft = recipe ? JSON.parse(JSON.stringify(recipe.items || [])) : [];
  renderRecipeItems();

  document.getElementById("modal-recipe").style.display = "flex";
  document.getElementById("recipe-name").focus();
}

function renderRecipeItems() {
  const list = document.getElementById("recipe-items-list");
  if (recipeItemsDraft.length === 0) {
    list.innerHTML = '<p class="empty-state">No ingredients yet. Click "+ Add Item".</p>';
    return;
  }

  list.innerHTML = recipeItemsDraft
    .map(
      (item, i) => `
    <div class="item-row">
      <div class="item-info">
        <div class="item-name">${esc(item.item || "(unnamed)")}</div>
        <div class="item-detail">${esc(item.productName || "")}${item.note ? " (" + esc(item.note) + ")" : ""}</div>
      </div>
      <span class="item-qty">x${item.quantity || 1}</span>
      <div class="item-actions">
        <button onclick="openRecipeItemModal(${i})" title="Edit">&#9998;</button>
        <button class="btn-del" onclick="removeRecipeItem(${i})" title="Remove">&#10005;</button>
      </div>
    </div>`
    )
    .join("");
}

let editingRecipeItemIndex = null;

function addRecipeItemRow() {
  openRecipeItemModal(-1);
}

function openRecipeItemModal(index) {
  editingRecipeItemIndex = index;
  const item = index >= 0 ? recipeItemsDraft[index] : null;

  document.getElementById("recipe-item-modal-title").textContent = item ? "Edit Ingredient" : "Add Ingredient";
  document.getElementById("recipe-item-name").value = item ? item.item || "" : "";
  document.getElementById("recipe-item-quantity").value = item ? item.quantity || 1 : 1;
  document.getElementById("recipe-item-note").value = item ? item.note || "" : "";
  document.getElementById("recipe-item-product-name").value = item ? item.productName || "" : "";
  document.getElementById("recipe-item-search-area").style.display = "none";
  document.getElementById("recipe-item-search-results").innerHTML =
    '<p class="empty-state">Enter a search term and click Search.</p>';

  window._recipeItemSelectedPrice = item ? item.price || "" : "";
  document.getElementById("modal-recipe-item").style.display = "flex";
  document.getElementById("recipe-item-name").focus();
}

function saveRecipeItem() {
  const name = document.getElementById("recipe-item-name").value.trim();
  const productName = document.getElementById("recipe-item-product-name").value.trim();
  if (!name && !productName) return;

  const data = {
    item: name || productName,
    quantity: parseInt(document.getElementById("recipe-item-quantity").value) || 1,
    note: document.getElementById("recipe-item-note").value.trim(),
    productName: productName,
    price: window._recipeItemSelectedPrice || "",
  };

  if (editingRecipeItemIndex >= 0) {
    recipeItemsDraft[editingRecipeItemIndex] = data;
  } else {
    recipeItemsDraft.push(data);
  }

  renderRecipeItems();
  document.getElementById("modal-recipe-item").style.display = "none";
}

function toggleRecipeItemSearch() {
  const area = document.getElementById("recipe-item-search-area");
  area.style.display = area.style.display === "none" ? "block" : "none";
  if (area.style.display === "block") {
    const itemName = document.getElementById("recipe-item-name").value.trim();
    document.getElementById("recipe-item-search-query").value = itemName;
    document.getElementById("recipe-item-search-query").focus();
  }
}

async function doRecipeItemSearch() {
  const query = document.getElementById("recipe-item-search-query").value.trim();
  if (!query) return;

  const resultsDiv = document.getElementById("recipe-item-search-results");
  resultsDiv.innerHTML = '<p class="empty-state">Searching...</p>';
  document.getElementById("btn-recipe-item-search-go").disabled = true;
  showActivity("cart-activity", "cart-activity-status", "Searching Woodmans for \"" + query + "\"...");

  try {
    const products = await appApi.searchProducts(query);

    if (products.error) {
      resultsDiv.innerHTML = `<p class="empty-state">Error: ${esc(products.error)}</p>`;
      hideActivity("cart-activity", "cart-activity-status", "Search failed: " + products.error, "error");
      return;
    }

    if (!products || products.length === 0) {
      resultsDiv.innerHTML = '<p class="empty-state">No products found. Try a different search term.</p>';
      hideActivity("cart-activity", "cart-activity-status", "No products found", "error");
      return;
    }

    resultsDiv.innerHTML = products
      .map(
        (p, i) => `
      <div class="product-result-row" onclick="selectRecipeItemProduct(${i})">
        <div class="product-result-name">${esc(p.name)}</div>
        <div class="product-result-meta">${esc(p.price)}${p.size ? " - " + esc(p.size) : ""}</div>
      </div>`
      )
      .join("");

    window._recipeItemSearchResults = products;
    hideActivity("cart-activity", "cart-activity-status", "Found " + products.length + " products", "success");
  } catch (err) {
    resultsDiv.innerHTML = `<p class="empty-state">Error: ${esc(err.message)}</p>`;
    hideActivity("cart-activity", "cart-activity-status", "Search error: " + err.message, "error");
  } finally {
    document.getElementById("btn-recipe-item-search-go").disabled = false;
  }
}

function selectRecipeItemProduct(index) {
  const products = window._recipeItemSearchResults;
  if (!products || !products[index]) return;

  const p = products[index];
  document.getElementById("recipe-item-product-name").value = p.name;
  window._recipeItemSelectedPrice = p.price || "";
  const nameField = document.getElementById("recipe-item-name");
  if (!nameField.value.trim()) {
    nameField.value = p.name;
  }
  document.getElementById("recipe-item-search-area").style.display = "none";
}

function updateRecipeItem(index, field, value) {
  if (recipeItemsDraft[index]) {
    recipeItemsDraft[index][field] = value;
  }
}

function removeRecipeItem(index) {
  recipeItemsDraft.splice(index, 1);
  renderRecipeItems();
}

async function saveRecipe() {
  const name = document.getElementById("recipe-name").value.trim();
  if (!name) return;

  // Filter out empty items
  const items = recipeItemsDraft.filter((item) => item.item && item.item.trim());

  if (editingRecipeId) {
    const idx = recipes.findIndex((r) => r.id === editingRecipeId);
    if (idx !== -1) {
      recipes[idx].name = name;
      recipes[idx].items = items;
    }
  } else {
    recipes.push({
      id: generateId(),
      name,
      enabled: true,
      items,
    });
  }

  await appApi.saveRecipes(recipes);
  renderRecipes();
  renderCart();
  document.getElementById("modal-recipe").style.display = "none";
}

async function deleteRecipe(id) {
  if (!confirm("Delete this recipe?")) return;
  recipes = recipes.filter((r) => r.id !== id);
  await appApi.saveRecipes(recipes);
  renderRecipes();
  renderCart();
}

// --- AI Recipe Generation ---

function openAiRecipeModal() {
  document.getElementById("ai-recipe-prompt").value = "";
  document.getElementById("ai-recipe-servings").value = "4";
  document.getElementById("ai-recipe-status").style.display = "none";
  document.getElementById("btn-ai-generate").disabled = false;
  document.getElementById("modal-ai-recipe").style.display = "flex";
  document.getElementById("ai-recipe-prompt").focus();
  // Preserve checkbox state across opens (user preference)
}

async function generateAiRecipe() {
  const prompt = document.getElementById("ai-recipe-prompt").value.trim();
  if (!prompt) return;

  const servings = parseInt(document.getElementById("ai-recipe-servings").value) || 4;
  const glutenFree = document.getElementById("ai-gluten-free").checked;
  const dairyFree = document.getElementById("ai-dairy-free").checked;
  const preferOrganic = document.getElementById("ai-prefer-organic").checked;
  const statusEl = document.getElementById("ai-recipe-status");
  const btn = document.getElementById("btn-ai-generate");

  statusEl.style.display = "block";
  statusEl.textContent = "Generating recipe with Claude AI...";
  statusEl.className = "ai-status loading";
  btn.disabled = true;

  try {
    const result = await appApi.generateRecipe({ prompt, servings, glutenFree, dairyFree, preferOrganic });

    if (result.error) {
      statusEl.textContent = "Error: " + result.error;
      statusEl.className = "ai-status error";
      btn.disabled = false;
      return;
    }

    // Add the recipe
    const recipe = {
      id: generateId(),
      name: result.name || prompt,
      enabled: true,
      items: (result.items || []).map((item) => ({
        item: item.item || "",
        quantity: item.quantity || 1,
        note: item.note || "",
        productName: "",
        price: "",
      })),
    };

    recipes.push(recipe);
    await appApi.saveRecipes(recipes);
    renderRecipes();
    renderCart();

    statusEl.textContent = `Added "${recipe.name}" with ${recipe.items.length} ingredients!`;
    statusEl.className = "ai-status success";

    // Close after a brief delay
    setTimeout(() => {
      document.getElementById("modal-ai-recipe").style.display = "none";
    }, 1500);
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.className = "ai-status error";
  } finally {
    btn.disabled = false;
  }
}

// --- Combined Cart ---

function getCartItems() {
  const items = [];

  // Staples
  for (const s of staples) {
    items.push({
      id: "staple-" + s.id,
      item: s.item,
      productName: s.productName,
      quantity: s.quantity || 1,
      note: s.note,
      price: s.price || "",
      source: "staple",
    });
  }

  // Enabled recipe items
  for (const r of recipes) {
    if (!r.enabled) continue;
    for (const item of r.items || []) {
      items.push({
        id: "recipe-" + r.id + "-" + (item.item || ""),
        item: item.item,
        productName: item.productName,
        quantity: item.quantity || 1,
        note: item.note,
        price: item.price || "",
        source: r.name,
      });
    }
  }

  // Manual items
  for (const m of manualItems) {
    items.push({
      id: "manual-" + m.id,
      item: m.item,
      quantity: m.quantity || 1,
      note: "",
      price: m.price || "",
      source: "manual",
    });
  }

  return items;
}

function renderCart() {
  const items = getCartItems().filter((item) => !excludedCartIds.has(item.id));
  const list = document.getElementById("cart-list");
  const countEl = document.getElementById("cart-count");
  const estEl = document.getElementById("cart-estimate");

  countEl.textContent = items.length;

  // Calculate estimated cost
  let total = 0;
  let hasEstimate = false;
  for (const item of items) {
    const price = parsePrice(item.price);
    if (price > 0) {
      total += price;
      hasEstimate = true;
    }
  }
  estEl.textContent = hasEstimate ? `Est. $${total.toFixed(2)}` : "";

  if (items.length === 0) {
    list.innerHTML = '<p class="empty-state">Cart is empty. Add staples or enable recipes to populate.</p>';
    return;
  }

  list.innerHTML = items
    .map(
      (item) => {
        const status = cartItemResults[item.id];
        const rowClass = status === "fail" ? " item-failed" : status === "skip" ? " item-skipped" : status === "ok" ? " item-ok" : "";
        const badge = status === "fail" ? '<span class="item-status-badge badge-failed">FAILED</span>'
          : status === "skip" ? '<span class="item-status-badge badge-skipped">SKIPPED</span>'
          : status === "ok" ? '<span class="item-status-badge badge-ok">Added</span>'
          : "";
        return `
    <div class="item-row${rowClass}">
      <div class="item-info">
        <div class="item-name">${esc(item.item)}</div>
        <div class="item-detail">${item.note ? esc(item.note) : ""}${item.price ? " - " + esc(item.price) : ""}</div>
      </div>
      ${cartRunning ? `<span class="item-qty">x${item.quantity}</span>` : `<div class="item-qty-controls"><button class="qty-btn" onclick="changeCartQty('${item.id}', -1)" title="Decrease">&#8722;</button><span class="item-qty-val">${item.quantity}</span><button class="qty-btn" onclick="changeCartQty('${item.id}', 1)" title="Increase">&#43;</button></div>`}
      ${badge}
      <span class="item-source">${esc(item.source)}</span>
      ${cartRunning ? "" : `<div class="item-actions"><button class="btn-del" onclick="removeCartItem('${item.id}')" title="Remove">&#10005;</button></div>`}
    </div>`;
      }
    )
    .join("");

  // Lock/unlock manual add row and staple/recipe controls
  const manualRow = document.querySelector(".manual-add-row");
  const manualSearch = document.getElementById("manual-search-area");
  if (manualRow) manualRow.style.display = cartRunning ? "none" : "flex";
  if (manualSearch && cartRunning) manualSearch.style.display = "none";
  document.getElementById("btn-clear-cart").style.display = cartRunning ? "none" : "inline-flex";
  document.getElementById("btn-add-all-staples").disabled = cartRunning;
  document.getElementById("btn-add-staple").disabled = cartRunning;
  document.getElementById("btn-add-recipe").disabled = cartRunning;
}

function addManualItem() {
  const nameInput = document.getElementById("manual-item-name");
  const qtyInput = document.getElementById("manual-item-qty");
  const name = nameInput.value.trim();
  if (!name) return;

  manualItems.push({
    id: generateId(),
    item: name,
    quantity: parseInt(qtyInput.value) || 1,
    price: window._manualSelectedPrice || "",
  });

  nameInput.value = "";
  qtyInput.value = "1";
  window._manualSelectedPrice = "";
  renderCart();
  nameInput.focus();
}

function removeManualItem(id) {
  const realId = id.replace("manual-", "");
  manualItems = manualItems.filter((m) => m.id !== realId);
  renderCart();
}

function clearCart() {
  const items = getCartItems();
  for (const item of items) {
    if (item.id.startsWith("manual-")) {
      continue; // handled below
    }
    excludedCartIds.add(item.id);
  }
  manualItems = [];
  renderCart();
}

function removeCartItem(id) {
  if (id.startsWith("manual-")) {
    removeManualItem(id);
  } else {
    excludedCartIds.add(id);
    renderCart();
  }
}

function changeCartQty(id, delta) {
  if (id.startsWith("staple-")) {
    const realId = id.replace("staple-", "");
    const s = staples.find((x) => x.id === realId);
    if (s) {
      s.quantity = Math.max(1, (s.quantity || 1) + delta);
      appApi.saveStaples(staples);
      renderStaples();
      renderCart();
    }
  } else if (id.startsWith("recipe-")) {
    // id format: recipe-{recipeId}-{itemName}
    const parts = id.replace("recipe-", "").split("-");
    const recipeId = parts[0];
    const itemName = parts.slice(1).join("-");
    const r = recipes.find((x) => x.id === recipeId);
    if (r) {
      const item = (r.items || []).find((x) => x.item === itemName);
      if (item) {
        item.quantity = Math.max(1, (item.quantity || 1) + delta);
        appApi.saveRecipes(recipes);
        renderRecipes();
        renderCart();
      }
    }
  } else if (id.startsWith("manual-")) {
    const realId = id.replace("manual-", "");
    const m = manualItems.find((x) => x.id === realId);
    if (m) {
      m.quantity = Math.max(1, (m.quantity || 1) + delta);
      renderCart();
    }
  }
}

// --- Manual item product search ---

function toggleManualSearch() {
  const area = document.getElementById("manual-search-area");
  area.style.display = area.style.display === "none" ? "block" : "none";
  if (area.style.display === "block") {
    const itemName = document.getElementById("manual-item-name").value.trim();
    document.getElementById("manual-search-query").value = itemName;
    document.getElementById("manual-search-query").focus();
  }
}

async function doManualSearch() {
  const query = document.getElementById("manual-search-query").value.trim();
  if (!query) return;

  const resultsDiv = document.getElementById("manual-search-results");
  resultsDiv.innerHTML = '<p class="empty-state">Searching...</p>';
  document.getElementById("btn-manual-search-go").disabled = true;
  showActivity("cart-activity", "cart-activity-status", "Searching Woodmans for \"" + query + "\"...");

  try {
    const products = await appApi.searchProducts(query);

    if (products.error) {
      resultsDiv.innerHTML = `<p class="empty-state">Error: ${esc(products.error)}</p>`;
      hideActivity("cart-activity", "cart-activity-status", "Search failed: " + products.error, "error");
      return;
    }

    if (!products || products.length === 0) {
      resultsDiv.innerHTML = '<p class="empty-state">No products found. Try a different search term.</p>';
      hideActivity("cart-activity", "cart-activity-status", "No products found", "error");
      return;
    }

    resultsDiv.innerHTML = products
      .map(
        (p, i) => `
      <div class="product-result-row" onclick="selectManualProduct(${i})">
        <div class="product-result-name">${esc(p.name)}</div>
        <div class="product-result-meta">${esc(p.price)}${p.size ? " - " + esc(p.size) : ""}</div>
      </div>`
      )
      .join("");

    window._manualSearchResults = products;
    hideActivity("cart-activity", "cart-activity-status", "Found " + products.length + " products", "success");
  } catch (err) {
    resultsDiv.innerHTML = `<p class="empty-state">Error: ${esc(err.message)}</p>`;
    hideActivity("cart-activity", "cart-activity-status", "Search error: " + err.message, "error");
  } finally {
    document.getElementById("btn-manual-search-go").disabled = false;
  }
}

function selectManualProduct(index) {
  const products = window._manualSearchResults;
  if (!products || !products[index]) return;

  const p = products[index];
  document.getElementById("manual-item-name").value = p.name;
  window._manualSelectedPrice = p.price || "";
  document.getElementById("manual-search-area").style.display = "none";
}

// --- Current Woodmans Online Cart ---

function renderOnlineCart(result) {
  const list = document.getElementById("online-cart-list");
  const countEl = document.getElementById("online-cart-count");
  const estEl = document.getElementById("online-cart-estimate");
  const removeAllBtn = document.getElementById("btn-remove-all-online");

  if (result && result.error) {
    list.innerHTML = `<p class="empty-state">Error: ${esc(result.error)}</p>`;
    countEl.textContent = "0";
    estEl.textContent = "";
    removeAllBtn.style.display = "none";
    return;
  }

  if (!result || !Array.isArray(result) || result.length === 0) {
    list.innerHTML = '<p class="empty-state">Your Woodmans online cart is empty.</p>';
    countEl.textContent = "0";
    estEl.textContent = "";
    removeAllBtn.style.display = "none";
    return;
  }

  removeAllBtn.style.display = "inline-flex";

  // Calculate total
  let total = 0;
  for (const item of result) {
    const price = parsePrice(item.price);
    if (price > 0) {
      total += price;
    }
  }

  countEl.textContent = result.length;
  estEl.textContent = total > 0 ? `Est. $${total.toFixed(2)}` : "";

  list.innerHTML = result
    .map(
      (item) => `
    <div class="item-row">
      <div class="item-info">
        <div class="item-name">${esc(item.name)}</div>
        <div class="item-detail">${item.size ? esc(item.size) : ""}${item.price ? " - " + esc(item.price) : ""}</div>
      </div>
      <span class="item-qty">x${item.quantity || 1}</span>
    </div>`
    )
    .join("");
}

async function fetchOnlineCart() {
  const btn = document.getElementById("btn-import-cart");
  btn.disabled = true;
  btn.textContent = "Loading...";

  document.getElementById("online-cart-list").innerHTML = "";
  showActivity("online-cart-activity", "online-cart-activity-status", "Fetching your Woodmans cart... (30-60s)");

  const logEl = document.getElementById("progress-log");
  logEl.innerHTML = "";

  // Listen for progress messages from the cart fetch
  if (removeProgressListener) removeProgressListener();
  removeProgressListener = appApi.onCartProgress((message) => {
    appendLog(message);
    // Update the activity status with the latest message
    const statusEl = document.getElementById("online-cart-activity-status");
    if (statusEl && statusEl.classList.contains("active")) {
      statusEl.textContent = message;
    }
  });

  try {
    const result = await appApi.fetchCurrentCart();
    renderOnlineCart(result);
    if (result && result.error) {
      hideActivity("online-cart-activity", "online-cart-activity-status", "Error: " + result.error, "error");
    } else {
      const count = Array.isArray(result) ? result.length : 0;
      hideActivity("online-cart-activity", "online-cart-activity-status", "Loaded " + count + " items", "success");
    }
  } catch (err) {
    renderOnlineCart({ error: err.message });
    hideActivity("online-cart-activity", "online-cart-activity-status", "Error: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh";
  }
}

async function removeAllOnlineCartItems() {
  if (!confirm("Remove ALL items from your Woodmans online cart? This cannot be undone.")) return;

  const btn = document.getElementById("btn-remove-all-online");
  const refreshBtn = document.getElementById("btn-import-cart");
  btn.disabled = true;
  btn.textContent = "Removing...";
  refreshBtn.disabled = true;
  showActivity("online-cart-activity", "online-cart-activity-status", "Removing all items from Woodmans cart...");

  const logEl = document.getElementById("progress-log");
  logEl.innerHTML = "";

  // Set up progress listener for removal updates
  if (removeProgressListener) removeProgressListener();
  removeProgressListener = appApi.onCartProgress((message) => {
    appendLog(message);
    const statusEl = document.getElementById("online-cart-activity-status");
    if (statusEl && statusEl.classList.contains("active")) {
      statusEl.textContent = message;
    }
  });

  try {
    const result = await appApi.removeAllCartItems();
    if (result && result.error) {
      appendLog("Error: " + result.error);
      hideActivity("online-cart-activity", "online-cart-activity-status", "Error: " + result.error, "error");
    } else {
      renderOnlineCart([]);
      hideActivity("online-cart-activity", "online-cart-activity-status", "All items removed", "success");
    }
  } catch (err) {
    appendLog("Error: " + err.message);
    hideActivity("online-cart-activity", "online-cart-activity-status", "Error: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Remove All";
    refreshBtn.disabled = false;
  }
}

// --- Cart Automation ---

async function startCartAutomation() {
  const items = getCartItems().filter((item) => !excludedCartIds.has(item.id));
  if (items.length === 0) {
    alert("No items in the cart. Add staples, enable recipes, or add items manually.");
    return;
  }

  cartRunning = true;
  cartItemResults = {};
  document.getElementById("btn-start-cart").style.display = "none";
  document.getElementById("btn-stop-cart").style.display = "inline-flex";
  renderCart();

  const logEl = document.getElementById("progress-log");
  logEl.innerHTML = "";

  // Set up progress listener
  if (removeProgressListener) removeProgressListener();
  removeProgressListener = appApi.onCartProgress((message) => {
    appendLog(message);
  });

  appendLog("Starting cart automation...");

  const cartItems = items.map((i) => ({
    id: i.id,
    item: i.item,
    productName: i.productName || "",
    quantity: i.quantity,
    note: i.note || "",
  }));

  // Show progress bar
  const progressBar = document.getElementById("cart-progress");
  progressBar.style.display = "block";
  updateProgressBar(0, cartItems.length);

  // Listen for per-item completion
  const removeItemDoneListener = appApi.onCartItemDone(({ id, index, total, status }) => {
    updateProgressBar(index + 1, total);
    cartItemResults[id] = status;
    if (status === "ok") {
      excludedCartIds.add(id);
    }
    renderCart();
  });

  try {
    await appApi.startCart({ items: cartItems, settings });
  } catch (err) {
    appendLog(`Error: ${err.message}`);
  }

  removeItemDoneListener();
  progressBar.style.display = "none";

  // Summary in activity status (no sliding bar — the progress bar already covered that)
  const okCount = Object.values(cartItemResults).filter((s) => s === "ok").length;
  const failCount = Object.values(cartItemResults).filter((s) => s === "fail").length;
  const skipCount = Object.values(cartItemResults).filter((s) => s === "skip").length;
  const statusEl = document.getElementById("cart-activity-status");
  if (statusEl) {
    if (failCount > 0) {
      statusEl.textContent = "Done — " + okCount + " added, " + failCount + " FAILED, " + skipCount + " skipped";
      statusEl.className = "activity-status active error";
    } else {
      statusEl.textContent = "Done — " + okCount + " added" + (skipCount > 0 ? ", " + skipCount + " skipped" : "");
      statusEl.className = "activity-status active success";
      setTimeout(function () { statusEl.className = "activity-status"; statusEl.textContent = ""; }, 5000);
    }
  }

  cartRunning = false;
  document.getElementById("btn-start-cart").style.display = "inline-flex";
  document.getElementById("btn-stop-cart").style.display = "none";
  renderCart();
}

function updateProgressBar(current, total) {
  const fill = document.getElementById("cart-progress-fill");
  const label = document.getElementById("cart-progress-label");
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  fill.style.width = pct + "%";
  label.textContent = `${current} / ${total} items (${pct}%)`;
}

async function stopCartAutomation() {
  appendLog("Stopping...");
  await appApi.stopCart();
  cartRunning = false;
  document.getElementById("btn-start-cart").style.display = "inline-flex";
  document.getElementById("btn-stop-cart").style.display = "none";
  renderCart();
}

function cleanLogMessage(msg) {
  if (!msg) return null;

  // Skip diagnostic/debug lines entirely
  if (/^  (\[role=|Strategy \d|Container total|First \d+ lines|Recommendation cutoff|recBoundary|Reakit portal|Sidebar|stepper|Found .+ by text|Using .+ fallback)/i.test(msg)) return null;
  if (/^\s+Item: "/.test(msg)) return null;
  if (/Mode buttons: \[/.test(msg)) return null;
  if (/^  \[role="dialog"\]/.test(msg)) return null;
  if (/selector/i.test(msg) && /detected|waiting/i.test(msg)) return null;
  if (/Cart button label:/i.test(msg)) return null;
  if (/aria-label shows 0/i.test(msg)) return null;
  if (/price-line|text pattern/i.test(msg)) return null;

  // Simplify semi-technical messages
  msg = msg.replace(/^Current mode: (.+), desired: (.+)$/, "Current mode: $1");
  msg = msg.replace(/^Mode after click: (.+)$/, "Switched to $1 mode");
  msg = msg.replace(/^Final mode: (.+)$/, "Shopping mode: $1");
  msg = msg.replace(/^Verifying login status\.\.\.$/, "Checking login...");
  msg = msg.replace(/^Connected! \(mode: (.+)\)$/, "Connected ($1 mode)");
  msg = msg.replace(/^Clicked cart button, waiting for sidebar content\.\.\.$/, "Loading cart...");
  msg = msg.replace(/^Cart scrape: (\d+) items found$/, "Found $1 items in cart");
  msg = msg.replace(/^Found Manage button, trying bulk remove\.\.\.$/, "Removing all items...");
  msg = msg.replace(/^No bulk remove available — removing items one at a time\.\.\.$/, "Removing items one by one...");
  msg = msg.replace(/^Reusing existing session$/, "Reconnecting...");
  msg = msg.replace(/^Ensuring (.+) mode\.\.\.$/, "Setting $1 mode...");
  msg = msg.replace(/Clicking (.+) button\.\.\./, "Switching to $1...");
  msg = msg.replace(/Retrying (.+) click\.\.\./, "Retrying $1...");
  msg = msg.replace(/Confirmed mode in dialog/, "Mode confirmed");
  msg = msg.replace(/^  SKIP - Could not find search bar$/, "  Skipped — search bar not available");
  msg = msg.replace(/^  FAIL - No "Add" button found in results$/, "  Failed — product not found in results");
  msg = msg.replace(/^  ERROR - (.+)$/, "  Error — $1");

  return msg;
}

function appendLog(message) {
  const cleaned = cleanLogMessage(message);
  if (!cleaned) return;
  const logEl = document.getElementById("progress-log");
  const line = document.createElement("p");
  line.className = "log-line";
  line.textContent = cleaned;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// --- Helpers ---

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function parsePrice(priceStr) {
  if (!priceStr) return 0;
  const match = String(priceStr).match(/\$?([\d]+\.?\d*)/);
  return match ? parseFloat(match[1]) : 0;
}

function esc(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Open a URL in the default external browser (Chrome etc.)
function openExternalUrl(url) {
  appApi.openExternal(url);
}

// Expose functions that are called from inline onclick handlers
window.openExternalUrl = openExternalUrl;
window.openStapleModal = openStapleModal;
window.deleteStaple = deleteStaple;
window.selectProduct = selectProduct;
window.openRecipeModal = openRecipeModal;
window.deleteRecipe = deleteRecipe;
window.toggleRecipe = toggleRecipe;
window.updateRecipeItem = updateRecipeItem;
window.removeRecipeItem = removeRecipeItem;
window.removeManualItem = removeManualItem;
window.removeCartItem = removeCartItem;
window.changeCartQty = changeCartQty;
window.openRecipeItemModal = openRecipeItemModal;
window.selectRecipeItemProduct = selectRecipeItemProduct;
window.selectManualProduct = selectManualProduct;
window.toggleShoppingMode = toggleShoppingMode;
window.toggleDarkMode = toggleDarkMode;
