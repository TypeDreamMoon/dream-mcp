"""One diagnostic shape, whichever path produced it.

The bridge hands back structured JSON; the CLI prints `path(line,col): error CODE: text`.
A caller that had to tell those apart would have to know which route its request took, and
then the routing would not be an implementation detail any more -- it would be part of the
interface, and every consumer would grow a branch for it.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

#: `C:/x/y.dfs(11,17): error DFX3003: message`, with the severity and code both optional so
#: the DreamShader form (`path(22,9): Failed to ...`) parses through the same expression.
_LOCATED = re.compile(
    r"^(?P<file>[A-Za-z]:[\\/][^()]+|[^()]*[\\/][^()]+)"
    r"\((?P<line>\d+),(?P<column>\d+)\)\s*:\s*"
    r"(?:(?P<severity>error|warning|info|fatal)\s+)?"
    r"(?:(?P<code>[A-Z]{3}\d{4})\s*)?:?\s*"
    r"(?P<message>.*)$",
    re.IGNORECASE,
)

#: Engine log furniture the drivers leave on the front of a line.
_LOG_PREFIX = re.compile(
    r"^Log(?:DreamFX|DreamShader):\s*(?:Display|Warning|Error|Fatal|Verbose)\s*:\s*",
    re.IGNORECASE,
)


@dataclass
class Diagnostic:
    file: str
    line: int
    column: int
    severity: str
    code: str | None
    message: str

    def __str__(self) -> str:
        code = f" {self.code}" if self.code else ""
        return (f"{self.file}({self.line},{self.column}): "
                f"{self.severity}{code}: {self.message}")

    @property
    def is_error(self) -> bool:
        return self.severity in ("error", "fatal")


def from_bridge(entries: list[dict]) -> list[Diagnostic]:
    """The bridge already emits this shape -- see `WriteDiagnosticsArray`.

    Each diagnostic keeps its own file on purpose: a `.dfs` that pulls in a broken `.dfe`
    fails at the `.dfe`'s position, and re-attributing it to the `.dfs` would send the
    author to the wrong file.
    """
    return [
        Diagnostic(
            file=entry.get("file", ""),
            line=max(1, int(entry.get("line", 1))),
            column=max(1, int(entry.get("column", 1))),
            severity=str(entry.get("severity", "error")).lower(),
            code=entry.get("code") or None,
            message=entry.get("message", ""),
        )
        for entry in entries
    ]


def from_cli(output: str) -> list[Diagnostic]:
    """Recover the same shape from driver output.

    Only lines that carry a real `(line,column)` become diagnostics. Summary lines, the
    `dfx: OK` footer and the editor-is-running warning are progress, not findings, and
    promoting them would inflate every error count.
    """
    found: list[Diagnostic] = []
    for raw in output.splitlines():
        line = _LOG_PREFIX.sub("", raw.strip())
        match = _LOCATED.match(line)
        if not match:
            continue

        severity = (match.group("severity") or "").lower()
        if not severity:
            # DreamShader prints no severity token; the log level carried it, and by this
            # point that prefix is gone. Anything with a location that reached the driver's
            # filtered output is a finding, so default to the safe reading.
            severity = "warning" if "warning" in raw.lower() else "error"

        found.append(Diagnostic(
            file=match.group("file").strip(),
            line=max(1, int(match.group("line"))),
            column=max(1, int(match.group("column"))),
            severity=severity,
            code=match.group("code"),
            message=match.group("message").strip(),
        ))
    return found


def read_published(project, lang: str) -> tuple[list[Diagnostic], str | None]:
    """Read whichever plugin's published `diagnostics.json`, normalised.

    Both bridges write one, and both rewrite it on every run precisely so a client that was
    not the one who asked -- or one that reconnected after a response was consumed -- can
    still see what the last run found. The two files have different shapes: DreamFX writes a
    flat array where each entry names its own file, DreamShader groups by file and puts the
    path on the group. Same destination shape either way.
    """
    from . import liveness as live  # local: liveness imports locate, never this module

    directory = (live.fx_bridge_dir(project) if lang == "fx"
                 else live.shader_bridge_dir(project))
    path = directory / "diagnostics.json"

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return [], None

    if lang == "fx":
        return from_bridge(data.get("diagnostics", [])), data.get("generatedUtc")

    found: list[Diagnostic] = []
    for entry in data.get("files", []):
        owner = entry.get("path", "")
        for item in entry.get("diagnostics", []):
            found.append(Diagnostic(
                file=owner,
                line=max(1, int(item.get("line", 1))),
                column=max(1, int(item.get("column", 1))),
                severity=str(item.get("severity", "error")).lower(),
                code=item.get("code") or None,
                message=item.get("message", ""),
            ))
    return found, data.get("updatedAtUtc")


def unlocated_errors(output: str, limit: int = 10) -> list[str]:
    """Error lines that carry no `(line,column)` and so become no diagnostic.

    These are not rare and they are not minor. `Generated DreamShader asset '...' could not
    be saved.` is one of them: a whole-run failure with a real cause and no source position
    anywhere in it. Reporting only located diagnostics drops it silently, leaving a caller
    staring at `FAILED (exit 1)` with no reason attached -- which is a worse answer than the
    raw log would have been.
    """
    found: list[str] = []
    for raw in output.splitlines():
        stripped = raw.strip()
        if not re.search(r"Log\w*:\s*(Error|Fatal)\s*:", stripped, re.IGNORECASE):
            continue
        text = _LOG_PREFIX.sub("", stripped)
        text = re.sub(r"^Log\w*:\s*(?:Error|Fatal)\s*:\s*", "", text, flags=re.IGNORECASE)
        if _LOCATED.match(text):
            continue  # already reported as a proper diagnostic
        if text and text not in found:
            found.append(text)
    return found[:limit]


def summarize(diagnostics: list[Diagnostic]) -> str:
    """Three buckets, not two. Folding `info` in with the warnings inflates the count that
    a reader scans for, and DreamFX emits informational notes routinely."""
    errors = sum(1 for d in diagnostics if d.is_error)
    warnings = sum(1 for d in diagnostics if d.severity == "warning")
    info = len(diagnostics) - errors - warnings

    parts = [f"{errors} error(s)", f"{warnings} warning(s)"]
    if info:
        parts.append(f"{info} info")
    return ", ".join(parts)
