"""Reading `DFX/.dfx-index.json` -- the whole Niagara module library, with input signatures.

This never touches the editor or the bridge, and that is deliberate rather than an
optimisation. The bridge's own `refreshIndex` action **refuses** to probe input signatures,
because probing walks the module graphs and `/Niagara/Modules/Masks/ConeMask` sends
`UNiagaraGraph::ReferencesStaticVariable` into unbounded recursion -- 81 frames and then an
uncatchable stack overflow that takes the editor down along with anything unsaved in it.

Signatures can therefore only be produced by a process that is allowed to die and be
restarted, which is `dfx.ps1 index` with its quarantine list. What that run leaves behind is
this file, and reading it is free.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from ..core.locate import Project

#: Past this the index is old enough to mention unprompted. Not an error -- the library only
#: changes when the engine or a content pack does, and both are rare.
STALE_AFTER_DAYS = 30.0


def normalize(name: str) -> str:
    """DreamFX's own matching form: lowercase, spaces and underscores removed.

    This is why source can write `LoopDuration` for an input actually named `Loop Duration`,
    and why `loop_duration` resolves too. Any divergence here shows up as this server
    resolving a name the compiler then rejects, which is worse than not resolving it.
    """
    return name.replace(" ", "").replace("_", "").lower()


@dataclass
class Module:
    name: str
    path: str
    kind: str
    stacks: list[str] = field(default_factory=list)
    category: str | None = None
    description: str | None = None
    probed_in: str | None = None
    inputs: list[dict] | None = None
    inputs_unavailable: str | None = None

    @property
    def qualified(self) -> str:
        """The form the compiler accepts when a short name is ambiguous."""
        return f"{self.path}.{self.name}"


class Ambiguous(Exception):
    """Refused rather than resolved arbitrarily -- `ConeMask` matches four different assets,
    and picking one would silently build the wrong effect."""

    def __init__(self, query: str, candidates: list[Module]):
        self.query = query
        self.candidates = candidates
        joined = ",\n  ".join(c.qualified for c in candidates)
        super().__init__(
            f"'{query}' is ambiguous -- {len(candidates)} entries match. "
            f"Write the full path, or enough of the tail to disambiguate:\n  {joined}"
        )


class NotFound(Exception):
    def __init__(self, query: str, suggestions: list[str]):
        self.query = query
        self.suggestions = suggestions
        hint = f" Did you mean: {', '.join(suggestions)}?" if suggestions else ""
        super().__init__(f"No module or dynamic input named '{query}'.{hint}")


@dataclass
class Index:
    path: Path
    version: int
    generated_utc: str | None
    project: str | None
    engine: str | None
    search_paths: list[str]
    modules: list[Module]
    quarantined: list[str]

    _by_normalized: dict[str, list[Module]] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        for module in self.modules:
            self._by_normalized.setdefault(normalize(module.name), []).append(module)

    # -- freshness ---------------------------------------------------------------

    @property
    def age_days(self) -> float:
        stamp = datetime.fromtimestamp(self.path.stat().st_mtime, tz=timezone.utc)
        return (datetime.now(timezone.utc) - stamp).total_seconds() / 86400.0

    def freshness_warnings(self, project: Project,
                           include_quarantine: bool = True) -> list[str]:
        """An index is a snapshot of a library that an engine upgrade or a new content pack
        can invalidate wholesale. Saying nothing when that has happened is how a stale
        signature becomes a confident wrong answer.

        `include_quarantine` is off for a single lookup: the quarantine list describes the
        health of the index, not of the entry you asked about, and repeating it on every
        successful query trains the reader to skip warnings. A quarantined module reports
        its own state through `inputs_unavailable` anyway.
        """
        warnings: list[str] = []

        if self.age_days > STALE_AFTER_DAYS:
            warnings.append(
                f"The index is {self.age_days:.0f} days old "
                f"(generated {self.generated_utc}). Run `dfx.ps1 index` to refresh it."
            )

        if self.engine:
            recorded = Path(self.engine.rstrip("/\\")).resolve()
            current = (project.engine_root / "Engine").resolve()
            if recorded != current:
                warnings.append(
                    f"The index was built against '{self.engine}' but this project resolves "
                    f"to '{current}'. Module signatures may not match. Run `dfx.ps1 index`."
                )

        if include_quarantine and self.quarantined:
            warnings.append(
                f"{len(self.quarantined)} module(s) are quarantined and have no probed "
                f"signature: {', '.join(self.quarantined)}. The quarantine list is also "
                f"specific to the engine that produced it."
            )

        return warnings

    # -- lookup ------------------------------------------------------------------

    def find(self, query: str, kind: str | None = None) -> Module:
        """Resolve one entry, or refuse with the full candidate list.

        Accepts a bare name (`GravityForce`), a qualified path
        (`/Niagara/Modules/.../X.X`), or any tail of a path
        (`Spawn/Initialization/InitializeParticle`). The tail form is anchored at the end,
        which is what makes it select that asset and not its `V2/` sibling.
        """
        candidates = self._candidates(query)
        if kind:
            candidates = [c for c in candidates if c.kind == kind]

        if not candidates:
            raise NotFound(query, self._suggest(query))
        if len(candidates) > 1:
            raise Ambiguous(query, candidates)
        return candidates[0]

    def _candidates(self, query: str) -> list[Module]:
        cleaned = query.strip().replace("\\", "/")

        # `/Path/To/Thing.Thing` -- drop the object-name suffix the compiler prints.
        if "/" in cleaned and "." in cleaned.rsplit("/", 1)[-1]:
            stem, _, suffix = cleaned.rpartition(".")
            if normalize(suffix) == normalize(stem.rsplit("/", 1)[-1]):
                cleaned = stem

        if "/" in cleaned:
            tail = "/" + cleaned.strip("/")
            normalized_tail = normalize(tail)
            return [m for m in self.modules
                    if normalize(m.path).endswith(normalized_tail)]

        return list(self._by_normalized.get(normalize(cleaned), []))

    def _suggest(self, query: str, limit: int = 5) -> list[str]:
        """Cutoff tuned down to 0.6 so a single dropped letter still suggests -- `Gravty`
        for `Gravity` is the shape of typo this has to catch, and 0.7 misses it."""
        import difflib
        close = difflib.get_close_matches(
            normalize(query), list(self._by_normalized), n=limit, cutoff=0.6
        )
        # Report the real spelling, not the normalised key it matched on.
        return [self._by_normalized[key][0].name for key in close]

    def search(self, term: str, kind: str | None = None, limit: int = 40) -> list[Module]:
        needle = normalize(term)
        hits = [m for m in self.modules
                if needle in normalize(m.name) or needle in normalize(m.path)]
        if kind:
            hits = [m for m in hits if m.kind == kind]
        hits.sort(key=lambda m: (len(m.name), m.name))
        return hits[:limit]


def index_path(project: Project) -> Path:
    return project.root / "DFX/.dfx-index.json"


def load(project: Project) -> Index:
    path = index_path(project)
    if not path.exists():
        raise FileNotFoundError(
            f"No module index at '{path}'. Build one with `dfx.ps1 index` -- it takes a few "
            f"minutes and only needs redoing when the engine or the module library changes."
        )

    data = json.loads(path.read_text(encoding="utf-8"))

    quarantine = path.with_suffix(path.suffix + ".quarantine")
    quarantined: list[str] = []
    if quarantine.exists():
        quarantined = [line.strip() for line in
                       quarantine.read_text(encoding="utf-8").splitlines() if line.strip()]

    modules = [
        Module(
            name=entry["name"],
            path=entry["path"],
            kind=entry["kind"],
            stacks=entry.get("stacks", []),
            category=entry.get("category"),
            description=entry.get("description"),
            probed_in=entry.get("probedIn"),
            inputs=entry.get("inputs"),
            inputs_unavailable=entry.get("inputsUnavailable"),
        )
        for entry in data.get("modules", [])
    ]

    return Index(
        path=path,
        version=data.get("version", 0),
        generated_utc=data.get("generatedUtc"),
        project=data.get("project"),
        engine=data.get("engine"),
        search_paths=data.get("searchPaths", []),
        modules=modules,
        quarantined=quarantined,
    )
