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

from .diagnostics import Diagnostic, from_cli, unlocated_errors
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
    unlocated: list[str] = field(default_factory=list)
    """Error lines with no source position. Never drop these -- a run can fail entirely on
    one of them, and reporting the exit code alone says nothing about why."""


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


#: A cold run is engine boot (~12 s for DreamFX, ~24 s for DreamShader on this project) plus
#: the work. Five minutes is generous for a single file and short enough that a hang fails
#: while someone is still watching. It was 1800 s, which is not a timeout -- it is half an
#: hour of a silent tool call, and the caller cannot tell that from a crash.
DEFAULT_TIMEOUT_SECONDS = 300.0


def run(project: Project, lang: str, command: str,
        target: str | None = None,
        flags: list[str] | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS) -> CliResult:
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
        return CliResult(
            False, -1,
            f"The cold path did not finish within {timeout:.0f}s and was killed. "
            f"Open the project in the editor and retry -- through the bridge the same work "
            f"is milliseconds, because it skips the engine boot entirely. If the build "
            f"genuinely needs longer than this, pass a larger timeout.",
            "")

    output = (completed.stdout or "") + (completed.stderr or "")

    return CliResult(
        ok=completed.returncode == 0,
        exit_code=completed.returncode,
        message=_last_status_line(output) or f"exit {completed.returncode}",
        output=output,
        diagnostics=from_cli(output),
        unlocated=unlocated_errors(output),
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
