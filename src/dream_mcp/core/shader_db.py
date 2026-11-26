"""The DreamSource layout of DreamShader: where its sources and generated data live.

Since the DreamSource layout (DreamShader's Plan/DreamSource spec, section 12) the plugin
keeps everything it publishes for tools in one SQLite database,
`<Project>/Intermediate/DreamSource/shader.db`, instead of the JSON manifests, `bridge.db`
and the `diagnostics.json` that used to sit in `Saved/DreamShader/Bridge/`:

    meta(key, value)              schema='1', producer, revision, <part>_revision, <part>_updated_utc
    documents(name, json, ...)    the former whole-file manifests, verbatim:
                                  material-expressions, settings, substrate-builtins, pass-keys,
                                  preprocessor-defines, builtin-catalog, preview
    diagnostics(path, json, updated_at_utc)   one row per source (the former diagnostics/<md5>.json)
    source_index(root, path, json, ...)       one source's symbol index

The database survives the editor: it is emptied of the session's diagnostics and preview at
startup, never deleted. It therefore says nothing about whether an editor is running -- that
is still `status.json`, now in `Intermediate/DreamSource/Shader/Bridge/`.

Every reader here prefers the database and falls back to the legacy files, so an older
plugin build keeps working.
"""

from __future__ import annotations

import configparser
import json
import re
import sqlite3
from pathlib import Path

from .locate import Project

#: The schema this build reads. A database stamped with another one is refused, not guessed at.
SCHEMA = "1"

DEFAULT_SOURCE_DIRECTORY = "DreamSource/Shader"
LEGACY_SOURCE_DIRECTORY = "DShader"
PLUGIN_SOURCE_DIRECTORY = "DreamSource/Shader"


class SchemaMismatch(Exception):
    """shader.db was written by a plugin whose schema this build of dream-mcp does not know."""


# ---------------------------------------------------------------- locations


def database_path(project: Project) -> Path:
    return project.root / "Intermediate/DreamSource/shader.db"


def intermediate_dir(project: Project) -> Path:
    return project.root / "Intermediate/DreamSource/Shader"


def bridge_dir(project: Project) -> Path:
    """`Intermediate/DreamSource/Shader/Bridge` -- the request files of a current plugin."""
    return intermediate_dir(project) / "Bridge"


def legacy_bridge_dir(project: Project) -> Path:
    """`Saved/DreamShader/Bridge` -- where a plugin from before the DreamSource layout keeps
    its request files, status, JSON manifests and bridge.db."""
    return project.saved / "DreamShader/Bridge"


def preview_dir(project: Project) -> Path:
    return intermediate_dir(project) / "Preview"


# ---------------------------------------------------------------- source directory


def _read_ini_directory(path: Path, section: str) -> str:
    """`SourceDirectory` of one section, as `(Path="x")` or a bare value; '' when absent."""
    if not path.is_file():
        return ""
    parser = configparser.RawConfigParser(strict=False, interpolation=None)
    parser.optionxform = str  # keep key case
    try:
        parser.read(path, encoding="utf-8-sig")
    except (configparser.Error, OSError, UnicodeDecodeError):
        return ""
    if not parser.has_section(section):
        return ""
    raw = parser.get(section, "SourceDirectory", fallback="").strip()
    match = re.search(r'Path\s*=\s*"([^"]*)"', raw)
    value = match.group(1) if match else raw.strip('"')
    return value.strip().replace("\\", "/").rstrip("/")


def _usable(value: str) -> bool:
    return bool(value) and not Path(value).is_absolute() and not re.match(r"^[A-Za-z]:", value)


def configured_source_directory(project: Project) -> str:
    """The configured project source directory, relative to the project.

    `Config/DefaultDreamSource.ini` `[/Script/DreamShader.DreamShaderSourceSettings]` unless it
    is left at the default, then the legacy `DefaultEngine.ini`
    `[/Script/DreamShader.DreamShaderSettings]` key unless it holds the old default `DShader`,
    then `DreamSource/Shader`. Absolute or empty values read as unset.
    """
    config = project.root / "Config"
    new = _read_ini_directory(config / "DefaultDreamSource.ini",
                              "/Script/DreamShader.DreamShaderSourceSettings")
    if _usable(new) and new.lower() != DEFAULT_SOURCE_DIRECTORY.lower():
        return new
    legacy = _read_ini_directory(config / "DefaultEngine.ini",
                                 "/Script/DreamShader.DreamShaderSettings")
    if _usable(legacy) and legacy.lower() != LEGACY_SOURCE_DIRECTORY.lower():
        return legacy
    return DEFAULT_SOURCE_DIRECTORY


