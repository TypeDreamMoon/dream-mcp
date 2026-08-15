"""The double-write must not be reachable by any path, including the racy ones.

Every test here is about the same failure: two processes writing the same `.uasset`, the
later save winning, and the earlier work vanishing with no error anywhere. It is silent,
which is why it needs tests rather than care.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from dream_mcp import server
from dream_mcp.core import liveness as live, routing, transport
from dream_mcp.core.locate import Project


@pytest.fixture
def project(tmp_path, monkeypatch):
    uproject = tmp_path / "Fake.uproject"
    uproject.write_text('{"EngineAssociation": "test"}', encoding="utf-8")
    (tmp_path / "Saved/DreamFX/Bridge/Requests").mkdir(parents=True)
    (tmp_path / "Saved/DreamFX/Bridge/Responses").mkdir(parents=True)
    (tmp_path / "DFX").mkdir()
    (tmp_path / "DFX/Thing.dfs").write_text("System Thing {}", encoding="utf-8")

    fake = Project(uproject=uproject, engine_root=tmp_path / "Engine")
    monkeypatch.setattr(live, "_process_exists", lambda pid: True)
    monkeypatch.setattr(server, "_project", lambda _: fake)
    return fake


def publish_status(project: Project, *, busy: bool = False, age: float = 0.0,
                   protocol: int | None = None) -> None:
    stamp = datetime.now(timezone.utc) - timedelta(seconds=age)
    (live.fx_bridge_dir(project) / "status.json").write_text(json.dumps({
        "protocol": live.PROTOCOL_VERSION if protocol is None else protocol,
        "pid": 4242,
        "projectDir": str(project.root),
        "busy": busy,
        "heartbeatUtc": stamp.isoformat().replace("+00:00", "Z"),
    }), encoding="utf-8")


def no_cli(monkeypatch):
    """Any call to the driver in these tests is the bug."""
    def explode(*args, **kwargs):
        raise AssertionError("fell back to the CLI while an editor held the packages")
    monkeypatch.setattr(server.cli, "run", explode)


def test_hung_editor_never_reaches_the_cli(project, monkeypatch):
    no_cli(monkeypatch)
    publish_status(project, age=live.HEARTBEAT_STALE_SECONDS + 60)

    report = server.dream_build("DFX/Thing.dfs")
    assert "refuse" in report
    assert "hung" in report


def test_editor_hanging_mid_request_does_not_earn_a_cold_retry(project, monkeypatch):
    """The race the first version of this got wrong: decide says BRIDGE, the editor hangs
    before the send, and a naive handler treats 'bridge unavailable' as 'nothing is holding
    the packages'. It is still holding them."""
    no_cli(monkeypatch)
    publish_status(project)

    def hang_then_fail(*args, **kwargs):
        publish_status(project, age=live.HEARTBEAT_STALE_SECONDS + 60)
        raise transport.BridgeUnavailable("stale: the editor is hung")

    monkeypatch.setattr(server.transport, "send", hang_then_fail)

    report = server.dream_build("DFX/Thing.dfs")
    assert "refuse" in report


def test_protocol_mismatch_does_not_earn_a_cold_retry(project, monkeypatch):
    """A mismatched editor is still a running editor. Falling back would double-write."""
    no_cli(monkeypatch)
    publish_status(project, protocol=live.PROTOCOL_VERSION + 5)

    report = server.dream_build("DFX/Thing.dfs")
    assert "cli" not in report.split("route:")[1].split("\n")[0]


def test_closed_editor_does_earn_a_cold_retry(project, monkeypatch):
    """The permitted case, kept honest: a closed editor holds nothing, so the cold path is
    correct there and must not be refused along with the others."""
    publish_status(project)
    calls = {"n": 0}

    def vanish_then_fail(*args, **kwargs):
        (live.fx_bridge_dir(project) / "status.json").unlink(missing_ok=True)
        raise transport.BridgeUnavailable("dead: the editor went away")

    def record(*args, **kwargs):
        calls["n"] += 1
        return server.cli.CliResult(True, 0, "dfx: OK (exit 0)", "")

    monkeypatch.setattr(server.transport, "send", vanish_then_fail)
    monkeypatch.setattr(server.cli, "run", record)

    report = server.dream_build("DFX/Thing.dfs")
    assert calls["n"] == 1, "a closed editor must not block the cold path"
    assert "OK" in report


def test_whole_tree_through_a_live_editor_is_reported_as_queued(project, monkeypatch):
    """`build scope:all` goes through the watcher queue and drains across ticks, so the
    bridge answers 'queued N', not a result. Presenting that as a result would be a lie."""
    publish_status(project)
    monkeypatch.setattr(server.transport, "send", lambda *a, **k: transport.BridgeReply(
        ok=True, message="Queued 24 source file(s); the editor reports the result when the "
                         "batch drains.", duration_ms=3))

    report = server.dream_build("all", lang="fx")
    assert "QUEUED" in report
    assert "not a result" in report
