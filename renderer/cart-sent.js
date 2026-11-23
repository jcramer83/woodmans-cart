// Decide whether Generate list should stay available.
// A cart payload with items but no aisle strings must not turn it off:
// the send-complete cart update omits locations, and Refresh is what used to add them.
function nextCartSent(wasSent, items) {
  if (!Array.isArray(items)) return !!wasSent;
  if (items.length === 0) return false;
  if (items.some(function (item) { return item && item.location; })) return true;
  return !!wasSent;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { nextCartSent: nextCartSent };
}
