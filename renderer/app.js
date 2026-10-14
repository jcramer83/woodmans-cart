// --- State ---
let staples = [];
let manualItems = [];
let settings = {};
let editingStapleId = null;
let excludedCartIds = new Set();
let cartRunning = false;
let removeProgressListener = null;
let cartItemResults = {}; // { itemId: "ok"|"fail"|"skip" } — tracks per-item status during automation
let selectedTimeSlot = null; // { day, slot } — currently selected pickup time slot
let checkoutPreviewData = null; // cached checkout preview response
let cartOperationActive = false; // true when a cart fetch/remove/add is running (for progress routing)

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

  try {
    settings = (await appApi.loadSettings()) || {};
  } catch (e) { console.warn("Failed to load settings:", e); }
  try {
    staples = (await appApi.loadStaples()) || [];
  } catch (e) { console.warn("Failed to load staples:", e); }
  try {
    manualItems = (await appApi.loadManualItems()) || [];
  } catch (e) { console.warn("Failed to load manual items:", e); }

  // Validate loaded data (guard against API returning error objects)
  if (!Array.isArray(staples)) staples = [];
  if (!Array.isArray(manualItems)) manualItems = [];
  if (typeof settings !== "object" || settings === null || settings.error) settings = {};

  // Exclude all staples from cart on launch — user clicks "Add All to Cart" to include them
  for (const s of staples) {
    excludedCartIds.add("staple-" + s.id);
  }

  initDarkMode();
  restoreCollapsedSections();
  renderStaples();
  renderCart();
  updateModeBadge();
  updateTimeSlotsVisibility();
  bindEvents();

  // Auto-fetch online cart and time slots on load
  fetchOnlineCart();
  if ((settings.shoppingMode || "instore") === "pickup") {
    fetchTimeSlots();
  }

  // Listen for online cart updates pushed after automation completes
  appApi.onOnlineCartUpdate((items) => {
    renderOnlineCart(items);
  });

  // Listen for manual items updates from other clients (e.g. API)
  appApi.onManualItemsUpdate((items) => {
    manualItems = items || [];
    renderCart();
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

  // Online cart viewer
  document.getElementById("btn-import-cart").addEventListener("click", fetchOnlineCart);
  document.getElementById("btn-remove-all-online").addEventListener("click", removeAllOnlineCartItems);
  document.getElementById("btn-copy-cart").addEventListener("click", openCopyCartModal);
  document.getElementById("btn-copy-cart-confirm").addEventListener("click", executeCopyCart);

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

  // Mobile cart bar
  document.getElementById("mcb-start").addEventListener("click", () => {
    if (cartRunning) stopCartAutomation();
    else startCartAutomation();
  });
  document.getElementById("mcb-summary").addEventListener("click", () => {
    document.getElementById("cart-section").scrollIntoView({ behavior: "smooth", block: "start" });
  });

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
    const stapleSearchRow = document.getElementById("staple-search-row");
    const stapleResults = document.getElementById("staple-search-results");
    // (staple results are shown/hidden only via the "visible" class; never set inline display)
    if (stapleResults && stapleResults.classList.contains("visible")) {
      if (!e.target.closest("#staple-search-row") && !e.target.closest("#staple-search-results")) {
        stapleResults.classList.remove("visible");
      }
    }
    // Manual search: dismiss if click is outside the search row and results
    const manualResults = document.getElementById("manual-search-results");
    if (manualResults && manualResults.style.display !== "none") {
      if (!e.target.closest("#manual-search-row") && !e.target.closest("#manual-search-results")) {
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
  updateTimeSlotsVisibility();
  // Refresh online cart for new mode
  fetchOnlineCart();
  // Auto-fetch time slots when switching to pickup
  if (settings.shoppingMode === "pickup") {
    fetchTimeSlots();
  }
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
  content.closest(".section").classList.toggle("is-collapsed", content.classList.contains("collapsed"));
  // Persist state
  const collapsed = JSON.parse(localStorage.getItem("collapsedSections") || "{}");
  collapsed[sectionId] = content.classList.contains("collapsed");
  localStorage.setItem("collapsedSections", JSON.stringify(collapsed));
}

function restoreCollapsedSections() {
  const collapsed = JSON.parse(localStorage.getItem("collapsedSections") || "{}");
  // Staples start collapsed unless the user has expanded them before
  if (!("staples" in collapsed)) collapsed.staples = true;
  for (const [sectionId, isCollapsed] of Object.entries(collapsed)) {
    if (!isCollapsed) continue;
    const content = document.getElementById("section-" + sectionId);
    const btn = content ? content.closest(".section").querySelector(".collapse-btn") : null;
    if (content) {
      content.classList.add("collapsed");
      content.closest(".section").classList.add("is-collapsed");
    }
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
        <button onclick="addSingleStapleToCart('${s.id}')" title="Add to cart">&#128722;</button>
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

function addSingleStapleToCart(id) {
  excludedCartIds.delete("staple-" + id);
  renderCart();
  const s = staples.find((x) => x.id === id);
  if (s) showToast("Added " + (s.productName || s.item) + " to cart", "success");
}

// --- Staple search (inline) ---

let stapleSearchSeq = 0;
async function doStapleSearch() {
  const query = document.getElementById("staple-search-query").value.trim();
  if (!query) return;
  const seq = ++stapleSearchSeq;

  const resultsDiv = document.getElementById("staple-search-results");
  resultsDiv.style.display = "";
  resultsDiv.classList.add("visible");
  resultsDiv.innerHTML = skeletonHTML(3);
  document.getElementById("btn-staple-search").disabled = true;

  try {
    const products = await appApi.searchProducts(query);
    if (seq !== stapleSearchSeq) return; // a newer search started; drop this stale response

    if (!products || products.error) {
      resultsDiv.innerHTML = `<p class="empty-state">Error: ${esc((products && products.error) || "Search failed")}</p>`;
      return;
    }

    if (products.length === 0) {
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
    if (seq === stapleSearchSeq) resultsDiv.innerHTML = `<p class="empty-state">Error: ${esc(err.message)}</p>`;
  } finally {
    if (seq === stapleSearchSeq) document.getElementById("btn-staple-search").disabled = false;
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
  stapleSearchSeq++;
  document.getElementById("btn-staple-search").disabled = false;
  document.getElementById("staple-search-query").value = "";
  document.getElementById("staple-search-results").classList.remove("visible");
  document.getElementById("staple-search-query").focus();
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
  updateMobileCartBar(items.length, hasEstimate ? total : null);

  if (items.length === 0) {
    list.innerHTML = '<p class="empty-state">Cart is empty. Use Add Items or Weekly Staples to fill it.</p>';
  } else {
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
  }

  // Lock/unlock manual search and staple controls
  const manualSearchRow = document.getElementById("manual-search-row");
  if (manualSearchRow) manualSearchRow.style.display = cartRunning ? "none" : "flex";
  const manualResults = document.getElementById("manual-search-results");
  if (manualResults && cartRunning) manualResults.style.display = "none";
  document.getElementById("btn-clear-cart").style.display = cartRunning ? "none" : "inline-flex";
  document.getElementById("btn-add-all-staples").disabled = cartRunning;
}

function removeManualItem(id) {
  const realId = id.replace("manual-", "");
  manualItems = manualItems.filter((m) => m.id !== realId);
  appApi.removeManualItem(realId);
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
  appApi.clearManualItems();
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
  } else if (id.startsWith("manual-")) {
    const realId = id.replace("manual-", "");
    const m = manualItems.find((x) => x.id === realId);
    if (m) {
      m.quantity = Math.max(1, (m.quantity || 1) + delta);
      appApi.updateManualItem(realId, { quantity: m.quantity });
      renderCart();
    }
  }
}

// --- Mobile cart bar ---

function syncHeaderHeight() {
  const h = document.querySelector(".app-header");
  if (h) document.documentElement.style.setProperty("--header-h", h.offsetHeight + "px");
}
window.addEventListener("resize", syncHeaderHeight);
document.addEventListener("DOMContentLoaded", syncHeaderHeight);

let mcbLast = { count: 0, total: null };
function updateMobileCartBar(count, total) {
  if (count !== undefined) mcbLast = { count, total };
  const countEl = document.getElementById("mcb-count");
  if (!countEl) return;
  countEl.textContent = mcbLast.count + (mcbLast.count === 1 ? " item" : " items");
  document.getElementById("mcb-est").textContent = mcbLast.total != null ? "Est. $" + mcbLast.total.toFixed(2) : "";
  const btn = document.getElementById("mcb-start");
  document.body.classList.toggle("cart-running", cartRunning);
  btn.textContent = cartRunning ? "Stop" : "Add to Woodmans";
  btn.classList.toggle("btn-danger", cartRunning);
  btn.classList.toggle("btn-accent", !cartRunning);
  btn.disabled = !cartRunning && mcbLast.count === 0;
}

// --- Manual item product search (same pattern as staples) ---

let manualSearchSeq = 0;
async function doManualSearch() {
  const query = document.getElementById("manual-search-query").value.trim();
  if (!query) return;
  const seq = ++manualSearchSeq;

  const resultsDiv = document.getElementById("manual-search-results");
  resultsDiv.style.display = "block";
  resultsDiv.innerHTML = skeletonHTML(3);
  document.getElementById("btn-manual-search-go").disabled = true;

  try {
    const products = await appApi.searchProducts(query);
    if (seq !== manualSearchSeq) return; // stale response

    if (!products || products.error) {
      resultsDiv.innerHTML = `<p class="empty-state">Error: ${esc((products && products.error) || "Search failed")}</p>`;
      return;
    }

    if (products.length === 0) {
      resultsDiv.innerHTML = '<p class="empty-state">No products found. Try a different search.</p>';
      return;
    }

    resultsDiv.innerHTML = products
      .map(
        (p, i) => `
      <div class="product-result-row" onclick="selectManualProduct(${i})">
        ${p.image ? `<img class="product-result-thumb" src="${esc(p.image)}" alt="">` : '<span class="product-result-thumb placeholder">&#128722;</span>'}
        <div class="product-result-info">
          <div class="product-result-name">${esc(p.name)}</div>
          <div class="product-result-meta">${esc(p.price)}${p.size ? " - " + esc(p.size) : ""}</div>
        </div>
        <span class="product-result-add" aria-hidden="true">+ Add</span>
      </div>`
      )
      .join("");

    window._manualSearchResults = products;
  } catch (err) {
    if (seq === manualSearchSeq) resultsDiv.innerHTML = `<p class="empty-state">Error: ${esc(err.message)}</p>`;
  } finally {
    if (seq === manualSearchSeq) document.getElementById("btn-manual-search-go").disabled = false;
  }
}

async function selectManualProduct(index) {
  const products = window._manualSearchResults;
  if (!products || !products[index]) return;

  const p = products[index];
  await appApi.addManualItem({
    item: p.name,
    quantity: 1,
    price: p.price || "",
    image: p.image || "",
  });
  // Don't push locally — the WebSocket manual-items-update handler will update manualItems and re-render
  showToast("Added " + p.name + " to cart", "success");

  // Clear search
  manualSearchSeq++;
  document.getElementById("btn-manual-search-go").disabled = false;
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
      ${item.itemId ? `<button class="btn-icon btn-remove-online" onclick="removeOnlineCartItem('${esc(item.itemId)}')" title="Remove from cart">&times;</button>` : ""}
    </div>`
    )
    .join("");
}

async function removeOnlineCartItem(itemId) {
  const mode = settings.shoppingMode || "instore";
  try {
    const result = await appApi.removeOnlineCartItem(itemId, mode);
    if (result.error) {
      showToast("Failed to remove: " + result.error, "error");
    } else {
      showToast("Item removed", "success");
      importOnlineCart();
    }
  } catch (err) {
    showToast("Failed to remove: " + err.message, "error");
  }
}

async function fetchOnlineCart() {
  const btn = document.getElementById("btn-import-cart");
  btn.disabled = true;
  btn.textContent = "Loading...";

  document.getElementById("online-cart-list").innerHTML = "";
  showActivity("online-cart-activity", "online-cart-activity-status", "Fetching your Woodmans cart... (30-60s)");
  cartOperationActive = true;

  const statusLine = document.getElementById("cart-status-line");
  if (statusLine) { statusLine.textContent = ""; statusLine.className = "cart-status-line"; }

  // Listen for progress messages from the cart fetch
  if (removeProgressListener) removeProgressListener();
  removeProgressListener = appApi.onCartProgress((message) => {
    appendLog(message);
  });

  try {
    const result = await appApi.fetchCurrentCart(settings.shoppingMode || "instore");
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
    cartOperationActive = false;
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
  cartOperationActive = true;

  const statusLine = document.getElementById("cart-status-line");
  if (statusLine) { statusLine.textContent = ""; statusLine.className = "cart-status-line"; }

  if (removeProgressListener) removeProgressListener();
  removeProgressListener = appApi.onCartProgress((message) => {
    appendLog(message);
  });

  try {
    const result = await appApi.removeAllCartItems(settings.shoppingMode || "instore");
    if (result && result.error) {
      hideActivity("online-cart-activity", "online-cart-activity-status", "Error: " + result.error, "error");
    } else {
      renderOnlineCart([]);
      hideActivity("online-cart-activity", "online-cart-activity-status", "All items removed", "success");
    }
  } catch (err) {
    hideActivity("online-cart-activity", "online-cart-activity-status", "Error: " + err.message, "error");
  } finally {
    cartOperationActive = false;
    btn.disabled = false;
    btn.textContent = "Remove All";
    refreshBtn.disabled = false;
  }
}

// --- Copy Cart Between Modes ---

function openCopyCartModal() {
  if (cartRunning) {
    showToast("Cart automation is running. Please wait.", "error");
    return;
  }
  // Pre-select direction based on current mode
  const dirSelect = document.getElementById("copy-cart-direction");
  dirSelect.value = (settings.shoppingMode === "pickup") ? "pickup-instore" : "instore-pickup";
  document.getElementById("copy-cart-clear-source").checked = false;
  const statusEl = document.getElementById("copy-cart-status");
  statusEl.style.display = "none";
  statusEl.textContent = "";
  statusEl.className = "status-msg";
  document.getElementById("btn-copy-cart-confirm").disabled = false;
  showModal("modal-copy-cart");
}

async function executeCopyCart() {
  const dirValue = document.getElementById("copy-cart-direction").value;
  const parts = dirValue.split("-");
  const fromMode = parts[0];
  const toMode = parts[1];
  const clearSource = document.getElementById("copy-cart-clear-source").checked;
  const statusEl = document.getElementById("copy-cart-status");
  const confirmBtn = document.getElementById("btn-copy-cart-confirm");

  statusEl.style.display = "block";
  statusEl.textContent = "Starting...";
  statusEl.className = "status-msg loading";
  confirmBtn.disabled = true;

  // Listen for progress messages
  if (removeProgressListener) removeProgressListener();
  removeProgressListener = appApi.onCartProgress((message) => {
    statusEl.textContent = message;
  });

  try {
    const result = await appApi.copyCart({ fromMode, toMode, clearSource });
    if (result && result.error) {
      statusEl.textContent = "Error: " + result.error;
      statusEl.className = "status-msg error";
    } else {
      statusEl.textContent = "Copied " + (result.copied || 0) + " item(s)" + (result.cleared ? " and cleared source cart" : "") + "!";
      statusEl.className = "status-msg success";
      // Update settings to reflect destination mode
      settings.shoppingMode = toMode;
      await appApi.saveSettings(settings);
      updateModeBadge();
      showToast("Copied " + (result.copied || 0) + " items to " + (toMode === "pickup" ? "Pickup" : "In-Store") + " cart", "success");
      // Auto-close after short delay
      setTimeout(() => hideModal("modal-copy-cart"), 1500);
    }
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.className = "status-msg error";
  } finally {
    confirmBtn.disabled = false;
  }
}

// --- Pickup Time Slots & Checkout Preview ---

function updateTimeSlotsVisibility() {
  const section = document.getElementById("section-timeslots");
  if (!section) return;
  const mode = settings.shoppingMode || "instore";
  section.style.display = mode === "pickup" ? "" : "none";
  const label = document.getElementById("timeslot-header-label");
  if (label) label.textContent = mode === "pickup" ? "Pickup Time" : "Delivery Time";
}

async function fetchTimeSlots() {
  const container = document.getElementById("timeslots-container");
  const loading = document.getElementById("timeslots-loading");
  if (!container) return;

  loading.classList.add("active");
  container.innerHTML = "";

  // Clear any stale progress text
  const statusLine = document.getElementById("cart-status-line");

  try {
    const mode = settings.shoppingMode || "instore";
    const slotsData = await appApi.fetchTimeSlots(mode).catch(() => null);

    if (slotsData && slotsData._pickupFromServiceChooser) {
      // Fallback: time slot API didn't return selectable slots
      const sc = slotsData.serviceChooser;
      const pickupInfo = sc && sc.service_types
        ? sc.service_types.find(function(st) { return st.service_type === "pickup" || st.type === "active"; })
        : null;
      let msg = slotsData._errorMsg || "";
      if (!msg && pickupInfo && pickupInfo.bottom_text) {
        msg = pickupInfo.bottom_text;
      }
      if (!msg) {
        msg = "Pickup available — check Woodmans site for times";
      }
      container.innerHTML = '<div class="pickup-info-card">' +
        '<div class="pickup-info-label">Pickup Info</div>' +
        '<div class="pickup-info-value">' + esc(msg) + '</div></div>';
    } else if (slotsData && !slotsData.error) {
      renderTimeSlots(slotsData, container);
    } else {
      container.innerHTML = '<p class="empty-state">' + esc((slotsData && slotsData.error) || "Failed to load time slots") + '</p>';
    }
  } catch (err) {
    container.innerHTML = '<p class="empty-state">Failed to load time slots</p>';
  } finally {
    loading.classList.remove("active");
    if (statusLine) { statusLine.textContent = ""; statusLine.className = "cart-status-line"; }
  }
}

function renderTimeSlots(data, container) {
  const tiers = data.tiers || [];
  const days = data.days || [];

  if (days.length === 0) {
    const errorMod = data.error_module;
    if (errorMod) {
      container.innerHTML = '<p class="empty-state">' + esc(errorMod.title || "No time slots available") +
        (errorMod.description_lines ? '<br>' + errorMod.description_lines.map(esc).join('<br>') : '') + '</p>';
    } else {
      container.innerHTML = '<p class="empty-state">No time slots available. Add items to Woodmans cart first.</p>';
    }
    return;
  }

  let html = '';
  for (const day of days) {
    const dayLabel = day.day_full || day.date || day.day || "Unknown";
    // Instacart uses "options" array, not "slots"
    const options = day.options || day.slots || day.windows || [];
    if (options.length === 0) continue;

    html += '<div class="timeslot-day">';
    html += '<div class="timeslot-day-label">' + esc(dayLabel) + '</div>';
    html += '<div class="timeslot-slots">';

    for (const opt of options) {
      const label = opt.window || opt.formatted_time_range || opt.label || "";
      const attrs = opt.attributes || [];
      const available = attrs.includes("available");
      const optionId = opt.id || opt.option_id || "";
      const isSelected = selectedTimeSlot && selectedTimeSlot.optionId === optionId;
      const price = opt.price || "";

      html += '<div class="timeslot-chip' +
        (isSelected ? ' selected' : '') +
        (!available ? ' unavailable' : '') +
        '" onclick="' + (available ? "selectTimeSlot('" + esc(optionId) + "','" + esc(label) + "','" + esc(dayLabel) + "','" + esc(price) + "')" : "") +
        '" title="' + esc(opt.pickup_full_window || opt.full_window || label) + '">' +
        esc(label) +
        (price ? '<span class="timeslot-price">' + esc(price) + '</span>' : '') +
        '</div>';
    }

    html += '</div></div>';
  }

  if (!html) {
    container.innerHTML = '<p class="empty-state">No time slots available right now.</p>';
  } else {
    container.innerHTML = html;
  }
}

async function selectTimeSlot(optionId, label, dayLabel, price) {
  selectedTimeSlot = { optionId, label, dayLabel, price: price || "" };
  const selectedEl = document.getElementById("timeslot-selected");
  if (selectedEl) selectedEl.textContent = dayLabel + " " + label;
  // Re-render to update selected state
  const container = document.getElementById("timeslots-container");
  if (container) {
    container.querySelectorAll(".timeslot-chip").forEach(function (chip) {
      chip.classList.remove("selected");
    });
    container.querySelectorAll(".timeslot-chip").forEach(function (chip) {
      if (chip.getAttribute("onclick") && chip.getAttribute("onclick").includes(optionId)) {
        chip.classList.add("selected");
      }
    });
  }
  // Actually select the time slot on Woodmans
  const mode = settings.shoppingMode || "instore";
  const statusLine = document.getElementById("cart-status-line");
  try {
    const result = await appApi.selectTimeSlot(optionId, mode);
    if (result.error) {
      showToast("Failed to select: " + result.error, "error");
    } else {
      showToast("Selected: " + dayLabel + " " + label, "success");
    }
  } catch (err) {
    showToast("Selected locally: " + dayLabel + " " + label, "success");
  } finally {
    if (statusLine) { statusLine.textContent = ""; statusLine.className = "cart-status-line"; }
  }
}

async function openCheckoutPreview() {
  showModal("modal-checkout");
  const body = document.getElementById("checkout-preview-body");
  body.innerHTML = '<div class="checkout-loading">Loading checkout details...</div>';

  try {
    const mode = settings.shoppingMode || "instore";
    const data = await appApi.fetchCheckoutPreview(mode);
    if (data.error) {
      body.innerHTML = '<div class="checkout-loading">' + esc(data.error) + '</div>';
      return;
    }
    checkoutPreviewData = data;
    renderCheckoutPreview(data, body);
  } catch (err) {
    body.innerHTML = '<div class="checkout-loading">Failed to load: ' + esc(err.message) + '</div>';
  } finally {
    const statusLine = document.getElementById("cart-status-line");
    if (statusLine) { statusLine.textContent = ""; statusLine.className = "cart-status-line"; }
  }
}

function renderCheckoutPreview(data, body) {
  const cartItems = data.cartItems || [];
  const serviceChooser = data.serviceChooser;
  const checkoutTotals = data.checkoutTotals;

  if (cartItems.length === 0) {
    body.innerHTML = '<div class="checkout-warning">Your Woodmans online cart is empty.</div>' +
      '<p class="empty-state">Use "Add to Woodmans Cart" first, then come back to preview checkout.</p>';
    return;
  }

  const currentMode = settings.shoppingMode || "instore";
  const isPickup = currentMode === "pickup";
  const activeServiceType = isPickup ? "pickup" : "delivery";

  // Update Place Order button state
  var placeBtn = document.getElementById("btn-place-order");
  if (placeBtn) {
    if (isPickup) {
      placeBtn.disabled = false;
      placeBtn.style.opacity = "";
      placeBtn.title = "";
    } else {
      placeBtn.disabled = true;
      placeBtn.style.opacity = "0.4";
      placeBtn.title = "Order placement is only available in pickup mode";
    }
  }

  let html = '';

  // Service type
  html += '<div class="checkout-section"><div class="checkout-section-title">Service Type</div>';
  html += '<div class="checkout-section-value" style="font-weight:600;">' + (isPickup ? 'Pickup' : 'In-Store') + '</div>';
  if (serviceChooser && serviceChooser.service_types) {
    var activeType = serviceChooser.service_types.find(function(st) { return st.type === "active"; });
    if (activeType && activeType.bottom_text) {
      html += '<div class="checkout-section-value" style="color:#888;font-size:13px;">' + esc(activeType.bottom_text) + '</div>';
    }
  }
  if (!isPickup) {
    html += '<div class="checkout-section-value" style="color:#e74c3c;font-size:13px;">Switch to Pickup mode to place orders</div>';
  }
  html += '</div>';

  // Selected time slot
  if (selectedTimeSlot) {
    html += '<div class="checkout-section"><div class="checkout-section-title">Selected ' +
      (activeServiceType === "pickup" ? "Pickup" : "Delivery") + ' Time</div>' +
      '<div class="checkout-section-value">' + esc(selectedTimeSlot.dayLabel + " " + selectedTimeSlot.label) +
      (selectedTimeSlot.price ? ' <span style="color:#888;">(' + esc(selectedTimeSlot.price) + ' fee)</span>' : '') +
      '</div></div>';
  } else {
    html += '<div class="checkout-section"><div class="checkout-section-title">Selected Time</div>' +
      '<div class="checkout-section-value" style="color:#e74c3c;">No time slot selected — choose one above before placing order</div></div>';
  }

  // Cart items summary
  html += '<div class="checkout-section"><div class="checkout-section-title">Items (' + cartItems.length + ')</div>';
  html += '<div class="checkout-section-value" style="max-height:200px;overflow-y:auto;">';
  for (const item of cartItems) {
    html += '<div class="item-row" style="padding:4px 0;">';
    if (item.image) html += '<img class="item-thumb" src="' + esc(item.image) + '" alt="" style="width:28px;height:28px;">';
    html += '<div class="item-info"><div class="item-name" style="font-size:13px;">' + esc(item.name || item.item || "") + '</div>';
    html += '<div class="item-detail">' + (item.size ? esc(item.size) + ' - ' : '') + esc(item.price || "") + '</div></div>';
    html += '<span class="item-qty">x' + (item.quantity || 1) + '</span>';
    html += '</div>';
  }
  html += '</div></div>';

  // Order totals
  html += '<div class="checkout-section"><div class="checkout-section-title">Order Summary</div>';
  html += '<div class="checkout-totals">';

  // Check if we have real totals from Woodmans (must have line_items with actual values AND a total)
  var hasRealTotals = checkoutTotals && checkoutTotals.line_items && checkoutTotals.line_items.length > 0
    && checkoutTotals.total && parsePrice(checkoutTotals.total.value) > 0;

  // Always calculate subtotal from cart items as baseline
  var subtotal = 0;
  for (var i = 0; i < cartItems.length; i++) {
    var p = parsePrice(cartItems[i].price);
    if (p > 0) subtotal += p * (cartItems[i].quantity || 1);
  }

  var slotFee = selectedTimeSlot ? parsePrice(selectedTimeSlot.price) : 0;
  var feeLabel = activeServiceType === "pickup" ? "Pickup fee" : "Delivery fee";

  if (hasRealTotals) {
    // Real totals from Woodmans checkout API
    for (var j = 0; j < checkoutTotals.line_items.length; j++) {
      var li = checkoutTotals.line_items[j];
      if (!li.value) continue;
      html += '<div class="checkout-total-row"><span>' + esc(li.label || "") + '</span><span>' + esc(li.value) + '</span></div>';
    }
    if (slotFee > 0) {
      html += '<div class="checkout-total-row"><span>' + feeLabel + '</span><span>$' + slotFee.toFixed(2) + '</span></div>';
    }
    if (checkoutTotals.explicit_tip && activeServiceType === "delivery") {
      var tipVal = checkoutTotals.explicit_tip.display_value;
      var tipStr = tipVal && tipVal.strings && tipVal.strings[0] ? tipVal.strings[0].value : "";
      if (tipStr) {
        html += '<div class="checkout-total-row"><span>' + esc(checkoutTotals.explicit_tip.label || "Tip") + '</span><span>' + esc(tipStr) + '</span></div>';
      }
    }
    var woodmansTotal = parsePrice(checkoutTotals.total.value);
    var tipAmount = (checkoutTotals.explicit_tip && activeServiceType === "delivery") ? (checkoutTotals.selected_amounts?.initial_tip || 0) : 0;
    html += '<div class="checkout-total-row total-final"><span>Total</span><span>$' + (woodmansTotal + slotFee + tipAmount).toFixed(2) + '</span></div>';
  } else {
    // Fallback: use cart item prices
    html += '<div class="checkout-total-row"><span>Subtotal (' + cartItems.length + ' items)</span><span>$' + subtotal.toFixed(2) + '</span></div>';
    if (slotFee > 0) {
      html += '<div class="checkout-total-row"><span>' + feeLabel + '</span><span>$' + slotFee.toFixed(2) + '</span></div>';
    }
    html += '<div class="checkout-total-row total-final"><span>Estimated Total</span><span>$' + (subtotal + slotFee).toFixed(2) + '</span></div>';
  }
  html += '</div></div>';

  body.innerHTML = html;
}

async function placeOrder() {
  if (!selectedTimeSlot) {
    showToast("Select a pickup/delivery time slot first", "error");
    return;
  }
  if (!confirm("Place this order? Your payment method on file will be charged.")) return;

  const btn = document.getElementById("btn-place-order");
  btn.disabled = true;
  btn.textContent = "Placing order...";
  const body = document.getElementById("checkout-preview-body");

  try {
    const mode = settings.shoppingMode || "instore";
    const result = await appApi.placeOrder(mode, selectedTimeSlot.optionId);
    if (result.error) {
      showToast("Order failed: " + result.error, "error");
      btn.textContent = "Place Order";
      btn.disabled = false;
    } else {
      btn.textContent = "Order Placed!";
      btn.className = "btn";
      btn.style.background = "#2e7d32";
      btn.style.color = "#fff";
      showToast("Order placed successfully!", "success");
      // Refresh the online cart (it should be empty now)
      if (typeof importOnlineCart === "function") importOnlineCart();
    }
  } catch (err) {
    showToast("Order failed: " + err.message, "error");
    btn.textContent = "Place Order";
    btn.disabled = false;
  } finally {
    const statusLine = document.getElementById("cart-status-line");
    if (statusLine) { statusLine.textContent = ""; statusLine.className = "cart-status-line"; }
  }
}

// --- Cart Automation ---

async function startCartAutomation() {
  const items = getCartItems().filter((item) => !excludedCartIds.has(item.id));
  if (items.length === 0) {
    alert("No items in the cart. Add staples or search to add items.");
    return;
  }

  cartRunning = true;
  cartOperationActive = true;
  cartItemResults = {};
  document.getElementById("btn-start-cart").style.display = "none";
  document.getElementById("btn-stop-cart").style.display = "inline-flex";
  updateMobileCartBar();
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

  } finally {
    cartRunning = false;
    cartOperationActive = false;
    document.getElementById("btn-start-cart").style.display = "inline-flex";
    document.getElementById("btn-stop-cart").style.display = "none";
    updateMobileCartBar();
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
    cartOperationActive = false;
  document.getElementById("btn-start-cart").style.display = "inline-flex";
  document.getElementById("btn-stop-cart").style.display = "none";
  updateMobileCartBar();
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
  // Route to cart area only when a cart operation is actually in progress,
  // otherwise show in the main status line below checkout preview
  if (cartOperationActive) {
    var cartStatus = document.getElementById("online-cart-activity-status");
    if (cartStatus) {
      cartStatus.textContent = cleaned;
      cartStatus.className = "activity-status active";
    }
  } else {
    var statusLine = document.getElementById("cart-status-line");
    if (statusLine) {
      statusLine.textContent = cleaned;
      statusLine.className = "cart-status-line active";
    }
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

  if (type !== "staple") return;
  const [moved] = staples.splice(fromIndex, 1);
  staples.splice(index, 0, moved);
  appApi.saveStaples(staples);
  renderStaples();
  renderCart();
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
window.addSingleStapleToCart = addSingleStapleToCart;
window.selectStapleSearchResult = selectStapleSearchResult;
window.removeManualItem = removeManualItem;
window.removeCartItem = removeCartItem;
window.changeCartQty = changeCartQty;
window.selectManualProduct = selectManualProduct;
window.toggleShoppingMode = toggleShoppingMode;
window.toggleDarkMode = toggleDarkMode;
window.toggleSection = toggleSection;
window.dragStartItem = dragStartItem;
window.dragOverItem = dragOverItem;
window.dragLeaveItem = dragLeaveItem;
window.dropItem = dropItem;
window.dragEndItem = dragEndItem;
window.openCopyCartModal = openCopyCartModal;
window.executeCopyCart = executeCopyCart;
window.fetchTimeSlots = fetchTimeSlots;
window.selectTimeSlot = selectTimeSlot;
window.openCheckoutPreview = openCheckoutPreview;
window.placeOrder = placeOrder;
window.removeOnlineCartItem = removeOnlineCartItem;
