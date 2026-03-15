# Woodmans Cart API Guide

API for automating grocery ordering on ShopWoodmans.com. Base URL: `http://localhost:3456`

All POST endpoints accept JSON bodies (`Content-Type: application/json`).

---

## Complete Order Flow

### 1. Set Shopping Mode

```
POST /api/shopping-mode
Body: { "shoppingMode": "pickup" }
```

Options: `"pickup"` or `"instore"`. Check current mode with `GET /api/shopping-mode`.

### 2. Add Items to Cart

**Add a single item by search query:**

```
POST /api/cart/add
Body: { "shoppingMode": "pickup", "query": "organic whole milk", "quantity": 1 }
```

Response:
```json
{
  "ok": true,
  "item": { "itemId": "items_498198-12345", "name": "Organic Whole Milk", "price": "$5.49", "size": "1 gal", "quantity": 1 }
}
```

Searches the Woodmans catalog for the best match and adds it to the online cart. You can also pass a product ID directly (e.g. `"query": "items_498198-12345"`). Returns the matched product details.

**Add all staples and recipes at once:**

```
POST /api/cart/start
```

Adds all enabled staples and recipes to the Woodmans online cart. Items are defined in the app's staples/recipes lists.

### 3. Get Available Pickup/Delivery Time Slots

```
POST /api/checkout/timeslots
Body: { "shoppingMode": "pickup" }
```

Response:
```json
{
  "days": [
    {
      "day_full": "Sunday, March 15",
      "date": "Mar 15",
      "options": [
        {
          "id": "7525985868",
          "window": "8am - 9am",
          "price": "$4.95",
          "attributes": ["available"],
          "pickup_full_window": "Pickup tomorrow, 8am - 9am"
        }
      ]
    }
  ]
}
```

Only options containing `"available"` in `attributes` can be selected. Use the `id` value when selecting a slot.

If the cart is below the store's order minimum, returns a fallback with `_pickupFromServiceChooser: true` instead of selectable slots.

### 4. Select a Time Slot

```
POST /api/checkout/select-timeslot
Body: { "shoppingMode": "pickup", "optionId": "7525985868" }
```

Response: `{ "ok": true }` on success.

### 5. Preview Checkout (Review Before Ordering)

```
POST /api/checkout/preview
Body: { "shoppingMode": "pickup" }
```

Response:
```json
{
  "cartItems": [
    { "name": "Organic Bell Peppers", "price": "$5.69", "size": "1 each", "quantity": 1, "image": "https://..." }
  ],
  "serviceChooser": {
    "service_types": [
      { "service_type": "pickup", "type": "active", "label": "Pickup", "bottom_text": "From $4.95 • From 8am" },
      { "service_type": "delivery", "type": "available", "label": "Delivery", "bottom_text": "From $9.95 • By 3pm" }
    ]
  },
  "checkoutTotals": {
    "line_items": [
      { "label": "Subtotal", "value": "$90.31" },
      { "label": "Est. tax", "value": "$0.66" }
    ],
    "total": { "label": "Total", "value": "$90.97" }
  }
}
```

**Note:** The pickup/delivery fee (e.g. $4.95) shown per-slot in the timeslots response is NOT included in `checkoutTotals`. Add it to the total to get the true grand total.

### 6. Place Order

```
POST /api/checkout/place-order
Body: { "shoppingMode": "pickup", "slotId": "7525985868" }
```

**This charges the credit card on file and places the order.** The `slotId` must be a valid `id` from the timeslots response.

Success: `{ "ok": true, "result": { ... } }`
Failure: `{ "error": "reason" }`

Requires a credit/debit card saved at shopwoodmans.com. PayPal is not supported via the API.

---

## Item Management

### Staples (Weekly Recurring Items)

```
GET  /api/staples              → Array of staple items
POST /api/staples              → Save full staples array (replaces all)
```

