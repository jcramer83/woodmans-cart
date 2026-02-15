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

// --- Modal helpers ---

function showModal(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  const modal = overlay.querySelector(".modal");
  if (modal) { modal.style.position = ""; modal.style.left = ""; modal.style.top = ""; }
  requestAnimationFrame(() => overlay.classList.add("visible"));
}

function hideModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove("visible");
}

function isModalOpen(id) {
  const el = document.getElementById(id);
  return el && el.classList.contains("visible");
}

// --- Toast notifications ---

function showToast(message, type) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast" + (type ? " " + type : "");
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("visible"));
  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// --- Loading skeleton ---

function skeletonHTML(count) {
  return Array(count || 3).fill(
    '<div class="skeleton-row"><div class="skeleton-thumb"></div><div class="skeleton-lines"><div class="skeleton-line"></div><div class="skeleton-line"></div></div></div>'
  ).join("");
}

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

// --- Broken image handler ---
// On load failure or blank image from a cached bad response, retry once with cache bust.
// If retry also fails, hide the image.
document.addEventListener("error", (e) => {
  const img = e.target;
  if (img.tagName !== "IMG" || !img.src) return;
  if (img.dataset.retried) {
    img.style.display = "none";
  } else {
    img.dataset.retried = "1";
    const sep = img.src.includes("?") ? "&" : "?";
    img.src = img.src.replace(/([&?])_cb=\d+/, "") + sep + "_cb=" + Date.now();
  }
}, true);

document.addEventListener("load", (e) => {
  const img = e.target;
  if (img.tagName !== "IMG") return;
  if (img.naturalWidth <= 1 && img.naturalHeight <= 1) {
    if (img.dataset.retried) {
      img.style.display = "none";
    } else {
      img.dataset.retried = "1";
      const sep = img.src.includes("?") ? "&" : "?";
      img.src = img.src.replace(/([&?])_cb=\d+/, "") + sep + "_cb=" + Date.now();
    }
  }
}, true);

// --- Init ---

document.addEventListener("DOMContentLoaded", init);

async function init() {
  // Show loading skeletons while data loads
  document.getElementById("staples-list").innerHTML = skeletonHTML(3);
  document.getElementById("recipes-list").innerHTML = skeletonHTML(3);

  try {
    settings = (await appApi.loadSettings()) || {};
  } catch (e) { console.warn("Failed to load settings:", e); }
  try {
    staples = (await appApi.loadStaples()) || [];
  } catch (e) { console.warn("Failed to load staples:", e); }
  try {
    recipes = (await appApi.loadRecipes()) || [];
  } catch (e) { console.warn("Failed to load recipes:", e); }

  // Validate loaded data (guard against API returning error objects)
  if (!Array.isArray(staples)) staples = [];
  if (!Array.isArray(recipes)) recipes = [];
  if (typeof settings !== "object" || settings === null || settings.error) settings = {};

  // Exclude all staples from cart on launch — user clicks "Add All to Cart" to include them
  for (const s of staples) {
    excludedCartIds.add("staple-" + s.id);
  }

  initDarkMode();
  restoreCollapsedSections();
  renderStaples();
  renderRecipes();
  renderCart();
  updateModeBadge();
  bindEvents();

  // Listen for online cart updates pushed after automation completes
  appApi.onOnlineCartUpdate((items) => {
    renderOnlineCart(items);
  });

}

// --- Event binding ---

