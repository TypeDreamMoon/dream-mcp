"""What moved on disk.

The CLI driver answers this by snapshotting every `.uasset` under `Content/` and `Plugins/`
before and after the run and diffing the timestamps. The bridge reply carries no such list,
so the same technique is the only way to answer it on the warm path -- but the economics are
completely different. Measured on this project: 3173 assets, **1.95 s** per walk. The CLI can
absorb that behind a 12 s engine boot; a bridge build that finishes in 0.5 s cannot, and
paying it unconditionally would make the fast path four times slower to add a footnote.

So it is opt-in, and it walks once rather than twice -- the request's own start time is a
perfectly good floor, and the second walk was only ever establishing what the clock already
knows.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path

from .locate import Project

#: Where generated assets can land. Matches the CLI driver's own scope.
ROOTS = ("Content", "Plugins")


@dataclass
class Changed:
    paths: list[str]
    scanned: int
    seconds: float
    floor: float

    def describe(self, limit: int = 25) -> str:
        if not self.paths:
            return (f"No .uasset changed on disk ({self.scanned} scanned in "
                    f"{self.seconds:.1f}s).")

        lines = [f"{len(self.paths)} .uasset changed on disk during this run "
                 f"({self.scanned} scanned in {self.seconds:.1f}s):"]
        lines.extend(f"  {p}" for p in self.paths[:limit])
        if len(self.paths) > limit:
            lines.append(f"  ... and {len(self.paths) - limit} more")
        # Said plainly because it is a real limit, not a disclaimer: an autosave or another
        # session writing at the same time lands in this list too. It reports what changed
        # during the window, which is not the same claim as what this request wrote.
        lines.append("  (Anything else writing during the window appears here too.)")
        return "\n".join(lines)


def floor_now() -> float:
    """The timestamp to compare against. Taken a moment early so a filesystem whose
    timestamp granularity is coarse cannot round a genuine write to just below the line."""
    return time.time() - 1.0


def changed_since(project: Project, floor: float) -> Changed:
    started = time.monotonic()
    found: list[str] = []
    scanned = 0

    for root in ROOTS:
        base = project.root / root
        if not base.is_dir():
            continue
        for directory, _, files in os.walk(base):
            for name in files:
                if not name.endswith(".uasset"):
                    continue
                scanned += 1
                path = Path(directory) / name
                try:
                    if path.stat().st_mtime > floor:
                        found.append(str(path.relative_to(project.root)).replace("\\", "/"))
                except OSError:
                    continue

    found.sort()
    return Changed(paths=found, scanned=scanned,
                   seconds=time.monotonic() - started, floor=floor)
