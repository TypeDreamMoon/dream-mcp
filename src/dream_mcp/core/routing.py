"""Which path a request takes, and when it must take none.

The whole value of this server is in this file. Everything else is transport.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from . import liveness as live
from .locate import Project

FX_EXTENSIONS = {".dfs", ".dfe", ".dfm"}
SHADER_EXTENSIONS = {".dsm", ".dsf", ".dsh"}


class Route(str, Enum):
    BRIDGE = "bridge"
    CLI = "cli"
    REFUSE = "refuse"


@dataclass
class Decision:
    route: Route
    reason: str
    status: live.BridgeStatus


def language_for(target: str | None) -> str | None:
    """`.dfs` is DreamFX, `.dsm` is DreamShader. Returns None when it cannot tell."""
    if not target:
        return None
    suffix = Path(target).suffix.lower()
    if suffix in FX_EXTENSIONS:
        return "fx"
    if suffix in SHADER_EXTENSIONS:
        return "shader"
    return None


def decide(project: Project, lang: str) -> Decision:
    """Pick a path, or refuse.

    The refusal is the part that matters. A hung editor still holds every package it has
    open, so falling back to the CLI there recreates exactly the silent double-write this
    server exists to prevent -- the later save wins and the earlier work is gone with no
    error anywhere. "Cannot do this safely right now" is the correct answer, and a caller
    that is told so can go deal with the editor.
    """
    status = (live.read_fx_status(project) if lang == "fx"
              else live.read_shader_status(project))

    if status.can_serve:
        return Decision(Route.BRIDGE, f"the editor is {status.liveness.value}", status)

    if status.liveness is live.Liveness.STALE:
        return Decision(
            Route.REFUSE,
            "The editor is hung -- the heartbeat stopped and nothing is marked busy. It "
            "still holds the project's packages open, so running the CLI now would let "
            "whichever process saves last silently overwrite the other. Close or recover "
            "the editor first.",
            status,
        )

    return Decision(Route.CLI, f"no editor is running ({status.liveness.value})", status)