function bindEvents() {
  // Staples
  document.getElementById("btn-add-all-staples").addEventListener("click", addAllStaplesToCart);
  document.getElementById("btn-staple-search").addEventListener("click", doStapleSearch);
  document.getElementById("staple-search-query").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doStapleSearch();
  });
  document.getElementById("btn-save-staple").addEventListener("click", saveStaple);

  // Recipes
  document.getElementById("btn-add-recipe").addEventListener("click", () => openRecipeModal(null));

  // Recipe modal
  document.getElementById("btn-add-recipe-item").addEventListener("click", addRecipeItemRow);
  document.getElementById("btn-save-recipe").addEventListener("click", saveRecipe);

  // AI recipe
  document.getElementById("btn-ai-recipe").addEventListener("click", openAiRecipeModal);
  document.getElementById("btn-ai-generate").addEventListener("click", searchAiRecipeOptions);
  document.getElementById("btn-ai-suggest").addEventListener("click", suggestRecipes);
  document.getElementById("ai-recipe-prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.value.trim()) searchAiRecipeOptions();
  });
  document.getElementById("ai-recipe-prompt").addEventListener("input", (e) => {
    document.getElementById("btn-ai-generate").disabled = !e.target.value.trim();
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

  // Manual cart add (search-and-add, same as staples)
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
      hideModal(btn.getAttribute("data-close"));
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

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll(".modal-overlay").forEach((m) => m.classList.remove("visible"));
    }
  });

  // Debounced auto-search for staples
  let stapleSearchTimer = null;
  document.getElementById("staple-search-query").addEventListener("input", (e) => {
    clearTimeout(stapleSearchTimer);
    if (e.target.value.trim().length >= 3) {
      stapleSearchTimer = setTimeout(doStapleSearch, 400);
    }
  });

  // Debounced auto-search for manual cart add
  let manualSearchTimer = null;
  document.getElementById("manual-search-query").addEventListener("input", (e) => {
    clearTimeout(manualSearchTimer);
    if (e.target.value.trim().length >= 3) {
      manualSearchTimer = setTimeout(doManualSearch, 400);
    }
  });

  // Click-outside dismissal for search results
  document.addEventListener("click", (e) => {
    // Staple search: dismiss if click is outside the search row and results
    const stapleSearchRow = document.querySelector(".left-col .staple-search-row");
    const stapleResults = document.getElementById("staple-search-results");
    if (stapleResults && stapleResults.style.display !== "none") {
      if (!e.target.closest(".left-col .staple-search-row") && !e.target.closest("#staple-search-results")) {
        stapleResults.style.display = "none";
      }
    }
    // Manual search: dismiss if click is outside the search row and results
    const manualResults = document.getElementById("manual-search-results");
    if (manualResults && manualResults.style.display !== "none") {
      if (!e.target.closest(".right-col .staple-search-row") && !e.target.closest("#manual-search-results")) {
        manualResults.style.display = "none";
      }
    }
  });

}

// --- Settings ---

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

// --- Collapsible Sections ---

function toggleSection(sectionId) {
  const content = document.getElementById("section-" + sectionId);
  const btn = content ? content.closest(".section").querySelector(".collapse-btn") : null;
  if (!content) return;
  content.classList.toggle("collapsed");
  if (btn) btn.classList.toggle("collapsed");
  // Persist state
  const collapsed = JSON.parse(localStorage.getItem("collapsedSections") || "{}");
  collapsed[sectionId] = content.classList.contains("collapsed");
  localStorage.setItem("collapsedSections", JSON.stringify(collapsed));
}

function restoreCollapsedSections() {
  const collapsed = JSON.parse(localStorage.getItem("collapsedSections") || "{}");
  for (const [sectionId, isCollapsed] of Object.entries(collapsed)) {
    if (!isCollapsed) continue;
    const content = document.getElementById("section-" + sectionId);
    const btn = content ? content.closest(".section").querySelector(".collapse-btn") : null;
    if (content) content.classList.add("collapsed");
    if (btn) btn.classList.add("collapsed");
  }
}

// --- Staples ---

