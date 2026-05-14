// Example menu for the demo. A small café — coffees in three sizes, plus
// some unsized pastries and drinks. Real projects pass their own data into
// MenuLookup; this is just the demo seed.

import type { MenuItem } from "./types";

export const MENU: readonly MenuItem[] = [
  // ─── Coffees (sized) ──────────────────────────────────────────────────────
  { id: "latte_s",  base: "Latte",  category: "coffee", size: "Small",   pence: 290 },
  { id: "latte_r",  base: "Latte",  category: "coffee", size: "Regular", pence: 350 },
  { id: "latte_l",  base: "Latte",  category: "coffee", size: "Large",   pence: 410 },

  { id: "capp_s",   base: "Cappuccino", category: "coffee", size: "Small",   pence: 290 },
  { id: "capp_r",   base: "Cappuccino", category: "coffee", size: "Regular", pence: 350 },
  { id: "capp_l",   base: "Cappuccino", category: "coffee", size: "Large",   pence: 410 },

  { id: "amer_s",   base: "Americano", category: "coffee", size: "Small",   pence: 250 },
  { id: "amer_r",   base: "Americano", category: "coffee", size: "Regular", pence: 300 },
  { id: "amer_l",   base: "Americano", category: "coffee", size: "Large",   pence: 360 },

  { id: "mocha_s",  base: "Mocha", category: "coffee", size: "Small",   pence: 320 },
  { id: "mocha_r",  base: "Mocha", category: "coffee", size: "Regular", pence: 380 },
  { id: "mocha_l",  base: "Mocha", category: "coffee", size: "Large",   pence: 440 },

  { id: "hotchoc_s", base: "Hot Chocolate", category: "hot_chocolate", size: "Small",   pence: 320 },
  { id: "hotchoc_r", base: "Hot Chocolate", category: "hot_chocolate", size: "Regular", pence: 380 },
  { id: "hotchoc_l", base: "Hot Chocolate", category: "hot_chocolate", size: "Large",   pence: 440 },

  // ─── Coffees (unsized — single price) ─────────────────────────────────────
  { id: "espresso",   base: "Espresso",   category: "coffee", size: null, pence: 220 },
  { id: "macchiato",  base: "Macchiato",  category: "coffee", size: null, pence: 260 },
  { id: "flat_white", base: "Flat White", category: "coffee", size: null, pence: 330 },

  // ─── Teas ─────────────────────────────────────────────────────────────────
  { id: "english_tea", base: "English Breakfast Tea", category: "tea", size: null, pence: 240 },
  { id: "earl_grey",   base: "Earl Grey",             category: "tea", size: null, pence: 240 },
  { id: "green_tea",   base: "Green Tea",             category: "tea", size: null, pence: 240 },

  // ─── Pastries ────────────────────────────────────────────────────────────
  { id: "croissant",        base: "Croissant",        category: "pastry", size: null, pence: 280 },
  { id: "pain_au_chocolat", base: "Pain au Chocolat", category: "pastry", size: null, pence: 310 },
  { id: "brownie",          base: "Brownie",          category: "pastry", size: null, pence: 350 },
  { id: "cookie",           base: "Cookie",           category: "pastry", size: null, pence: 220 },
  { id: "muffin",           base: "Blueberry Muffin", category: "pastry", size: null, pence: 290 },
  { id: "cheesecake",       base: "Cheesecake Slice", category: "pastry", size: null, pence: 420 },
];
