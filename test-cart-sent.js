// Generate list stays available after a send, even when the cart
// update that follows has items but no aisle strings yet.
const assert = require("assert");
const { nextCartSent, withoutCartItem } = require("./renderer/cart-sent");

assert.strictEqual(nextCartSent(false, undefined), false, "no news keeps it off");
assert.strictEqual(nextCartSent(true, undefined), true, "a finished send is remembered");
assert.strictEqual(nextCartSent(true, []), false, "an empty cart turns it off");
assert.strictEqual(
  nextCartSent(true, [{ name: "Milk", quantity: 1 }]),
  true,
  "items without aisle numbers must not undo a successful send"
);
assert.strictEqual(
  nextCartSent(false, [{ name: "Milk", quantity: 1, location: "Aisle 4" }]),
  true,
  "aisle data turns it on"
);
assert.strictEqual(
  nextCartSent(false, [{ name: "Milk", location: "" }]),
  false,
  "a blank aisle is not aisle data"
);

const cart = [
  { itemId: "items_1", name: "Milk", price: "$3.49", quantity: 1, location: "Aisle 12" },
  { itemId: "items_2", name: "Bread", price: "$2.99", quantity: 2, location: "Aisle 7" },
];
assert.deepStrictEqual(
  withoutCartItem(cart, "items_1").map((item) => item.name),
  ["Bread"],
  "the x button drops only the clicked cart line"
);
assert.strictEqual(withoutCartItem(cart, "missing").length, 2);
assert.deepStrictEqual(withoutCartItem(null, "items_1"), []);
assert.strictEqual(nextCartSent(true, withoutCartItem(cart, "items_1")), true, "other aisle items keep Generate list");
assert.strictEqual(nextCartSent(true, withoutCartItem(withoutCartItem(cart, "items_1"), "items_2")), false, "an empty cart turns Generate list off");

const fs = require("fs");
const removeFn = fs.readFileSync("./renderer/app.js", "utf8");
const start = removeFn.indexOf("async function removeOnlineCartItem");
const end = removeFn.indexOf("async function fetchOnlineCart");
const body = removeFn.slice(start, end);
assert.ok(start !== -1 && end > start, "remove handler exists");
assert.ok(!body.includes("importOnlineCart"), "single remove must not call the missing importOnlineCart helper");
assert.ok(body.includes("withoutCartItem"), "single remove updates the list from the items still in the cart");

console.log("cart sent tests passed");