function renderStaples() {
  const list = document.getElementById("staples-list");
  if (staples.length === 0) {
    list.innerHTML = '<p class="empty-state"><img class="empty-state-img" src="/assets/empty-staples.png" alt="" />No staples yet. Search below to add items.</p>';
    return;
  }

  list.innerHTML = staples
    .map(
      (s, i) => `
    <div class="item-row" data-id="${s.id}" draggable="true" ondragstart="dragStartItem(event,'staple',${i})" ondragover="dragOverItem(event)" ondragleave="dragLeaveItem(event)" ondrop="dropItem(event,'staple',${i})" ondragend="dragEndItem(event)">
      ${s.image ? `<img class="item-thumb" src="${esc(s.image)}" alt="">` : ""}
      <div class="item-info">
        <div class="item-name">${esc(s.productName || s.item)}</div>
        <div class="item-detail">${s.price ? esc(s.price) : ""}${s.note ? (s.price ? " - " : "") + esc(s.note) : ""}</div>
      </div>
      <div class="item-qty-controls">
        <button class="qty-btn" onclick="changeStapleQty('${s.id}', -1)" title="Decrease">&#8722;</button>
        <span class="item-qty-val">${s.quantity || 1}</span>
        <button class="qty-btn" onclick="changeStapleQty('${s.id}', 1)" title="Increase">&#43;</button>
      </div>
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
  if (!staple) return;

  document.getElementById("staple-edit-product").textContent = staple.productName || staple.item;
  document.getElementById("staple-quantity").value = staple.quantity || 1;
  document.getElementById("staple-note").value = staple.note || "";

  showModal("modal-staple");
  document.getElementById("staple-quantity").focus();
}

async function saveStaple() {
  if (!editingStapleId) return;
  const idx = staples.findIndex((s) => s.id === editingStapleId);
  if (idx === -1) return;

  staples[idx].quantity = parseInt(document.getElementById("staple-quantity").value) || 1;
  staples[idx].note = document.getElementById("staple-note").value.trim();

  await appApi.saveStaples(staples);
  renderStaples();
  renderCart();
  hideModal("modal-staple");
  showToast("Staple updated", "success");
}

async function deleteStaple(id) {
  if (!confirm("Delete this staple item?")) return;
  staples = staples.filter((s) => s.id !== id);
  await appApi.saveStaples(staples);
  renderStaples();
  renderCart();
  showToast("Staple removed");
}

async function changeStapleQty(id, delta) {
  const s = staples.find((x) => x.id === id);
  if (!s) return;
  s.quantity = Math.max(1, (s.quantity || 1) + delta);
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
  if (staples.length > 0) showToast("Added " + staples.length + " staples to cart", "success");
}

// --- Staple search (inline) ---

async function doStapleSearch() {
  const query = document.getElementById("staple-search-query").value.trim();
  if (!query) return;

  const resultsDiv = document.getElementById("staple-search-results");
  resultsDiv.style.display = "block";
  resultsDiv.innerHTML = skeletonHTML(3);
  document.getElementById("btn-staple-search").disabled = true;

  try {
    const products = await appApi.searchProducts(query);

    if (products.error) {
      resultsDiv.innerHTML = `<p class="empty-state">Error: ${esc(products.error)}</p>`;
      return;
    }

    if (!products || products.length === 0) {
      resultsDiv.innerHTML = '<p class="empty-state">No products found. Try a different search.</p>';
      return;
    }

    resultsDiv.innerHTML = products
      .map(
        (p, i) => `
      <div class="product-result-row" onclick="selectStapleSearchResult(${i})">
        ${p.image ? `<img class="product-result-thumb" src="${esc(p.image)}" alt="">` : ""}
        <div class="product-result-info">
          <div class="product-result-name">${esc(p.name)}</div>
          <div class="product-result-meta">${esc(p.price)}${p.size ? " - " + esc(p.size) : ""}</div>
        </div>
      </div>`
      )
      .join("");

    window._stapleSearchResults = products;
  } catch (err) {
    resultsDiv.innerHTML = `<p class="empty-state">Error: ${esc(err.message)}</p>`;
  } finally {
    document.getElementById("btn-staple-search").disabled = false;
  }
}

async function selectStapleSearchResult(index) {
  const products = window._stapleSearchResults;
  if (!products || !products[index]) return;

  const p = products[index];
  const staple = {
    id: generateId(),
    item: p.name,
    quantity: 1,
    note: "",
    productName: p.name,
    brand: "",
    price: p.price || "",
    image: p.image || "",
  };

  staples.push(staple);
  excludedCartIds.add("staple-" + staple.id);
  await appApi.saveStaples(staples);
  renderStaples();
  showToast("Added " + p.name, "success");

  // Clear search
  document.getElementById("staple-search-query").value = "";
  document.getElementById("staple-search-results").style.display = "none";
  document.getElementById("staple-search-query").focus();
}

// --- Recipes ---

function renderRecipes() {
  const list = document.getElementById("recipes-list");
  if (recipes.length === 0) {
    list.innerHTML = '<p class="empty-state"><img class="empty-state-img" src="/assets/empty-recipes.png" alt="" />No recipes yet. Click "AI Recipe" to get started.</p>';
    return;
  }

  list.innerHTML = recipes
    .map(
      (r, i) => `
    <div class="item-row" data-id="${r.id}" draggable="true" ondragstart="dragStartItem(event,'recipe',${i})" ondragover="dragOverItem(event)" ondragleave="dragLeaveItem(event)" ondrop="dropItem(event,'recipe',${i})" ondragend="dragEndItem(event)">
      <label class="toggle">
        <input type="checkbox" ${r.enabled ? "checked" : ""} onchange="toggleRecipe('${r.id}', this.checked)" />
        <span class="toggle-slider"></span>
      </label>
      ${r.imageUrl ? `<img class="item-thumb" src="${esc(r.imageUrl)}" alt="">` : ""}
      <div class="item-info">
        <div class="item-name">${esc(r.name)}</div>
        <div class="item-detail">${(r.items || []).length} item${(r.items || []).length !== 1 ? "s" : ""}</div>
      </div>
      <div class="item-actions">
        ${r.instructions && r.instructions.length > 0 ? `<button onclick="viewRecipe('${r.id}')" title="View Recipe">&#128220;</button>` : ""}
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

  showModal("modal-recipe");
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
      ${item.image ? `<img class="item-thumb" src="${esc(item.image)}" alt="">` : ""}
      <div class="item-info">
        <div class="item-name">${esc(item.item || "(unnamed)")}</div>
        <div class="item-detail">${esc(item.productName || "")}${item.note ? " (" + esc(item.note) + ")" : ""}${item.price ? " - " + esc(item.price) : ""}</div>
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
  window._recipeItemSelectedImage = item ? item.image || "" : "";
  showModal("modal-recipe-item");
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
    image: window._recipeItemSelectedImage || "",
  };

  if (editingRecipeItemIndex >= 0) {
    recipeItemsDraft[editingRecipeItemIndex] = data;
  } else {
    recipeItemsDraft.push(data);
  }

  renderRecipeItems();
  hideModal("modal-recipe-item");
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
  resultsDiv.innerHTML = skeletonHTML(3);
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
        ${p.image ? `<img class="product-result-thumb" src="${esc(p.image)}" alt="">` : ""}
        <div class="product-result-info">
          <div class="product-result-name">${esc(p.name)}</div>
          <div class="product-result-meta">${esc(p.price)}${p.size ? " - " + esc(p.size) : ""}</div>
        </div>
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
  window._recipeItemSelectedImage = p.image || "";
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
  hideModal("modal-recipe");
  showToast("Recipe saved", "success");
}

