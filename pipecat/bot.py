"""Sweet Spot voice ordering bot — Pipecat + SmallWebRTC.

Based on pipecat-examples/p2p-webrtc/pipecat-cloud, extended with Sweet Spot
menu, tool calls, and Supabase persistence (mirrors bridge/tools.js).
"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from loguru import logger
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import RunnerArguments
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

from .menu import menu_for_prompt
from .supabase_client import create_session, end_session, log_event
from .tools import TOOL_SCHEMAS, CallState, build_handlers

load_dotenv(override=True)


SYSTEM_PROMPT_TEMPLATE = """You are the friendly phone host for Sweet Spot, a UK dessert shop.

Rules:
- Greet the caller and ask what they'd like.
- Prices are in GBP. All prices are for the REGULAR size unless the caller explicitly says small or large.
- For waffles and cookie dough: NEVER ask for size first — default to Reg.
- If the caller says "Sweet Spot Special" without a category, treat it as "Sweet Spot Special Waffle Reg".
- If the caller says "carrot chai" / "karrot chai", they mean Karak Chai.
- When the caller lists multiple items in one go, call `record_items` ONCE with them all — do not call add_item repeatedly.
- Read the cart back briefly before confirming. Only call `confirm_order` after the caller clearly says they're done.
- Keep replies short and natural — your output becomes speech.
- Do not invent menu items. If something isn't on the menu, say so and suggest the closest match.

MENU:
{menu}
"""


async def run_bot(transport: BaseTransport, runner_args: RunnerArguments) -> None:
    body = getattr(runner_args, "body", None) or {}
    caller_msisdn = body.get("caller_msisdn")
    channel_id = body.get("channel_id")

    session = create_session(caller_msisdn=caller_msisdn, channel_id=channel_id)
    session_id = session["id"]
    logger.info(f"Sweet Spot session started: {session_id}")

    state = CallState(session_id=session_id, caller_msisdn=caller_msisdn)
    handlers = build_handlers(state)

    stt = DeepgramSTTService(api_key=os.environ["DEEPGRAM_API_KEY"])

    llm = OpenAILLMService(
        api_key=os.environ["OPENAI_API_KEY"],
        model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
        settings=OpenAILLMService.Settings(
            system_instruction=SYSTEM_PROMPT_TEMPLATE.format(menu=menu_for_prompt()),
        ),
    )

    for name, fn in handlers.items():
        llm.register_function(name, fn)

    tts = CartesiaTTSService(
        api_key=os.environ["CARTESIA_API_KEY"],
        settings=CartesiaTTSService.Settings(
            voice=os.environ.get("CARTESIA_VOICE_ID", "71a7ad14-091c-4e8e-a314-022ece01c121"),
        ),
    )

    tools = ToolsSchema(standard_tools=TOOL_SCHEMAS)
    context = LLMContext(tools=tools)

    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            user_aggregator,
            llm,
            tts,
            transport.output(),
            assistant_aggregator,
        ]
    )

    task = PipelineTask(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
    )

    @transport.event_handler("on_client_connected")
    async def on_client_connected(_t, _c):  # noqa: ANN001
        logger.info("Caller connected")
        log_event(session_id, "call_connected")
        await task.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(_t, _c):  # noqa: ANN001
        logger.info("Caller disconnected")
        log_event(session_id, "call_disconnected")
        end_session(session_id)
        await task.cancel()

    runner = PipelineRunner(handle_sigint=runner_args.handle_sigint)
    await runner.run(task)


async def bot(runner_args: RunnerArguments) -> None:
    """Pipecat Cloud entry point."""
    logger.info(f"Starting Sweet Spot bot, body: {getattr(runner_args, 'body', None)}")
    webrtc_connection: SmallWebRTCConnection = runner_args.webrtc_connection

    krisp_filter = None
    if os.environ.get("ENV") != "local":
        try:
            from pipecat.audio.filters.krisp_viva_filter import KrispVivaFilter

            krisp_filter = KrispVivaFilter()
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"Krisp filter unavailable, continuing without: {exc}")

    transport = SmallWebRTCTransport(
        webrtc_connection=webrtc_connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_in_filter=krisp_filter,
            audio_out_enabled=True,
        ),
    )

    await run_bot(transport, runner_args)


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()