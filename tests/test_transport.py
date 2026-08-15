"""M2 gate, protocol half: the client against a faithful mimic of the editor's bridge.

The mimic replays the behaviour that actually matters in `DreamFXBridgeService.cpp` --
oldest-first ordering, delete-before-serve, the protocol check, atomic responses, and the
busy flag -- so a divergence in this client shows up here rather than as a request that
vanishes silently against a real editor.

The live half of the gate needs an editor running and is not automatable here.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from dream_mcp.core import liveness as live, routing, transport
from dream_mcp.core.locate import Project


@pytest.fixture
def project(tmp_path, monkeypatch):
    uproject = tmp_path / "Fake.uproject"
    uproject.write_text('{"EngineAssociation": "test"}', encoding="utf-8")
    (tmp_path / "Saved/DreamFX/Bridge/Requests").mkdir(parents=True)
    (tmp_path / "Saved/DreamFX/Bridge/Responses").mkdir(parents=True)
    monkeypatch.setattr(live, "_process_exists", lambda pid: True)
    monkeypatch.setattr(transport, "POLL_SECONDS", 0.01)
    return Project(uproject=uproject, engine_root=tmp_path / "Engine")


def publish_status(project: Project, *, busy: bool = False, age: float = 0.0) -> None:
    stamp = datetime.now(timezone.utc) - timedelta(seconds=age)
    (live.fx_bridge_dir(project) / "status.json").write_text(json.dumps({
        "protocol": live.PROTOCOL_VERSION,
        "pid": 4242,
        "project": "Fake",
        "projectDir": str(project.root),
        "pluginVersion": "1.0.0",
        "busy": busy,
        "heartbeatUtc": stamp.isoformat().replace("+00:00", "Z"),
    }), encoding="utf-8")


class FakeEditor(threading.Thread):
    """Serves requests the way the real bridge does, and records what it saw."""

    def __init__(self, project: Project, reply: dict | None = None):
        super().__init__(daemon=True)
        self.project = project
        self.reply = reply or {"ok": True, "message": "Built.", "durationMs": 12}
        self.seen: list[dict] = []
        self.partial_writes_observed = 0
        self._halt = threading.Event()

    def stop(self) -> None:
        self._halt.set()
        self.join(timeout=2)

    def run(self) -> None:
        bridge = live.fx_bridge_dir(self.project)
        requests, responses = bridge / "Requests", bridge / "Responses"
        while not self._halt.is_set():
            for path in sorted(requests.glob("*.json")):
                text = path.read_text(encoding="utf-8")
                try:
                    body = json.loads(text)
                except json.JSONDecodeError:
                    # The real bridge leaves a half-written file for the next poll. Seeing
                    # one here at all would mean the client is not renaming into place.
                    self.partial_writes_observed += 1
                    continue

                path.unlink()  # deleted before it is served, never after
                self.seen.append(body)

                request_id = body.get("requestId") or path.stem
                if body.get("protocol") != live.PROTOCOL_VERSION:
                    payload = {"ok": False,
                               "message": f"Protocol {body.get('protocol')} is not understood.",
                               "durationMs": 0, "diagnostics": []}
                else:
                    payload = {"diagnostics": [], **self.reply}

                payload.update({"protocol": live.PROTOCOL_VERSION, "requestId": request_id})
                target = responses / f"{request_id}.json"
                temporary = target.with_suffix(".tmp")
                temporary.write_text(json.dumps(payload), encoding="utf-8")
                temporary.replace(target)
            time.sleep(0.01)


def test_round_trip_carries_the_protocol_and_a_request_id(project):
    publish_status(project)
    editor = FakeEditor(project)
    editor.start()
    try:
        reply = transport.send(project, "build", timeout=5,
                               sourceFile="C:/x/NS_Thing.dfs")
    finally:
        editor.stop()

    assert reply.ok and reply.duration_ms == 12
    assert len(editor.seen) == 1
    request = editor.seen[0]
    assert request["protocol"] == live.PROTOCOL_VERSION
    assert request["action"] == "build"
    assert request["sourceFile"] == "C:/x/NS_Thing.dfs"
    assert request["requestId"], "the response is addressed by this; it cannot be empty"
    assert editor.partial_writes_observed == 0, "requests must be renamed into place"


def test_request_ids_sort_in_send_order(project):
    """The bridge serves `Requests` in filename order, so the timestamp prefix is load
    bearing -- two requests fired back to back must arrive in the order they were sent."""
    ids = [transport._request_id() for _ in range(20)]
    assert ids == sorted(ids)
    assert len(set(ids)) == 20


def test_nothing_is_written_when_the_editor_is_not_listening(project):
    """The editor discards any request whose file predates the moment it started listening.
    Writing one anyway means waiting out the timeout for an answer that cannot come -- and
    leaves a landmine for the next editor to start."""
    with pytest.raises(transport.BridgeUnavailable):
        transport.send(project, "build", timeout=1, sourceFile="C:/x/y.dfs")

    requests = live.fx_bridge_dir(project) / "Requests"
    assert list(requests.glob("*.json")) == []


def test_protocol_mismatch_refuses_before_sending(project):
    publish_status(project)
    path = live.fx_bridge_dir(project) / "status.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["protocol"] = live.PROTOCOL_VERSION + 7
    path.write_text(json.dumps(data), encoding="utf-8")

    with pytest.raises(transport.BridgeUnavailable, match="protocol"):
        transport.send(project, "build", timeout=1, sourceFile="C:/x/y.dfs")


def test_editor_exiting_mid_request_is_not_a_timeout(project, monkeypatch):
    """Waiting out a ten-minute timeout for a process that is already gone is the worst
    available answer, and the one a naive poll gives."""
    publish_status(project)

    calls = {"n": 0}
    real = live.read_fx_status

    def vanish(_project):
        (live.fx_bridge_dir(_project) / "status.json").unlink(missing_ok=True)
        return real(_project)  # the original, not the patch -- otherwise this recurses

    def flaky(p):
        calls["n"] += 1
        return real(p) if calls["n"] <= 1 else vanish(p)

    monkeypatch.setattr(transport.live, "read_fx_status", flaky)

    with pytest.raises(transport.BridgeUnavailable, match="went away"):
        transport.send(project, "build", timeout=5, sourceFile="C:/x/y.dfs")


def test_diagnostics_survive_the_round_trip(project):
    publish_status(project)
    editor = FakeEditor(project, reply={
        "ok": False, "message": "Failed.", "durationMs": 40,
        "diagnostics": [{
            "file": "C:/x/Broken.dfe", "line": 11, "column": 17,
            "severity": "error", "code": "DFX3003",
            "message": "Module 'GravityForce' has no input named 'Gravty'.",
        }],
    })
    editor.start()
    try:
        reply = transport.send(project, "build", timeout=5, sourceFile="C:/x/Host.dfs")
    finally:
        editor.stop()

    assert not reply.ok
    assert len(reply.diagnostics) == 1
    found = reply.diagnostics[0]
    assert found.code == "DFX3003"
    assert found.file.endswith("Broken.dfe"), \
        "a diagnostic keeps its own file -- a .dfs pulling in a broken .dfe fails at the .dfe"


# -- routing ---------------------------------------------------------------------


def test_hung_editor_refuses_rather_than_falling_back(project):
    """The one state where both paths are unsafe. A hung editor still holds every package
    it has open, so the CLI fallback would recreate the silent double-write."""
    publish_status(project, age=live.HEARTBEAT_STALE_SECONDS + 30)

    decision = routing.decide(project, "fx")
    assert decision.route is routing.Route.REFUSE
    assert "hung" in decision.reason


def test_busy_editor_routes_to_the_bridge(project):
    publish_status(project, busy=True)
    assert routing.decide(project, "fx").route is routing.Route.BRIDGE


def test_no_editor_routes_to_the_cli(project):
    assert routing.decide(project, "fx").route is routing.Route.CLI


def test_language_is_read_off_the_extension():
    assert routing.language_for("a/b/NS_Thing.dfs") == "fx"
    assert routing.language_for("a/b/Emitter.dfe") == "fx"
    assert routing.language_for("a/b/M_Panel.dsm") == "shader"
    assert routing.language_for("a/b/Lib.dsf") == "shader"
    assert routing.language_for("a/b/notes.txt") is None
