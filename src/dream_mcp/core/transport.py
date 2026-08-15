"""Talking to a warm editor.

DreamFX's bridge is a real request/response channel and this speaks it properly. DreamShader
has only an inbound half until plan phase M3, so its path here infers completion instead of
being told about it, and labels every result it returns as inferred.
"""

from __future__ import annotations

import itertools
import json
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from . import liveness as live
from .diagnostics import Diagnostic, from_bridge
from .locate import Project

#: How long to wait for a response before giving up. Generous because the ceiling is real
#: work: a single large system has been measured at 28 s after optimisation, and the editor
#: serves requests one at a time from the game thread, so a queue ahead of us counts too.
DEFAULT_TIMEOUT_SECONDS = 600.0

#: The bridge polls every 0.25 s, so checking faster than that only burns CPU.
POLL_SECONDS = 0.25


class BridgeUnavailable(Exception):
    """Raised instead of falling through to the CLI, when falling through would be unsafe."""


@dataclass
class BridgeReply:
    ok: bool
    message: str
    duration_ms: int
    diagnostics: list[Diagnostic] = field(default_factory=list)
    inferred: bool = False
    """True when the transport had to guess the outcome (DreamShader, pre-M3)."""
    request_id: str = ""
    """Echoed back so a caller can correlate a side artifact with its own request.
    `preview.json` needs this: it is a single file that every preview overwrites, so
    reading it without checking whose result it holds can hand back someone else's."""


_sequence = itertools.count()
_sequence_lock = threading.Lock()


def _request_id() -> str:
    """Sortable, because the bridge serves `Requests` in filename order and that ordering is
    how two requests fired back to back arrive in the order they were sent.

    The timestamp alone is not enough: two requests issued inside the same microsecond tick
    would then be ordered by the random uuid, which is to say not ordered at all. The
    counter makes send order and filename order the same thing by construction; the uuid
    stays only to keep two *processes* from colliding.
    """
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    with _sequence_lock:
        ordinal = next(_sequence)
    return f"{stamp}-{ordinal:06d}-{uuid.uuid4().hex[:8]}"


def _write_atomically(target: Path, payload: dict) -> None:
    """Write beside the directory and rename in.

    The poller may open a file that is still being written, so a plain write makes the file
    exist while it is still half a file. Renaming makes appearing and being complete the
    same event. The temporary lives in the bridge root rather than the OS temp directory so
    the rename stays within one volume, where it is atomic.
    """
    temporary = target.parent.parent / f".{target.name}.tmp"
    temporary.write_text(json.dumps(payload), encoding="utf-8")
    temporary.replace(target)


