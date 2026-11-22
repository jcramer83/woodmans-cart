// Store walk order for Woodman's in-store shopping lists.
// Numbered aisles sort inside their range. Named departments (Produce,
// Bakery, the Soda Wall, and so on) follow the section list. Items with no
// location fall through to the fallback section, which stays last.

const DEFAULT_SECTIONS = [
  { id: "produce", type: "department", label: "Produce", match: ["produce"] },
  { id: "floral", type: "department", label: "Floral", match: ["floral", "flower"] },
  { id: "bakery", type: "department", label: "Bakery", match: ["bakery", "bread"] },
  { id: "deli", type: "department", label: "Deli", match: ["deli"] },
  { id: "cheese", type: "department", label: "Cheese", match: ["cheese"] },
  { id: "meat", type: "department", label: "Meat & Seafood", match: ["meat", "seafood", "butcher"] },
  { id: "aisles", type: "aisles", label: "Aisles", from: 1, to: 99, reverse: false },
  { id: "dairy", type: "department", label: "Dairy", match: ["dairy"] },
  { id: "frozen", type: "department", label: "Frozen", match: ["frozen", "ice cream"] },
  { id: "soda", type: "department", label: "Soda Wall", match: ["soda", "pop"] },
  { id: "liquor", type: "department", label: "Liquor", match: ["liquor", "beer", "wine", "spirits"] },
  { id: "health", type: "department", label: "Health & Beauty", match: ["health", "beauty", "pharmacy", "vitamin"] },
  { id: "other", type: "fallback", label: "Other" },
];

function defaultLayout() {
  return {
    sections: DEFAULT_SECTIONS.map(function (section) {
      const copy = Object.assign({}, section);
      if (section.match) copy.match = section.match.slice();
      return copy;
    }),
  };
}

function priceAmount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = String(value == null ? "" : value).replace(/,/g, "").match(/(\d+\.\d+|\d+)/);
  return match ? parseFloat(match[1]) : 0;
}

function parseLocation(input) {
  const text = String(input == null ? "" : input).trim();
  const empty = { raw: "", section: "", aisle: null, shelfLetter: "", shelfNumber: null };
  if (!text) return empty;

  const parts = text.split(/\s*-\s*/);
  const head = (parts[0] || "").trim();
  const tail = parts.slice(1).join(" - ").trim();
  const aisleMatch = head.match(/\baisle\s+(\d+)\b/i) || text.match(/\baisle\s+(\d+)\b/i);
  const aisle = aisleMatch ? parseInt(aisleMatch[1], 10) : null;
  let section = head;
  if (aisle != null && /^\s*aisle\s+\d+\s*$/i.test(head)) section = "Aisle";

  const shelfSource = tail || (aisle == null ? text : "");
  const shelfMatch = shelfSource.match(/\bshelf\s*([A-Za-z])?\s*(\d+)?/i);
  let shelfLetter = "";
  let shelfNumber = null;
  if (shelfMatch && (shelfMatch[1] || shelfMatch[2])) {
    shelfLetter = (shelfMatch[1] || "").toUpperCase();
    if (shelfMatch[2]) shelfNumber = parseInt(shelfMatch[2], 10);
  }

  return { raw: text, section: section, aisle: aisle, shelfLetter: shelfLetter, shelfNumber: shelfNumber };
}

