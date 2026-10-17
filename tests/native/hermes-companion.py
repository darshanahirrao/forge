"""Use the installed Hermes MCP client and registry, with isolated explicit config.

No model, scheduler, browser, provider credential or private home is loaded.
"""
import hermes_bootstrap

hermes_bootstrap.harden_import_path()

import json
import sys
from tools.mcp_tool import register_mcp_servers, shutdown_mcp_servers
from tools.registry import registry

fixture = json.load(sys.stdin)


def call(name, arguments):
    tool = registry.get_entry("mcp_forge_" + name)
    assert tool is not None, "Native Hermes did not register the Forge MCP tool"
    response = json.loads(tool.handler(arguments))
    assert "error" not in response, "Native MCP call failed"
    if "structuredContent" in response:
        return response["structuredContent"]
    return json.loads(response["result"])


try:
    names = register_mcp_servers({"forge": {
        "url": fixture["endpoint"],
        "headers": {"Authorization": "Bearer " + fixture["token"]},
        "timeout": 15,
        "connect_timeout": 10,
        "sampling": {"enabled": False},
        "elicitation": {"enabled": False},
    }})
    assert len(names) == (6 if fixture.get("handoff") else 5)
    assert not any("approv" in name or "start_work" in name for name in names)
    workspace = call("forge_workspace", {})
    assert workspace["profile"]["id"] == fixture["profileId"]
    assert any(work["id"] == fixture["workId"] for work in workspace["work"])
    context = call("forge_context", {"workId": fixture["workId"]})
    assert "native-selected-copper" in json.dumps(context)
    assert "native-excluded-violet" not in json.dumps(context)
    if fixture.get("handoff"):
        ready = call("forge_companion_ready", fixture["handoff"])
        assert ready["state"] == "ready"
        print(json.dumps({"native": "Hermes MCP client", "ready": True, "tools": len(names), "paidModelCalls": 0}))
        sys.exit(0)
    work = call("forge_work", {"workId": fixture["workId"]})["work"]
    note = {
        "requestId": "native-hermes-note", "workId": work["id"],
        "expectedRevision": work["revision"], "note": "Native Hermes MCP observed the selected project memory.",
    }
    first = call("forge_checkpoint", note)
    assert call("forge_checkpoint", note)["id"] == first["id"]
    draft = {
        "requestId": "native-hermes-work", "title": "Native companion proposed work",
        "goal": "Retain the same Forge profile when replacing the companion.",
    }
    saved = call("forge_create_work", draft)
    assert call("forge_create_work", draft)["id"] == saved["id"]
    assert saved["profileId"] == fixture["profileId"]
    assert saved["activeRunId"] is None
    print(json.dumps({"native": "Hermes MCP client", "tools": len(names), "selectedMemory": True,
                      "idempotentCheckpoint": True, "idempotentWork": True, "paidModelCalls": 0}))
finally:
    shutdown_mcp_servers()
