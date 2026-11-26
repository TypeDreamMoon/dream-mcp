"""Reading the DreamShader bridge manifests.

The material-expressions, substrate-builtins and settings manifests are written at bridge
startup and whenever the workspace is opened, and they survive the editor exiting.

Since the DreamSource layout they are `documents` rows of
`Intermediate/DreamSource/shader.db` -- the same JSON text the files held, verbatim -- and the
database persists across sessions. Before it they were `material-expressions.json`,
`substrate-builtins.json` and `settings.json` in `Saved/DreamShader/Bridge`; that plugin's
`bridge.db` was deleted at startup and shutdown and never served as a source of truth. The
database is read when it exists, the legacy files otherwise.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from ..core import shader_db
from ..core.locate import Project


def normalize_mapping_key(name: str) -> str:
    """`UDreamShaderSettings::NormalizeMappingKey` -- enum aliases (`Clear Coat`).

    Strips hyphens as well as spaces and underscores, which neither of the other two
    normalizers in this codebase do.
    """
    return (name.strip().lower()
            .replace(" ", "").replace("_", "").replace("-", ""))


def normalize_setting_key(name: str) -> str:
    """`UE::DreamShader::NormalizeSettingKey` -- setting keys inside a `.dsm`, and the
    argument names of a `UE.Expression` call.

    Trim and lowercase, and **nothing else**. `Shading Model` is not `ShadingModel` here.
    Kept separate from the mapping-key rule on purpose: collapsing the two would resolve
    names the compiler then rejects.
    """
    return name.strip().lower()


def expression_class_candidates(name: str) -> list[str]:
    """`ResolveMaterialExpressionClass`'s candidate list, in its order.

    Not a normalisation like the other three rules -- it is prefix expansion. A bare `Abs`
    is tried as `Abs`, `UAbs`, `MaterialExpressionAbs` and `UMaterialExpressionAbs`, each
    compared case-insensitively against every concrete `UMaterialExpression` subclass. Which
    is why the manifest's `name` (`Abs`) and its `className` (`MaterialExpressionAbs`) are
    both things a user can legitimately write.
    """
    candidate = name.strip()
    if not candidate:
        return []

    # UE's FString::StartsWith defaults to ESearchCase::IgnoreCase, so a lowercase
    # `materialexpressionabs` counts as already prefixed and does not get another one.
    # Python's str.startswith is case-sensitive, hence the explicit fold.
    lowered = candidate.lower()

    options = [candidate]
    if not lowered.startswith("u"):
        options.append("U" + candidate)
    if not lowered.startswith("materialexpression"):
        options.append("MaterialExpression" + candidate)
    if not lowered.startswith("umaterialexpression"):
        options.append("UMaterialExpression" + candidate)
    return options


@dataclass
class Expression:
    name: str
    class_name: str
    path_name: str
    default_output_type: str
    inputs: list[dict] = field(default_factory=list)
    outputs: list[dict] = field(default_factory=list)
    properties: list[dict] = field(default_factory=list)


@dataclass
class Builtin:
    name: str
    qualified_name: str
    class_name: str
    output_type: str
    is_substrate_output: bool
    detail: str | None = None
    example: str | None = None
    snippet: str | None = None
    parameters: list[dict] = field(default_factory=list)


@dataclass
class Alias:
    kind: str
    alias: str
    value: int
    name: str | None
    display_name: str | None
    source: str


@dataclass
class Manifests:
    directory: Path
    generated_at: str | None
    expressions: list[Expression]
    builtins: list[Builtin]
    aliases: list[Alias]
    substrate_supported: bool
    substrate_unsupported_reason: str | None
    missing: list[str] = field(default_factory=list)

    def find_expression(self, query: str) -> list[Expression]:
        """Resolve the way `ResolveMaterialExpressionClass` does, then fall back to search.

        The prefix-expansion rule is replayed against both `name` and `className`, because
        the engine compares against the real UClass name and the manifest carries both
        spellings. So `Abs`, `MaterialExpressionAbs` and `umaterialexpressionabs` all land
        on the same entry -- exactly the set the compiler accepts.
        """
        candidates = {c.lower() for c in expression_class_candidates(query)}
        if candidates:
            exact = [e for e in self.expressions
                     if e.name.lower() in candidates or e.class_name.lower() in candidates]
            if exact:
                return exact

        needle = query.strip().lower()
        return sorted(
            (e for e in self.expressions if needle in e.name.lower()),
            key=lambda e: (len(e.name), e.name),
        )[:40]

    def find_builtin(self, query: str) -> list[Builtin]:
        needle = query.strip().lower().removeprefix("substrate.")
        exact = [b for b in self.builtins if b.name.lower() == needle]
        if exact:
            return exact
        return [b for b in self.builtins if needle in b.name.lower()][:40]

    def find_alias(self, query: str, kind: str | None = None) -> list[Alias]:
        needle = normalize_mapping_key(query)
        hits = [a for a in self.aliases if normalize_mapping_key(a.alias) == needle]
        if not hits:
            hits = [a for a in self.aliases if needle in normalize_mapping_key(a.alias)]
        if kind:
            hits = [a for a in hits if a.kind.lower() == kind.lower()]
        return hits[:40]


def _load_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


#: Each manifest's `documents` name in shader.db, and the file it used to be.
_MANIFESTS = (("material-expressions", "material-expressions.json"),
              ("substrate-builtins", "substrate-builtins.json"),
              ("settings", "settings.json"))


def load(project: Project) -> Manifests:
    """The manifests, from shader.db when it exists, else from the legacy JSON files.

    Raises `shader_db.SchemaMismatch` for a database of a schema this build does not read.
    """
    missing: list[str] = []
    loaded: dict[str, dict | None] = {}

    if shader_db.has_database(project):
        directory = shader_db.database_path(project)
        for document, _ in _MANIFESTS:
            loaded[document] = shader_db.read_document_json(project, document)
            if loaded[document] is None:
                missing.append(document)
    else:
        directory = shader_db.legacy_bridge_dir(project)
        for document, file_name in _MANIFESTS:
            loaded[document] = _load_json(directory / file_name)
            if loaded[document] is None:
                missing.append(file_name)

    expressions_data = loaded["material-expressions"]
    builtins_data = loaded["substrate-builtins"]
    settings_data = loaded["settings"]

    expressions = [
        Expression(
            name=entry["name"],
            class_name=entry.get("className", ""),
            path_name=entry.get("pathName", ""),
            default_output_type=entry.get("defaultOutputType", ""),
            inputs=entry.get("inputs", []),
            outputs=entry.get("outputs", []),
            properties=entry.get("properties", []),
        )
        for entry in (expressions_data or {}).get("expressions", [])
    ]

    builtins = [
        Builtin(
            name=entry["name"],
            qualified_name=entry.get("qualifiedName", ""),
            class_name=entry.get("className", ""),
            output_type=entry.get("outputType", ""),
            is_substrate_output=bool(entry.get("isSubstrateOutput")),
            detail=entry.get("detail"),
            example=entry.get("example"),
            snippet=entry.get("snippet"),
            parameters=entry.get("parameters", []),
        )
        for entry in (builtins_data or {}).get("builtins", [])
    ]

    aliases = [
        Alias(
            kind=kind,
            alias=entry["alias"],
            value=entry.get("value", 0),
            name=entry.get("name"),
            display_name=entry.get("displayName"),
            source=entry.get("source", "builtin"),
        )
        for kind, entries in (settings_data or {}).get("mappings", {}).items()
        for entry in entries
    ]

    return Manifests(
        directory=directory,
        generated_at=(expressions_data or {}).get("generatedAt"),
        expressions=expressions,
        builtins=builtins,
        aliases=aliases,
        substrate_supported=bool((builtins_data or {}).get("supported", False)),
        substrate_unsupported_reason=(builtins_data or {}).get("unsupportedReason"),
        missing=missing,
    )
