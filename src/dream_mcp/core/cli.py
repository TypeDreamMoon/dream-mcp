"""The cold fallback: the existing PowerShell drivers.

These are not reimplemented. `dfx.ps1` and `dsc.ps1` carry a lot of hard-won behaviour --
the index quarantine-and-resume loop, `-CleanNew`'s refusal to touch tracked assets, the log
de-duplication DreamShader needs because every line is emitted twice -- and a second
implementation would be a second thing to keep correct. This shells out to them and
normalises what comes back.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from .diagnostics import Diagnostic, from_cli
from .locate import Project


class DriverMissing(Exception):
    pass


@dataclass
class CliResult:
    ok: bool
    exit_code: int
    message: str
    output: str
    diagnostics: list[Diagnostic] = field(default_factory=list)


def _pwsh() -> str:
    for candidate in ("pwsh", "powershell"):
        found = shutil.which(candidate)
        if found:
            return found
    raise DriverMissing("Neither pwsh nor powershell is on PATH.")


def driver_path(project: Project, lang: str) -> Path:
    plugin = "DreamFX" if lang == "fx" else "DreamShader"
    script = "dfx.ps1" if lang == "fx" else "dsc.ps1"
    path = project.root / "Plugins" / plugin / ".skill" / script
    if not path.exists():
        raise DriverMissing(f"No driver at '{path}'.")
    return path


def run(project: Project, lang: str, command: str,
        target: str | None = None,
        flags: list[str] | None = None,
        timeout: float = 1800.0) -> CliResult:
    """Invoke a driver and normalise its result.

    Exit codes differ between the two and both are meaningful: `dfx.ps1` returns the error
    count, `dsc.ps1` returns the commandlet's own 0/1. Only the zero/non-zero split is
    interpreted here; the raw code is passed through for a caller that wants the count.
    """
    script = driver_path(project, lang)
    argv = [_pwsh(), "-NoProfile", "-File", str(script), command]
    if target:
        argv.append(target)
    argv.extend(flags or [])

    try:
        completed = subprocess.run(
            argv, cwd=str(project.root), capture_output=True, text=True,
            timeout=timeout, encoding="utf-8", errors="replace",
        )
    except subprocess.TimeoutExpired:
        return CliResult(False, -1, f"The driver did not finish within {timeout:.0f}s.", "")

    output = (completed.stdout or "") + (completed.stderr or "")
    diagnostics = from_cli(output)

    return CliResult(
        ok=completed.returncode == 0,
        exit_code=completed.returncode,
        message=_last_status_line(output) or f"exit {completed.returncode}",
        output=output,
        diagnostics=diagnostics,
    )


def _last_status_line(output: str) -> str | None:
    """The drivers end with their own verdict (`dfx: OK (exit 0)`), which is a better
    summary than anything reconstructed from the surrounding noise."""
    for line in reversed(output.splitlines()):
        stripped = line.strip()
        if stripped.startswith(("dfx:", "dsc:")) and (
                "OK" in stripped or "FAILED" in stripped):
            return stripped
    return None