async function deleteRecipe(id) {
  if (!confirm("Delete this recipe?")) return;
  appApi.deleteRecipeImage(id);
  recipes = recipes.filter((r) => r.id !== id);
  await appApi.saveRecipes(recipes);
  renderRecipes();
  renderCart();
  showToast("Recipe deleted");
}

// --- View Recipe ---

let viewingRecipeId = null;

function viewRecipe(id) {
  const recipe = recipes.find((r) => r.id === id);
  if (!recipe) return;

  viewingRecipeId = id;
  document.getElementById("view-recipe-title").textContent = recipe.name;

  const imgEl = document.getElementById("view-recipe-image");
  if (recipe.imageUrl) {
    imgEl.src = recipe.imageUrl + "?t=" + Date.now();
    imgEl.alt = recipe.name;
    imgEl.style.display = "block";
  } else {
    imgEl.style.display = "none";
    imgEl.src = "";
  }

  const servingsEl = document.getElementById("view-recipe-servings");
  servingsEl.textContent = recipe.servings ? "Serves " + recipe.servings : "";

  const ingredientsList = document.getElementById("view-recipe-ingredients");
  const items = recipe.items || [];
  if (items.length > 0) {
    ingredientsList.innerHTML = items
      .map((item) => {
        const thumb = item.image ? `<img class="item-thumb" src="${esc(item.image)}" alt="">` : "";
        let text = "";
        if (item.quantity && item.quantity > 1) text += item.quantity + "x ";
        text += esc(item.productName || item.item || "");
        if (item.note) text += " (" + esc(item.note) + ")";
        if (item.price) text += " - " + esc(item.price);
        return `<li>${thumb}${text}</li>`;
      })
      .join("");
  } else {
    ingredientsList.innerHTML = '<li class="empty-state">No ingredients</li>';
  }

  const instructionsList = document.getElementById("view-recipe-instructions");
  const instructions = recipe.instructions || [];
  if (instructions.length > 0) {
    instructionsList.innerHTML = instructions
      .map((step) => "<li>" + esc(step) + "</li>")
      .join("");
  } else {
    instructionsList.innerHTML = '<li class="empty-state">No instructions available</li>';
  }

  showModal("modal-view-recipe");
}

function printRecipe() {
  window.print();
}

