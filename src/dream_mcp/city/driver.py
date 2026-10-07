"""Running `dcc.ps1` and reading the report it leaves."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from ..core.cli import DEFAULT_TIMEOUT_SECONDS, DriverMissing, _pwsh
from ..core.diagnostics import Diagnostic
from ..core.locate import Project

#: A city's own source. Grammars and kits are compiled as part of the city that names them.
CITY_EXTENSIONS = {".dct"}
PART_EXTENSIONS = {".dcg", ".dck"}

#: What `dcc.ps1` says when an editor holds the project, quoted so the refusal is recognised.
EDITOR_OPEN = "Close it first."


@dataclass
class CityReport:
    city: str
    file: str
    compiled: bool
    errors: int
    warnings: int
    blocks: int | None = None
    lots: int | None = None
    pieces: int | None = None
    diagnostics: list[Diagnostic] = field(default_factory=list)
    counts: list[int] = field(default_factory=list)
    """How many times each diagnostic was said, in the same order: the compiler says a
    problem a grammar rule meets on many lots once, and counts the rest."""


@dataclass
class CityResult:
    ok: bool
    exit_code: int
    refused: str | None
    report: CityReport | None
    output: str


def driver_path(project: Project) -> Path:
    path = project.root / "Plugins" / "DreamCity" / "Tools" / "dcc.ps1"
    if not path.exists():
        raise DriverMissing(f"No driver at '{path}'.")
    return path


def is_city_target(target: str) -> bool:
    """A `.dct` file, or a package such as `@dreamcity/cities/Island` (`/Game/...` too)."""
    stripped = target.strip()
    return stripped.startswith(("@", "/Game/")) or Path(stripped).suffix.lower() in CITY_EXTENSIONS


def read_report(path: Path) -> CityReport | None:
    """The JSON the commandlet writes. A diagnostic about the layout rather than a line of
    text -- two junctions that overlap -- has no file; it keeps line and column 0 instead of
    being given a position it does not have."""
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None
    report = CityReport(
        city=data.get("city", ""),
        file=data.get("file", ""),
        compiled=bool(data.get("compiled", False)),
        errors=int(data.get("errors", 0)),
        warnings=int(data.get("warnings", 0)),
        blocks=data.get("blocks"),
        lots=data.get("lots"),
        pieces=data.get("pieces"),
    )
    for entry in data.get("diagnostics", []):
        report.diagnostics.append(Diagnostic(
            file=entry.get("file", ""),
            line=int(entry.get("line", 0)),
            column=int(entry.get("column", 0)),
            severity=str(entry.get("severity", "error")).lower(),
            code=entry.get("code") or None,
            message=entry.get("message", ""),
        ))
        report.counts.append(int(entry.get("count", 1)))
    return report


def describe(diagnostic: Diagnostic, count: int = 1) -> str:
    where = (f"{diagnostic.file}({diagnostic.line},{diagnostic.column}): " if diagnostic.file
             else "(the layout): ")
    code = f" {diagnostic.code}" if diagnostic.code else ""
    times = f" (x{count})" if count > 1 else ""
    return f"{where}{diagnostic.severity}{code}: {diagnostic.message}{times}"


def report_path(project: Project, target: str) -> Path:
    name = Path(target.replace("@", "").split("/")[-1]).stem or "city"
    return project.saved / "DreamCity" / "Verify" / f"{name}.json"


def run(project: Project, target: str, verify_only: bool, map_path: str | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS) -> CityResult:
    """`dcc.ps1 verify` writes nothing but the report; `dcc.ps1 compile` bakes the city into
    its asset and map, and writes the report beside its own."""
    script = driver_path(project)
    report = report_path(project, target)
    report.parent.mkdir(parents=True, exist_ok=True)
    if report.exists():
        report.unlink()

    argv = [_pwsh(), "-NoProfile", "-File", str(script), "verify" if verify_only else "compile",
            "-City", target, "-Report", str(report)]
    if map_path:
        argv += ["-Map", map_path]
    try:
        completed = subprocess.run(argv, cwd=str(project.root), capture_output=True, text=True,
                                   timeout=timeout, encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return CityResult(False, -1, None, None,
                          f"dcc.ps1 did not finish within {timeout:.0f}s and was killed.")

    output = (completed.stdout or "") + (completed.stderr or "")
    refused = next((line.strip() for line in output.splitlines() if EDITOR_OPEN in line), None)
    return CityResult(ok=completed.returncode == 0, exit_code=completed.returncode,
                      refused=refused, report=read_report(report), output=output)


def latest_reports(project: Project) -> list[tuple[Path, CityReport]]:
    """Every city's last report, newest first: what dream_diagnostics shows for cities."""
    directory = project.saved / "DreamCity" / "Verify"
    found: list[tuple[Path, CityReport]] = []
    for path in sorted(directory.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        report = read_report(path)
        if report is not None:
            found.append((path, report))
    return found
