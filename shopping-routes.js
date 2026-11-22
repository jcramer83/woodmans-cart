// Shopping list, active trip, and trip history. All of it is JSON in the data dir,
// same as staples and manual items, so a container restart keeps it.

const fs = require("fs");
const path = require("path");
const {
  defaultLayout,
  normalizeLayout,
  orderShoppingItems,
  priceAmount,
} = require("./store-layout");
const { buildShoppingPdf } = require("./shopping-pdf");

function registerShoppingRoutes(app, deps) {
  const readJSON = deps.readJSON;
  const writeJSON = deps.writeJSON;
  const layoutPath = deps.LAYOUT_PATH || path.join(__dirname, "data", "store-layout.json");
  const activePath = deps.ACTIVE_TRIP_PATH || path.join(__dirname, "data", "active-trip.json");
  const tripsPath = deps.TRIPS_PATH || path.join(__dirname, "data", "shopping-trips.json");

  function ensureParent(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  function loadLayout() {
    const saved = readJSON(layoutPath);
    if (!saved || !Array.isArray(saved.sections)) return defaultLayout();
    return normalizeLayout(saved);
  }

  function loadActive() {
    const data = readJSON(activePath);
    if (!data || !Array.isArray(data.items) || !data.items.length) return null;
    return data;
  }

  function saveActive(trip) {
    ensureParent(activePath);
    writeJSON(activePath, trip);
  }

  function clearActive() {
    if (fs.existsSync(activePath)) fs.unlinkSync(activePath);
  }

  function loadTrips() {
    const trips = readJSON(tripsPath);
    return Array.isArray(trips) ? trips : [];
  }

  function summarize(trip, endedAt) {
    const endMs = new Date(endedAt).getTime();
    const startMs = trip.startedAt ? new Date(trip.startedAt).getTime() : null;
    const durationMs = startMs && Number.isFinite(startMs) ? Math.max(0, endMs - startMs) : 0;
    let checkedCount = 0;
    let total = 0;
    const items = (trip.items || []).map(function (item) {
      if (item.checked) checkedCount += 1;
      total += priceAmount(item.price) * (item.quantity || 1);
      return {
        id: item.id,
        name: item.name,
        price: item.price || "",
        size: item.size || "",
        image: item.image || "",
        quantity: item.quantity || 1,
        location: item.location || "",
        sectionKey: item.sectionKey || "other",
        sectionLabel: item.sectionLabel || "Other",
        shelfLabel: item.shelfLabel || "",
        aisle: item.aisle == null ? null : item.aisle,
        checked: !!item.checked,
      };
    });
    return {
      id: trip.id,
      mode: "instore",
      createdAt: trip.createdAt,
      startedAt: trip.startedAt || null,
      endedAt: endedAt,
      durationMs: durationMs,
      totalPrice: Math.round(total * 100) / 100,
      itemCount: items.length,
      checkedCount: checkedCount,
      skippedCount: items.length - checkedCount,
      items: items,
    };
  }

  function archiveTrip(trip, endedAt) {
    const summary = summarize(trip, endedAt || new Date().toISOString());
    const trips = loadTrips();
    trips.unshift(summary);
    if (trips.length > 200) trips.length = 200;
    ensureParent(tripsPath);
    writeJSON(tripsPath, trips);
    return summary;
  }

  function applyOrder(items, previous) {
    const ordered = orderShoppingItems(items, loadLayout());
    const previousById = Object.create(null);
    if (previous && Array.isArray(previous.items)) {
      previous.items.forEach(function (item) { previousById[item.id] = item; });
    }
    const now = new Date().toISOString();
    return ordered.items.map(function (item) {
      const prior = previousById[item.id];
      const checked = !!(prior && prior.checked);
      return Object.assign({}, item, {
        checked: checked,
        checkedAt: checked ? (prior.checkedAt || now) : null,
      });
    });
  }

  function overlapRatio(previous, items) {
    if (!previous || !previous.items || !previous.items.length) return 1;
    const ids = new Set((items || []).map(function (item) {
      return String(item.itemId || item.id || "");
    }));
    let shared = 0;
    previous.items.forEach(function (item) {
      if (ids.has(item.id)) shared += 1;
    });
    return shared / previous.items.length;
  }

  function buildTrip(items) {
    let previous = loadActive();
    if (previous && overlapRatio(previous, items) < 0.25) {
      if (previous.startedAt || previous.items.some(function (item) { return item.checked; })) {
        archiveTrip(previous);
      }
      previous = null;
    }
    const now = new Date().toISOString();
    const trip = {
      id: previous && previous.id ? previous.id : "trip-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      status: "active",
      mode: "instore",
      createdAt: previous && previous.createdAt ? previous.createdAt : now,
      startedAt: previous && previous.startedAt ? previous.startedAt : null,
      items: applyOrder(items, previous),
    };
    saveActive(trip);
    return trip;
  }

  function resortActive() {
    const trip = loadActive();
    if (!trip) return null;
    trip.items = applyOrder(trip.items.map(function (item) {
      return {
        itemId: item.id,
        name: item.name,
        price: item.price,
        size: item.size,
        image: item.image,
        quantity: item.quantity,
        location: item.location,
      };
    }), trip);
    saveActive(trip);
    return trip;
  }

  app.get("/api/store-layout", function (req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.json(loadLayout());
  });

  app.post("/api/store-layout", function (req, res) {
    const body = req.body || {};
    if (body.reset === true) {
      const layout = defaultLayout();
      ensureParent(layoutPath);
      writeJSON(layoutPath, layout);
      return res.json({ ok: true, layout: layout, trip: resortActive() });
    }
    if (!Array.isArray(body.sections) || !body.sections.length) {
      return res.status(400).json({ error: "sections must be a non-empty list" });
    }
    const layout = normalizeLayout(body);
    const useful = layout.sections.filter(function (section) { return section.type !== "fallback"; });
    if (!useful.length) {
      return res.status(400).json({ error: "Add at least one department or aisle range." });
    }
    ensureParent(layoutPath);
    writeJSON(layoutPath, layout);
    const trip = resortActive();
    res.json({ ok: true, layout: layout, trip: trip });
  });

  app.get("/api/shopping/active", function (req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.json({ trip: loadActive() });
  });

  app.post("/api/shopping/prepare", function (req, res) {
    const items = req.body && req.body.items;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: "items must be a list" });
    }
    if (!items.length) {
      return res.json({ trip: loadActive() });
    }
    const cleaned = items.filter(function (item) {
      return item && (item.name || item.item || item.itemId || item.id);
    }).map(function (item) {
      return {
        itemId: item.itemId || item.id,
        name: item.name || item.item || "Item",
        price: item.price || "",
        size: item.size || "",
        image: item.image || "",
        quantity: item.quantity || 1,
        location: item.location || "",
      };
    });
    res.json({ trip: buildTrip(cleaned) });
  });

  app.post("/api/shopping/start", function (req, res) {
    const trip = loadActive();
    if (!trip) return res.status(400).json({ error: "There is no shopping list to start." });
    if (!trip.startedAt) trip.startedAt = new Date().toISOString();
    saveActive(trip);
    res.json({ trip: trip });
  });

  app.post("/api/shopping/check", function (req, res) {
    const trip = loadActive();
    if (!trip) return res.status(400).json({ error: "There is no shopping list." });
    const itemId = req.body && req.body.itemId;
    if (!itemId) return res.status(400).json({ error: "itemId is required" });
    const item = trip.items.find(function (entry) { return entry.id === itemId; });
    if (!item) return res.status(404).json({ error: "Item is not on this list." });
    const checked = !!(req.body && req.body.checked);
    item.checked = checked;
    item.checkedAt = checked ? new Date().toISOString() : null;
    saveActive(trip);
    res.json({ ok: true, trip: trip });
  });

  app.post("/api/shopping/end", function (req, res) {
    const trip = loadActive();
    if (!trip) return res.status(400).json({ error: "There is no trip to save." });
    const summary = archiveTrip(trip);
    clearActive();
    res.json({ ok: true, trip: summary });
  });

  app.get("/api/shopping/history", function (req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.json({ trips: loadTrips() });
  });

  app.get("/api/shopping/pdf", async function (req, res) {
    try {
      const trip = loadActive();
      if (!trip) return res.status(404).json({ error: "There is no shopping list to export." });
      const bytes = await buildShoppingPdf(trip);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "inline; filename=\"woodmans-shopping-list.pdf\"");
      res.setHeader("Cache-Control", "no-store");
      res.send(bytes);
    } catch (err) {
      res.status(500).json({ error: err.message || "Could not build the PDF." });
    }
  });
}

module.exports = { registerShoppingRoutes };