function formatShelf(loc) {
  if (!loc || (!loc.shelfLetter && loc.shelfNumber == null)) return "";
  if (loc.shelfLetter && loc.shelfNumber != null) {
    return "Shelf " + loc.shelfLetter + String(loc.shelfNumber).padStart(2, "0");
  }
  if (loc.shelfNumber != null) return "Shelf " + loc.shelfNumber;
  return "Shelf " + loc.shelfLetter;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesDepartment(sectionName, keywords) {
  const name = String(sectionName || "").toLowerCase();
  if (!name) return false;
  return (keywords || []).some(function (keyword) {
    const key = String(keyword || "").toLowerCase().trim();
    if (!key) return false;
    if (name === key) return true;
    const re = new RegExp("(?:^|[^a-z0-9])" + escapeRegExp(key) + "(?:[^a-z0-9]|$)", "i");
    return re.test(name);
  });
}

function normalizeLayout(layout) {
  const incoming = layout && Array.isArray(layout.sections) ? layout.sections : null;
  const source = incoming && incoming.length ? incoming : defaultLayout().sections;
  const sections = [];
  let fallback = null;

  source.forEach(function (raw, index) {
    if (!raw || typeof raw !== "object") return;
    const type = raw.type === "aisles" || raw.type === "fallback" ? raw.type : "department";
    const id = String(raw.id || type + "-" + index).slice(0, 40);
    const label = String(raw.label || (type === "fallback" ? "Other" : "Section")).trim().slice(0, 40) || "Section";

    if (type === "fallback") {
      fallback = { id: id || "other", type: "fallback", label: label || "Other" };
      return;
    }

    if (type === "aisles") {
      let from = parseInt(raw.from, 10);
      let to = parseInt(raw.to, 10);
      if (!Number.isFinite(from)) from = 1;
      if (!Number.isFinite(to)) to = 99;
      from = Math.max(0, Math.min(500, from));
      to = Math.max(0, Math.min(500, to));
      if (from > to) {
        const swap = from;
        from = to;
        to = swap;
      }
      sections.push({
        id: id,
        type: "aisles",
        label: label || "Aisles",
        from: from,
        to: to,
        reverse: !!raw.reverse,
      });
      return;
    }

    let match = Array.isArray(raw.match) ? raw.match : String(raw.match || "").split(",");
    match = match
      .map(function (entry) { return String(entry || "").trim().toLowerCase(); })
      .filter(Boolean)
      .slice(0, 12);
    if (!match.length) match = [label.toLowerCase()];
    sections.push({ id: id, type: "department", label: label, match: match });
  });

  if (sections.length > 40) sections.length = 40;
  sections.push(fallback || { id: "other", type: "fallback", label: "Other" });
  return { sections: sections };
}

function locate(loc, sections) {
  const fallbackIndex = sections.length - 1;
  if (loc.aisle != null) {
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      if (section.type === "aisles" && loc.aisle >= section.from && loc.aisle <= section.to) {
        return {
          order: i,
          aisleSort: section.reverse ? -loc.aisle : loc.aisle,
          sectionKey: "aisle:" + loc.aisle,
          sectionLabel: "Aisle " + loc.aisle,
        };
      }
    }
  }

  if (loc.section && loc.aisle == null) {
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      if (section.type === "department" && matchesDepartment(loc.section, section.match)) {
        return {
          order: i,
          aisleSort: 0,
          sectionKey: "dept:" + section.id,
          sectionLabel: section.label,
        };
      }
    }
  }

  const fallback = sections[fallbackIndex];
  return {
    order: fallbackIndex,
    aisleSort: 0,
    sectionKey: "other",
    sectionLabel: fallback.label || "Other",
  };
}

function shelfRank(loc) {
  const hasShelf = !!(loc.shelfLetter || loc.shelfNumber != null);
  if (!hasShelf) return [1, "", 0];
  return [0, loc.shelfLetter || "", loc.shelfNumber == null ? 0 : loc.shelfNumber];
}

function orderShoppingItems(items, layout) {
  const sections = normalizeLayout(layout).sections;
  const rows = (Array.isArray(items) ? items : []).map(function (item, index) {
    const source = item || {};
    const loc = parseLocation(source.location);
    return { source: source, index: index, loc: loc, place: locate(loc, sections) };
  });

  rows.sort(function (a, b) {
    if (a.place.order !== b.place.order) return a.place.order - b.place.order;
    if (a.place.aisleSort !== b.place.aisleSort) return a.place.aisleSort - b.place.aisleSort;
    const aShelf = shelfRank(a.loc);
    const bShelf = shelfRank(b.loc);
    if (aShelf[0] !== bShelf[0]) return aShelf[0] - bShelf[0];
    if (aShelf[1] !== bShelf[1]) return aShelf[1] < bShelf[1] ? -1 : 1;
    if (aShelf[2] !== bShelf[2]) return aShelf[2] - bShelf[2];
    const nameCmp = String(a.source.name || "").localeCompare(String(b.source.name || ""), undefined, { sensitivity: "base" });
    if (nameCmp) return nameCmp;
    return a.index - b.index;
  });

  const seen = Object.create(null);
  const ordered = rows.map(function (row, sortIndex) {
    let id = String(row.source.itemId || row.source.id || "item-" + row.index);
    if (seen[id]) id = id + "-" + row.index;
    seen[id] = true;
    const quantity = parseInt(row.source.quantity, 10);
    return {
      id: id,
      name: String(row.source.name || "Item").slice(0, 180),
      price: row.source.price == null ? "" : String(row.source.price).slice(0, 40),
      size: row.source.size == null ? "" : String(row.source.size).slice(0, 80),
      image: row.source.image == null ? "" : String(row.source.image).slice(0, 2000),
      quantity: Number.isFinite(quantity) && quantity > 0 ? Math.min(quantity, 99) : 1,
      location: row.loc.raw,
      sectionKey: row.place.sectionKey,
      sectionLabel: row.place.sectionLabel,
      shelfLabel: formatShelf(row.loc),
      aisle: row.loc.aisle,
      sortIndex: sortIndex,
    };
  });

  const groups = [];
  ordered.forEach(function (item) {
    let group = groups[groups.length - 1];
    if (!group || group.key !== item.sectionKey) {
      group = { key: item.sectionKey, label: item.sectionLabel, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  });

  return { items: ordered, groups: groups };
}

module.exports = {
  defaultLayout,
  normalizeLayout,
  parseLocation,
  formatShelf,
  matchesDepartment,
  orderShoppingItems,
  priceAmount,
};
