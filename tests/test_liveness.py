"""M0 gate: the four liveness states, three of which need a synthetic status file.

ALIVE is easy to see by hand; BUSY, STALE and the crashed-editor case are exactly the ones
that only show up when something has gone wrong, which is when a bug here costs the most.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from dream_mcp.core import liveness as live
from dream_mcp.core.locate import Project


@pytest.fixture
def project(tmp_path):
    uproject = tmp_path / "Fake.uproject"
    uproject.write_text('{"EngineAssociation": "test"}', encoding="utf-8")
    (tmp_path / "Saved/DreamFX/Bridge").mkdir(parents=True)
    return Project(uproject=uproject, engine_root=tmp_path / "Engine")


def write_status(project: Project, **fields) -> None:
    payload = {
        "protocol": live.PROTOCOL_VERSION,
        "pid": 0,  # never a real pid, so the process check cannot accidentally pass
        "project": "Fake",
        "projectDir": str(project.root),
        "engineDir": str(project.engine_root),
        "pluginVersion": "1.0.0",
        "busy": False,
        "heartbeatUtc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    payload.update(fields)
    (live.fx_bridge_dir(project) / "status.json").write_text(
        json.dumps(payload), encoding="utf-8")


def test_missing_status_is_dead_not_timeout(project):
    """The bridge deletes status.json on shutdown, so absence is a definite answer. A
    client that treated it as 'maybe' would wait out a liveness window for nothing."""
    status = live.read_fx_status(project)
    assert status.liveness is live.Liveness.DEAD
    assert not status.can_serve


def test_busy_is_alive(project, monkeypatch):
    """The heartbeat stops during a build because it blocks the game thread. Reading a
    stale heartbeat without checking `busy` makes every real build look like a crash."""
    monkeypatch.setattr(live, "_process_exists", lambda pid: True)
    old = datetime.now(timezone.utc) - timedelta(seconds=300)
    write_status(project, busy=True, busyAction="build",
                 heartbeatUtc=old.isoformat().replace("+00:00", "Z"))

    status = live.read_fx_status(project)
    assert status.liveness is live.Liveness.BUSY
    assert status.can_serve, "a busy editor still queues the request; do not fall back"
    assert "build" in status.detail


def test_stopped_heartbeat_without_busy_is_stale(project, monkeypatch):
    monkeypatch.setattr(live, "_process_exists", lambda pid: True)
    old = datetime.now(timezone.utc) - timedelta(
        seconds=live.HEARTBEAT_STALE_SECONDS + 30)
    write_status(project, heartbeatUtc=old.isoformat().replace("+00:00", "Z"))

    status = live.read_fx_status(project)
    assert status.liveness is live.Liveness.STALE
    assert not status.can_serve


def test_dead_process_beats_a_fresh_heartbeat(project, monkeypatch):
    """A crash leaves status.json behind. The pid is what resolves it."""
    monkeypatch.setattr(live, "_process_exists", lambda pid: False)
    write_status(project, pid=424242)

    status = live.read_fx_status(project)
    assert status.liveness is live.Liveness.DEAD
    assert "424242" in status.detail


def test_unknown_process_state_does_not_declare_death(project, monkeypatch):
    """`_process_exists` returns None when it cannot tell. Guessing 'dead' there would
    route a build to the CLI while the editor holds the same packages open."""
    monkeypatch.setattr(live, "_process_exists", lambda pid: None)
    write_status(project)

    assert live.read_fx_status(project).liveness is live.Liveness.ALIVE


def test_protocol_mismatch_warns_but_still_reports_state(project, monkeypatch):
    monkeypatch.setattr(live, "_process_exists", lambda pid: True)
    write_status(project, protocol=live.PROTOCOL_VERSION + 1)

    status = live.read_fx_status(project)
    assert status.liveness is live.Liveness.ALIVE
    assert any("protocol" in w for w in status.warnings)


def test_status_from_another_project_warns(project, monkeypatch):
    monkeypatch.setattr(live, "_process_exists", lambda pid: True)
    write_status(project, projectDir="C:/Somewhere/Else")

    assert any("different project" in w
               for w in live.read_fx_status(project).warnings)


def shader_dir(project: Project):
    directory = project.saved / "DreamShader/Bridge"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def test_shader_reads_the_real_heartbeat_when_one_exists(project, monkeypatch):
    """Since M3 both plugins publish the same contract, so this is a fact, not a guess."""
    monkeypatch.setattr(live, "_process_exists", lambda pid: True)
    (shader_dir(project) / "status.json").write_text(json.dumps({
        "protocol": live.PROTOCOL_VERSION, "pid": 1, "projectDir": str(project.root),
        "busy": False, "pluginVersion": "2.0.0",
        "heartbeatUtc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }), encoding="utf-8")

    status = live.read_shader_status(project)
    assert status.liveness is live.Liveness.ALIVE
    assert status.protocol == live.PROTOCOL_VERSION
    assert "DreamShader 2.0.0" in status.detail
    assert not status.warnings


def test_old_plugin_build_is_still_recognised_as_running(project):
    """An editor on a pre-M3 DreamShader publishes no status file. Calling that DEAD would
    send a compile to the CLI while an editor is open, which is the double-write."""
    (shader_dir(project) / "bridge.db").write_text("", encoding="utf-8")

    status = live.read_shader_status(project)
    assert status.liveness is live.Liveness.ALIVE
    assert status.protocol is None, "no protocol means route to the inferring transport"
    assert any("pre-m3" in w.lower() for w in status.warnings)


def test_no_signal_at_all_is_plainly_dead(project):
    shader_dir(project)
    status = live.read_shader_status(project)
    assert status.liveness is live.Liveness.DEAD
    assert not status.warnings, "nothing is being inferred here, so nothing to caveat"