function openRecipeExternal() {
  const recipe = viewingRecipeId ? recipes.find((r) => r.id === viewingRecipeId) : null;
  if (!recipe) return;

  const items = recipe.items || [];
  const instructions = recipe.instructions || [];

  let imgTag = "";
  if (recipe.imageUrl) {
    // Convert relative URL to absolute for the blob page
    const absUrl = new URL(recipe.imageUrl, location.origin).href;
    imgTag = '<img src="' + esc(absUrl) + '" style="width:100%;max-height:400px;object-fit:cover;border-radius:8px;margin-bottom:16px;" alt="' + esc(recipe.name) + '" />';
  }

  const ingredientsHtml = items.length > 0
    ? "<ul>" + items.map((item) => {
        let text = "";
        if (item.quantity && item.quantity > 1) text += item.quantity + "x ";
        text += esc(item.item || "");
        if (item.note) text += " (" + esc(item.note) + ")";
        return "<li>" + text + "</li>";
      }).join("") + "</ul>"
    : "<p>No ingredients</p>";

  const instructionsHtml = instructions.length > 0
    ? "<ol>" + instructions.map((step) => "<li>" + esc(step) + "</li>").join("") + "</ol>"
    : "<p>No instructions available</p>";

  const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + esc(recipe.name) + '</title>'
    + '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:700px;margin:40px auto;padding:0 20px;color:#1a1a1a;line-height:1.6;}'
    + 'h1{color:#b71c1c;margin-bottom:4px;}p.servings{color:#666;margin-bottom:16px;font-size:15px;}'
    + 'h2{font-size:18px;margin-top:20px;margin-bottom:8px;border-bottom:2px solid #eee;padding-bottom:4px;}'
    + 'ul{padding-left:20px;}ol{padding-left:24px;}li{padding:3px 0;}'
    + 'img{display:block;}</style></head><body>'
    + imgTag
    + '<h1>' + esc(recipe.name) + '</h1>'
    + (recipe.servings ? '<p class="servings">Serves ' + recipe.servings + '</p>' : '')
    + '<h2>Ingredients</h2>' + ingredientsHtml
    + '<h2>Instructions</h2>' + instructionsHtml
    + '</body></html>';

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
}

// --- AI Recipe Generation ---

function openAiRecipeModal() {
  document.getElementById("ai-recipe-prompt").value = "";
  document.getElementById("ai-recipe-servings").value = "4";
  document.getElementById("ai-recipe-status").style.display = "none";
  document.getElementById("ai-recipe-status").innerHTML = "";
  document.getElementById("btn-ai-generate").disabled = true;
  document.getElementById("ai-suggestions").style.display = "none";
  document.getElementById("ai-suggestions-list").innerHTML = "";
  showModal("modal-ai-recipe");
  document.getElementById("ai-recipe-prompt").focus();
}

async function suggestRecipes() {
  document.getElementById("ai-recipe-prompt").value = "";
  document.getElementById("btn-ai-generate").disabled = true;

  const suggestionsEl = document.getElementById("ai-suggestions");
  const listEl = document.getElementById("ai-suggestions-list");
  const btn = document.getElementById("btn-ai-suggest");

  suggestionsEl.style.display = "block";
  listEl.innerHTML = '<span class="ai-suggestions-loading">Getting ideas...</span>';
  btn.disabled = true;

  const glutenFree = document.getElementById("ai-gluten-free").checked;
  const pickyEater = document.getElementById("ai-picky-eater").checked;
  const dairyFree = document.getElementById("ai-dairy-free").checked;
  const preferOrganic = document.getElementById("ai-prefer-organic").checked;

  try {
    const result = await appApi.suggestRecipes({ glutenFree, dairyFree, preferOrganic, pickyEater });

    if (result.error) {
      listEl.innerHTML = '<span class="ai-suggestions-loading">Could not load suggestions.</span>';
      btn.disabled = false;
      return;
    }

    const suggestions = result.suggestions || [];
    if (suggestions.length === 0) {
      listEl.innerHTML = '<span class="ai-suggestions-loading">No suggestions returned.</span>';
      btn.disabled = false;
      return;
    }

    listEl.innerHTML = suggestions.map((s, i) =>
      '<div class="ai-suggestion-chip" onclick="selectSuggestion(' + i + ')">' +
        '<div class="chip-name">' + esc(s.name) + '</div>' +
        '<div class="chip-desc">' + esc(s.description) + '</div>' +
      '</div>'
    ).join("");

    window._aiSuggestions = suggestions;
  } catch (err) {
    listEl.innerHTML = '<span class="ai-suggestions-loading">Could not load suggestions.</span>';
  } finally {
    btn.disabled = false;
  }
}

function selectSuggestion(index) {
  const suggestions = window._aiSuggestions;
  if (!suggestions || !suggestions[index]) return;
  document.getElementById("ai-recipe-prompt").value = suggestions[index].name;
  document.getElementById("btn-ai-generate").disabled = false;
  // Highlight selected chip
  document.querySelectorAll(".ai-suggestion-chip").forEach((chip, i) => {
    chip.classList.toggle("selected", i === index);
  });
  document.getElementById("ai-recipe-prompt").focus();
}

