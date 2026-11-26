"""The DreamSource layout of DreamFX: where its sources and generated data live.

Since the DreamSource layout (Plan/DreamSource spec, section 13) DreamFX keeps what it
publishes for tools in two SQLite databases instead of JSON files:

`<Project>/Intermediate/DreamSource/fx.db` -- rebuilt automatically, replaces
`Saved/DreamFX/Bridge/diagnostics.json` (the diagnostics of the bridge's last request):

    meta(key, value)              schema='1', producer, revision, diagnostics_revision,
                                  diagnostics_updated_utc (the former generatedUtc)
    diagnostics(seq, file, json)  one row per diagnostic, seq keeps the original array order

`<FX source dir>/.dreamfx/index.db` -- never rebuilt automatically (`dfx index` takes
minutes and its quarantine was learned by crashing), replaces `.dfx-index.json` and its
`.inflight` / `.quarantine` companions:

    meta(key, value)              schema='1', producer, revision, modules_revision,
                                  modules_updated_utc, and the former JSON header: version,
                                  generated_utc, project, inputs_probed ('true'/'false'),
                                  engine, plugins and search_paths (JSON array text)
    modules(ord, path, name, kind, json)   one row per module or dynamic input
    probe_journal(id, package, started_utc)  the module being probed right now, if any
    quarantine(package, quarantined_utc)

The bridge's request files and `status.json` stay plain files and move from
`Saved/DreamFX/Bridge` to `Intermediate/DreamSource/FX/Bridge`.

Every reader here prefers the database and falls back to the legacy files, so an older
plugin build keeps working. Databases are opened read-only, so a reader never creates one.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from .locate import Project
from .shader_db import _read_ini_directory, _usable

#: The schema this build reads. A database stamped with another one is refused, not guessed at.
SCHEMA = "1"

SETTINGS_SECTION = "/Script/DreamFXEditor.DreamFXSourceSettings"
DEFAULT_SOURCE_DIRECTORY = "DreamSource/FX"
LEGACY_SOURCE_DIRECTORY = "DFX"
PLUGIN_SOURCE_DIRECTORY = "DreamSource/FX"

INDEX_DIRECTORY = ".dreamfx"
INDEX_DATABASE = "index.db"
LEGACY_INDEX_FILE = ".dfx-index.json"


class SchemaMismatch(Exception):
    """fx.db or index.db was written by a plugin whose schema this dream-mcp does not know."""


# ---------------------------------------------------------------- locations


def database_path(project: Project) -> Path:
    """`Intermediate/DreamSource/fx.db`."""
    return project.root / "Intermediate/DreamSource/fx.db"


def intermediate_dir(project: Project) -> Path:
    return project.root / "Intermediate/DreamSource/FX"


def bridge_dir(project: Project) -> Path:
    """`Intermediate/DreamSource/FX/Bridge` -- the request files of a current plugin."""
    return intermediate_dir(project) / "Bridge"


def legacy_bridge_dir(project: Project) -> Path:
    """`Saved/DreamFX/Bridge` -- where a plugin from before the DreamSource layout keeps its
    request files, status and `diagnostics.json`."""
    return project.saved / "DreamFX/Bridge"


def index_database_path(source_dir: Path) -> Path:
    """`<FX source dir>/.dreamfx/index.db`."""
    return source_dir / INDEX_DIRECTORY / INDEX_DATABASE


def legacy_index_path(source_dir: Path) -> Path:
    """`<FX source dir>/.dfx-index.json` (its quarantine sits beside it, `.quarantine`)."""
    return source_dir / LEGACY_INDEX_FILE


# ---------------------------------------------------------------- source directory


def configured_source_directory(project: Project) -> str:
    """The configured project source directory, relative to the project.

    `Config/DefaultDreamSource.ini` `[/Script/DreamFXEditor.DreamFXSourceSettings]
    SourceDirectory`, as `(Path="x")` or a bare value; `DreamSource/FX` when it is absent,
    empty or absolute. FX has no legacy key.
    """
    value = _read_ini_directory(project.root / "Config/DefaultDreamSource.ini", SETTINGS_SECTION)
    return value if _usable(value) else DEFAULT_SOURCE_DIRECTORY


def configured_source_path(project: Project) -> Path:
    """`<Project>/<SourceDirectory>`, whether or not it exists -- where a new file would go."""
    return project.root / configured_source_directory(project)


def legacy_source_path(project: Project) -> Path:
    return project.root / LEGACY_SOURCE_DIRECTORY


def source_directory(project: Project) -> Path:
    """The project's FX source directory: the configured one when it exists, else the legacy
    `DFX/` when that exists, else the configured one (where a new file would go)."""
    configured = configured_source_path(project)
    if configured.is_dir():
        return configured
    legacy = legacy_source_path(project)
    if legacy.is_dir():
        return legacy
    return configured


def uses_legacy_source_directory(project: Project) -> bool:
    return source_directory(project) == legacy_source_path(project)


def plugin_source_directory(plugin_dir: Path) -> Path | None:
    """`<Plugin>/DreamSource/FX`, else the legacy `<Plugin>/DFX`; None when neither."""
    for candidate in (plugin_dir / PLUGIN_SOURCE_DIRECTORY, plugin_dir / LEGACY_SOURCE_DIRECTORY):
        if candidate.is_dir():
            return candidate
    return None


# ---------------------------------------------------------------- database


def _connect(path: Path) -> sqlite3.Connection:
    # Read-only through the URI, so a reader can never create the file or take a write lock;
    # the timeout waits out the editor's commit instead of failing on SQLITE_BUSY.
    uri = "file:" + path.resolve().as_posix() + "?mode=ro"
    return sqlite3.connect(uri, uri=True, timeout=5.0)


def _open(path: Path) -> sqlite3.Connection | None:
    """A connection to a current-schema database at `path`, None when there is none (or it
    cannot be read at all).

    Raises SchemaMismatch for a database of another schema: reading it anyway would hand
    back rows whose shape this build cannot vouch for.
    """
    if not path.is_file():
        return None
    try:
        connection = _connect(path)
    except sqlite3.Error:
        return None
    try:
        row = connection.execute("SELECT value FROM meta WHERE key = 'schema'").fetchone()
    except sqlite3.Error:
        connection.close()
        return None
    schema = row[0] if row else None
    if schema != SCHEMA:
        connection.close()
        raise SchemaMismatch(
            f"{path} has schema {schema!r}; this dream-mcp reads schema {SCHEMA!r}. "
            f"Update dream-mcp or the DreamFX plugin so they agree.")
    return connection


def _meta(connection: sqlite3.Connection) -> dict[str, str]:
    return dict(connection.execute("SELECT key, value FROM meta").fetchall())


def has_database(project: Project) -> bool:
    return database_path(project).is_file()


def read_diagnostics(project: Project) -> dict | None:
    """The former `diagnostics.json`, rebuilt from fx.db:
    `{protocol: 1, generatedUtc: meta.diagnostics_updated_utc, diagnostics: [row json by seq]}`.

    None when there is no readable database. `generatedUtc` is None while nothing was ever
    written, which is how the JSON reader told "the bridge has not run" apart from "clean".
    """
    connection = _open(database_path(project))
    if connection is None:
        return None
    try:
        meta = _meta(connection)
        rows = connection.execute("SELECT json FROM diagnostics ORDER BY seq").fetchall()
    except sqlite3.Error:
        return None
    finally:
        connection.close()

    diagnostics = []
    for (text,) in rows:
        try:
            entry = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(entry, dict):
            diagnostics.append(entry)
    return {"protocol": 1, "generatedUtc": meta.get("diagnostics_updated_utc"),
            "diagnostics": diagnostics}


def read_published_diagnostics(project: Project) -> dict | None:
    """DreamFX's published diagnostics in the `diagnostics.json` shape: from fx.db when there
    is one, else from the legacy `Saved/DreamFX/Bridge/diagnostics.json`. None when neither
    can be read.

    A database of a schema this build does not know raises SchemaMismatch rather than falling
    back: the legacy file beside it, if any, is older than the database.
    """
    if has_database(project):
        data = read_diagnostics(project)
        if data is not None:
            return data
    try:
        data = json.loads((legacy_bridge_dir(project) / "diagnostics.json")
                          .read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


# ---------------------------------------------------------------- module index


def _json_value(text: str | None):
    if text is None:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _version(text: str):
    """`version` is stored as text; the JSON had a number."""
    try:
        return int(text)
    except (TypeError, ValueError):
        return text


#: meta key -> (JSON key, decoder), in the JSON file's own key order.
_INDEX_HEADER = (
    ("version", "version", _version),
    ("generated_utc", "generatedUtc", str),
    ("project", "project", str),
    ("inputs_probed", "inputsProbed", lambda v: v.strip().lower() == "true"),
    ("engine", "engine", str),
    ("plugins", "plugins", _json_value),
    ("search_paths", "searchPaths", _json_value),
)


def read_index(path: Path) -> tuple[dict, list[str], dict[str, str]] | None:
    """The module index at `path` (an index.db) rebuilt into the former `.dfx-index.json`
    shape -- `{version, generatedUtc, project, inputsProbed, engine, plugins, searchPaths,
    modules: [row json by ord]}`, header keys only when the database has them -- with the
    quarantine list (`quarantine.package`, sorted) and the raw meta.

    None when there is no readable database. A database that holds no modules (one that has
    so far only recorded a quarantine) still reads; the caller decides what that means.
    """
    connection = _open(path)
    if connection is None:
        return None
    try:
        meta = _meta(connection)
        rows = connection.execute("SELECT json FROM modules ORDER BY ord").fetchall()
        quarantined = [row[0] for row in connection.execute(
            "SELECT package FROM quarantine ORDER BY package").fetchall()]
    except sqlite3.Error:
        return None
    finally:
        connection.close()

    data: dict = {}
    for key, json_key, decode in _INDEX_HEADER:
        if key in meta:
            data[json_key] = decode(meta[key])
    modules = []
    for (text,) in rows:
        entry = _json_value(text)
        if isinstance(entry, dict):
            modules.append(entry)
    data["modules"] = modules
    return data, quarantined, meta


def read_legacy_quarantine(index_file: Path) -> list[str]:
    """`<index>.quarantine`: one package per line, in the order they were quarantined."""
    quarantine = index_file.with_name(index_file.name + ".quarantine")
    try:
        text = quarantine.read_text(encoding="utf-8")
    except OSError:
        return []
    return [line.strip() for line in text.splitlines() if line.strip()]
