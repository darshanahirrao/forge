"""Expose existing Hermes turn evidence over ACP, using the installed native implementation.

This process-local compatibility adapter targets Hermes 0.17.0. It changes no
installed files and implements no model loop, tool, memory engine, or ACP parser.
"""

import hermes_bootstrap

hermes_bootstrap.harden_import_path()

import math
from acp_adapter import entry

# Match the native entry point's environment initialization before importing its server.
entry._load_env()
from acp_adapter import server
from acp_adapter.session import SessionManager

if server.HERMES_VERSION != "0.17.0":
    raise RuntimeError("Unsupported native Hermes reporting contract")


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else None


def summary(result, session_id):
    # Native early provider failures carry explicit failed=True but may omit
    # interrupted and usage. Preserve the failure without inventing counters.
    if isinstance(result, dict) and result.get("failed") is True and "interrupted" not in result:
        return {
            "version": 1, "sessionId": session_id, "reported": True,
            "completed": False, "failed": True, "interrupted": False,
            "cleanupFailed": bool(result.get("cleanup_errors")),
        }
    if not isinstance(result, dict) or not all(isinstance(result.get(key), bool) for key in ("completed", "failed", "interrupted")):
        return {"version": 1, "sessionId": session_id, "reported": False}
    return {
        "version": 1, "sessionId": session_id, "reported": True,
        "completed": result["completed"], "failed": result["failed"], "interrupted": result["interrupted"],
        "cleanupFailed": bool(result.get("cleanup_errors")),
        "usage": {
            "inputTokens": number(result.get("prompt_tokens")),
            "outputTokens": number(result.get("completion_tokens")),
            "totalTokens": number(result.get("total_tokens")),
            "thoughtTokens": number(result.get("reasoning_tokens")),
            "cachedReadTokens": number(result.get("cache_read_tokens")),
            "cachedWriteTokens": number(result.get("cache_write_tokens")),
        },
        "estimatedUsd": number(result.get("estimated_cost_usd")),
        "costStatus": str(result.get("cost_status") or "unknown")[:80],
    }


class ReportingSessions(SessionManager):
    def __init__(self):
        super().__init__()
        self.turn_results = {}
        self.depths = {}

    def _make_agent(self, **kwargs):
        agent = super()._make_agent(**kwargs)
        native_run = agent.run_conversation
        session_id = kwargs["session_id"]

        def observe(*args, **options):
            try:
                result = native_run(*args, **options)
            except Exception:
                self.turn_results.setdefault(session_id, []).append({
                    "version": 1, "sessionId": session_id, "reported": True,
                    "completed": False, "failed": True, "interrupted": False,
                })
                raise
            self.turn_results.setdefault(session_id, []).append(summary(result, session_id))
            return result

        agent.run_conversation = observe
        return agent


NativeAgent = server.HermesACPAgent


class ReportingAgent(NativeAgent):
    def __init__(self):
        super().__init__(ReportingSessions())

    async def initialize(self, **kwargs):
        response = await super().initialize(**kwargs)
        response.field_meta = {**(response.field_meta or {}), "forge": {"hermesNativeResult": 1}}
        return response

    async def prompt(self, prompt, session_id, **kwargs):
        sessions = self.session_manager
        outer = sessions.depths.get(session_id, 0) == 0
        if outer:
            sessions.turn_results.pop(session_id, None)
        sessions.depths[session_id] = sessions.depths.get(session_id, 0) + 1
        try:
            response = await super().prompt(prompt=prompt, session_id=session_id, **kwargs)
        finally:
            sessions.depths[session_id] -= 1
        results = sessions.turn_results.pop(session_id, []) if outer else sessions.turn_results.get(session_id, [])
        report = results[-1] if results else {"version": 1, "sessionId": session_id, "reported": False}
        if any(item.get("failed") or item.get("cleanupFailed") for item in results):
            report = {**report, "failed": True}
        response.field_meta = {**(response.field_meta or {}), "forge": {"hermesTurn": report}}
        return response


# Let the native entry point perform its own logging, MCP discovery and ACP lifecycle.
server.HermesACPAgent = ReportingAgent
entry.main([])