async function searchAiRecipeOptions() {
  const prompt = document.getElementById("ai-recipe-prompt").value.trim();
  if (!prompt) return;

  const suggestionsEl = document.getElementById("ai-suggestions");
  const listEl = document.getElementById("ai-suggestions-list");
  const btn = document.getElementById("btn-ai-generate");

  suggestionsEl.style.display = "block";
  listEl.innerHTML = '<span class="ai-suggestions-loading">Finding recipe options...</span>';
  btn.disabled = true;

  const glutenFree = document.getElementById("ai-gluten-free").checked;
  const pickyEater = document.getElementById("ai-picky-eater").checked;
  const dairyFree = document.getElementById("ai-dairy-free").checked;
  const preferOrganic = document.getElementById("ai-prefer-organic").checked;

  try {
    const result = await appApi.suggestRecipes({ prompt, glutenFree, dairyFree, preferOrganic, pickyEater });

    if (result.error) {
      listEl.innerHTML = '<span class="ai-suggestions-loading">Could not load options.</span>';
      return;
    }

    const suggestions = result.suggestions || [];
    if (suggestions.length === 0) {
      listEl.innerHTML = '<span class="ai-suggestions-loading">No options returned.</span>';
      return;
    }

    listEl.innerHTML = suggestions.map((s, i) =>
      '<div class="ai-suggestion-chip" onclick="generateFromOption(' + i + ')">' +
        '<div class="chip-name">' + esc(s.name) + '</div>' +
        '<div class="chip-desc">' + esc(s.description) + '</div>' +
      '</div>'
    ).join("");

    window._aiRecipeOptions = suggestions;
  } catch (err) {
    listEl.innerHTML = '<span class="ai-suggestions-loading">Could not load options.</span>';
  } finally {
    btn.disabled = false;
  }
}

function generateFromOption(index) {
  const options = window._aiRecipeOptions;
  if (!options || !options[index]) return;
  document.getElementById("ai-recipe-prompt").value = options[index].name;
  // Highlight selected
  document.querySelectorAll("#ai-suggestions-list .ai-suggestion-chip").forEach((chip, i) => {
    chip.classList.toggle("selected", i === index);
  });
  generateAiRecipe();
}

async function generateAiRecipe() {
  const prompt = document.getElementById("ai-recipe-prompt").value.trim();
  if (!prompt) return;

  const servings = parseInt(document.getElementById("ai-recipe-servings").value) || 4;
  const glutenFree = document.getElementById("ai-gluten-free").checked;
  const pickyEater = document.getElementById("ai-picky-eater").checked;
  const dairyFree = document.getElementById("ai-dairy-free").checked;
  const preferOrganic = document.getElementById("ai-prefer-organic").checked;
  const statusEl = document.getElementById("ai-recipe-status");
  const btn = document.getElementById("btn-ai-generate");

  statusEl.style.display = "block";
  statusEl.innerHTML = '<div class="ai-loading-animation"><img class="ai-loading-img" src="/assets/cooking-loading.png" alt="" /><span>Cooking up your recipe...</span></div>';
  statusEl.className = "ai-status loading";
  btn.disabled = true;
  // Scroll status into view on mobile where it may be off-screen
  statusEl.scrollIntoView({ behavior: "smooth", block: "nearest" });

  try {
    const result = await appApi.generateRecipe({ prompt, servings, glutenFree, dairyFree, preferOrganic, pickyEater });

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
      servings: result.servings || servings,
      instructions: result.instructions || [],
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

    // Close AI modal and open the view recipe modal
    hideModal("modal-ai-recipe");
    viewRecipe(recipe.id);

    // Look up product matches for each ingredient, then generate recipe image
    matchRecipeProducts(recipe).then(async () => {
      await appApi.saveRecipes(recipes);
      renderRecipes();
      renderCart();
      // Update view modal if still open
      if (isModalOpen("modal-view-recipe") && viewingRecipeId === recipe.id) {
        viewRecipe(recipe.id);
      }
      // Generate recipe image after product matching is done (avoids save race)
      const imgResult = await appApi.generateRecipeImage(recipe.id, recipe.name);
      if (imgResult && imgResult.imageUrl && !imgResult.error) {
        recipe.imageUrl = imgResult.imageUrl;
        await appApi.saveRecipes(recipes);
        renderRecipes();
        var imgEl = document.getElementById("view-recipe-image");
        if (imgEl && isModalOpen("modal-view-recipe")) {
          imgEl.src = imgResult.imageUrl + "?t=" + Date.now();
          imgEl.alt = recipe.name;
          imgEl.style.display = "block";
        }
      }
    });
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.className = "ai-status error";
  } finally {
    btn.disabled = false;
  }
}

