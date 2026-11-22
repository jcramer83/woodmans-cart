// Shopping-mode checks: aisle order, trip persistence, and the fillable PDF.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { PDFDocument, PDFName } = require("pdf-lib");
const {
  parseLocation,
  orderShoppingItems,
  defaultLayout,
} = require("./store-layout");
const { parseItemDetails } = require("./cart-worker-fast");
const { resolveAsset } = require("./shopping-pdf");
const { writeSampleImages } = require("./fixtures/sample-art");

const EXPECTED_SAMPLE_ORDER = [
  "Bananas",
  "Romaine Hearts",
  "Strawberries",
  "Mixed Bouquet",
  "Everything Bagels",
  "French Bread",
  "Sliced Turkey",
  "Sharp Cheddar",
  "Ground Beef",
  "Chicken Thighs",
  "Diced Tomatoes",
  "Spaghetti",
  "Peanut Butter",
  "Oat Cereal",
  "Olive Oil",
  "Kettle Chips",
  "Paper Towels",
  "Greek Yogurt",
  "Salted Butter",
  "Whole Milk",
  "Vanilla Ice Cream",
  "Frozen Pizza",
  "Cola 12-Pack",
  "Sparkling Water",
  "Birthday Candles",
];

function testLocations() {
  const aisle = parseLocation("Aisle 12 - Shelf B05");
  assert.strictEqual(aisle.aisle, 12);
  assert.strictEqual(aisle.shelfLetter, "B");
  assert.strictEqual(aisle.shelfNumber, 5);

  const dairy = parseLocation("Dairy - Shelf 10");
  assert.strictEqual(dairy.aisle, null);
  assert.strictEqual(dairy.section, "Dairy");
  assert.strictEqual(dairy.shelfNumber, 10);
  assert.strictEqual(dairy.shelfLetter, "");

  const soda = parseLocation("Soda Wall - Shelf A08");
  assert.strictEqual(soda.section, "Soda Wall");
  assert.strictEqual(soda.shelfLetter, "A");
  assert.strictEqual(soda.shelfNumber, 8);

  assert.strictEqual(parseLocation("Produce - Shelf 15").section, "Produce");
  assert.strictEqual(parseLocation("Dairy").section, "Dairy");
  assert.strictEqual(parseLocation("Bakery").shelfNumber, null);
  assert.strictEqual(parseLocation("").raw, "");
  assert.strictEqual(parseLocation(null).aisle, null);

  const tight = parseLocation("Aisle 3-Shelf A02");
  assert.strictEqual(tight.aisle, 3);
  assert.strictEqual(tight.shelfLetter, "A");
  assert.strictEqual(tight.shelfNumber, 2);
}

function testOrder() {
  const sample = require("./fixtures/sample-cart.json");
  const ordered = orderShoppingItems(sample, defaultLayout());
  assert.deepStrictEqual(ordered.items.map(function (item) { return item.name; }), EXPECTED_SAMPLE_ORDER);
  assert.strictEqual(ordered.items.find(function (item) { return item.name === "Olive Oil"; }).shelfLabel, "Shelf A05");
  assert.strictEqual(ordered.items.find(function (item) { return item.name === "Whole Milk"; }).sectionLabel, "Dairy");
  assert.strictEqual(ordered.items.find(function (item) { return item.name === "Vanilla Ice Cream"; }).sectionLabel, "Frozen");
  assert.strictEqual(ordered.items.find(function (item) { return item.name === "Birthday Candles"; }).sectionLabel, "Other");
  assert.strictEqual(ordered.items.find(function (item) { return item.name === "Cola 12-Pack"; }).sectionLabel, "Soda Wall");
  assert.strictEqual(ordered.groups[0].label, "Produce");

  const custom = orderShoppingItems([
    { itemId: "a12", name: "Aisle 12", location: "Aisle 12 - Shelf A01" },
    { itemId: "a4", name: "Aisle 4", location: "Aisle 4 - Shelf B01" },
    { itemId: "milk", name: "Milk", location: "Dairy - Shelf 2" },
    { itemId: "a10", name: "Aisle 10", location: "Aisle 10 - Shelf A01" },
    { itemId: "apple", name: "Apple", location: "Produce - Shelf 1" },
    { itemId: "mystery", name: "Mystery", location: "" },
  ], {
    sections: [
      { id: "produce", type: "department", label: "Produce", match: ["produce"] },
      { id: "low", type: "aisles", label: "Front", from: 1, to: 8 },
      { id: "dairy", type: "department", label: "Dairy", match: ["dairy"] },
      { id: "high", type: "aisles", label: "Back", from: 9, to: 20, reverse: true },
      { id: "other", type: "fallback", label: "Other" },
    ],
  });
  assert.deepStrictEqual(custom.items.map(function (item) { return item.name; }), [
    "Apple", "Aisle 4", "Milk", "Aisle 12", "Aisle 10", "Mystery",
  ]);

  const sameShelf = orderShoppingItems([
    { itemId: "b", name: "Zucchini", location: "Produce - Shelf 4" },
    { itemId: "a", name: "Apples", location: "Produce - Shelf 4" },
  ], defaultLayout());
  assert.deepStrictEqual(sameShelf.items.map(function (item) { return item.name; }), ["Apples", "Zucchini"]);
}