Each staple: `{ "id": "...", "item": "Whole Milk", "productName": "Woodmans Whole Milk", "brand": "Woodmans" }`

### Recipes

```
GET  /api/recipes              → Array of recipes
POST /api/recipes              → Save full recipes array (replaces all)
```

Each recipe: `{ "id": "...", "name": "Tacos", "enabled": true, "items": [{ "item": "Ground Beef", ... }] }`

Only recipes with `"enabled": true` are included when adding to cart.

### Product Search

```
GET /api/products/search?q=organic+milk
```

Returns matching products from the Woodmans catalog with name, price, size, brand, and image.

---

## Cart Operations

### Add Item to Cart

```
POST /api/cart/add
Body: { "shoppingMode": "pickup", "query": "bananas", "quantity": 2 }
```

Searches Woodmans and adds the best match. Works with product names, brands, or exact item IDs.

### View Current Online Cart

```
POST /api/cart/fetch
Body: { "shoppingMode": "pickup" }
```

Returns array of items currently in the Woodmans online cart. Each item includes `itemId`, `name`, `price`, `size`, `quantity`. Use `itemId` to remove individual items.

### Remove a Single Item from Cart

```
POST /api/cart/remove
Body: { "shoppingMode": "pickup", "itemId": "items_498198-12345" }
```

Removes one item from the Woodmans online cart. The `itemId` comes from the `/api/cart/fetch` response.

### Clear Entire Cart

```
POST /api/cart/remove-all
Body: { "shoppingMode": "pickup" }
```

Removes all items from the Woodmans online cart.

### Stop Cart Automation

```
POST /api/cart/stop
```

Aborts a running cart automation (if `POST /api/cart/start` is in progress).

---

## AI Recipe Generation

### Generate a Recipe

```
POST /api/recipe/generate
Body: { "prompt": "healthy chicken stir fry", "dietaryFlags": { "glutenFree": true } }
```

Uses Claude AI to generate a full recipe with ingredients optimized for Woodmans product search.

### Get Recipe Suggestions

```
POST /api/recipe/suggest
Body: { "prompt": "quick weeknight dinners", "count": 5 }
```

Returns recipe name ideas (no full recipes).

---

## Error Handling

All endpoints return `{ "error": "message" }` on failure. Common errors:

- `"Session expired"` — Login credentials may be invalid or session timed out
- `"No payment method on file..."` — Add a credit card at shopwoodmans.com
- `"No time slot selected"` — Must provide a valid `slotId` to place order
- `"A card is required for payment"` — Payment method not configured

---

## Example: Full Order Automation

```bash
# 1. Switch to pickup mode
curl -X POST localhost:3456/api/shopping-mode \
  -H "Content-Type: application/json" \
  -d '{"shoppingMode":"pickup"}'

# 2. Add items to cart (individually or all at once)
curl -X POST localhost:3456/api/cart/add \
  -H "Content-Type: application/json" \
  -d '{"shoppingMode":"pickup","query":"organic whole milk","quantity":1}'

# Or add all staples/recipes at once:
# curl -X POST localhost:3456/api/cart/start

# 3. Get available pickup time slots
curl -X POST localhost:3456/api/checkout/timeslots \
  -H "Content-Type: application/json" \
  -d '{"shoppingMode":"pickup"}'

# 4. Select a time slot (use an "id" from step 3)
curl -X POST localhost:3456/api/checkout/select-timeslot \
  -H "Content-Type: application/json" \
  -d '{"shoppingMode":"pickup","optionId":"7525985868"}'

# 5. Preview the order
curl -X POST localhost:3456/api/checkout/preview \
  -H "Content-Type: application/json" \
  -d '{"shoppingMode":"pickup"}'

# 6. Place the order (CHARGES THE CARD)
curl -X POST localhost:3456/api/checkout/place-order \
  -H "Content-Type: application/json" \
  -d '{"shoppingMode":"pickup","slotId":"7525985868"}'
```
