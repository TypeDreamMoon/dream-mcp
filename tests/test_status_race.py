"""The mid-replace race, caught live on 2026-08-15.

Polling `status.json` every 50 ms while a real build ran, one sample in 77 found no file and
reported a running editor as DEAD. Both bridges publish by writing a temporary and renaming
over the target, and on Windows that replace leaves a narrow window where the destination
name resolves to nothing.

One sample in 77 sounds ignorable. It is not: DEAD is the single verdict that routes work to
the CLI, and it would do that while the editor holds the packages the CLI is about to write.
The rare wrong answer is the expensive one.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone

import pytest

from dream_mcp.core import liveness as live
from dream_mcp.core.locate import Project


@pytest.fixture
def project(tmp_path, monkeypatch):
    uproject = tmp_path / "Fake.uproject"
    uproject.write_text('{"EngineAssociation": "test"}', encoding="utf-8")
    (tmp_path / "Saved/DreamFX/Bridge").mkdir(parents=True)
    (tmp_path / "Saved/DreamShader/Bridge").mkdir(parents=True)
    monkeypatch.setattr(live, "_process_exists", lambda pid: True)
    return Project(uproject=uproject, engine_root=tmp_path / "Engine")


def status_payload(project: Project) -> str:
    return json.dumps({
        "protocol": live.PROTOCOL_VERSION,
        "pid": 4242,
        # The real path, so the cross-project guard stays quiet and a test that asserts on
        # `warnings` is asserting about the race and nothing else.
        "projectDir": str(project.root),
        "pluginVersion": "1.0.0",
        "busy": False,
        "heartbeatUtc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    })


def test_a_momentary_gap_is_not_death(project, monkeypatch):
    """Missing on the first look, present on the next. The editor never went anywhere."""
    path = live.fx_bridge_dir(project) / "status.json"
    looks = {"n": 0}
    real_read = type(path).read_text

    def flaky(self, *args, **kwargs):
        if self == path:
            looks["n"] += 1
            if looks["n"] == 1:
                raise FileNotFoundError(2, "No such file", str(self))
        return real_read(self, *args, **kwargs)

    path.write_text(status_payload(project), encoding="utf-8")
    monkeypatch.setattr(type(path), "read_text", flaky)

    status = live.read_fx_status(project)
    assert status.liveness is live.Liveness.ALIVE
    assert looks["n"] >= 2, "the first miss has to be re-checked, not believed"


def test_a_torn_read_is_not_death(project, monkeypatch):
    """The same race seen from the other side: the file is there but half-written."""
    path = live.fx_bridge_dir(project) / "status.json"
    good = status_payload(project)
    looks = {"n": 0}

    def flaky(self, *args, **kwargs):
        looks["n"] += 1
        return good[: len(good) // 2] if looks["n"] == 1 else good

    monkeypatch.setattr(type(path), "read_text", flaky)
    assert live.read_fx_status(project).liveness is live.Liveness.ALIVE


def test_a_file_that_is_really_gone_is_still_dead(project):
    """The confirmation must not turn into never admitting death -- a closed editor has to
    resolve to DEAD promptly, because that is what releases the CLI fallback."""
    started = time.monotonic()
    status = live.read_fx_status(project)
    elapsed = time.monotonic() - started

    assert status.liveness is live.Liveness.DEAD
    assert elapsed < 1.0, "confirming absence must stay cheap next to a 12 s cold boot"


def test_shader_gap_does_not_downgrade_to_the_pre_m3_path(project, monkeypatch):
    """Reading the gap as "no status file" would silently route a current plugin through the
    inferring transport, and every compile result would come back marked as a guess."""
    directory = live.shader_bridge_dir(project)
    (directory / "bridge.db").write_text("", encoding="utf-8")
    path = directory / "status.json"
    path.write_text(status_payload(project), encoding="utf-8")

    looks = {"n": 0}
    real_read = type(path).read_text

    def flaky(self, *args, **kwargs):
        if self == path:
            looks["n"] += 1
            if looks["n"] == 1:
                raise FileNotFoundError(2, "No such file", str(self))
        return real_read(self, *args, **kwargs)

    monkeypatch.setattr(type(path), "read_text", flaky)

    status = live.read_shader_status(project)
    assert status.liveness is live.Liveness.ALIVE
    assert status.protocol == live.PROTOCOL_VERSION
    assert not status.warnings, "this is the real contract, nothing is being inferred"


def test_concurrent_replacement_never_reads_dead(project):
    """The live shape of the bug: one thread republishing the way the bridge does, another
    polling the way the client does."""
    path = live.fx_bridge_dir(project) / "status.json"
    path.write_text(status_payload(project), encoding="utf-8")
    halt = threading.Event()

    published = {"ok": 0, "denied": 0}

    def republish():
        temporary = path.with_suffix(".tmp")
        while not halt.is_set():
            try:
                temporary.write_text(status_payload(project), encoding="utf-8")
                temporary.replace(path)
                published["ok"] += 1
            except PermissionError:
                # Windows refuses to replace a file another handle has open, so a reader
                # polling hard makes some publishes fail outright. The real bridge behaves
                # the same way -- `WriteFileAtomically` deletes its temporary and returns
                # false, and `PublishStatus` does not look at the result. Swallowing it here
                # is what makes this thread a faithful stand-in rather than one that dies on
                # the first collision and stops exercising anything.
                published["denied"] += 1
            time.sleep(0.002)

    writer = threading.Thread(target=republish, daemon=True)
    writer.start()
    try:
        verdicts = [live.read_fx_status(project).liveness for _ in range(120)]
    finally:
        halt.set()
        writer.join(timeout=2)

    assert live.Liveness.DEAD not in verdicts, \
        f"a live editor was reported dead {verdicts.count(live.Liveness.DEAD)}x"
    assert published["ok"] > 20, (
        f"the writer only managed {published['ok']} publishes "
        f"({published['denied']} denied) -- this run did not exercise the race"
    )