async function matchRecipeProducts(recipe) {
  for (let i = 0; i < recipe.items.length; i++) {
    const item = recipe.items[i];
    if (item.image) continue;
    try {
      const results = await appApi.searchProducts(item.item);
      if (Array.isArray(results) && results.length > 0) {
        const p = results[0];
        item.productName = p.name || item.productName;
        item.price = p.price || item.price;
        item.image = p.image || "";
      }
    } catch (err) {
      console.warn("matchRecipeProducts failed for:", item.item, err);
    }
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
      image: s.image || "",
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
        image: item.image || "",
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
      image: m.image || "",
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
      total += price * (item.quantity || 1);
      hasEstimate = true;
    }
  }
  estEl.textContent = hasEstimate ? `Est. $${total.toFixed(2)}` : "";

  if (items.length === 0) {
    list.innerHTML = '<p class="empty-state"><img class="empty-state-img" src="/assets/empty-cart.png" alt="" />Cart is empty. Add staples or enable recipes to populate.</p>';
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
      ${item.image ? `<img class="item-thumb" src="${esc(item.image)}" alt="">` : ""}
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

  // Lock/unlock manual search and staple/recipe controls
  const manualSearchRow = document.querySelector(".right-col .staple-search-row");
  if (manualSearchRow) manualSearchRow.style.display = cartRunning ? "none" : "flex";
  const manualResults = document.getElementById("manual-search-results");
  if (manualResults && cartRunning) manualResults.style.display = "none";
  document.getElementById("btn-clear-cart").style.display = cartRunning ? "none" : "inline-flex";
  document.getElementById("btn-add-all-staples").disabled = cartRunning;
  document.getElementById("btn-add-recipe").disabled = cartRunning;
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

// --- Manual item product search (same pattern as staples) ---

async function doManualSearch() {
  const query = document.getElementById("manual-search-query").value.trim();
  if (!query) return;

  const resultsDiv = document.getElementById("manual-search-results");
  resultsDiv.style.display = "block";
  resultsDiv.innerHTML = skeletonHTML(3);
  document.getElementById("btn-manual-search-go").disabled = true;

  try {
    const products = await appApi.searchProducts(query);

    if (products.error) {
      resultsDiv.innerHTML = `<p class="empty-state">Error: ${esc(products.error)}</p>`;
      return;
    }

    if (!products || products.length === 0) {
      resultsDiv.innerHTML = '<p class="empty-state">No products found. Try a different search.</p>';
      return;
    }

    resultsDiv.innerHTML = products
      .map(
        (p, i) => `
      <div class="product-result-row" onclick="selectManualProduct(${i})">
        ${p.image ? `<img class="product-result-thumb" src="${esc(p.image)}" alt="">` : ""}
        <div class="product-result-info">
          <div class="product-result-name">${esc(p.name)}</div>
          <div class="product-result-meta">${esc(p.price)}${p.size ? " - " + esc(p.size) : ""}</div>
        </div>
      </div>`
      )
      .join("");

    window._manualSearchResults = products;
  } catch (err) {
    resultsDiv.innerHTML = `<p class="empty-state">Error: ${esc(err.message)}</p>`;
  } finally {
    document.getElementById("btn-manual-search-go").disabled = false;
  }
}

function selectManualProduct(index) {
  const products = window._manualSearchResults;
  if (!products || !products[index]) return;

  const p = products[index];
  manualItems.push({
    id: generateId(),
    item: p.name,
    quantity: 1,
    price: p.price || "",
    image: p.image || "",
  });

  renderCart();
  showToast("Added " + p.name + " to cart", "success");

  // Clear search
  document.getElementById("manual-search-query").value = "";
  document.getElementById("manual-search-results").style.display = "none";
  document.getElementById("manual-search-query").focus();
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
      total += price * (item.quantity || 1);
    }
  }

  countEl.textContent = result.length;
  estEl.textContent = total > 0 ? `Est. $${total.toFixed(2)}` : "";

  list.innerHTML = result
    .map(
      (item) => `
    <div class="item-row">
      ${item.image ? `<img class="item-thumb" src="${esc(item.image)}" alt="">` : ""}
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

  const statusLine = document.getElementById("cart-status-line");
  if (statusLine) { statusLine.textContent = ""; statusLine.className = "cart-status-line"; }

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

  const statusLine = document.getElementById("cart-status-line");
  if (statusLine) { statusLine.textContent = ""; statusLine.className = "cart-status-line"; }

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

  const statusLine = document.getElementById("cart-status-line");
  if (statusLine) { statusLine.textContent = ""; statusLine.className = "cart-status-line"; }

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
    try {
      await appApi.startCart({ items: cartItems, settings });
    } catch (err) {
      appendLog(`Error: ${err.message}`);
    }

    removeItemDoneListener();
    progressBar.style.display = "none";

    // Summary
    const okCount = Object.values(cartItemResults).filter((s) => s === "ok").length;
    const failCount = Object.values(cartItemResults).filter((s) => s === "fail").length;
    const skipCount = Object.values(cartItemResults).filter((s) => s === "skip").length;
    const summaryLine = document.getElementById("cart-status-line");
    if (summaryLine) {
      if (failCount > 0) {
        summaryLine.textContent = "Done — " + okCount + " added, " + failCount + " failed, " + skipCount + " skipped";
        summaryLine.className = "cart-status-line error";
        showToast(failCount + " items failed to add", "error");
      } else {
        summaryLine.textContent = "Done — " + okCount + " added" + (skipCount > 0 ? ", " + skipCount + " skipped" : "");
        summaryLine.className = "cart-status-line success";
        showToast("All " + okCount + " items added!", "success");
      }
    }

    // Auto-disable recipes whose items were all successfully added
    let recipesChanged = false;
    for (const r of recipes) {
      if (!r.enabled) continue;
      const recipeItems = r.items || [];
      const recipeItemIds = recipeItems.map((item) => "recipe-" + r.id + "-" + (item.item || ""));
      const allOk = recipeItemIds.length > 0 && recipeItemIds.every((id) => cartItemResults[id] === "ok");
      if (allOk) {
        r.enabled = false;
        recipesChanged = true;
      }
    }
    if (recipesChanged) {
      try {
        await appApi.saveRecipes(recipes);
        renderRecipes();
      } catch (e) {
        console.warn("Failed to save recipe state after automation:", e);
      }
    }
  } finally {
    cartRunning = false;
    document.getElementById("btn-start-cart").style.display = "inline-flex";
    document.getElementById("btn-stop-cart").style.display = "none";
    renderCart();
  }
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
  const statusLine = document.getElementById("cart-status-line");
  if (statusLine) {
    statusLine.textContent = cleaned;
    statusLine.className = "cart-status-line active";
  }
}

// --- Drag-to-Reorder ---

function dragStartItem(e, type, index) {
  e.dataTransfer.setData("text/plain", JSON.stringify({ type, index }));
  e.dataTransfer.effectAllowed = "move";
  e.target.closest(".item-row").style.opacity = "0.5";
}

function dragOverItem(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const row = e.target.closest(".item-row");
  if (row) row.classList.add("drag-over");
}

function dragLeaveItem(e) {
  const row = e.target.closest(".item-row");
  if (row) row.classList.remove("drag-over");
}

function dropItem(e, type, index) {
  e.preventDefault();
  const row = e.target.closest(".item-row");
  if (row) row.classList.remove("drag-over");

  let data;
  try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
  if (data.type !== type) return;

  const fromIndex = data.index;
  if (fromIndex === index) return;

  const arr = type === "staple" ? staples : recipes;
  const [moved] = arr.splice(fromIndex, 1);
  arr.splice(index, 0, moved);

  if (type === "staple") {
    appApi.saveStaples(staples);
    renderStaples();
    renderCart();
  } else {
    appApi.saveRecipes(recipes);
    renderRecipes();
    renderCart();
  }
}

function dragEndItem(e) {
  e.target.closest(".item-row").style.opacity = "";
  document.querySelectorAll(".item-row.drag-over").forEach((r) => r.classList.remove("drag-over"));
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
window.changeStapleQty = changeStapleQty;
window.selectStapleSearchResult = selectStapleSearchResult;
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
window.selectSuggestion = selectSuggestion;
window.generateFromOption = generateFromOption;
window.viewRecipe = viewRecipe;
window.printRecipe = printRecipe;
window.openRecipeExternal = openRecipeExternal;
window.toggleShoppingMode = toggleShoppingMode;
window.toggleDarkMode = toggleDarkMode;
window.toggleSection = toggleSection;
window.dragStartItem = dragStartItem;
window.dragOverItem = dragOverItem;
window.dragLeaveItem = dragLeaveItem;
window.dropItem = dropItem;
window.dragEndItem = dragEndItem;