def send(project: Project,
         action: str,
         lang: str = "fx",
         timeout: float = DEFAULT_TIMEOUT_SECONDS,
         **fields: object) -> BridgeReply:
    """Send one request to a plugin's bridge and wait for its response.

    One function for both, because since plan phase M3 both bridges speak the same shape.

    Checks liveness *before* writing, and that ordering is not optional: the editor discards
    any request whose file predates the moment it started listening, so a request written to
    a closed editor is never served -- it is deleted the next time one starts. Fire and
    forget would mean waiting out the full timeout for an answer that was never coming.
    """
    status = (live.read_fx_status(project) if lang == "fx"
              else live.read_shader_status(project))
    if not status.can_serve:
        raise BridgeUnavailable(f"{status.liveness.value}: {status.detail}")
    if any("protocol" in w for w in status.warnings):
        raise BridgeUnavailable("; ".join(status.warnings))

    bridge = (live.fx_bridge_dir(project) if lang == "fx"
              else live.shader_bridge_dir(project))
    requests = bridge / "Requests"
    responses = bridge / "Responses"
    requests.mkdir(parents=True, exist_ok=True)

    request_id = _request_id()
    payload: dict[str, object] = {
        "protocol": live.PROTOCOL_VERSION,
        "requestId": request_id,
        "action": action,
    }
    payload.update({k: v for k, v in fields.items() if v is not None})

    _write_atomically(requests / f"{request_id}.json", payload)

    response_path = responses / f"{request_id}.json"
    deadline = time.monotonic() + timeout

    while True:
        if response_path.exists():
            try:
                data = json.loads(response_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                # Written atomically by the editor too, so this is a transient read race at
                # worst. Retry rather than treat it as a failure.
                time.sleep(POLL_SECONDS)
                continue
            response_path.unlink(missing_ok=True)
            return BridgeReply(
                ok=bool(data.get("ok")),
                message=str(data.get("message", "")),
                duration_ms=int(data.get("durationMs", 0)),
                diagnostics=from_bridge(data.get("diagnostics", [])),
                request_id=request_id,
            )

        # An editor that exits mid-request takes the answer with it. Without this the caller
        # waits out the whole timeout for a process that is already gone.
        current = (live.read_fx_status(project) if lang == "fx"
                   else live.read_shader_status(project))
        if current.liveness is live.Liveness.DEAD:
            raise BridgeUnavailable(
                f"The editor went away while serving '{action}': {current.detail}"
            )

        if time.monotonic() > deadline:
            raise TimeoutError(
                f"No response to '{action}' after {timeout:.0f}s. The editor is "
                f"{current.liveness.value}"
                + (f" ({current.busy_action})" if current.busy_action else "")
                + ". The work may still be running -- check the editor's Output Log."
            )

        time.sleep(POLL_SECONDS)


# ---------------------------------------------------------------- DreamShader


def _shader_diagnostics_stamp(project: Project) -> str | None:
    path = live.shader_bridge_dir(project) / "diagnostics.json"
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("updatedAtUtc")
    except (OSError, json.JSONDecodeError):
        return None


def _shader_diagnostics_for(project: Project, source_file: Path) -> list[Diagnostic]:
    path = live.shader_bridge_dir(project) / "diagnostics.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []

    wanted = str(source_file).replace("\\", "/").lower()
    found: list[Diagnostic] = []
    for entry in data.get("files", []):
        if str(entry.get("path", "")).replace("\\", "/").lower() != wanted:
            continue
        for item in entry.get("diagnostics", []):
            found.append(Diagnostic(
                file=entry.get("path", ""),
                line=max(1, int(item.get("line", 1))),
                column=max(1, int(item.get("column", 1))),
                # The plugin only ever writes `error` here, and documents that a client
                # should read anything missing or unknown the same way.
                severity=str(item.get("severity", "error")).lower(),
                code=item.get("code"),
                message=item.get("message", ""),
            ))
    return found


def send_shader(project: Project,
                source_file: Path | None,
                timeout: float = DEFAULT_TIMEOUT_SECONDS) -> BridgeReply:
    """Compile through the DreamShader bridge, using whichever contract the editor speaks.

    A post-M3 build publishes `status.json` and answers requests, so it gets the real
    round trip. An older build gets the inferring path below, because refusing it outright
    would be a regression: fire-and-forget was never *unsafe* there, only uninformative.
    """
    status = live.read_shader_status(project)
    if status.protocol is not None:
        return send(project, "recompile", lang="shader", timeout=timeout,
                    **({"scope": "file", "sourceFile": str(source_file).replace("\\", "/")}
                       if source_file is not None else {"scope": "all"}))
    return _send_shader_inferred(project, source_file, timeout=min(timeout, 120.0))


def _send_shader_inferred(project: Project,
                          source_file: Path | None,
                          timeout: float = 120.0) -> BridgeReply:
    """Queue a compile in a pre-M3 editor and infer the outcome.

    Kept for older plugin builds only. Its limits are real: that transport has no reply, so
    a malformed request produces no error file and no log line -- it simply vanishes.
    Completion is inferred by watching `diagnostics.json`'s timestamp move, and the result
    says `inferred`.

    What it does still buy is avoiding the double-write entirely -- the editor compiles in
    memory and no second process touches the packages.
    """
    directory = live.shader_bridge_dir(project)
    requests = directory / "Requests"
    if not requests.exists():
        raise BridgeUnavailable("No DreamShader bridge request directory.")

    before = _shader_diagnostics_stamp(project)

    payload: dict[str, object] = {"action": "recompile"}
    if source_file is not None:
        payload.update({"scope": "file", "sourceFile": str(source_file).replace("\\", "/")})
    else:
        payload["scope"] = "all"

    _write_atomically(requests / f"dream-mcp-{uuid.uuid4().hex}.json", payload)

    started = time.monotonic()
    deadline = started + timeout
    while time.monotonic() < deadline:
        time.sleep(POLL_SECONDS)
        if _shader_diagnostics_stamp(project) != before:
            elapsed = int((time.monotonic() - started) * 1000)
            found = (_shader_diagnostics_for(project, source_file)
                     if source_file is not None else [])
            return BridgeReply(
                ok=not any(d.is_error for d in found),
                message=("Diagnostics were rewritten, so the compile finished. Whether it "
                         "was this request that finished is not reported by this transport."),
                duration_ms=elapsed,
                diagnostics=found,
                inferred=True,
            )

    return BridgeReply(
        ok=False,
        message=(f"Diagnostics did not change within {timeout:.0f}s. Either the compile is "
                 f"still running, or the request was rejected -- a pre-M3 DreamShader bridge "
                 f"reports neither. Rebuild the plugin to get a real response."),
        duration_ms=int((time.monotonic() - started) * 1000),
        inferred=True,
    )
