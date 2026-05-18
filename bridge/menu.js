// Full SweetSpot menu — ported from sweetspot-full-v3 (src/components_food/sweetSpotPreset.ts
// and sweetspot-agent/src/logic/menu.ts). Prices are in pence (GBP).
//
// Shape is the existing bridge shape so tools.js works unchanged:
//   { id, base, cat, sizes: { Sml: pence, Reg: pence, Lrg: pence } | undefined, pence?: number }

const gbp = (p) => Math.round(p * 100);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

// Sized items (waffle / cookie dough) share one price ladder.
const SIZED = { Sml: gbp(5.25), Reg: gbp(6.45), Lrg: gbp(7.95) };

const WAFFLES = [
  "The Classic", "Strawberry City", "Peanutty Banana", "Mango Madness",
  "Sweet Spot Special", "Unicorn", "Apple Pie & Custard", "Terry's Chocolate Orange",
  "Oreo-licious", "Cinnamon Surprise", "Ferrero Nibbles", "Brownie Bites",
  "Bonofa", "Choco Mint", "Kinder Surprise", "Snow White", "Pistachio Craze",
  "White Vader", "The Lotus Biscoff",
];

const COOKIE_DOUGHS = [
  "The Classic", "Strawberry City", "Peanutty Banana", "Sweet Spot Special",
  "Apple Pie & Custard", "White Vader", "Mango Madness", "Cinnamon Surprise",
  "Oreo-licious", "Ferrero Nibbles", "Choco Mint", "Kinder Surprise",
  "Brownie Bites", "The Lotus Biscoff", "Terry's Chocolate Orange",
  "Pistachio Craze", "Snow White", "Triple Cookie Blast", "Unicorn",
];

const CHEESECAKES = [
  "The Classic", "Strawberry City", "Peanutty Banana", "Sweet Spot Special",
  "Mango Madness", "Raspberry", "Unicorn", "Apple Pie & Custard", "Pistachio Craze",
  "Cinnamon Surprise", "Oreo-licious", "Snow White", "Bubblegum", "Brownie Bites",
  "Ferrero Nibbles", "Choco Mint", "Kinder Surprise", "White Vader",
  "The Lotus Biscoff", "Terry's Chocolate Orange",
];

const BROWNIES = [
  "The Classic Brownie", "Kinder Surprise", "Pistachio Craze",
  "Terry Chocolate Orange", "Brownie & Custard", "Oreo-licious", "Strawberry City",
  "Snow White", "The Lotus Biscoff", "Ferrero Nibbles", "Choco-Mint", "White Vader",
];

const SUNDAES = [
  "Oreo-licious", "Choco Mint", "The Lotus Biscoff", "Unicorn", "Bubblegum",
  "Apple Pie", "Ferrero Nibbles", "Mango Madness", "Pistachio Craze",
  "Kinder Surprise", "Brownie Bites", "Strawberry City", "Raspberry",
  "Sweet Spot Special",
];

const CHURROS = [
  "The Classic Churros", "Pistachio Churros", "Oreo Churros",
  "Ferrero Churros", "Snow White Churros", "Lotus Churros",
];

const CLASSIC_SHAKES = [
  "Bounty", "Crunchie", "Ferrero Rocher", "Kinder Bueno", "Mint Aero",
  "Oreo", "Snickers", "Twix", "Vanilla", "Malteaser", "Kitkat",
  "Kinder White", "Galaxy Original", "Galaxy Caramel", "MilkyWay", "MilkyBar White",
];

const PREMIUM_SHAKES = [
  ["Mango Madness Shake", 7], ["Strawberry Meltdown Shake", 7],
  ["Salted Peanut Butter Shake", 7], ["Banoffee Blast Shake", 7],
  ["Lotus Biscoff Shake", 7], ["Snow White Shake", 7], ["Frappuccino", 7],
  ["Bubblegum Shake", 7], ["Raspberry Shake", 7], ["Unicorn Shake", 7],
  ["Pistachio Craze Shake", 7], ["Brownie-Licious Shake", 7],
  ["Jammie Dodger Milkshake", 7.5], ["Skittles Shake", 7],
];

const KUNAFAH = [
  ["Classic Milk Kunafah", 7], ["Classic White Kunafah", 7], ["Honey Kunafah", 7],
  ["Classic Pistachio Kunafah", 7.5], ["Triple Blast Kunafah", 8.5],
  ["Half and Half Kunafah", 8],
  ["Viral Milk Kunafah (Small)", 5], ["Viral White Kunafah (Small)", 5],
  ["Viral Mixed Kunafah (Small)", 5.5],
  ["Viral Milk Kunafah (Large)", 10], ["Viral White Kunafah (Large)", 10],
  ["Viral Mixed Kunafah (Large)", 10.5],
];

