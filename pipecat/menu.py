"""Sweet Spot menu — Python port of bridge/menu.js. Prices in pence (GBP)."""

from __future__ import annotations

import random
import re
import string
from datetime import datetime
from typing import Optional


def _gbp(p: float) -> int:
    return round(p * 100)


def _slug(s: str) -> str:
    return re.sub(r"^_|_$", "", re.sub(r"[^a-z0-9]+", "_", s.lower()))


SIZED = {"Sml": _gbp(5.25), "Reg": _gbp(6.45), "Lrg": _gbp(7.95)}

WAFFLES = [
    "The Classic", "Strawberry City", "Peanutty Banana", "Mango Madness",
    "Sweet Spot Special", "Unicorn", "Apple Pie & Custard", "Terry's Chocolate Orange",
    "Oreo-licious", "Cinnamon Surprise", "Ferrero Nibbles", "Brownie Bites",
    "Bonofa", "Choco Mint", "Kinder Surprise", "Snow White", "Pistachio Craze",
    "White Vader", "The Lotus Biscoff",
]

COOKIE_DOUGHS = [
    "The Classic", "Strawberry City", "Peanutty Banana", "Sweet Spot Special",
    "Apple Pie & Custard", "White Vader", "Mango Madness", "Cinnamon Surprise",
    "Oreo-licious", "Ferrero Nibbles", "Choco Mint", "Kinder Surprise",
    "Brownie Bites", "The Lotus Biscoff", "Terry's Chocolate Orange",
    "Pistachio Craze", "Snow White", "Triple Cookie Blast", "Unicorn",
]

CHEESECAKES = [
    "The Classic", "Strawberry City", "Peanutty Banana", "Sweet Spot Special",
    "Mango Madness", "Raspberry", "Unicorn", "Apple Pie & Custard", "Pistachio Craze",
    "Cinnamon Surprise", "Oreo-licious", "Snow White", "Bubblegum", "Brownie Bites",
    "Ferrero Nibbles", "Choco Mint", "Kinder Surprise", "White Vader",
    "The Lotus Biscoff", "Terry's Chocolate Orange",
]

BROWNIES = [
    "The Classic Brownie", "Kinder Surprise", "Pistachio Craze",
    "Terry Chocolate Orange", "Brownie & Custard", "Oreo-licious", "Strawberry City",
    "Snow White", "The Lotus Biscoff", "Ferrero Nibbles", "Choco-Mint", "White Vader",
]

SUNDAES = [
    "Oreo-licious", "Choco Mint", "The Lotus Biscoff", "Unicorn", "Bubblegum",
    "Apple Pie", "Ferrero Nibbles", "Mango Madness", "Pistachio Craze",
    "Kinder Surprise", "Brownie Bites", "Strawberry City", "Raspberry",
    "Sweet Spot Special",
]

CHURROS = [
    "The Classic Churros", "Pistachio Churros", "Oreo Churros",
    "Ferrero Churros", "Snow White Churros", "Lotus Churros",
]

CLASSIC_SHAKES = [
    "Bounty", "Crunchie", "Ferrero Rocher", "Kinder Bueno", "Mint Aero",
    "Oreo", "Snickers", "Twix", "Vanilla", "Malteaser", "Kitkat",
    "Kinder White", "Galaxy Original", "Galaxy Caramel", "MilkyWay", "MilkyBar White",
]

PREMIUM_SHAKES = [
    ("Mango Madness Shake", 7), ("Strawberry Meltdown Shake", 7),
    ("Salted Peanut Butter Shake", 7), ("Banoffee Blast Shake", 7),
    ("Lotus Biscoff Shake", 7), ("Snow White Shake", 7), ("Frappuccino", 7),
    ("Bubblegum Shake", 7), ("Raspberry Shake", 7), ("Unicorn Shake", 7),
    ("Pistachio Craze Shake", 7), ("Brownie-Licious Shake", 7),
    ("Jammie Dodger Milkshake", 7.5), ("Skittles Shake", 7),
]

KUNAFAH = [
    ("Classic Milk Kunafah", 7), ("Classic White Kunafah", 7), ("Honey Kunafah", 7),
    ("Classic Pistachio Kunafah", 7.5), ("Triple Blast Kunafah", 8.5),
    ("Half and Half Kunafah", 8),
    ("Viral Milk Kunafah (Small)", 5), ("Viral White Kunafah (Small)", 5),
    ("Viral Mixed Kunafah (Small)", 5.5),
    ("Viral Milk Kunafah (Large)", 10), ("Viral White Kunafah (Large)", 10),
    ("Viral Mixed Kunafah (Large)", 10.5),
]

HOT_DRINKS = [
    ("Karak Chai", 2), ("Latte", 2.2), ("Cappuccino", 2.2),
    ("Karak Coffee", 2.2), ("Americano", 2.2), ("Mocha", 2.2),
    ("Hot Chocolate", 2.8), ("Espresso (Single)", 1), ("Espresso (Double)", 2),
    ("Mint Tea", 2),
]

COLD_DRINKS = [
    ("Iced Tea", 4), ("Iced Coffee", 4), ("J2O", 1.8),
    ("Emerge Energy Drink", 1.8), ("Water", 1.3),
    ("Soft Drink Can", 1.3), ("Virgin Mojito", 6),
]

