"""Tests that the platform user_id set on the agent reaches registry.dispatch.

Regression coverage for the credential-sharing bug fixed in 6b4b4d78a
(handle_function_call never forwarded user_id, so plugin tool handlers fell
back to a shared credential slot). That fix only covered the sequential
tool-execution path; ``agent_runtime_helpers.invoke_tool`` — used by the
concurrent path — still dropped it. This file locks in both call sites.
"""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


def _make_registry(captured: dict):
    """Return a mock registry whose dispatch records the kwargs it receives."""
    registry = MagicMock()

    def _dispatch(name, args, **kwargs):
        captured.update(kwargs)
        return json.dumps({"result": "ok"})

    registry.dispatch.side_effect = _dispatch
    return registry


class TestHandleFunctionCallUserIdForwarding:

    def test_standard_path_forwards_user_id(self):
        captured = {}
        with patch("model_tools.registry", _make_registry(captured)):
            from model_tools import handle_function_call
            handle_function_call(
                "web_search",
                {"query": "test"},
                task_id="t1",
                session_id="sess-abc",
                user_id="discord-user-42",
                skip_pre_tool_call_hook=True,
            )
        assert captured.get("user_id") == "discord-user-42"

    def test_user_id_default_is_none(self):
        captured = {}
        with patch("model_tools.registry", _make_registry(captured)):
            from model_tools import handle_function_call
            handle_function_call(
                "web_search",
                {"query": "test"},
                task_id="t1",
                skip_pre_tool_call_hook=True,
            )
        assert "user_id" in captured
        assert captured["user_id"] is None


class TestInvokeToolUserIdForwarding:
    """Covers the concurrent tool-execution path (agent._invoke_tool ->
    agent_runtime_helpers.invoke_tool -> handle_function_call)."""

    def _make_agent(self, user_id: str):
        return SimpleNamespace(
            _user_id=user_id,
            session_id="sess-concurrent",
            _current_turn_id="turn-1",
            _current_api_request_id="req-1",
            valid_tool_names=None,
            enabled_toolsets=None,
            disabled_toolsets=None,
            _memory_manager=None,
        )

    def test_concurrent_path_forwards_agent_user_id(self):
        agent = self._make_agent("discord-user-99")
        captured_kwargs = {}

        def _fake_handle_function_call(*args, **kwargs):
            captured_kwargs.update(kwargs)
            return json.dumps({"result": "ok"})

        fake_run_agent = SimpleNamespace(handle_function_call=_fake_handle_function_call)

        with patch("agent.agent_runtime_helpers._ra", return_value=fake_run_agent):
            from agent.agent_runtime_helpers import invoke_tool
            invoke_tool(
                agent,
                "web_search",
                {"query": "test"},
                "task-1",
                pre_tool_block_checked=True,
                skip_tool_request_middleware=True,
            )

        assert captured_kwargs.get("user_id") == "discord-user-99"

    def test_concurrent_path_defaults_missing_user_id_to_empty_string(self):
        agent = self._make_agent("")
        captured_kwargs = {}

        def _fake_handle_function_call(*args, **kwargs):
            captured_kwargs.update(kwargs)
            return json.dumps({"result": "ok"})

        fake_run_agent = SimpleNamespace(handle_function_call=_fake_handle_function_call)

        with patch("agent.agent_runtime_helpers._ra", return_value=fake_run_agent):
            from agent.agent_runtime_helpers import invoke_tool
            invoke_tool(
                agent,
                "web_search",
                {"query": "test"},
                "task-1",
                pre_tool_block_checked=True,
                skip_tool_request_middleware=True,
            )

        assert captured_kwargs.get("user_id") == ""
