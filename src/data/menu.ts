// Mirror of bridge/menu.js — single source of truth for the SweetSpot food menu.
// Prices are in pence.

export type MenuItem = {
  id: string;
  base: string;
  cat: "waffle" | "dough" | "cake" | "brownie" | "shake" | "drink" | "kunafah" | "churros" | "sundae";
  sizes?: Record<string, number>;
  pence?: number;
};

export const MENU: MenuItem[] = [
  { id: "waffle_classic",    base: "Classic Waffle",         cat: "waffle",  sizes: { Reg: 645,  Large: 845 } },
  { id: "waffle_banana",     base: "Banana Waffle",          cat: "waffle",  sizes: { Reg: 745,  Large: 945 } },
  { id: "waffle_strawberry", base: "Strawberry Waffle",      cat: "waffle",  sizes: { Reg: 795,  Large: 995 } },
  { id: "waffle_lotus",      base: "Lotus Biscoff Waffle",   cat: "waffle",  sizes: { Reg: 845,  Large: 1095 } },
  { id: "waffle_kinder",     base: "Kinder Bueno Waffle",    cat: "waffle",  sizes: { Reg: 895,  Large: 1145 } },
  { id: "dough_chocolate",   base: "Chocolate Cookie Dough", cat: "dough",   sizes: { Single: 595, Double: 895 } },
  { id: "dough_oreo",        base: "Oreo Cookie Dough",      cat: "dough",   sizes: { Single: 645, Double: 945 } },
  { id: "dough_lotus",       base: "Lotus Cookie Dough",     cat: "dough",   sizes: { Single: 695, Double: 995 } },
  { id: "dough_kinder",      base: "Kinder Cookie Dough",    cat: "dough",   sizes: { Single: 745, Double: 1045 } },
  { id: "cheese_ny",         base: "NY Cheesecake",          cat: "cake",    pence: 595 },
  { id: "cheese_lotus",      base: "Lotus Cheesecake",       cat: "cake",    pence: 695 },
  { id: "cheese_strawberry", base: "Strawberry Cheesecake",  cat: "cake",    pence: 695 },
  { id: "brownie_chocolate", base: "Chocolate Brownie",      cat: "brownie", pence: 425 },
  { id: "brownie_caramel",   base: "Salted Caramel Brownie", cat: "brownie", pence: 475 },
  { id: "shake_vanilla",     base: "Vanilla Shake",          cat: "shake",   pence: 495 },
  { id: "shake_chocolate",   base: "Chocolate Shake",        cat: "shake",   pence: 495 },
  { id: "shake_strawberry",  base: "Strawberry Shake",       cat: "shake",   pence: 495 },
  { id: "shake_oreo",        base: "Oreo Shake",             cat: "shake",   pence: 645 },
  { id: "shake_lotus",       base: "Lotus Biscoff Shake",    cat: "shake",   pence: 695 },
  { id: "shake_kinder",      base: "Kinder Shake",           cat: "shake",   pence: 745 },
  { id: "shake_nutella",     base: "Nutella Shake",          cat: "shake",   pence: 695 },
  { id: "latte",             base: "Latte",                  cat: "drink",   sizes: { Small: 295, Reg: 345, Large: 395 } },
  { id: "cappuccino",        base: "Cappuccino",             cat: "drink",   sizes: { Small: 295, Reg: 345, Large: 395 } },
  { id: "hotchoc",           base: "Hot Chocolate",          cat: "drink",   sizes: { Small: 325, Reg: 375, Large: 425 } },
  { id: "tea",               base: "Tea",                    cat: "drink",   sizes: { Small: 195, Reg: 245 } },
  { id: "iced_latte",        base: "Iced Latte",             cat: "drink",   pence: 395 },
  { id: "iced_choc",         base: "Iced Chocolate",         cat: "drink",   pence: 425 },
  { id: "kunafah",           base: "Kunafah",                cat: "kunafah", pence: 795 },
  { id: "churros",           base: "Churros",                cat: "churros", pence: 545 },
  { id: "sundae",            base: "Sundae",                 cat: "sundae",  pence: 595 },
];

export const CATEGORY_LABELS: Record<MenuItem["cat"], string> = {
  waffle: "Waffles",
  dough: "Cookie Dough",
  cake: "Cheesecakes",
  brownie: "Brownies",
  shake: "Shakes",
  drink: "Drinks",
  kunafah: "Kunafah",
  churros: "Churros",
  sundae: "Sundaes",
};

export function fmtPence(p: number) {
  return `£${(p / 100).toFixed(2)}`;
}