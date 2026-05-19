"""Thin Supabase wrapper mirroring bridge/supabase.js."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Optional

from loguru import logger
from supabase import Client, create_client

_client: Optional[Client] = None


def sb() -> Client:
    global _client
    if _client is None:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        _client = create_client(url, key)
    return _client


def create_session(caller_msisdn: Optional[str] = None, channel_id: Optional[str] = None) -> dict:
    res = (
        sb()
        .table("sweetspot_call_sessions")
        .insert(
            {
                "caller_msisdn": caller_msisdn,
                "asterisk_channel_id": channel_id,
                "status": "active",
                "cart": [],
            }
        )
        .execute()
    )
    return res.data[0]


def update_session(session_id: str, patch: dict[str, Any]) -> None:
    try:
        sb().table("sweetspot_call_sessions").update(patch).eq("id", session_id).execute()
    except Exception as exc:  # noqa: BLE001
        logger.error(f"[sb] update_session: {exc}")


def end_session(session_id: str) -> None:
    update_session(
        session_id,
        {"status": "ended", "ended_at": datetime.now(timezone.utc).isoformat()},
    )


def log_event(session_id: str, kind: str, text: Optional[str] = None, payload: Any = None) -> None:
    try:
        sb().table("sweetspot_call_events").insert(
            {"session_id": session_id, "kind": kind, "text": text, "payload": payload}
        ).execute()
    except Exception as exc:  # noqa: BLE001
        logger.error(f"[sb] log_event: {exc}")


def create_order(
    *,
    session_id: str,
    caller_msisdn: Optional[str],
    customer_name: Optional[str],
    receipt_no: str,
    cart: list[dict],
    total_pence: int,
) -> dict:
    res = (
        sb()
        .table("sweetspot_orders")
        .insert(
            {
                "session_id": session_id,
                "caller_msisdn": caller_msisdn,
                "customer_name": customer_name,
                "receipt_no": receipt_no,
                "items": cart,
                "total_pence": total_pence,
            }
        )
        .execute()
    )
    return res.data[0]


def mark_whatsapp_sent(order_id: str) -> None:
    try:
        sb().table("sweetspot_orders").update(
            {"whatsapp_sent_at": datetime.now(timezone.utc).isoformat()}
        ).eq("id", order_id).execute()
    except Exception as exc:  # noqa: BLE001
        logger.error(f"[sb] mark_whatsapp_sent: {exc}")