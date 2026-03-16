# Woodmans Cart API Guide

API for managing a grocery shopping cart for Woodmans Food Markets. Base URL: `http://localhost:3456`

All POST endpoints accept JSON bodies (`Content-Type: application/json`).

---

## Shopping Cart

The shopping cart combines three sources: weekly staples, enabled recipe ingredients, and manually added items.

### View Cart

```
GET /api/cart
```

Response:
```json
{
  "items": [
    { "id": "staple-abc", "item": "A2 Milk Whole Milk 59 Oz", "quantity": 3, "price": "", "source": "staple" },
    { "id": "recipe-xyz-Ground Beef", "item": "Ground Beef", "quantity": 1, "price": "", "source": "Tacos" },
    { "id": "manual-m1abc", "item": "Bananas", "quantity": 2, "price": "", "source": "manual" }
  ],
  "itemCount": 3,
  "estimatedTotal": "$0.00"
}
```

The `source` field indicates where the item comes from: `"staple"` for weekly staples, a recipe name for recipe ingredients, or `"manual"` for manually added items. The `estimatedTotal` is calculated from items that have price data (not all items have prices stored).

### Add Item to Cart

```
POST /api/cart/add
Body: { "item": "organic whole milk", "quantity": 1 }
```

Adds an item to the manual items list in the shopping cart.

### Remove Item from Cart

```
DELETE /api/cart/manual/:id
```

Removes a manually added item. Use the ID portion after `manual-` from the cart response. For example, if the cart item ID is `manual-m1abc23`, call `DELETE /api/cart/manual/m1abc23`.

### Clear All Manual Items

```
POST /api/cart/manual/clear
```

---

## Weekly Staples

Recurring items that are always in the shopping cart.

### View Staples

```
GET /api/staples
```

Returns the full staples list:
```json
[
  { "id": "mle009s728zlz", "item": "A2 Milk Whole Milk 59 Oz", "quantity": 3, "productName": "A2 Milk Whole Milk 59 Oz", "brand": "" }
]
```

### Add a Staple

```
POST /api/staples
Body: { "item": "Organic Bananas", "quantity": 1 }
```

Adds a new weekly staple. Optional fields: `productName`, `brand`, `note`.

---

## Recipes

### View Active Recipes

```
GET /api/recipes/active
```

Returns only enabled recipes with their ingredients:
```json
[
  {
    "id": "abc123",
    "name": "Tacos",
    "items": [
      { "item": "Ground Beef", "quantity": 1, "note": "1 lb" },
      { "item": "Taco Shells", "quantity": 1 }
    ]
  }
]
```

### View All Recipes

```
GET /api/recipes
```

Returns all recipes including disabled ones. Each recipe has an `enabled` boolean.

---

## Product Search

```
GET /api/products/search?q=organic+milk
```

Search the Woodmans catalog. Returns matching products with name, price, size, brand, and image. Useful for finding exact product names to add as staples.

---

## AI Recipe Generation

### Generate a Recipe

```
POST /api/recipe/generate
Body: { "prompt": "healthy chicken stir fry", "dietaryFlags": { "glutenFree": true } }
```

Generates a full recipe with ingredients using Claude AI. Available dietary flags: `glutenFree`, `dairyFree`, `organic`, `pickyEater`.

### Get Recipe Suggestions

```
POST /api/recipe/suggest
Body: { "prompt": "quick weeknight dinners", "count": 5 }
```

Returns recipe name ideas.

---

## Error Handling

All endpoints return `{ "error": "message" }` on failure.

---

## Example: Add Items to Cart

```bash
# Add a manual item
curl -X POST localhost:3456/api/cart/add \
  -H "Content-Type: application/json" \
  -d '{"item":"organic whole milk","quantity":1}'

# Add a weekly staple
curl -X POST localhost:3456/api/staples \
  -H "Content-Type: application/json" \
  -d '{"item":"Organic Bananas","quantity":6}'

# View the full cart
curl localhost:3456/api/cart

# View active recipes
curl localhost:3456/api/recipes/active

# Search for a product
curl "localhost:3456/api/products/search?q=organic+milk"
```
