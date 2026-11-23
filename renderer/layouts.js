// Preview layouts for the main screen. Open with ?layout=a, ?layout=b, or ?layout=c.
// Send to Woodman's is simulated here. It does not call the live cart.

(function () {
  var CATALOG = [
    { id: "milk", name: "Whole milk", price: 3.19, image: "/assets/sample/milk.png" },
    { id: "bread", name: "French bread", price: 2.49, image: "/assets/sample/bread.png" },
    { id: "bananas", name: "Bananas", price: 1.49, image: "/assets/sample/banana.png" },
    { id: "berries", name: "Strawberries", price: 3.49, image: "/assets/sample/berry.png" },
    { id: "cheddar", name: "Sharp cheddar", price: 4.29, image: "/assets/sample/cheddar.png" },
    { id: "yogurt", name: "Greek yogurt", price: 1.25, image: "/assets/sample/yogurt.png" },
    { id: "eggs", name: "Eggs", price: 2.99, image: "/assets/sample/butter.png" },
    { id: "pasta", name: "Spaghetti", price: 1.49, image: "/assets/sample/pasta.png" },
  ];

  var MOCK_STAPLES = [
    { id: "staple-milk", name: "Whole milk", price: 3.19, qty: 1, image: "/assets/sample/milk.png", weekly: true, skipped: false },
    { id: "staple-bread", name: "French bread", price: 2.49, qty: 1, image: "/assets/sample/bread.png", weekly: true, skipped: false },
    { id: "staple-bananas", name: "Bananas", price: 1.49, qty: 1, image: "/assets/sample/banana.png", weekly: true, skipped: false },
    { id: "staple-eggs", name: "Eggs", price: 2.99, qty: 1, image: "/assets/sample/butter.png", weekly: true, skipped: false },
  ];

  var layout = "";
  var items = [];
  var orderType = "instore";
  var step = 1;
  var tab = "list";
  var sent = false;
  var sending = false;
  var query = "";
  var managing = false;

  function money(n) { return "$" + (Number(n) || 0).toFixed(2); }
  function toSend() {
    return items.filter(function (item) { return !(item.weekly && item.skipped); });
  }
  function total() {
    return toSend().reduce(function (sum, item) { return sum + (item.price || 0) * item.qty; }, 0);
  }
  function staples() { return items.filter(function (item) { return item.weekly; }); }
  function extras() { return items.filter(function (item) { return !item.weekly; }); }
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function pictureFor(name) {
    var text = String(name || "").toLowerCase().replace(/buttermilk/g, "");
    var pairs = [
      ["pancake", "/assets/sample/bread.png"],
      ["milk", "/assets/sample/milk.png"],
      ["bread", "/assets/sample/bread.png"],
      ["banana", "/assets/sample/banana.png"],
      ["strawber", "/assets/sample/berry.png"],
      ["egg", "/assets/sample/butter.png"],
      ["cheddar", "/assets/sample/cheddar.png"],
      ["cheese", "/assets/sample/cheddar.png"],
      ["yogurt", "/assets/sample/yogurt.png"],
    ];
    for (var i = 0; i < pairs.length; i++) {
      if (text.indexOf(pairs[i][0]) !== -1) return pairs[i][1];
    }
    return "/assets/sample/can.png";
  }

  function priceOf(value) {
    var match = String(value || "").replace(/,/g, "").match(/(\d+\.\d+|\d+)/);
    return match ? parseFloat(match[1]) : 0;
  }

  function fromStaple(staple) {
    var name = staple.productName || staple.item || "Staple";
    return {
      id: "staple-" + (staple.id || name),
      stapleId: staple.id || "",
      name: name,
      price: priceOf(staple.price),
      qty: Math.max(1, parseInt(staple.quantity, 10) || 1),
      image: staple.image || pictureFor(name),
      weekly: true,
      skipped: false,
    };
  }

  async function seed() {
    var loaded = [];
    try {
      var data = await fetch("/api/staples").then(function (res) { return res.json(); });
      if (Array.isArray(data)) loaded = data.filter(function (staple) { return staple && (staple.item || staple.productName); }).map(fromStaple);
    } catch (err) {
      loaded = [];
    }
    items = loaded.length ? loaded : MOCK_STAPLES.map(function (item) { return Object.assign({}, item); });
    if (!extras().length) {
      items.push({ id: "berries", name: "Strawberries", price: 3.49, qty: 1, image: "/assets/sample/berry.png", weekly: false, skipped: false });
    }
  }

  function addById(id) {
    var found = CATALOG.filter(function (item) { return item.id === id; })[0];
    if (!found) return;
    var existing = items.filter(function (item) { return item.id === id || item.name === found.name; })[0];
    if (existing) {
      existing.qty += 1;
      existing.skipped = false;
    } else {
      items.push({ id: found.id, name: found.name, price: found.price, qty: 1, image: found.image, weekly: false, skipped: false });
    }
    sent = false;
    render();
  }

  function addFromQuery() {
    var q = query.trim();
    if (!q) return;
    var match = CATALOG.filter(function (item) { return item.name.toLowerCase().indexOf(q.toLowerCase()) !== -1; })[0];
    query = "";
    if (match) return addById(match.id);
    items.push({ id: "custom-" + Date.now(), name: q, price: 0, qty: 1, image: "/assets/sample/can.png", weekly: false, skipped: false });
    sent = false;
    render();
  }

  // ShopWoodmans is the native app (App Store 1213495198, bundle
  // com.grocerkey.shopper.woodmans). Apple's public listing does not publish a
  // URL scheme, and shopwoodmans.com's apple-app-site-association file is empty,
  // so there is no verified universal link. Try the likely scheme, then the website.
  function openWoodmansApp() {
    var web = "https://shopwoodmans.com/store/woodmans-food-markets/storefront";
    var scheme = "shopwoodmans://";
    var ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (!ios) {
      window.open(web, "_blank", "noopener");
      return;
    }
    var started = Date.now();
    window.location.href = scheme;
    setTimeout(function () {
      if (!document.hidden && Date.now() - started < 1600) window.location.href = web;
    }, 900);
  }

  async function startShopping() {
    if (!window.appApi || !window.openShoppingMode) return;
    var payload = toSend().map(function (item) {
      return {
        itemId: item.id,
        name: item.name,
        price: money(item.price),
        quantity: item.qty,
        image: item.image,
        location: guessLocation(item.name),
      };
    });
    try {
      await appApi.prepareShoppingList(payload);
      openShoppingMode(false);
    } catch (err) {
      alert("Couldn't build the shopping list.");
    }
  }

  function guessLocation(name) {
    var n = name.toLowerCase();
    if (n.indexOf("milk") !== -1 || n.indexOf("cheddar") !== -1 || n.indexOf("yogurt") !== -1) return "Dairy - Shelf 4";
    if (n.indexOf("bread") !== -1) return "Bakery";
    if (n.indexOf("banana") !== -1 || n.indexOf("strawber") !== -1) return "Produce - Shelf 8";
    if (n.indexOf("spaghetti") !== -1 || n.indexOf("pasta") !== -1) return "Aisle 4 - Shelf B08";
    return "";
  }

  function send() {
    if (!toSend().length || sending) return;
    sending = true;
    render();
    setTimeout(function () {
      sending = false;
      sent = true;
      if (layout === "b") step = 3;
      if (layout === "c") tab = "shop";
      render();
    }, 600);
  }

  function row(item, manage) {
    var weekly = !!item.weekly;
    var action = "";
    if (manage && weekly) {
      action = '<button type="button" class="skip-btn" data-act="remove" data-id="' + esc(item.id) + '">Remove</button>';
    } else if (weekly) {
      action = '<button type="button" class="skip-btn" data-act="skip" data-id="' + esc(item.id) + '">' +
        (item.skipped ? "Add it back" : "Skip this week") + "</button>";
    } else {
      action = '<button type="button" class="skip-btn" data-act="weekly" data-id="' + esc(item.id) + '">Make weekly</button>' +
        '<button type="button" class="icon-x" data-act="remove" data-id="' + esc(item.id) + '" aria-label="Remove">×</button>';
    }
    return '<div class="layout-row' + (item.skipped ? " is-skipped" : "") + '">' +
      '<img src="' + esc(item.image) + '" alt="">' +
      '<div class="grow"><div class="name">' + esc(item.name) + '</div>' +
      '<div class="meta">' + (weekly ? "Weekly staple" : "This week only") +
      (item.price ? " · " + money(item.price) : "") + "</div>" + action + "</div>" +
      '<div class="qty-step">' +
        '<button type="button" data-act="qty" data-id="' + esc(item.id) + '" data-d="-1" aria-label="Less">−</button>' +
        "<span>" + item.qty + "</span>" +
        '<button type="button" data-act="qty" data-id="' + esc(item.id) + '" data-d="1" aria-label="More">+</button>' +
      "</div></div>";
  }

  function sectionHead(title, actionHtml) {
    return '<div class="section-label"><span>' + title + "</span>" + (actionHtml || "") + "</div>";
  }

  function staplesAndExtras(manage) {
    var stapleRows = staples();
    var extraRows = extras();
    var head = sectionHead("Weekly staples", manage
      ? '<button type="button" data-act="done-manage">Done</button>'
      : '<button type="button" data-act="manage">Edit staples</button>');
    var body = stapleRows.length
      ? stapleRows.map(function (item) { return row(item, manage); }).join("")
      : '<p class="layout-sub">No weekly staples yet. Add an item, then tap Make weekly.</p>';
    if (manage) return head + '<div class="layout-list">' + body + "</div>";
    var extra = sectionHead("Just this week") +
      (extraRows.length
        ? extraRows.map(function (item) { return row(item, false); }).join("")
        : '<p class="layout-sub">Nothing extra this week.</p>');
    return head + '<div class="layout-list">' + body + extra + "</div>";
  }

  function searchBox() {
    return '<div class="layout-search">' +
      '<input id="layout-q" type="text" inputmode="search" placeholder="Add item" value="' + esc(query) + '" enterkeyhint="done">' +
      '<button type="button" data-act="add">Add item</button></div>' +
      '<div class="chips">' +
      CATALOG.slice(0, 6).map(function (item) {
        return '<button type="button" class="chip" data-act="chip" data-id="' + item.id + '">' + esc(item.name) + "</button>";
      }).join("") + "</div>";
  }

  function typePicker() {
    return '<div class="order-type">' +
      '<button type="button" data-act="type" data-type="instore"' + (orderType === "instore" ? ' class="is-on"' : "") + ">In the store</button>" +
      '<button type="button" data-act="type" data-type="pickup"' + (orderType === "pickup" ? ' class="is-on"' : "") + ">Pickup</button>" +
      "</div>";
  }

  function sendBlock() {
    if (sent) return successCard();
    return '<button type="button" class="primary" data-act="send"' + (toSend().length && !sending ? "" : " disabled") + ">" +
      (sending ? "Sending…" : "Send to Woodman's") + "</button>" +
      '<button type="button" class="text-link" data-act="app">Open Woodman\'s app</button>';
  }

  function successCard() {
    var instore = orderType === "instore";
    return '<div class="success"><div class="layout-kicker">Done</div><h2>Sent to Woodman\'s</h2><p>' +
      (instore
        ? "Your in-store list is ready, in aisle order. Start shopping when you get to the store."
        : "Your pickup order is in the Woodman's cart. Open the Woodman's app if you want to check the time.") +
      "</p>" +
      (instore ? '<button type="button" class="primary" data-act="shop" style="margin-top:14px;">Start shopping</button>' : "") +
      '<button type="button" class="text-link" data-act="app">Open Woodman\'s app</button>' +
      '<button type="button" class="secondary" data-act="reset">Build another list</button></div>';
  }

  function listBlock() {
    if (managing) return staplesAndExtras(true);
    return staplesAndExtras(false) + searchBox();
  }

  function switcher() {
    return '<div class="layout-switch">' +
      ["a", "b", "c"].map(function (id) {
        return '<button type="button" data-act="layout" data-layout="' + id + '"' + (layout === id ? ' class="is-on"' : "") + ">Layout " + id.toUpperCase() + "</button>";
      }).join("") + "</div>";
  }

  function renderA() {
    if (sent) return switcher() + successCard();
    return switcher() + '<div class="layout-split"><div><div class="layout-top">' +
      '<div class="layout-kicker">Layout A · one screen</div><h1 class="layout-title">This week\'s list</h1>' +
      '<p class="layout-sub">Weekly staples are already here. Skip one for this week, or add something extra.</p>' + typePicker() + "</div>" +
      listBlock() + '</div><div class="layout-dock">' + sendBlock() + "</div></div>";
  }

  function renderB() {
    var labels = ["Build", "Review", "Send"];
    var steps = '<div class="steps">' + labels.map(function (label, i) {
      var n = i + 1;
      var cls = n === step ? "is-on" : (n < step ? "is-done" : "");
      return '<span class="' + cls + '">' + n + ". " + label + "</span>";
    }).join("") + "</div>";
    var body = "";
    if (sent) {
      body = successCard();
    } else if (step === 1) {
      body = '<div class="layout-top"><h1 class="layout-title">What do you need?</h1><p class="layout-sub">Weekly staples come first. Add anything extra for this week.</p></div>' + listBlock();
    } else if (step === 2) {
      var going = toSend();
      var skipped = staples().filter(function (item) { return item.skipped; });
      body = '<div class="layout-top"><h1 class="layout-title">Look this over</h1><p class="layout-sub">Weekly staples you did not skip, plus anything extra.</p></div>' +
        typePicker() + '<div class="review-card"><h2>' + going.length + " items</h2>" +
        going.map(function (item) {
          return '<div class="review-line"><span>' + (item.weekly ? "Weekly · " : "") + esc(item.name) + " × " + item.qty + "</span><span>" + money((item.price || 0) * item.qty) + "</span></div>";
        }).join("") +
        (skipped.length ? '<p class="layout-sub">Skipped this week: ' + skipped.map(function (item) { return esc(item.name); }).join(", ") + "</p>" : "") +
        '<div class="review-total"><span>Estimated</span><span>' + money(total()) + "</span></div></div>";
    } else {
      body = '<div class="layout-top"><h1 class="layout-title">Send it</h1><p class="layout-sub">' +
        (orderType === "instore" ? "This also makes your aisle list." : "This fills your pickup cart.") +
        "</p></div>";
    }
    var dock = sent ? "" : '<div class="layout-dock">' +
      (step > 1 ? '<button type="button" class="secondary" data-act="back">Back</button>' : "") +
      (step < 3
        ? '<button type="button" class="primary" data-act="next"' + (toSend().length ? "" : " disabled") + ">" + (step === 1 ? "Review list" : "Continue") + "</button>"
        : sendBlock()) +
      "</div>";
    return switcher() + steps + '<div class="layout-split"><div>' + body + "</div>" + dock + "</div>";
  }

  function renderC() {
    var body = "";
    if (tab === "list") {
      body = '<div class="layout-top"><div class="layout-kicker">List</div><h1 class="layout-title">' + (managing ? "Weekly staples" : "This week") + "</h1></div>" + listBlock();
    } else if (tab === "send") {
      body = '<div class="layout-top"><div class="layout-kicker">Send</div><h1 class="layout-title">Send to Woodman\'s</h1>' +
        '<p class="layout-sub">' + toSend().length + " items · " + money(total()) + "</p></div>" + typePicker() +
        '<div class="layout-dock" style="position:static;">' + sendBlock() + "</div>";
    } else if (tab === "shop") {
      body = '<div class="layout-top"><div class="layout-kicker">Shop</div><h1 class="layout-title">In the store</h1></div>' +
        (sent && orderType === "instore"
          ? successCard()
          : '<p class="layout-sub" style="padding:0 16px;">Send an in-store list first. Then your aisle list shows up here.</p>');
    } else {
      body = '<div class="layout-top"><div class="layout-kicker">Trips</div><h1 class="layout-title">Past trips</h1>' +
        '<p class="layout-sub">A simple history. The real trip charts stay in Shopping Mode.</p></div>' +
        '<div class="trip-mini"><strong>Last Sunday · 24 min</strong><span>26 of 28 items · $104.62</span></div>' +
        '<div class="trip-mini"><strong>The Sunday before · 28 min</strong><span>28 of 30 items · $121.33</span></div>';
    }
    var tabs = '<nav class="tabs">' +
      [["list", "List"], ["send", "Send"], ["shop", "Shop"], ["trips", "Trips"]].map(function (pair) {
        return '<button type="button" data-act="tab" data-tab="' + pair[0] + '"' + (tab === pair[0] ? ' class="is-on"' : "") + ">" + pair[1] + "</button>";
      }).join("") + "</nav>";
    return switcher() + '<div class="layout-scroll">' + body + "</div>" + tabs;
  }

  function render() {
    var root = document.getElementById("layout-root");
    if (!root) return;
    root.className = "layout-root layout-" + layout;
    root.innerHTML = '<div class="layout-frame">' + (layout === "b" ? renderB() : layout === "c" ? renderC() : renderA()) + "</div>";
    var input = document.getElementById("layout-q");
    if (input) {
      input.addEventListener("input", function () { query = input.value; });
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") addFromQuery(); });
    }
  }

  function onClick(event) {
    var button = event.target.closest("[data-act]");
    if (!button || !document.getElementById("layout-root").contains(button)) return;
    var act = button.getAttribute("data-act");
    if (act === "layout") {
      var next = button.getAttribute("data-layout");
      var url = new URL(location.href);
      url.searchParams.set("layout", next);
      history.replaceState(null, "", url);
      layout = next;
      sent = false;
      managing = false;
      step = 1;
      tab = "list";
      render();
      return;
    }
    if (act === "add") return addFromQuery();
    if (act === "chip") return addById(button.getAttribute("data-id"));
    if (act === "type") { orderType = button.getAttribute("data-type"); sent = false; return render(); }
    if (act === "qty") {
      var id = button.getAttribute("data-id");
      var delta = Number(button.getAttribute("data-d"));
      items.forEach(function (item) {
        if (item.id === id) item.qty = Math.max(1, item.qty + delta);
      });
      sent = false;
      return render();
    }
    if (act === "remove") {
      var removeId = button.getAttribute("data-id");
      items = items.filter(function (item) { return item.id !== removeId; });
      sent = false;
      return render();
    }
    if (act === "skip") {
      var skipId = button.getAttribute("data-id");
      items.forEach(function (item) {
        if (item.id === skipId && item.weekly) item.skipped = !item.skipped;
      });
      sent = false;
      return render();
    }
    if (act === "weekly") {
      var weeklyId = button.getAttribute("data-id");
      items.forEach(function (item) {
        if (item.id === weeklyId) { item.weekly = true; item.skipped = false; }
      });
      sent = false;
      return render();
    }
    if (act === "manage") { managing = true; return render(); }
    if (act === "done-manage") { managing = false; return render(); }
    if (act === "send") return send();
    if (act === "app") return openWoodmansApp();
    if (act === "shop") return startShopping();
    if (act === "reset") {
      sent = false;
      managing = false;
      step = 1;
      tab = "list";
      seed().then(render);
      return;
    }
    if (act === "next") { if (items.length) step = Math.min(3, step + 1); return render(); }
    if (act === "back") { step = Math.max(1, step - 1); sent = false; return render(); }
    if (act === "tab") { tab = button.getAttribute("data-tab"); return render(); }
  }

  function boot() {
    var param = new URLSearchParams(location.search).get("layout");
    if (param !== "a" && param !== "b" && param !== "c") return;
    layout = param;
    document.body.classList.add("layout-preview");
    var root = document.getElementById("layout-root");
    if (root) {
      root.hidden = false;
      root.addEventListener("click", onClick);
    }
    seed().then(render);
  }

  document.addEventListener("DOMContentLoaded", boot);
  window.openWoodmansApp = openWoodmansApp;
})();
