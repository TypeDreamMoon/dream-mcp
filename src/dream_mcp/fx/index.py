"""Reading the DreamFX module index -- the whole Niagara module library, with input signatures.

Since the DreamSource layout it lives in `<FX source dir>/.dreamfx/index.db` (modules,
quarantine and probe journal in one SQLite database, see `core.fx_db`); before it, in
`<FX source dir>/.dfx-index.json` with a `.quarantine` file beside it. The FX source dir is
`DreamSource/FX` (or whatever `Config/DefaultDreamSource.ini` says), or the legacy `DFX/`.
`load` prefers the database and falls back to the JSON file, so either plugin build works.

This never touches the editor or the bridge, and that is deliberate rather than an
optimisation. The bridge's own `refreshIndex` action **refuses** to probe input signatures,
because probing walks the module graphs and `/Niagara/Modules/Masks/ConeMask` sends
`UNiagaraGraph::ReferencesStaticVariable` into unbounded recursion -- 81 frames and then an
uncatchable stack overflow that takes the editor down along with anything unsaved in it.

Signatures can therefore only be produced by a process that is allowed to die and be
restarted, which is `dfx.ps1 index` with its quarantine list. What that run leaves behind is
that index, and reading it is free.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from ..core import fx_db
from ..core.locate import Project

#: Raised by `load` for an index.db of a schema this build does not read.
SchemaMismatch = fx_db.SchemaMismatch

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
    updated_utc: str | None = None
    """When the modules were last written, for an index read from index.db. Its file's
    mtime moves with every quarantine write, so it cannot stand in for this the way the
    JSON file's mtime does."""

    _by_normalized: dict[str, list[Module]] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        for module in self.modules:
            self._by_normalized.setdefault(normalize(module.name), []).append(module)

    @property
    def from_database(self) -> bool:
        return self.path.suffix == ".db"

    # -- freshness ---------------------------------------------------------------

    @property
    def age_days(self) -> float:
        stamp = _parse_utc(self.updated_utc) if self.from_database else None
        if stamp is None:
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


def _parse_utc(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        stamp = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def index_path(project: Project) -> Path:
    """Where the index is read from: `<FX source dir>/.dreamfx/index.db` when it exists, else
    the legacy `<FX source dir>/.dfx-index.json` when that exists, else where index.db would
    be. (`load` also falls back to the JSON file when index.db holds no modules yet.)"""
    source = fx_db.source_directory(project)
    database = fx_db.index_database_path(source)
    legacy = fx_db.legacy_index_path(source)
    if not database.is_file() and legacy.is_file():
        return legacy
    return database


def load(project: Project) -> Index:
    """The module index: index.db when it holds modules, else the legacy `.dfx-index.json`.

    Raises FileNotFoundError when there is neither, and SchemaMismatch for an index.db of a
    schema this build does not read -- not a fallback to the JSON file, which the plugin
    deletes once it has imported it.
    """
    source = fx_db.source_directory(project)
    database = fx_db.index_database_path(source)
    legacy = fx_db.legacy_index_path(source)

    from_db = fx_db.read_index(database)
    if from_db is not None and from_db[0]["modules"]:
        data, quarantined, meta = from_db
        return _build(database, data, quarantined,
                      meta.get("modules_updated_utc") or data.get("generatedUtc"))

    if not legacy.is_file():
        state = ("exists but holds no modules yet" if from_db is not None
                 else "does not exist")
        raise FileNotFoundError(
            f"No module index in '{source}': '{database}' {state}, and there is no legacy "
            f"'{legacy.name}' beside it. Build one with `dfx.ps1 index` -- it takes a few "
            f"minutes and only needs redoing when the engine or the module library changes."
        )

    data = json.loads(legacy.read_text(encoding="utf-8"))
    quarantined = fx_db.read_legacy_quarantine(legacy)
    if from_db is not None:
        # A database that recorded quarantine but no modules yet: those crashes count too.
        quarantined += [q for q in from_db[1] if q not in quarantined]
    return _build(legacy, data, quarantined, None)


def _build(path: Path, data: dict, quarantined: list[str], updated_utc: str | None) -> Index:
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
        search_paths=data.get("searchPaths") or [],
        modules=modules,
        quarantined=quarantined,
        updated_utc=updated_utc,
    )