def source_directory(project: Project) -> Path:
    """The project's source directory: the configured one when it exists, else the legacy
    `DShader/` when that exists, else the configured one (where a new file would go)."""
    configured = project.root / configured_source_directory(project)
    if configured.is_dir():
        return configured
    legacy = project.root / LEGACY_SOURCE_DIRECTORY
    if legacy.is_dir():
        return legacy
    return configured


def plugin_source_directory(plugin_dir: Path) -> Path | None:
    """`<Plugin>/DreamSource/Shader`, else the legacy `<Plugin>/DShader`; None when neither."""
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


def _open(project: Project) -> sqlite3.Connection | None:
    """A connection to a current-schema shader.db, None when there is none.

    Raises SchemaMismatch for a database of another schema: reading it anyway would hand
    back rows whose shape this build cannot vouch for.
    """
    path = database_path(project)
    if not path.is_file():
        return None
    try:
        connection = _connect(path)
        row = connection.execute("SELECT value FROM meta WHERE key = 'schema'").fetchone()
    except sqlite3.Error:
        return None
    schema = row[0] if row else None
    if schema != SCHEMA:
        connection.close()
        raise SchemaMismatch(
            f"{path} has schema {schema!r}; this dream-mcp reads schema {SCHEMA!r}. "
            f"Update dream-mcp or the DreamShader plugin so they agree.")
    return connection


def has_database(project: Project) -> bool:
    return database_path(project).is_file()


def read_meta(project: Project) -> dict[str, str] | None:
    connection = _open(project)
    if connection is None:
        return None
    try:
        return dict(connection.execute("SELECT key, value FROM meta").fetchall())
    except sqlite3.Error:
        return None
    finally:
        connection.close()


def read_document(project: Project, name: str) -> str | None:
    """One `documents` row's json text, None when the database or the row is missing."""
    connection = _open(project)
    if connection is None:
        return None
    try:
        row = connection.execute("SELECT json FROM documents WHERE name = ?", (name,)).fetchone()
    except sqlite3.Error:
        return None
    finally:
        connection.close()
    return row[0] if row else None


def read_document_json(project: Project, name: str) -> dict | None:
    text = read_document(project, name)
    if text is None:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def read_diagnostics(project: Project) -> dict | None:
    """The former `diagnostics.json` envelope, rebuilt from the `diagnostics` rows:
    `{version: 1, updatedAtUtc: meta.diagnostics_updated_utc, files: [row json...]}`.

    None when there is no database. `updatedAtUtc` is None while nothing was ever written,
    which is how the JSON reader told "the bridge has not run" apart from "clean".
    """
    connection = _open(project)
    if connection is None:
        return None
    try:
        stamp_row = connection.execute(
            "SELECT value FROM meta WHERE key = 'diagnostics_updated_utc'").fetchone()
        rows = connection.execute("SELECT json FROM diagnostics ORDER BY path").fetchall()
    except sqlite3.Error:
        return None
    finally:
        connection.close()

    files = []
    for (text,) in rows:
        try:
            entry = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(entry, dict):
            files.append(entry)
    return {"version": 1, "updatedAtUtc": stamp_row[0] if stamp_row else None, "files": files}


def read_source_index(project: Project, root: str, relative_path: str) -> dict | None:
    """One source's symbol index; `root` is `Project`, a plugin's name or `External`."""
    connection = _open(project)
    if connection is None:
        return None
    try:
        row = connection.execute(
            "SELECT json FROM source_index WHERE root = ? AND path = ?",
            (root, relative_path.replace("\\", "/"))).fetchone()
    except sqlite3.Error:
        return None
    finally:
        connection.close()
    if not row:
        return None
    try:
        return json.loads(row[0])
    except json.JSONDecodeError:
        return None
