// Generate list stays available after a send, even when the cart
// update that follows has items but no aisle strings yet.
const assert = require("assert");
const { nextCartSent } = require("./renderer/cart-sent");

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

console.log("cart sent tests passed");
