// In-store shopping mode. The list, checks, and timer live on the server so a
// reload or a locked phone comes back to the same trip.

(function () {
  var shopTrip = null;
  var shopView = "list";
  var shopLayout = null;
  var shopHistory = [];
  var shopDoneOpen = false;
  var shopSheet = false;
  var openTripId = null;
  var leaving = Object.create(null);
  var leaveCount = 0;
  var toastTimer = null;
  var wakeLock = null;
  var opening = false;
  var shopScrollY = 0;
  var shopDensity = "compact";

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function priceAmount(value) {
    var match = String(value == null ? "" : value).replace(/,/g, "").match(/(\d+\.\d+|\d+)/);
    return match ? parseFloat(match[1]) : 0;
  }

  function money(amount) {
    return "$" + (Math.round(amount * 100) / 100).toFixed(2);
  }

  function formatClock(ms) {
    var seconds = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  function formatMinutes(totalSeconds) {
    var seconds = Math.max(0, Math.round(totalSeconds));
    if (seconds < 90) return seconds + "s";
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + " min";
    var hours = Math.floor(minutes / 60);
    return hours + "h " + (minutes % 60) + "m";
  }

  function tripTotal(trip) {
    if (!trip || !trip.items) return 0;
    return trip.items.reduce(function (sum, item) {
      return sum + priceAmount(item.price) * (item.quantity || 1);
    }, 0);
  }

  function checkedCount(trip) {
    if (!trip || !trip.items) return 0;
    return trip.items.filter(function (item) { return item.checked; }).length;
  }

  function chipText(item) {
    if (item.shelfLabel && item.aisle != null) return item.shelfLabel;
    if (item.shelfLabel) return item.shelfLabel;
    if (item.location && item.location !== item.sectionLabel) return item.location;
    return "";
  }

  function localKey(tripId) {
    return "woodmans-shop-checks:" + tripId;
  }

  function readLocal(tripId) {
    try { return JSON.parse(localStorage.getItem(localKey(tripId))) || {}; }
    catch (err) { return {}; }
  }

  function writeLocal(tripId, itemId, checked) {
    var map = readLocal(tripId);
    map[itemId] = !!checked;
    try { localStorage.setItem(localKey(tripId), JSON.stringify(map)); } catch (err) {}
  }

  function writeAllLocal(trip) {
    var map = {};
    (trip.items || []).forEach(function (item) { map[item.id] = !!item.checked; });
    try { localStorage.setItem(localKey(trip.id), JSON.stringify(map)); } catch (err) {}
  }

  function clearLocal(tripId) {
    try { localStorage.removeItem(localKey(tripId)); } catch (err) {}
  }

  async function reconcile(trip) {
    if (!trip || !trip.id) return trip;
    var local = readLocal(trip.id);
    var jobs = [];
    (trip.items || []).forEach(function (item) {
      if (Object.prototype.hasOwnProperty.call(local, item.id) && !!local[item.id] !== !!item.checked) {
        item.checked = !!local[item.id];
        jobs.push(item.id);
      }
    });
    for (var i = 0; i < jobs.length; i++) {
      try { await appApi.setShoppingCheck(jobs[i], !!local[jobs[i]]); }
      catch (err) {}
    }
    writeAllLocal(trip);
    return trip;
  }

  function icon(name) {
    if (name === "back") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 L8 12 L15 19"/></svg>';
    if (name === "check") return '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="5 12 10 17 19 7"/></svg>';
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6 L18 18 M18 6 L6 18"/></svg>';
  }

  function showToast(message) {
    var el = document.getElementById("shop-toast");
    if (!el) return;
    el.hidden = false;
    el.textContent = message;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2400);
  }

  async function acquireWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", function () { wakeLock = null; });
    } catch (err) {
      wakeLock = null;
    }
  }

  function releaseWakeLock() {
    if (!wakeLock) return;
    wakeLock.release().catch(function () {});
    wakeLock = null;
  }

  function screenEl() { return document.getElementById("shop-screen"); }

  // iOS Safari's layout viewport is taller than the visible screen while the
  // address bar is up, and a home-screen app draws under the notch. Pin the
  // overlay to the visual viewport so it is edge to edge in both.
  function fitShopScreen() {
    var screen = screenEl();
    if (!screen || screen.hidden) return;
    var vv = window.visualViewport;
    if (!vv) return;
    screen.style.top = vv.offsetTop + "px";
    screen.style.left = vv.offsetLeft + "px";
    screen.style.width = vv.width + "px";
    screen.style.height = vv.height + "px";
    screen.style.right = "auto";
    screen.style.bottom = "auto";
  }

  function clearShopScreenFit() {
    var screen = screenEl();
    if (!screen) return;
    screen.style.top = "";
    screen.style.left = "";
    screen.style.width = "";
    screen.style.height = "";
    screen.style.right = "";
    screen.style.bottom = "";
  }

  function openScreen() {
    var screen = screenEl();
    if (!screen) return;
    shopScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    screen.hidden = false;
    document.documentElement.classList.add("shop-open");
    document.body.classList.add("shop-open");
    document.body.style.top = (-shopScrollY) + "px";
    fitShopScreen();
    acquireWakeLock();
    render();
    updateResume();
    syncThemeColor();
  }

  function closeScreen() {
    var screen = screenEl();
    if (screen) screen.hidden = true;
    document.documentElement.classList.remove("shop-open");
    document.body.classList.remove("shop-open");
    document.body.style.top = "";
    clearShopScreenFit();
    shopSheet = false;
    releaseWakeLock();
    window.scrollTo(0, shopScrollY);
    updateResume();
    syncThemeColor();
  }

  var LIST_HIDDEN_KEY = "woodmans-list-hidden";

  function listCardHidden() {
    try { return !!(shopTrip && localStorage.getItem(LIST_HIDDEN_KEY) === shopTrip.id); }
    catch (e) { return false; }
  }

  function updateResume() {
    var wrap = document.getElementById("shop-resume-wrap");
    var banner = document.getElementById("shop-resume");
    var active = shopTrip && shopTrip.items && shopTrip.items.length;
    if (!wrap || !banner) return;
    if (wrap.classList.contains("is-dragging") || wrap.classList.contains("is-dismissing")) return;
    if (!active || document.body.classList.contains("shop-open") || listCardHidden()) {
      wrap.hidden = true;
      return;
    }
    var done = shopTrip.items.filter(function (item) { return item.checked; }).length;
    var time = shopTrip.startedAt
      ? formatClock(Date.now() - new Date(shopTrip.startedAt).getTime())
      : "Ready";
    wrap.hidden = false;
    var thumbs = shopTrip.items.slice(0, 3).map(function (item) {
      var src = item.image || (window.bundledThumb && window.bundledThumb(item.name));
      return src ? '<img src="' + esc(src) + '" alt="">' : "";
    }).join("");
    banner.innerHTML = '<span class="shop-resume-copy"><span class="shop-resume-kicker">Shopping list</span><strong>' +
      done + " of " + shopTrip.items.length + "</strong></span><span class=\"shop-resume-side\">" +
      (thumbs ? '<span class="shop-resume-thumbs">' + thumbs + "</span>" : "") +
      '<span class="shop-resume-time">' + esc(time) + "</span></span>";
  }

  function hideShoppingList() {
    if (shopTrip && shopTrip.id) {
      try { localStorage.setItem(LIST_HIDDEN_KEY, shopTrip.id); } catch (e) {}
    }
    var wrap = document.getElementById("shop-resume-wrap");
    if (wrap) {
      wrap.hidden = true;
      wrap.classList.remove("is-dismissing");
      wrap.style.transition = "";
      wrap.style.transform = "";
      wrap.style.opacity = "";
    }
  }

  function revealShoppingList() {
    try { localStorage.removeItem(LIST_HIDDEN_KEY); } catch (e) {}
    updateResume();
  }

  function paintProgress() {
    if (!shopTrip) return;
    var total = shopTrip.items.length;
    var done = checkedCount(shopTrip);
    var count = document.getElementById("shop-count");
    if (count) count.innerHTML = "<b>" + done + "</b><span> of " + total + "</span>";
    var bar = document.getElementById("shop-bar-fill");
    if (bar) bar.style.width = (total ? (done / total) * 100 : 0) + "%";
    var doneLabel = document.getElementById("shop-done-count");
    if (doneLabel) doneLabel.textContent = done + " checked";
    var toggle = document.getElementById("shop-done-toggle");
    if (toggle) toggle.hidden = done === 0;
  }

  function tickClock() {
    updateResume();
    var face = document.getElementById("shop-elapsed");
    var timer = document.getElementById("shop-timer");
    if (!face || !shopTrip) return;
    if (!shopTrip.startedAt) {
      face.textContent = "Ready";
      if (timer) timer.classList.remove("is-live");
      return;
    }
    face.textContent = formatClock(Date.now() - new Date(shopTrip.startedAt).getTime());
    if (timer) timer.classList.add("is-live");
  }

  function renderRow(item, done) {
    var chip = chipText(item);
    var photoSrc = item.image || (window.bundledThumb && window.bundledThumb(item.name));
    var photo = photoSrc
      ? '<img class="shop-photo" src="' + esc(photoSrc) + '" alt="">'
      : "";
    var badge = (item.quantity || 1) > 1
      ? '<span class="shop-qty-badge">×' + esc(item.quantity) + "</span>"
      : "";
    var checked = done || item.checked ? " is-checked" : "";
    return '<button type="button" class="shop-row' + checked + '" data-action="toggle" data-id="' + esc(item.id) + '">' +
      '<span class="shop-photo-wrap"><span class="shop-photo-fallback">' + esc((item.name || "?").slice(0, 1)) + "</span>" +
      photo + badge + "</span>" +
      '<span class="shop-copy"><span class="shop-name">' + esc(item.name) + "</span>" +
      '<span class="shop-meta">' +
      (chip ? '<span class="shop-aisle">' + esc(chip) + "</span>" : "") +
      '<span class="shop-qty-text">×' + esc(item.quantity || 1) + "</span>" +
      (item.price ? '<span class="shop-price">' + esc(item.price) + "</span>" : "") +
      (item.size ? '<span class="shop-size">' + esc(item.size) + "</span>" : "") +
      "</span></span>" +
      '<span class="shop-check" aria-hidden="true">' + icon("check") + "</span></button>";
  }

  function groupOpen(items) {
    var groups = [];
    items.forEach(function (item) {
      var last = groups[groups.length - 1];
      if (!last || last.key !== item.sectionKey) {
        last = { key: item.sectionKey, label: item.sectionLabel, items: [] };
        groups.push(last);
      }
      last.items.push(item);
    });
    return groups.map(function (group) {
      return '<section><h2 class="shop-group-label"><span>' + esc(group.label) + "</span><em>" +
        group.items.length + "</em></h2>" +
        group.items.map(function (item) { return renderRow(item, false); }).join("") +
        "</section>";
    }).join("");
  }

  function renderHeader() {
    var header = document.getElementById("shop-header");
    if (!header) return;
    if (shopView === "list") {
      var total = shopTrip && shopTrip.items ? shopTrip.items.length : 0;
      var done = checkedCount(shopTrip);
      var estimate = shopTrip ? money(tripTotal(shopTrip)) : "";
      var place = shopDensity === "compact" ? "In-store" : ("In-store · Racine" + (estimate && total ? " · " + estimate : ""));
      header.innerHTML =
        '<div class="shop-header-row">' +
          '<button type="button" class="shop-icon-btn" data-action="close" aria-label="Close shopping">' + icon("close") + "</button>" +
          '<div class="shop-heading"><div class="shop-kicker">' + place + "</div>" +
          '<div class="shop-count" id="shop-count" aria-live="polite"><b>' + done + "</b><span> of " + total + "</span></div></div>" +
          '<button type="button" class="shop-density" data-action="density" aria-pressed="' + (shopDensity === "compact" ? "true" : "false") + '">' +
            (shopDensity === "compact" ? "Compact" : "Comfortable") + "</button>" +
          '<div class="shop-timer" id="shop-timer"><span class="shop-dot"></span><span id="shop-elapsed">Ready</span></div>' +
        "</div>" +
        '<div class="shop-bar" aria-hidden="true"><div class="shop-bar-fill" id="shop-bar-fill" style="width:' +
          (total ? (done / total) * 100 : 0) + '%"></div></div>';
      tickClock();
      return;
    }
    var title = shopView === "history" ? "Trips" : "Walk order";
    var kicker = shopView === "history" ? "Time, spend, pace" : "Racine store";
    header.innerHTML =
      '<div class="shop-header-row">' +
        '<button type="button" class="shop-icon-btn" data-action="back" aria-label="Back to the list">' + icon("back") + "</button>" +
        '<div class="shop-heading"><div class="shop-kicker">' + kicker + '</div><div class="shop-title">' + title + "</div></div>" +
      "</div>";
  }

  function renderList() {
    var scroll = document.getElementById("shop-scroll");
    if (!scroll) return;
    var top = scroll.scrollTop;
    if (!shopTrip || !shopTrip.items || !shopTrip.items.length) {
      scroll.innerHTML =
        '<div class="shop-empty"><img src="/assets/empty-cart.png" alt="">' +
        "<h2>No list yet</h2><p>Refresh the Woodman's cart in In-Store mode, then start here. Aisle labels come from that cart.</p></div>";
      return;
    }
    var located = shopTrip.items.some(function (item) { return item.location; });
    var banner = located ? "" :
      '<div class="shop-banner">No aisle labels on this list. Switch to In-Store and refresh the Woodman\'s cart so each item picks up its shelf.</div>';
    scroll.innerHTML = banner + groupOpen(shopTrip.items) +
      '<button type="button" class="shop-update" data-action="rebuild">Update from Woodman\'s cart</button>';
    scroll.scrollTop = top;
  }

  function weekStart(date) {
    var day = new Date(date);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - day.getDay());
    return day;
  }

  function weekBuckets(trips) {
    var start = weekStart(new Date());
    var weeks = [];
    for (var i = 7; i >= 0; i--) {
      var begin = new Date(start.getTime() - i * 7 * 86400000);
      var end = begin.getTime() + 7 * 86400000;
      var list = trips.filter(function (trip) {
        var ms = new Date(trip.endedAt).getTime();
        return ms >= begin.getTime() && ms < end;
      });
      var seconds = 0;
      var spend = 0;
      var items = 0;
      list.forEach(function (trip) {
        seconds += (trip.durationMs || 0) / 1000;
        spend += trip.totalPrice || 0;
        items += trip.itemCount || 0;
      });
      weeks.push({
        label: (begin.getMonth() + 1) + "/" + begin.getDate(),
        trips: list.length,
        seconds: seconds,
        spend: spend,
        items: items,
        pace: items ? seconds / items : 0,
      });
    }
    return weeks;
  }

  function chartSvg(weeks, key, color) {
    var max = 0;
    weeks.forEach(function (week) { if (week[key] > max) max = week[key]; });
    if (max <= 0) max = 1;
    var w = 320;
    var h = 88;
    var gap = 8;
    var bw = (w - gap * (weeks.length - 1)) / weeks.length;
    var shapes = weeks.map(function (week, index) {
      var value = week[key] || 0;
      var bh = value ? Math.max(4, (value / max) * (h - 18)) : 2;
      var x = index * (bw + gap);
      var y = h - 16 - bh;
      return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + bh.toFixed(1) + '" rx="3" fill="' + color + '" opacity="' + (value ? "1" : "0.35") + '"></rect>' +
        '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (h - 3) + '" text-anchor="middle">' + esc(week.label) + "</text>";
    }).join("");
    return '<svg class="shop-chart" viewBox="0 0 ' + w + " " + h + '" role="img">' + shapes + "</svg>";
  }

  function renderHistory() {
    var scroll = document.getElementById("shop-scroll");
    if (!scroll) return;
    var trips = shopHistory || [];
    var weeks = weekBuckets(trips);
    var current = weeks[weeks.length - 1];
    var previous = weeks[weeks.length - 2];
    var paceDelta = previous.pace && current.pace ? previous.pace - current.pace : 0;
    var delta = "";
    if (current.trips && previous.trips && paceDelta) {
      var faster = paceDelta > 0;
      delta = '<p class="shop-delta' + (faster ? " is-good" : "") + '">' +
        Math.abs(Math.round(paceDelta)) + "s " + (faster ? "faster" : "slower") +
        " per item than last week.</p>";
    } else if (!trips.length) {
      delta = '<p class="shop-delta">Finish a trip and the week-to-week charts fill in here.</p>';
    }
    var cards =
      '<div class="shop-compare">' +
        statCard("This week", current) +
        statCard("Last week", previous) +
      "</div>" + delta +
      chartCard("Time per week", weeks, "seconds", "#b71c1c", function (week) {
        return week.trips ? formatMinutes(week.seconds) : "—";
      }) +
      chartCard("Spend per week", weeks, "spend", "#1b7f4a", function (week) {
        return week.trips ? money(week.spend) : "—";
      }) +
      chartCard("Seconds per item", weeks, "pace", "#c47b12", function (week) {
        return week.items ? Math.round(week.pace) + "s" : "—";
      });

    var note = "";
    if (shopTrip && shopTrip.startedAt) {
      note = '<div class="shop-banner">This trip is still going · ' +
        formatClock(Date.now() - new Date(shopTrip.startedAt).getTime()) + " · " +
        checkedCount(shopTrip) + " of " + shopTrip.items.length + " checked. End it to save the numbers.</div>";
    }

    var rows = trips.map(function (trip) {
      var when = new Date(trip.endedAt);
      var date = when.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      var pace = trip.itemCount ? Math.round((trip.durationMs || 0) / 1000 / trip.itemCount) : 0;
      var open = openTripId === trip.id;
      var detail = "";
      if (open) {
        detail = '<div class="trip-detail">' + (trip.items || []).map(function (item) {
          return '<div class="trip-detail-row' + (item.checked ? "" : " is-skipped") + '"><span><span class="trip-detail-name">' +
            (item.checked ? "✓ " : "– ") + esc(item.name) + "</span><br><span class=\"trip-detail-where\">" +
            esc(item.sectionLabel || item.location || "Other") + " · ×" + esc(item.quantity || 1) +
            "</span></span><span>" + esc(item.price || "") + "</span></div>";
        }).join("") + "</div>";
      }
      return '<button type="button" class="trip-card" data-action="trip" data-id="' + esc(trip.id) + '">' +
        '<span class="trip-date">' + esc(date) + "</span>" +
        '<span class="trip-line">' + formatClock(trip.durationMs || 0) + " · " + money(trip.totalPrice || 0) +
        " · " + (trip.checkedCount || 0) + "/" + (trip.itemCount || 0) + " checked</span>" +
        '<span class="trip-line">' + (trip.skippedCount || 0) + " skipped · " + pace + "s per item</span></button>" + detail;
    }).join("");

    scroll.innerHTML = note + cards + (rows || '<div class="shop-empty"><h2>No trips yet</h2><p>End a shopping trip and it lands here with the time, the total, and what you skipped.</p></div>');
  }

  function statCard(title, week) {
    return '<article class="shop-stat-card"><h3>' + title + "</h3><strong>" +
      (week.trips ? formatMinutes(week.seconds) : "—") + "</strong><p>" +
      (week.trips ? money(week.spend) + " · " + Math.round(week.pace || 0) + "s / item" : "No trips") +
      "</p><p>" + week.trips + (week.trips === 1 ? " trip" : " trips") + "</p></article>";
  }

  function chartCard(title, weeks, key, color) {
    return '<article class="shop-chart-card"><h3>' + title + "</h3>" + chartSvg(weeks, key, color) + "</article>";
  }

  function renderLayout() {
    var scroll = document.getElementById("shop-scroll");
    if (!scroll || !shopLayout) {
      if (scroll) scroll.innerHTML = '<p class="shop-help">Loading the walk order…</p>';
      return;
    }
    var cards = shopLayout.sections.map(function (section, index) {
      var body = "";
      if (section.type === "department") {
        body = '<input class="walk-match" type="text" data-field="match" data-index="' + index +
          '" value="' + esc((section.match || []).join(", ")) + '" aria-label="Words that match ' + esc(section.label) + '" autocapitalize="none" autocorrect="off">';
      } else if (section.type === "aisles") {
        body = '<div class="walk-aisle-row">' +
          '<input type="number" inputmode="numeric" data-field="from" data-index="' + index + '" value="' + esc(section.from) + '" aria-label="First aisle">' +
          '<input type="number" inputmode="numeric" data-field="to" data-index="' + index + '" value="' + esc(section.to) + '" aria-label="Last aisle">' +
          "</div>" +
          '<label class="walk-rev"><input type="checkbox" data-field="reverse" data-index="' + index + '"' +
          (section.reverse ? " checked" : "") + "> High numbers first</label>";
      } else {
        body = '<p class="shop-help">Anything without a location, or a department you have not named.</p>';
      }
      var moves = section.type === "fallback" ? "" :
        '<div class="walk-moves">' +
          '<button type="button" data-action="up" data-index="' + index + '" aria-label="Move ' + esc(section.label) + ' up">↑</button>' +
          '<button type="button" data-action="down" data-index="' + index + '" aria-label="Move ' + esc(section.label) + ' down">↓</button>' +
        "</div>";
      var remove = section.type === "fallback" ? "" :
        '<button type="button" class="walk-remove" data-action="remove-section" data-index="' + index + '">Remove</button>';
      var labelField = section.type === "fallback"
        ? "<strong>" + esc(section.label) + "</strong>"
        : '<input type="text" data-field="label" data-index="' + index + '" value="' + esc(section.label) + '" aria-label="Section name">';
      return '<article class="walk-card"><div class="walk-index">' + (index + 1) + "</div><div>" +
        labelField + body + remove + "</div>" + moves + "</article>";
    }).join("");

    scroll.innerHTML =
      '<p class="shop-help walk-help">This is the one-pass walk for the Racine store. Numbered aisles stay in order inside a range. Put Produce, Bakery, Deli, and Meat where you actually pass them, then the aisles, then Dairy, Frozen, and the Soda Wall. Other stays at the end.</p>' +
      cards +
      '<div class="walk-add">' +
        '<button type="button" class="shop-tool" data-action="add-dept">Add department</button>' +
        '<button type="button" class="shop-tool" data-action="add-aisles">Add aisle range</button>' +
      "</div>";
  }

  function renderFooter() {
    var footer = document.getElementById("shop-footer");
    if (!footer) return;
    if (shopView === "history") {
      footer.innerHTML = "";
      return;
    }
    if (shopView === "layout") {
      footer.innerHTML =
        '<div class="shop-footer-actions">' +
          '<button type="button" class="shop-primary" data-action="save-layout">Save walk order</button>' +
          '<button type="button" class="shop-ghost" data-action="reset-layout">Reset to Racine default</button>' +
        "</div>";
      return;
    }
    var started = shopTrip && shopTrip.startedAt;
    footer.innerHTML =
      '<div class="shop-tools">' +
        '<button type="button" class="shop-tool" data-action="pdf">PDF</button>' +
        '<button type="button" class="shop-tool" data-action="layout">Aisles</button>' +
        '<button type="button" class="shop-tool" data-action="history">Trips</button>' +
      "</div>" +
      (started
        ? '<button type="button" class="shop-primary is-end" data-action="end">End Shopping</button>'
        : '<button type="button" class="shop-primary" data-action="start"' + (shopTrip && shopTrip.items.length ? "" : " disabled") + ">Start Shopping</button>");
  }

  function renderSheet() {
    var sheet = document.getElementById("shop-sheet");
    if (!sheet) return;
    if (!shopSheet || !shopTrip) {
      sheet.hidden = true;
      sheet.innerHTML = "";
      return;
    }
    var done = shopTrip.items.filter(function (item) { return item.checked; }).length;
    var skipped = shopTrip.items.length - done;
    var elapsed = shopTrip.startedAt ? formatClock(Date.now() - new Date(shopTrip.startedAt).getTime()) : "not started";
    sheet.hidden = false;
    sheet.innerHTML =
      '<div class="shop-sheet-card"><h3>End this trip?</h3><p>' + esc(elapsed) + " · " +
      done + " of " + shopTrip.items.length + " checked · " + skipped + " skipped · " +
      money(tripTotal(shopTrip)) + ".</p>" +
      '<button type="button" class="shop-primary" data-action="confirm-end">Save trip</button>' +
      '<button type="button" class="shop-ghost" data-action="dismiss-sheet">Keep shopping</button></div>';
  }

  function render() {
    renderHeader();
    if (shopView === "history") renderHistory();
    else if (shopView === "layout") renderLayout();
    else renderList();
    renderFooter();
    renderSheet();
    var toast = document.getElementById("shop-toast");
    if (toast && toast.parentElement !== document.querySelector(".shop-column")) {
      /* toast node lives in the column already */
    }
  }

  function findRow(id) {
    var rows = document.querySelectorAll("#shop-screen .shop-row");
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute("data-id") === id) return rows[i];
    }
    return null;
  }

  var lastToggleAt = Object.create(null);
  var rowGesture = null;

  function toggleItem(id) {
    if (!shopTrip || !id) return;
    var now = Date.now();
    if (lastToggleAt[id] && now - lastToggleAt[id] < 400) return;
    lastToggleAt[id] = now;
    var item = shopTrip.items.find(function (entry) { return entry.id === id; });
    if (!item) return;
    var next = !item.checked;
    item.checked = next;
    item.checkedAt = next ? new Date().toISOString() : null;
    writeLocal(shopTrip.id, id, next);
    if (navigator.vibrate) navigator.vibrate(10);
    var row = findRow(id);
    if (row) {
      row.classList.toggle("is-checked", next);
      if (next) row.classList.add("just-checked");
      else row.classList.remove("just-checked");
    }
    paintProgress();
    appApi.setShoppingCheck(id, next).then(function (res) {
      if (res && res.error) throw new Error(res.error);
      if (res && res.trip) shopTrip.startedAt = shopTrip.startedAt || res.trip.startedAt;
    }).catch(function () {
      item.checked = !next;
      item.checkedAt = item.checked ? new Date().toISOString() : null;
      writeLocal(shopTrip.id, id, item.checked);
      if (row) row.classList.toggle("is-checked", item.checked);
      paintProgress();
      showToast("Couldn't save that check. Try again.");
    });
  }

  async function openShoppingMode(fromCart) {
    if (opening) return;
    opening = true;
    var launch = document.getElementById("btn-shop-instore");
    if (launch) { launch.disabled = true; launch.textContent = "Opening…"; }
    try {
      var cart = fromCart && window.getOnlineCartItems ? window.getOnlineCartItems() : [];
      if (cart && cart.length) {
        var prepared = await appApi.prepareShoppingList(cart);
        shopTrip = prepared && prepared.trip;
      } else {
        var active = await appApi.getActiveTrip();
        shopTrip = active && active.trip;
      }
      if (shopTrip) await reconcile(shopTrip);
      shopView = "list";
      shopSheet = false;
      openScreen();
    } catch (err) {
      showToast(err.message || "Couldn't open the shopping list");
    } finally {
      opening = false;
      if (window.syncGenerateList) window.syncGenerateList();
      updateResume();
    }
  }

  async function showHistory() {
    shopView = "history";
    render();
    try {
      var data = await appApi.getShoppingHistory();
      shopHistory = (data && data.trips) || [];
    } catch (err) {
      shopHistory = [];
      showToast("Couldn't load trips");
    }
    if (shopView === "history") renderHistory();
  }

  async function showLayout() {
    shopView = "layout";
    render();
    try {
      shopLayout = await appApi.getStoreLayout();
    } catch (err) {
      showToast("Couldn't load the walk order");
    }
    if (shopView === "layout") render();
  }

  async function openPdf() {
    try {
      var response = await fetch("/api/shopping/pdf");
      var type = response.headers.get("content-type") || "";
      if (!response.ok || type.indexOf("pdf") === -1) {
        var body = await response.json().catch(function () { return {}; });
        showToast(body.error || "Could not build the PDF");
        return;
      }
      var blob = await response.blob();
      var url = URL.createObjectURL(blob);
      var opened = window.open(url, "_blank");
      if (!opened) {
        var link = document.createElement("a");
        link.href = url;
        link.download = "woodmans-shopping-list.pdf";
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    } catch (err) {
      showToast("Could not build the PDF");
    }
  }

  function moveSection(index, direction) {
    if (!shopLayout) return;
    var sections = shopLayout.sections;
    var next = index + direction;
    if (next < 0 || next >= sections.length) return;
    if (sections[index].type === "fallback" || sections[next].type === "fallback") return;
    var swapped = sections[index];
    sections[index] = sections[next];
    sections[next] = swapped;
    render();
  }

  async function onShopClick(event) {
    var target = event.target.closest("[data-action]");
    if (!target || !screenEl().contains(target)) return;
    var action = target.getAttribute("data-action");
    var index = target.dataset.index != null ? Number(target.dataset.index) : null;

    if (action === "close") return closeScreen();
    if (action === "density") return toggleDensity();
    if (action === "back") { shopView = "list"; shopSheet = false; return render(); }
    if (action === "toggle") {
      var rowId = target.getAttribute("data-id");
      if (rowGesture && rowGesture.id === rowId && rowGesture.moved) {
        rowGesture = null;
        return;
      }
      rowGesture = null;
      return toggleItem(rowId);
    }
    if (action === "toggle-done") { shopDoneOpen = !shopDoneOpen; return renderFooter(); }
    if (action === "pdf") return openPdf();
    if (action === "history") return showHistory();
    if (action === "layout") return showLayout();
    if (action === "dismiss-sheet") { shopSheet = false; return renderSheet(); }
    if (action === "end") { shopSheet = true; return renderSheet(); }
    if (action === "trip") {
      var id = target.getAttribute("data-id");
      openTripId = openTripId === id ? null : id;
      return renderHistory();
    }
    if (action === "up") return moveSection(index, -1);
    if (action === "down") return moveSection(index, 1);
    if (action === "remove-section" && shopLayout) {
      if (shopLayout.sections[index] && shopLayout.sections[index].type !== "fallback") {
        shopLayout.sections.splice(index, 1);
        render();
      }
      return;
    }
    if (action === "add-dept" && shopLayout) {
      var fallback = shopLayout.sections.pop();
      shopLayout.sections.push({ id: "dept-" + Date.now().toString(36), type: "department", label: "New section", match: ["new section"] });
      shopLayout.sections.push(fallback);
      return render();
    }
    if (action === "add-aisles" && shopLayout) {
      var tail = shopLayout.sections.pop();
      shopLayout.sections.push({ id: "aisles-" + Date.now().toString(36), type: "aisles", label: "Aisles", from: 1, to: 10, reverse: false });
      shopLayout.sections.push(tail);
      return render();
    }
    if (action === "rebuild") return openShoppingMode(true);
    if (action === "start") {
      target.disabled = true;
      try {
        var started = await appApi.startShopping();
        if (started && started.trip) shopTrip = started.trip;
        else if (started && started.error) showToast(started.error);
        render();
      } catch (err) {
        showToast("Couldn't start the timer");
        target.disabled = false;
      }
      return;
    }
    if (action === "confirm-end") {
      target.disabled = true;
      try {
        var ended = await appApi.endShopping();
        if (ended && ended.error) {
          showToast(ended.error);
          target.disabled = false;
          return;
        }
        if (shopTrip) clearLocal(shopTrip.id);
        shopTrip = null;
        shopSheet = false;
        shopDoneOpen = false;
        showToast("Trip saved");
        await showHistory();
        updateResume();
      } catch (err) {
        showToast("Couldn't save the trip");
        target.disabled = false;
      }
      return;
    }
    if (action === "save-layout" || action === "reset-layout") {
      target.disabled = true;
      try {
        var payload = action === "reset-layout" ? { reset: true } : { sections: shopLayout.sections };
        var saved = await appApi.saveStoreLayout(payload);
        if (saved && saved.error) {
          showToast(saved.error);
          target.disabled = false;
          return;
        }
        shopLayout = saved.layout;
        if (saved.trip) shopTrip = saved.trip;
        showToast(action === "reset-layout" ? "Reset to the Racine walk" : "Walk order saved");
        shopView = "list";
        render();
      } catch (err) {
        showToast("Couldn't save the walk order");
        target.disabled = false;
      }
    }
  }

  function onShopInput(event) {
    var el = event.target;
    if (!el.dataset || el.dataset.index == null || !shopLayout) return;
    var section = shopLayout.sections[Number(el.dataset.index)];
    if (!section) return;
    if (el.dataset.field === "label") section.label = el.value;
    if (el.dataset.field === "match") {
      section.match = el.value.split(",").map(function (part) { return part.trim().toLowerCase(); }).filter(Boolean);
    }
    if (el.dataset.field === "from") section.from = parseInt(el.value, 10);
    if (el.dataset.field === "to") section.to = parseInt(el.value, 10);
    if (el.dataset.field === "reverse") section.reverse = !!el.checked;
  }

  function applyDensity() {
    var screen = screenEl();
    if (screen) screen.classList.toggle("is-comfortable", shopDensity === "comfortable");
  }

  function loadDensity() {
    try {
      shopDensity = localStorage.getItem("woodmans-shop-density") === "comfortable" ? "comfortable" : "compact";
    } catch (err) {
      shopDensity = "compact";
    }
    applyDensity();
  }

  function toggleDensity() {
    shopDensity = shopDensity === "compact" ? "comfortable" : "compact";
    try { localStorage.setItem("woodmans-shop-density", shopDensity); } catch (err) {}
    applyDensity();
    if (shopView === "list") renderHeader();
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  }

  function syncThemeColor() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    if (document.body.classList.contains("shop-open")) {
      meta.setAttribute("content", document.body.classList.contains("dark") ? "#0c0c0d" : "#efece7");
      return;
    }
    meta.setAttribute("content", document.body.classList.contains("dark") ? "#1c1c1e" : "#f2f2f7");
  }

  document.addEventListener("DOMContentLoaded", function () {
    var screen = screenEl();
    if (screen) {
      screen.addEventListener("click", onShopClick);
      screen.addEventListener("input", onShopInput);
      screen.addEventListener("change", onShopInput);
      screen.addEventListener("pointerdown", function (e) {
        if (!wakeLock && document.body.classList.contains("shop-open")) acquireWakeLock();
        var row = e.target.closest(".shop-row");
        if (!row) { rowGesture = null; return; }
        rowGesture = { id: row.getAttribute("data-id"), x: e.clientX, y: e.clientY, moved: false };
      }, { passive: true });
      screen.addEventListener("pointermove", function (e) {
        if (!rowGesture) return;
        if (Math.abs(e.clientX - rowGesture.x) > 10 || Math.abs(e.clientY - rowGesture.y) > 10) rowGesture.moved = true;
      }, { passive: true });
    }
    bindResumeCard();
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && document.body.classList.contains("shop-open")) {
        acquireWakeLock();
        fitShopScreen();
        tickClock();
      }
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", fitShopScreen);
      window.visualViewport.addEventListener("scroll", fitShopScreen);
    }
    window.addEventListener("resize", fitShopScreen);
    window.addEventListener("orientationchange", function () {
      fitShopScreen();
      setTimeout(fitShopScreen, 150);
      setTimeout(fitShopScreen, 450);
    });
    setInterval(tickClock, 1000);
    loadDensity();
    registerServiceWorker();
    syncThemeColor();
    appApi.getActiveTrip().then(async function (data) {
      shopTrip = data && data.trip;
      if (shopTrip) await reconcile(shopTrip);
      updateResume();
      if (shopTrip && shopTrip.startedAt) openScreen();
    }).catch(function () {});
  });

  window.openShoppingMode = openShoppingMode;
  window.syncShopThemeColor = syncThemeColor;
  window.revealShoppingList = revealShoppingList;

  function bindResumeCard() {
    var wrap = document.getElementById("shop-resume-wrap");
    var banner = document.getElementById("shop-resume");
    var closeBtn = document.getElementById("shop-resume-close");
    if (!wrap || !banner) return;
    var startX = 0;
    var startY = 0;
    var dx = 0;
    var dragging = false;
    var axis = "";
    var suppressClick = false;

    banner.addEventListener("click", function (e) {
      if (suppressClick) { suppressClick = false; e.preventDefault(); return; }
      openShoppingMode(false);
    });
    if (closeBtn) {
      closeBtn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        dismissResume(0);
      });
    }
    wrap.addEventListener("pointerdown", function (e) {
      if (e.target.closest(".shop-resume-close")) return;
      startX = e.clientX;
      startY = e.clientY;
      dx = 0;
      dragging = true;
      axis = "";
      if (wrap.setPointerCapture) {
        try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
      }
    });
    wrap.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var x = e.clientX - startX;
      var y = e.clientY - startY;
      if (!axis) {
        if (Math.abs(x) < 8 && Math.abs(y) < 8) return;
        axis = Math.abs(x) > Math.abs(y) ? "x" : "y";
        if (axis === "y") {
          dragging = false;
          return;
        }
        wrap.classList.add("is-dragging");
      }
      if (axis !== "x") return;
      dx = x;
      wrap.style.transform = "translateX(" + dx + "px)";
      wrap.style.opacity = String(Math.max(0.4, 1 - Math.abs(dx) / 260));
    });
    function finish() {
      if (!dragging && axis !== "x") return;
      var moved = Math.abs(dx);
      dragging = false;
      wrap.classList.remove("is-dragging");
      if (axis === "x" && moved > 72) {
        suppressClick = true;
        dismissResume(dx);
      } else if (axis === "x") {
        if (moved > 8) suppressClick = true;
        wrap.style.transition = "transform 0.28s cubic-bezier(.2,.85,.2,1), opacity 0.28s ease";
        wrap.style.transform = "";
        wrap.style.opacity = "";
        setTimeout(function () { wrap.style.transition = ""; }, 300);
      }
      dx = 0;
      axis = "";
    }
    wrap.addEventListener("pointerup", finish);
    wrap.addEventListener("pointercancel", finish);

    function dismissResume(delta) {
      var dir = delta >= 0 ? 1 : -1;
      wrap.classList.add("is-dismissing");
      wrap.style.transition = "transform 0.32s cubic-bezier(.2,.85,.2,1), opacity 0.28s ease";
      wrap.style.transform = "translateX(" + (dir * Math.max(wrap.offsetWidth, 280)) + "px)";
      wrap.style.opacity = "0";
      setTimeout(hideShoppingList, 300);
    }
  }
})();
