"""Tool definitions and executors — Python port of bridge/tools.js.

Uses Pipecat's native FunctionSchema / register_function pattern so tool calls
are reliable across model providers (no more record_items routing bugs).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

from loguru import logger
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.services.llm_service import FunctionCallParams

from .menu import find_item, generate_receipt_no, has_sizes, price_of, sizes_of
from .supabase_client import create_order, log_event, update_session


@dataclass
class CallState:
    session_id: str
    caller_msisdn: Optional[str] = None
    customer_name: Optional[str] = None
    cart: list[dict] = field(default_factory=list)
    confirmed: bool = False
    order: Optional[dict] = None


def _recalc(line: dict) -> dict:
    line["lineTotal"] = line["unitPence"] * line["qty"]
    return line


def _cart_total(cart: list[dict]) -> int:
    return sum(l["lineTotal"] for l in cart)


def _normalise_size(size: Optional[str]) -> Optional[str]:
    s = (size or "").lower().strip()
    if not s:
        return None
    if re.match(r"^(sml|small)\b", s):
        return "Sml"
    if re.match(r"^(lrg|large)\b", s):
        return "Lrg"
    if re.match(r"^(reg|regular)\b", s):
        return "Reg"
    return size


def _normalise_add_args(args: dict) -> dict:
    out = dict(args or {})
    raw = str(out.get("name") or "")
    q = re.sub(r"[^a-z0-9]+", " ", raw.lower()).strip()
    if re.search(r"\b(?:carrot|karrot|kara)\s+chai\b", q):
        out["name"] = "Karak Chai"
    if re.search(r"\bsweet\s+spot\s+specials?\b", q) and not re.search(
        r"\b(cookie|dough|cheesecake|sundae)\b", q
    ):
        out["name"] = "Sweet Spot Special Waffle"
        out.setdefault("size", "Reg")
    out["size"] = _normalise_size(out.get("size"))
    return out


# ---------- core operations ----------


def _sync_cart(state: CallState) -> None:
    update_session(state.session_id, {"cart": state.cart})


def _add_item(state: CallState, args: dict) -> dict:
    args = _normalise_add_args(args)
    item = find_item(args.get("name", ""))
    if not item:
        log_event(state.session_id, "tool_add_miss", args.get("name"), args)
        return {"ok": False, "error": f"Item \"{args.get('name')}\" not found on the menu."}
    size = args.get("size")
    if has_sizes(item) and not size:
        size = "Reg"
    if size and has_sizes(item) and size not in item["sizes"]:
        return {
            "ok": False,
            "error": f"Size \"{size}\" not available for {item['base']}. Available: {', '.join(sizes_of(item))}.",
        }
    qty = max(1, int(args.get("qty") or 1))
    unit_pence = price_of(item, size)
    line = _recalc(
        {"id": item["id"], "name": item["base"], "size": size, "qty": qty, "unitPence": unit_pence, "lineTotal": 0}
    )
    existing = next((l for l in state.cart if l["id"] == item["id"] and l["size"] == size), None)
    if existing:
        existing["qty"] += qty
        _recalc(existing)
    else:
        state.cart.append(line)
    _sync_cart(state)
    log_event(
        state.session_id,
        "cart_add",
        f"{qty}x {size or ''} {item['base']}".strip(),
        {"item": item["id"], "size": size, "qty": qty},
    )
    return {
        "ok": True,
        "added": {"name": item["base"], "size": size, "qty": qty, "unitPence": unit_pence},
        "cart": state.cart,
        "total_pence": _cart_total(state.cart),
    }


def _remove_item(state: CallState, args: dict) -> dict:
    item = find_item(args.get("name", ""))
    if not item:
        return {"ok": False, "error": f"Not on menu: {args.get('name')}"}
    before = len(state.cart)
    state.cart = [
        l for l in state.cart if not (l["id"] == item["id"] and (not args.get("size") or l["size"] == args["size"]))
    ]
    _sync_cart(state)
    log_event(state.session_id, "cart_remove", item["base"], {"item": item["id"], "size": args.get("size")})
    return {"ok": True, "removed": before - len(state.cart), "cart": state.cart, "total_pence": _cart_total(state.cart)}


def _confirm_order(state: CallState) -> dict:
    if not state.cart:
        return {"ok": False, "error": "Cart is empty."}
    if state.confirmed:
        return {"ok": True, "already": True, "order": state.order}
    receipt_no = generate_receipt_no()
    total_pence = _cart_total(state.cart)
    order = create_order(
        session_id=state.session_id,
        caller_msisdn=state.caller_msisdn,
        customer_name=state.customer_name,
        receipt_no=receipt_no,
        cart=state.cart,
        total_pence=total_pence,
    )
    state.confirmed = True
    state.order = order
    update_session(state.session_id, {"status": "confirmed", "current_intent": "confirmed"})
    log_event(state.session_id, "order_confirmed", receipt_no, {"total_pence": total_pence})
    # WhatsApp dispatch hook — wire to your sender later (kept non-blocking on purpose).
    return {"ok": True, "receipt_no": receipt_no, "total_pence": total_pence}


# ---------- Pipecat handlers ----------


def build_handlers(state: CallState):
    async def record_items(params: FunctionCallParams) -> None:
        items = params.arguments.get("items") or []
        if not items:
            await params.result_callback({"ok": False, "error": "No valid items supplied."})
            return
        added, errors = [], []
        for raw in items:
            res = _add_item(state, raw)
            if res.get("ok"):
                added.append(res["added"])
            else:
                errors.append({"item": raw, "error": res.get("error")})
        await params.result_callback(
            {
                "ok": not errors,
                "added": added,
                "errors": errors,
                "cart": state.cart,
                "total_pence": _cart_total(state.cart),
            }
        )

    async def add_item(params: FunctionCallParams) -> None:
        await params.result_callback(_add_item(state, params.arguments or {}))

    async def remove_item(params: FunctionCallParams) -> None:
        await params.result_callback(_remove_item(state, params.arguments or {}))

    async def set_customer_name(params: FunctionCallParams) -> None:
        name = str((params.arguments or {}).get("name") or "").strip()[:80] or None
        state.customer_name = name
        update_session(state.session_id, {"customer_name": name})
        log_event(state.session_id, "name_captured", name)
        await params.result_callback({"ok": True, "customer_name": name})

    async def read_back_cart(params: FunctionCallParams) -> None:
        await params.result_callback(
            {"cart": state.cart, "total_pence": _cart_total(state.cart), "customer_name": state.customer_name}
        )

    async def confirm_order(params: FunctionCallParams) -> None:
        try:
            await params.result_callback(_confirm_order(state))
        except Exception as exc:  # noqa: BLE001
            logger.exception("confirm_order failed")
            await params.result_callback({"ok": False, "error": str(exc)})

    return {
        "record_items": record_items,
        "add_item": add_item,
        "remove_item": remove_item,
        "set_customer_name": set_customer_name,
        "read_back_cart": read_back_cart,
        "confirm_order": confirm_order,
    }


TOOL_SCHEMAS: list[FunctionSchema] = [
    FunctionSchema(
        name="record_items",
        description=(
            "Add one or more ordered items to the cart in a single call. Default waffles and "
            "cookie dough to Reg unless the caller explicitly said small or large. Sweet Spot "
            "Special without a category means Sweet Spot Special Waffle Reg. carrot/karrot chai "
            "means Karak Chai."
        ),
        properties={
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "size": {"type": "string", "description": "Sml, Reg, or Lrg."},
                        "qty": {"type": "integer", "minimum": 1, "default": 1},
                    },
                    "required": ["name"],
                },
            },
        },
        required=["items"],
    ),
    FunctionSchema(
        name="add_item",
        description=(
            "Add a single item to the order. For waffles and cookie dough, default to Reg unless "
            "the caller explicitly said small or large."
        ),
        properties={
            "name": {"type": "string"},
            "size": {"type": "string"},
            "qty": {"type": "integer", "minimum": 1, "default": 1},
        },
        required=["name"],
    ),
    FunctionSchema(
        name="remove_item",
        description="Remove an item from the cart by name (and optional size).",
        properties={"name": {"type": "string"}, "size": {"type": "string"}},
        required=["name"],
    ),
    FunctionSchema(
        name="set_customer_name",
        description="Record the customer's name when they tell you.",
        properties={"name": {"type": "string"}},
        required=["name"],
    ),
    FunctionSchema(
        name="read_back_cart",
        description="Get a snapshot of the current cart and total to read back to the caller.",
        properties={},
        required=[],
    ),
    FunctionSchema(
        name="confirm_order",
        description=(
            "Finalize the order, generate a receipt number, and persist it. Only call after the "
            "caller has clearly indicated they're done."
        ),
        properties={},
        required=[],
    ),
]