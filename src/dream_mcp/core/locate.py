"""Finding the project and the engine.

Ported from the two driver scripts rather than reinvented: `dfx.ps1` and `dsc.ps1` each
carry their own copy of this, and any disagreement between them and this module would
show up as the MCP server and the CLI fallback operating on different projects.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path


class LocateError(Exception):
    """Raised with the same wording the drivers use, so the fixes in their troubleshooting
    tables apply verbatim to a failure surfaced here."""


@dataclass(frozen=True)
class Project:
    uproject: Path
    engine_root: Path

    @property
    def root(self) -> Path:
        return self.uproject.parent

    @property
    def saved(self) -> Path:
        return self.root / "Saved"

    @property
    def editor_cmd(self) -> Path:
        return self.engine_root / "Engine/Binaries/Win64/UnrealEditor-Cmd.exe"


def find_uproject(explicit: str | os.PathLike[str] | None = None,
                  start_at: str | os.PathLike[str] | None = None) -> Path:
    """Walk up from the target first, then from the working directory.

    Both roots are tried because a source file under `DFX/` sits inside the project, so
    starting at the file finds the right project even when the server was launched from
    somewhere else entirely.
    """
    if explicit:
        path = Path(explicit)
        if not path.exists():
            raise LocateError(f"No .uproject at '{path}'.")
        return path.resolve()

    roots: list[Path] = []
    if start_at:
        item = Path(start_at)
        if item.exists():
            roots.append(item if item.is_dir() else item.parent)
    roots.append(Path.cwd())

    for root in roots:
        for directory in [root.resolve(), *root.resolve().parents]:
            found = sorted(directory.glob("*.uproject"))
            if found:
                return found[0]

    joined = "', '".join(str(r) for r in roots)
    raise LocateError(
        f"Could not find a .uproject at or above '{joined}'. Pass project_dir."
    )


def _registry_engine_root(association: str) -> Path | None:
    """A source build registers its root under a GUID association; an installed build uses
    a version string, which lives under a different key entirely."""
    try:
        import winreg
    except ImportError:  # not Windows; the drivers are Windows-only too
        return None

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"SOFTWARE\Epic Games\Unreal Engine\Builds") as key:
            value, _ = winreg.QueryValueEx(key, association)
            if value:
                return Path(value)
    except OSError:
        pass

    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                            rf"SOFTWARE\EpicGames\Unreal Engine\{association}") as key:
            value, _ = winreg.QueryValueEx(key, "InstalledDirectory")
            if value:
                return Path(value)
    except OSError:
        pass

    return None


def find_engine_root(uproject: Path,
                     explicit: str | os.PathLike[str] | None = None) -> Path:
    """Explicit, then `UE_ENGINE_ROOT`, then the association lookup.

    That order is the drivers' own, and it matters: the environment variable is how you
    override a machine whose registry association points at the wrong build, so it has to
    win over the registry rather than merely stand in for it.
    """
    if explicit:
        return Path(explicit).resolve()

    env = os.environ.get("UE_ENGINE_ROOT")
    if env:
        return Path(env).resolve()

    try:
        descriptor = json.loads(uproject.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise LocateError(f"Could not read '{uproject}': {error}") from error

    association = descriptor.get("EngineAssociation")
    if not association:
        raise LocateError("The .uproject has no EngineAssociation. Pass engine_root.")

    resolved = _registry_engine_root(association)
    if resolved is None:
        raise LocateError(
            f"EngineAssociation '{association}' is not registered. "
            f"Pass engine_root or set UE_ENGINE_ROOT."
        )
    return resolved.resolve()


def resolve(project_dir: str | os.PathLike[str] | None = None,
            engine_root: str | os.PathLike[str] | None = None,
            start_at: str | os.PathLike[str] | None = None) -> Project:
    uproject = find_uproject(project_dir, start_at)
    return Project(uproject=uproject, engine_root=find_engine_root(uproject, engine_root))