EXTRAS = [
    ("Gelato (1 Scoop)", 2.45, "gelato"), ("Gelato (2 Scoops)", 3.95, "gelato"),
    ("Gelato (3 Scoops)", 4.95, "gelato"), ("Cone", 0.95, "gelato"),
    ("Nachos (Regular)", 5.95, "nachos"), ("Nachos (Large)", 6.95, "nachos"),
    ("Strawberry & Chocolate Box", 6.5, "extras"),
    ("Pot of Strawberries", 2, "extras"), ("Pot of Bananas", 2, "extras"),
    ("Pot of Mango Chunks", 2, "extras"), ("Pot of Milk Chocolate", 2, "extras"),
    ("Pot of White Chocolate", 2, "extras"), ("Pot of Pistachio Sauce", 2, "extras"),
    ("Pot of Oreo", 1.5, "extras"), ("Pot of Hot Custard", 1.5, "extras"),
    ("12oz Cup Soft Ice Cream", 3.5, "extras"),
]


def _sized(name: str, cat: str) -> dict:
    label = "Cookie Dough" if cat == "cookie_dough" else "Waffle"
    return {"id": f"{cat}_{_slug(name)}", "base": f"{name} {label}", "cat": cat, "sizes": dict(SIZED)}


def _flat(name: str, pence: int, cat: str) -> dict:
    return {"id": f"{cat}_{_slug(name)}", "base": name, "cat": cat, "pence": pence}


MENU: list[dict] = []
MENU += [_sized(n, "waffle") for n in WAFFLES]
MENU += [_sized(n, "cookie_dough") for n in COOKIE_DOUGHS]
MENU += [_flat(f"{n} Cheesecake", _gbp(7.5), "cheesecake") for n in CHEESECAKES]
MENU += [_flat(n if "brownie" in n.lower() else f"{n} Brownie", _gbp(5.75), "brownie") for n in BROWNIES]
MENU += [_flat(f"{n} Sundae", _gbp(6), "sundae") for n in SUNDAES]
MENU += [_flat(n, _gbp(7.5), "churros") for n in CHURROS]
MENU += [_flat(f"{n} Shake", _gbp(6), "classic_shake") for n in CLASSIC_SHAKES]
MENU += [_flat(n, _gbp(p), "premium_shake") for n, p in PREMIUM_SHAKES]
MENU += [_flat(n, _gbp(p), "kunafah") for n, p in KUNAFAH]
MENU += [_flat(n, _gbp(p), "hot_drink") for n, p in HOT_DRINKS]
MENU += [_flat(n, _gbp(p), "cold_drink") for n, p in COLD_DRINKS]
MENU += [_flat(n, _gbp(p), c) for n, p, c in EXTRAS]


def _norm(s: Optional[str]) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _voice_alias(q: str) -> str:
    if re.search(r"\b(?:carrot|karrot|kara)\s+chai\b", q):
        return "karak chai"
    if re.search(r"\bsweet\s+spot\s+specials?\b", q) and not re.search(
        r"\b(cookie|dough|cheesecake|sundae)\b", q
    ):
        return "sweet spot special waffle"
    return q


def find_item(name: str) -> Optional[dict]:
    q = _voice_alias(_norm(name))
    if not q:
        return None
    for it in MENU:
        if _norm(it["base"]) == q:
            return it
    for it in MENU:
        nb = _norm(it["base"])
        if q in nb or nb in q:
            return it
    q_tokens = [t for t in q.split(" ") if len(t) > 2]
    best, best_score = None, 0
    for it in MENU:
        i_tokens = _norm(it["base"]).split(" ")
        overlap = sum(1 for t in q_tokens if any(t in u or u in t for u in i_tokens))
        if overlap > best_score:
            best, best_score = it, overlap
    return best if best_score >= 1 else None


def price_of(item: Optional[dict], size: Optional[str]) -> int:
    if not item:
        return 0
    if item.get("pence") is not None:
        return item["pence"]
    sizes = item.get("sizes")
    if sizes:
        if size and sizes.get(size) is not None:
            return sizes[size]
        if sizes.get("Reg") is not None:
            return sizes["Reg"]
        return next(iter(sizes.values()))
    return 0


def has_sizes(item: Optional[dict]) -> bool:
    return bool(item and item.get("sizes"))


def sizes_of(item: Optional[dict]) -> list[str]:
    return list(item["sizes"].keys()) if item and item.get("sizes") else []


def generate_receipt_no() -> str:
    d = datetime.utcnow()
    ymd = f"{d.year}{d.month:02d}{d.day:02d}"
    alphabet = string.ascii_uppercase.replace("I", "").replace("O", "") + "0123456789"
    rand = "".join(random.choice(alphabet) for _ in range(4))
    return f"SS-{ymd}-{rand}"


def menu_for_prompt() -> str:
    cats: dict[str, list[dict]] = {}
    for it in MENU:
        cats.setdefault(it["cat"], []).append(it)
    lines: list[str] = []
    for cat, items in cats.items():
        head = cat.replace("_", " ").upper()
        if items[0].get("sizes"):
            rng = " / ".join(f"{s} £{p/100:.2f}" for s, p in items[0]["sizes"].items())
            lines.append(f"# {head} ({rng})")
            lines.append("\n".join(f"- {i['base']}" for i in items))
        else:
            lines.append(f"# {head}")
            lines.append(
                "\n".join(f"- {i['base']} — £{(i.get('pence', 0))/100:.2f}" for i in items)
            )
    return "\n".join(lines)