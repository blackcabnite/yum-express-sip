// Ported from sweetspot-simulator.jsx — single source of truth for menu + pricing
export const MENU = [
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

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function findItem(name) {
  const q = norm(name);
  if (!q) return null;
  let m = MENU.find((it) => norm(it.base) === q);
  if (m) return m;
  m = MENU.find((it) => norm(it.base).includes(q) || q.includes(norm(it.base)));
  if (m) return m;
  const qTokens = q.split(" ").filter((t) => t.length > 2);
  let best = null, bestScore = 0;
  for (const it of MENU) {
    const iTokens = norm(it.base).split(" ");
    const overlap = qTokens.filter((t) => iTokens.some((u) => u.includes(t) || t.includes(u))).length;
    if (overlap > bestScore) { best = it; bestScore = overlap; }
  }
  return bestScore >= 1 ? best : null;
}

export function priceOf(item, size) {
  if (!item) return 0;
  if (item.pence != null) return item.pence;
  if (item.sizes) {
    if (size && item.sizes[size] != null) return item.sizes[size];
    if (item.sizes.Reg != null) return item.sizes.Reg;
    return Object.values(item.sizes)[0];
  }
  return 0;
}

export const hasSizes = (item) => !!item?.sizes;
export const sizesOf = (item) => item?.sizes ? Object.keys(item.sizes) : [];

export function generateReceiptNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  const rand = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join("");
  return `SS-${ymd}-${rand}`;
}

export function menuForPrompt() {
  const cats = {};
  for (const it of MENU) (cats[it.cat] ||= []).push(it);
  const fmt = (it) => {
    if (it.pence != null) return `${it.base} £${(it.pence / 100).toFixed(2)}`;
    return `${it.base} ` + Object.entries(it.sizes).map(([s, p]) => `${s} £${(p / 100).toFixed(2)}`).join(" / ");
  };
  return Object.entries(cats).map(([cat, items]) =>
    `${cat.toUpperCase()}:\n` + items.map((i) => "  - " + fmt(i)).join("\n")
  ).join("\n\n");
}