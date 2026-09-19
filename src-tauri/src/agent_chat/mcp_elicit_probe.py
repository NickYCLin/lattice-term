#!/usr/bin/env python3
"""A tiny MCP stdio server whose one tool asks the user a form question."""
import json, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n"); sys.stdout.flush()

pending_call = None
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": msg["params"].get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "elicit-probe", "version": "1"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"tools": [{
            "name": "ask_favorite",
            "description": "Asks the user for their favorite color and returns it.",
            "inputSchema": {"type": "object", "properties": {}}}]}})
    elif method == "tools/call":
        pending_call = msg["id"]
        send({"jsonrpc": "2.0", "id": "elicit-1", "method": "elicitation/create", "params": {
            "message": "What is your favorite color?",
            "requestedSchema": {"type": "object",
                "properties": {"color": {"type": "string", "title": "Color"}},
                "required": ["color"]}}})
    elif msg.get("id") == "elicit-1" and pending_call is not None:
        result = msg.get("result", {})
        if result.get("action") == "accept":
            text = "User said: " + str(result.get("content", {}).get("color"))
        else:
            text = "User declined: " + json.dumps(result)
        send({"jsonrpc": "2.0", "id": pending_call, "result": {"content": [{"type": "text", "text": text}]}})
        pending_call = None
    elif "id" in msg and method:
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {}})
