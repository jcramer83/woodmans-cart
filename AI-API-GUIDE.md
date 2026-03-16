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

**Add an item to the internal shopping cart:**

```
POST /api/cart/add
Body: { "item": "organic whole milk", "quantity": 1 }
```

Response:
```json
{
  "ok": true,
  "item": { "id": "m1abc23", "item": "organic whole milk", "quantity": 1 }
}
```

Adds an item to the internal shopping cart (manual items list). These items will be searched and added to the Woodmans online cart when "Add to Woodmans Cart" is triggered.

**Push all cart items to Woodmans:**

```
POST /api/cart/start
```

Searches and adds all enabled staples, recipes, and manual items to the Woodmans online cart.

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

Order placement is done through the app's UI: open Checkout Preview, review totals, then click Place Order. This is intentionally not exposed via API to prevent accidental charges.

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

### Add Item to Internal Cart

```
POST /api/cart/add
Body: { "item": "bananas", "quantity": 2 }
```

Adds an item to the internal shopping cart. Use `POST /api/cart/start` to push all items to Woodmans.

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

# 2. Add items to internal cart
curl -X POST localhost:3456/api/cart/add \
  -H "Content-Type: application/json" \
  -d '{"item":"organic whole milk","quantity":1}'

# 3. Push all cart items to Woodmans
curl -X POST localhost:3456/api/cart/start

# 4. Get available pickup time slots
curl -X POST localhost:3456/api/checkout/timeslots \
  -H "Content-Type: application/json" \
  -d '{"shoppingMode":"pickup"}'

# 5. Select a time slot (use an "id" from step 4)
curl -X POST localhost:3456/api/checkout/select-timeslot \
  -H "Content-Type: application/json" \
  -d '{"shoppingMode":"pickup","optionId":"7525985868"}'

# 6. Preview the order
curl -X POST localhost:3456/api/checkout/preview \
  -H "Content-Type: application/json" \
  -d '{"shoppingMode":"pickup"}'

# Order placement is done through the app UI (Checkout Preview → Place Order)
```
