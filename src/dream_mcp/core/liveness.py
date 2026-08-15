"""Is there a warm editor to talk to?

The whole point of this server is answering that question well enough to route on it.
Getting it wrong is expensive in both directions: a false "alive" leaves a caller waiting
on a response that is never coming, and a false "dead" sends a build to the CLI while the
editor holds the same packages open -- which is the silent double-write the DreamFX skill
documentation warns about.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

from .locate import Project

#: Bumped only when a change would make an older client misread a newer editor. Must match
#: `BridgeProtocolVersion` in DreamFXBridgeService.cpp -- a mismatch is rejected outright,
#: with a message telling the user to update one side or the other.
PROTOCOL_VERSION = 1

#: The editor rewrites `status.json` every 2 s while idle. A window several times that
#: absorbs a stalled game thread without declaring a healthy editor dead.
HEARTBEAT_STALE_SECONDS = 12.0

#: How many times to re-look for a status file that appears to be missing, and how long to
#: wait between looks. See `_read_status`.
MISSING_CONFIRMATIONS = 3
MISSING_RETRY_SECONDS = 0.06


class Liveness(str, Enum):
    ALIVE = "alive"
    """Heartbeat is current. Requests will be served."""

    BUSY = "busy"
    """Serving something now. Still alive -- see the note on the heartbeat below."""

    STALE = "stale"
    """Status file exists, process exists, but the heartbeat stopped and nothing claims to
    be busy. A hung editor. Not routed to."""

    DEAD = "dead"
    """No status file, or the process it names is gone. Fall back to the CLI."""

    UNKNOWN = "unknown"
    """No liveness signal exists for this plugin yet (DreamShader, before M3)."""


@dataclass
class BridgeStatus:
    liveness: Liveness
    detail: str
    protocol: int | None = None
    pid: int | None = None
    project: str | None = None
    project_dir: str | None = None
    engine_dir: str | None = None
    plugin_version: str | None = None
    busy_action: str | None = None
    last_result: str | None = None
    heartbeat_utc: str | None = None
    heartbeat_age_seconds: float | None = None
    warnings: list[str] = field(default_factory=list)

    @property
    def can_serve(self) -> bool:
        """Whether to route a request here. BUSY counts: the bridge queues, it does not
        refuse, and waiting behind a running build beats paying a cold boot to race it."""
        return self.liveness in (Liveness.ALIVE, Liveness.BUSY)


def fx_bridge_dir(project: Project) -> Path:
    return project.saved / "DreamFX/Bridge"


def shader_bridge_dir(project: Project) -> Path:
    return project.saved / "DreamShader/Bridge"


def _process_exists(pid: int) -> bool | None:
    """None when we cannot tell -- never a guess. A wrong `False` here would route a build
    to the CLI while the editor is very much alive and holding the same packages."""
    try:
        import ctypes
        from ctypes import wintypes
    except ImportError:
        return None

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259

    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        # Access-denied means it exists but is not ours to inspect; anything else at this
        # point means there is no such process.
        return kernel32.GetLastError() == 5  # ERROR_ACCESS_DENIED
    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return None
        return code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def _read_status(path: Path) -> dict | None:
    """Read a status file, treating "missing" as a claim that has to be confirmed.

    Both bridges publish atomically by writing a temporary and renaming over the target.
    On Windows that replace is not atomic the way it is on POSIX: there is a narrow window
    where the destination name resolves to nothing. Caught live -- one poll in 77, during a
    build, reported a running editor as gone.

    That single sample matters out of all proportion to its rate, because "gone" is the one
    verdict that sends work to the CLI, and it would do so while the editor holds the very
    packages the CLI is about to write. A few tens of milliseconds spent confirming is free
    next to the 12 s cold boot on the other side of the decision.
    """
    for attempt in range(MISSING_CONFIRMATIONS):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            if attempt + 1 < MISSING_CONFIRMATIONS:
                time.sleep(MISSING_RETRY_SECONDS)
        except (OSError, json.JSONDecodeError):
            # A torn or locked read is the same race seen from the other side: the file is
            # there but mid-replace. Retry rather than call a live editor dead.
            if attempt + 1 < MISSING_CONFIRMATIONS:
                time.sleep(MISSING_RETRY_SECONDS)
    return None


def _age_seconds(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        stamp = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - stamp).total_seconds()


def read_status(project: Project, directory: Path, plugin: str,
                data: dict | None = None) -> BridgeStatus:
    """Read one bridge's heartbeat.

    Both plugins publish the same status contract since plan phase M3, so this is one
    reader. Three details of it are load-bearing:

    1. Shutdown *deletes* the status file. A missing file therefore means "shut down
       cleanly", not "timed out" -- so the fallback is immediate, with no liveness window
       to wait out first.
    2. A long build blocks the game thread, so the heartbeat stops during it. Without
       reading `busy` first, every real build looks exactly like a crash.
    3. The file surviving a crash is the remaining ambiguity, and the pid closes it.
    """
    if data is None:
        data = _read_status(directory / "status.json")
    if data is None:
        return BridgeStatus(
            Liveness.DEAD,
            f"No status.json after {MISSING_CONFIRMATIONS} looks. The editor is not "
            f"running, or shut down cleanly (the {plugin} bridge deletes the file on the "
            f"way out).",
        )

    status = BridgeStatus(
        Liveness.ALIVE,
        "",
        protocol=data.get("protocol"),
        pid=data.get("pid"),
        project=data.get("project"),
        project_dir=data.get("projectDir"),
        engine_dir=data.get("engineDir"),
        plugin_version=data.get("pluginVersion"),
        busy_action=data.get("busyAction"),
        last_result=data.get("lastResult"),
        heartbeat_utc=data.get("heartbeatUtc"),
    )
    status.heartbeat_age_seconds = _age_seconds(status.heartbeat_utc)

    if status.protocol is not None and status.protocol != PROTOCOL_VERSION:
        status.warnings.append(
            f"The editor speaks bridge protocol {status.protocol}; this client speaks "
            f"{PROTOCOL_VERSION}. Requests would be rejected. Update whichever side is older."
        )

    # A status file naming another project is a different editor's, reached through a
    # shared Saved/ path or a stale copy. Routing a build there would build the wrong tree.
    if status.project_dir:
        try:
            same = Path(status.project_dir).resolve() == project.root.resolve()
        except OSError:
            same = True
        if not same:
            status.warnings.append(
                f"status.json belongs to a different project ({status.project_dir})."
            )

    if status.pid is not None and _process_exists(status.pid) is False:
        status.liveness = Liveness.DEAD
        status.detail = (
            f"status.json names pid {status.pid}, but no such process exists -- the editor "
            f"died without shutting the bridge down."
        )
        return status

    if data.get("busy"):
        status.liveness = Liveness.BUSY
        status.detail = (
            f"Serving '{status.busy_action or 'a request'}'. The heartbeat pauses during "
            f"this -- it is work, not a hang."
        )
        return status

    age = status.heartbeat_age_seconds
    if age is not None and age > HEARTBEAT_STALE_SECONDS:
        status.liveness = Liveness.STALE
        status.detail = (
            f"The heartbeat is {age:.0f}s old and nothing is marked busy. The editor is "
            f"hung or suspended."
        )
        return status

    status.detail = f"Listening. {plugin} {status.plugin_version or 'unknown'}."
    return status


def read_fx_status(project: Project) -> BridgeStatus:
    return read_status(project, fx_bridge_dir(project), "DreamFX")


def read_shader_status(project: Project) -> BridgeStatus:
    """Same contract as DreamFX since M3, with one fallback kept for older plugin builds.

    An editor running a pre-M3 DreamShader publishes no status file, and reporting that as
    DEAD would send a compile to the CLI while an editor is open. `bridge.db` is the signal
    that was available before: the plugin deletes it at both startup and shutdown and holds
    it open in between, so its presence tracks a running editor. It is a weaker claim -- a
    hard crash leaves the file behind and there is no pid to check it against -- so that
    path is marked, and callers route it to the inferring transport rather than the real
    request/response one.
    """
    directory = shader_bridge_dir(project)
    if not directory.exists():
        return BridgeStatus(
            Liveness.UNKNOWN,
            "No DreamShader bridge directory. The editor has not run with the plugin "
            "enabled in this project.",
        )

    # Read once and branch on the result rather than testing `.exists()` first: the same
    # mid-replace window that could report a live editor dead would here misreport a current
    # plugin as a pre-M3 one, and silently downgrade every compile to the inferring path.
    data = _read_status(directory / "status.json")
    if data is not None:
        return read_status(project, directory, "DreamShader", data)

    if (directory / "bridge.db").exists():
        generated_at = None
        manifest = directory / "material-expressions.json"
        if manifest.exists():
            try:
                generated_at = json.loads(
                    manifest.read_text(encoding="utf-8")).get("generatedAt")
            except (OSError, json.JSONDecodeError):
                pass
        return BridgeStatus(
            Liveness.ALIVE,
            "bridge.db is present but status.json is not: an editor is running a "
            "DreamShader build older than the M3 bridge. Liveness is inferred, and so is "
            "any compile result.",
            heartbeat_utc=generated_at,
            warnings=["Pre-M3 DreamShader build -- rebuild the plugin for real responses."],
        )

    return BridgeStatus(
        Liveness.DEAD,
        "No status.json and no bridge.db. The editor is not running.",
    )