function testParser() {
  const details = parseItemDetails([
    {
      id: "items_1-1",
      name: "Whole Milk",
      size: "1 gal",
      viewSection: {
        pricing: { price: { text: "$3.19" } },
        itemImage: { url: "https://cdn.example/milk.jpg" },
      },
      inStoreItemLocation: { viewSection: { locationString: "Dairy - Shelf 10" } },
    },
    {
      id: "items_2-2",
      name: "Pickup Only",
      size: "",
      viewSection: { itemImage: { url: "" } },
      inStoreItemLocation: null,
    },
  ]);
  assert.strictEqual(details["items_1-1"].location, "Dairy - Shelf 10");
  assert.strictEqual(details["items_1-1"].price, "$3.19");
  assert.strictEqual(details["items_1-1"].image, "https://cdn.example/milk.jpg");
  assert.strictEqual(details["items_2-2"].location, "");
  assert.strictEqual(resolveAsset("/assets/../../etc/passwd"), null);
  assert.strictEqual(resolveAsset("/etc/passwd"), null);
  assert.ok(String(resolveAsset("/assets/icon-new.png")).endsWith(path.join("assets", "icon-new.png")));
}

function startServer(dataDir, port) {
  const proc = spawn(process.execPath, ["server-standalone.js"], {
    cwd: path.join(__dirname),
    env: Object.assign({}, process.env, { DATA_DIR: dataDir, PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  proc.stdout.on("data", function (chunk) { logs += chunk; });
  proc.stderr.on("data", function (chunk) { logs += chunk; });
  proc.logs = function () { return logs; };
  return proc;
}

function stopServer(proc) {
  if (!proc || proc.killed) return Promise.resolve();
  return new Promise(function (resolve) {
    proc.once("exit", function () { resolve(); });
    proc.kill("SIGTERM");
    setTimeout(function () {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 2000);
  });
}

async function waitFor(proc, port) {
  const url = "http://127.0.0.1:" + port + "/api/settings";
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (proc.exitCode != null) throw new Error("server exited\n" + proc.logs());
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {}
    await new Promise(function (resolve) { setTimeout(resolve, 100); });
  }
  throw new Error("server did not start\n" + proc.logs());
}

async function testApi() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woodmans-shop-"));
  const port = 3461;
  const base = "http://127.0.0.1:" + port;
  const images = writeSampleImages(path.join(__dirname, "assets", "sample"));
  const banana = images.find(function (item) { return item.itemId === "bananas"; });
  let proc = startServer(dir, port);
  try {
    await waitFor(proc, port);

    const manifest = await fetch(base + "/manifest.webmanifest");
    assert.strictEqual(manifest.status, 200);
    assert.match(manifest.headers.get("content-type") || "", /manifest/);
    const shoppingJs = await fetch(base + "/shopping.js");
    assert.strictEqual(shoppingJs.status, 200);

    const layout = await (await fetch(base + "/api/store-layout")).json();
    assert.strictEqual(layout.sections[0].id, "produce");
    assert.strictEqual(layout.sections[layout.sections.length - 1].type, "fallback");

    const items = [
      { itemId: "milk", name: "Whole Milk", price: "$3.19", quantity: 1, location: "Dairy - Shelf 10", image: banana.image },
      { itemId: "bananas", name: "Bananas", price: "$1.49", quantity: 1, location: "Produce - Shelf 2", image: banana.image },
      { itemId: "pasta", name: "Spaghetti", price: "$1.49", quantity: 2, location: "Aisle 4 - Shelf B08", image: "/assets/../../etc/passwd" },
      { itemId: "cola", name: "Cola", price: "$6.49", quantity: 1, location: "Soda Wall - Shelf A08" },
      { itemId: "lost", name: "Birthday Candles", price: "$1.99", quantity: 1, location: "" },
    ];
    const prepared = await post(base + "/api/shopping/prepare", { items: items });
    assert.deepStrictEqual(prepared.trip.items.map(function (item) { return item.name; }), [
      "Bananas", "Spaghetti", "Whole Milk", "Cola", "Birthday Candles",
    ]);

    const marked = await post(base + "/api/shopping/check", { itemId: "bananas", checked: true });
    assert.strictEqual(marked.trip.items.find(function (item) { return item.id === "bananas"; }).checked, true);

    const started = await post(base + "/api/shopping/start", {});
    assert.ok(started.trip.startedAt);

    await stopServer(proc);
    proc = startServer(dir, port);
    await waitFor(proc, port);
    const resumed = await (await fetch(base + "/api/shopping/active")).json();
    assert.strictEqual(resumed.trip.items.find(function (item) { return item.id === "bananas"; }).checked, true);
    assert.strictEqual(resumed.trip.startedAt, started.trip.startedAt);

    const pdfRes = await fetch(base + "/api/shopping/pdf");
    assert.strictEqual(pdfRes.status, 200);
    assert.match(pdfRes.headers.get("content-type") || "", /pdf/);
    const bytes = Buffer.from(await pdfRes.arrayBuffer());
    assert.strictEqual(bytes.slice(0, 5).toString(), "%PDF-");
    const doc = await PDFDocument.load(bytes);
    const fields = doc.getForm().getFields();
    assert.strictEqual(fields.length, 5);
    const bananaBox = doc.getForm().getCheckBox("item_0");
    assert.strictEqual(bananaBox.isChecked(), true);
    assert.strictEqual(doc.getForm().getCheckBox("item_1").isChecked(), false);
    let imagesFound = 0;
    doc.context.enumerateIndirectObjects().forEach(function (entry) {
      const obj = entry[1];
      if (!obj || !obj.dict) return;
      const subtype = obj.dict.get(PDFName.of("Subtype"));
      if (subtype && String(subtype) === "/Image") imagesFound += 1;
    });
    assert.ok(imagesFound >= 1, "expected an embedded thumbnail");

    const ended = await post(base + "/api/shopping/end", {});
    assert.strictEqual(ended.trip.checkedCount, 1);
    assert.strictEqual(ended.trip.skippedCount, 4);
    assert.strictEqual(ended.trip.itemCount, 5);
    assert.ok(ended.trip.durationMs >= 0);
    assert.strictEqual(ended.trip.totalPrice, 16.14);
    const cleared = await (await fetch(base + "/api/shopping/active")).json();
    assert.strictEqual(cleared.trip, null);

    await stopServer(proc);
    proc = startServer(dir, port);
    await waitFor(proc, port);
    const history = await (await fetch(base + "/api/shopping/history")).json();
    assert.strictEqual(history.trips.length, 1);
    assert.strictEqual(history.trips[0].checkedCount, 1);
    assert.ok(fs.existsSync(path.join(dir, "shopping-trips.json")));
    assert.ok(!fs.existsSync(path.join(dir, "active-trip.json")));

    const moved = await post(base + "/api/store-layout", {
      sections: [
        { id: "soda", type: "department", label: "Soda Wall", match: ["soda"] },
        { id: "produce", type: "department", label: "Produce", match: ["produce"] },
        { id: "other", type: "fallback", label: "Other" },
      ],
    });
    assert.strictEqual(moved.layout.sections[0].id, "soda");
    const again = await post(base + "/api/shopping/prepare", { items: items });
    assert.deepStrictEqual(again.trip.items.map(function (item) { return item.name; }).slice(0, 2), ["Cola", "Bananas"]);
    const reset = await post(base + "/api/store-layout", { reset: true });
    assert.strictEqual(reset.layout.sections[0].id, "produce");
    assert.strictEqual(reset.trip.items[0].name, "Bananas");
  } finally {
    await stopServer(proc);
  }
}

function post(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async function (res) {
    const json = await res.json();
    if (!res.ok) throw new Error(res.status + " " + JSON.stringify(json));
    return json;
  });
}

async function main() {
  testLocations();
  testOrder();
  testParser();
  await testApi();
  console.log("shopping mode tests passed");
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