const HOT_DRINKS = [
  ["Karak Chai", 2], ["Latte", 2.2], ["Cappuccino", 2.2],
  ["Karak Coffee", 2.2], ["Americano", 2.2], ["Mocha", 2.2],
  ["Hot Chocolate", 2.8], ["Espresso (Single)", 1], ["Espresso (Double)", 2],
  ["Mint Tea", 2],
];

const COLD_DRINKS = [
  ["Iced Tea", 4], ["Iced Coffee", 4], ["J2O", 1.8],
  ["Emerge Energy Drink", 1.8], ["Water", 1.3],
  ["Soft Drink Can", 1.3], ["Virgin Mojito", 6],
];

const EXTRAS = [
  ["Gelato (1 Scoop)", 2.45, "gelato"], ["Gelato (2 Scoops)", 3.95, "gelato"],
  ["Gelato (3 Scoops)", 4.95, "gelato"], ["Cone", 0.95, "gelato"],
  ["Nachos (Regular)", 5.95, "nachos"], ["Nachos (Large)", 6.95, "nachos"],
  ["Strawberry & Chocolate Box", 6.5, "extras"],
  ["Pot of Strawberries", 2, "extras"], ["Pot of Bananas", 2, "extras"],
  ["Pot of Mango Chunks", 2, "extras"], ["Pot of Milk Chocolate", 2, "extras"],
  ["Pot of White Chocolate", 2, "extras"], ["Pot of Pistachio Sauce", 2, "extras"],
  ["Pot of Oreo", 1.5, "extras"], ["Pot of Hot Custard", 1.5, "extras"],
  ["12oz Cup Soft Ice Cream", 3.5, "extras"],
];

function sized(name, cat) { return { id: `${cat}_${slug(name)}`, base: `${name} ${cat === "cookie_dough" ? "Cookie Dough" : "Waffle"}`, cat, sizes: { ...SIZED } }; }
function flat(name, pence, cat) { return { id: `${cat}_${slug(name)}`, base: name, cat, pence }; }

export const MENU = [
  ...WAFFLES.map((n) => sized(n, "waffle")),
  ...COOKIE_DOUGHS.map((n) => sized(n, "cookie_dough")),
  ...CHEESECAKES.map((n) => flat(`${n} Cheesecake`, gbp(7.5), "cheesecake")),
  ...BROWNIES.map((n) => flat(n.toLowerCase().includes("brownie") ? n : `${n} Brownie`, gbp(5.75), "brownie")),
  ...SUNDAES.map((n) => flat(`${n} Sundae`, gbp(6), "sundae")),
  ...CHURROS.map((n) => flat(n, gbp(7.5), "churros")),
  ...CLASSIC_SHAKES.map((n) => flat(`${n} Shake`, gbp(6), "classic_shake")),
  ...PREMIUM_SHAKES.map(([n, p]) => flat(n, gbp(p), "premium_shake")),
  ...KUNAFAH.map(([n, p]) => flat(n, gbp(p), "kunafah")),
  ...HOT_DRINKS.map(([n, p]) => flat(n, gbp(p), "hot_drink")),
  ...COLD_DRINKS.map(([n, p]) => flat(n, gbp(p), "cold_drink")),
  ...EXTRAS.map(([n, p, c]) => flat(n, gbp(p), c)),
];

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function voiceAlias(q) {
  if (/\b(?:carrot|karrot|kara)\s+chai\b/.test(q)) return "karak chai";
  if (/\bsweet\s+spot\s+specials?\b/.test(q) && !/\b(cookie|dough|cheesecake|sundae)\b/.test(q)) {
    return "sweet spot special waffle";
  }
  return q;
}

export function findItem(name) {
  const q = voiceAlias(norm(name));
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

/** Compact menu summary fed into the system prompt. */
export function menuForPrompt() {
  const cats = {};
  for (const it of MENU) (cats[it.cat] ||= []).push(it);
  const lines = [];
  for (const [cat, items] of Object.entries(cats)) {
    const head = cat.replace(/_/g, " ").toUpperCase();
    if (items[0].sizes) {
      const range = Object.entries(items[0].sizes).map(([s, p]) => `${s} £${(p / 100).toFixed(2)}`).join(" / ");
      lines.push(`# ${head} (${range})`);
      lines.push(items.map((i) => `- ${i.base}`).join("\n"));
    } else {
      lines.push(`# ${head}`);
      lines.push(items.map((i) => `- ${i.base} — £${((i.pence ?? 0) / 100).toFixed(2)}`).join("\n"));
    }
  }
  return lines.join("\n");
}
