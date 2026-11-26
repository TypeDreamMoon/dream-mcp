"""The DreamSource layout of DreamFX: fx.db, .dreamfx/index.db, the bridge folder and the
source directory.

Every test builds the databases the way the plugin does -- stdlib sqlite3, the tables of the
spec's section 13 -- in a throwaway project, and checks that dream-mcp rebuilds the old JSON
shapes from them, prefers them, and falls back to the legacy files only when they are absent.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

import pytest

from dream_mcp import server
from dream_mcp.core import fx_db
from dream_mcp.core import liveness as live
from dream_mcp.core.diagnostics import read_published
from dream_mcp.core.locate import Project
from dream_mcp.fx import index as fx_index


@pytest.fixture
def project(tmp_path):
    uproject = tmp_path / "Fake.uproject"
    uproject.write_text('{"EngineAssociation": "test"}', encoding="utf-8")
    return Project(uproject=uproject, engine_root=tmp_path / "Engine")


def write_meta(connection: sqlite3.Connection, rows: dict) -> None:
    connection.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    connection.executemany("INSERT INTO meta VALUES (?, ?)", rows.items())


def make_fx_db(project: Project, diagnostics: list[dict] | None = None,
               schema: str = "1", meta: dict | None = None):
    path = fx_db.database_path(project)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    write_meta(connection, {"schema": schema, "producer": "DreamFX@test", "revision": "1",
                            **(meta or {})})
    connection.execute(
        "CREATE TABLE diagnostics(seq INTEGER PRIMARY KEY, file TEXT NOT NULL, json TEXT NOT NULL)")
    # Inserted back to front: the reader must order by seq, not by rowid or insertion.
    for seq, entry in reversed(list(enumerate(diagnostics or []))):
        connection.execute("INSERT INTO diagnostics VALUES (?, ?, ?)",
                           (seq, entry.get("file", ""), json.dumps(entry)))
    connection.commit()
    connection.close()
    return path


MODULES = [
    {"name": "GravityForce", "path": "/Niagara/Modules/Update/Forces/GravityForce",
     "kind": "module", "stacks": ["ParticleUpdate"], "inputs": [{"name": "Gravity"}]},
    {"name": "ConeMask", "path": "/Niagara/Modules/Masks/ConeMask", "kind": "module",
     "inputsUnavailable": "quarantined"},
    {"name": "RandomRangeFloat", "path": "/Niagara/DynamicInputs/RandomRangeFloat",
     "kind": "dynamicInput"},
]

HEADER = {
    "version": "1", "generated_utc": "2026-11-20T00:00:00Z", "project": "Fake",
    "inputs_probed": "true", "engine": "C:/UE/Engine/",
    "plugins": json.dumps(["Niagara", "DreamFX"]),
    "search_paths": json.dumps(["/Niagara/Modules", "/Niagara/DynamicInputs"]),
    "modules_updated_utc": "2026-11-21T00:00:00Z",
}


def make_index_db(source_dir, modules: list[dict] | None = None,
                  quarantine: list[str] = (), schema: str = "1", header: dict | None = None):
    path = fx_db.index_database_path(source_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    write_meta(connection, {"schema": schema, "producer": "DreamFX@test", "revision": "3",
                            "modules_revision": "1", **(HEADER if header is None else header)})
    connection.executescript("""
        CREATE TABLE modules(ord INTEGER PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL,
                             kind TEXT NOT NULL, json TEXT NOT NULL);
        CREATE INDEX modules_name ON modules(name);
        CREATE TABLE probe_journal(id INTEGER PRIMARY KEY CHECK (id = 1), package TEXT NOT NULL,
                                   started_utc TEXT NOT NULL);
        CREATE TABLE quarantine(package TEXT PRIMARY KEY, quarantined_utc TEXT NOT NULL);
    """)
    entries = MODULES if modules is None else modules
    for ord_, entry in reversed(list(enumerate(entries))):
        connection.execute("INSERT INTO modules VALUES (?, ?, ?, ?, ?)",
                           (ord_, entry["path"], entry["name"], entry["kind"], json.dumps(entry)))
    for package in quarantine:
        connection.execute("INSERT INTO quarantine VALUES (?, '2026-11-21T00:00:00Z')", (package,))
    connection.commit()
    connection.close()
    return path


def write_legacy_index(source_dir, modules: list[dict], quarantine: list[str] = ()):
    source_dir.mkdir(parents=True, exist_ok=True)
    path = source_dir / ".dfx-index.json"
    path.write_text(json.dumps({"version": 1, "generatedUtc": "2026-08-13T00:00:00Z",
                                "project": "Fake", "engine": None, "plugins": [],
                                "searchPaths": ["/Niagara/Modules"], "modules": modules}),
                    encoding="utf-8")
    if quarantine:
        (source_dir / ".dfx-index.json.quarantine").write_text("\n".join(quarantine) + "\n",
                                                               encoding="utf-8")
    return path


def write_status(directory, project: Project):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "status.json").write_text(json.dumps({
        "protocol": live.PROTOCOL_VERSION, "pid": 1, "projectDir": str(project.root),
        "busy": False, "pluginVersion": "2.0.0",
        "heartbeatUtc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }), encoding="utf-8")


def write_ini(project: Project, value: str, section: str = fx_db.SETTINGS_SECTION):
    config = project.root / "Config"
    config.mkdir(exist_ok=True)
    (config / "DefaultDreamSource.ini").write_text(
        f"[{section}]\nSourceDirectory={value}\n", encoding="utf-8")


# -- locations ---------------------------------------------------------------------


def test_the_paths_of_the_layout(project):
    root = project.root
    assert fx_db.database_path(project) == root / "Intermediate/DreamSource/fx.db"
    assert fx_db.bridge_dir(project) == root / "Intermediate/DreamSource/FX/Bridge"
    assert fx_db.legacy_bridge_dir(project) == root / "Saved/DreamFX/Bridge"
    assert fx_db.index_database_path(root / "DFX") == root / "DFX/.dreamfx/index.db"
    assert fx_db.legacy_index_path(root / "DFX") == root / "DFX/.dfx-index.json"


# -- the source directory ----------------------------------------------------------


def test_the_default_source_directory(project):
    assert fx_db.configured_source_directory(project) == "DreamSource/FX"


def test_the_ini_in_either_spelling(project):
    write_ini(project, '(Path="Art/Effects")')
    assert fx_db.configured_source_directory(project) == "Art/Effects"
    write_ini(project, "Art\\Bare\\")
    assert fx_db.configured_source_directory(project) == "Art/Bare"


def test_an_absolute_or_empty_value_or_another_section_reads_as_unset(project):
    write_ini(project, '(Path="C:/Elsewhere")')
    assert fx_db.configured_source_directory(project) == "DreamSource/FX"
    write_ini(project, '(Path="")')
    assert fx_db.configured_source_directory(project) == "DreamSource/FX"
    write_ini(project, '(Path="Art/Effects")', section="/Script/DreamShader.DreamShaderSourceSettings")
    assert fx_db.configured_source_directory(project) == "DreamSource/FX"


@pytest.mark.parametrize("current, legacy, expected", [
    (True, False, "C"),
    (True, True, "C"),
    (False, True, "L"),
    (False, False, "C"),
])
def test_the_resolver_table(project, current, legacy, expected):
    write_ini(project, '(Path="Art/Effects")')
    c, l = project.root / "Art/Effects", project.root / "DFX"
    if current:
        c.mkdir(parents=True)
    if legacy:
        l.mkdir()
    assert fx_db.source_directory(project) == (c if expected == "C" else l)
    assert fx_db.uses_legacy_source_directory(project) == (expected == "L")


def test_plugin_source_directory(tmp_path):
    assert fx_db.plugin_source_directory(tmp_path) is None
    (tmp_path / "DFX").mkdir()
    assert fx_db.plugin_source_directory(tmp_path) == tmp_path / "DFX"
    (tmp_path / "DreamSource/FX").mkdir(parents=True)
    assert fx_db.plugin_source_directory(tmp_path) == tmp_path / "DreamSource/FX"


# -- the bridge folder -------------------------------------------------------------


def test_the_bridge_folder_follows_the_status_file(project):
    current, legacy = fx_db.bridge_dir(project), fx_db.legacy_bridge_dir(project)
    assert live.fx_bridge_dir(project) == legacy, "nothing at all: the legacy folder"

    legacy.mkdir(parents=True)
    assert live.fx_bridge_dir(project) == legacy, "only the legacy folder exists"

    current.mkdir(parents=True)
    assert live.fx_bridge_dir(project) == current, "both exist, neither live: the new one"

    write_status(legacy, project)
    assert live.fx_bridge_dir(project) == legacy, "only the legacy one is live"

    write_status(current, project)
    assert live.fx_bridge_dir(project) == current


def test_a_current_editor_is_alive_from_the_new_folder(project, monkeypatch):
    monkeypatch.setattr(live, "_process_exists", lambda pid: True)
    make_fx_db(project)
    write_status(fx_db.bridge_dir(project), project)

    status = live.read_fx_status(project)
    assert status.liveness is live.Liveness.ALIVE
    assert status.plugin_version == "2.0.0"


def test_a_persistent_database_is_not_a_running_editor(project):
    make_fx_db(project, meta={"diagnostics_updated_utc": "x"})
    fx_db.bridge_dir(project).mkdir(parents=True)
    assert live.read_fx_status(project).liveness is live.Liveness.DEAD


# -- fx.db: diagnostics ------------------------------------------------------------


DIAGNOSTICS = [
    {"file": "C:/p/DFX/B.dfs", "line": 3, "column": 4, "severity": "error",
     "code": "DFX3003", "message": "unknown input"},
    {"file": "C:/p/DFX/A.dfe", "line": 1, "column": 1, "severity": "info",
     "code": "DFX5003", "message": "left as-is"},
]


def test_diagnostics_rows_rebuild_the_old_file(project):
    make_fx_db(project, DIAGNOSTICS, meta={"diagnostics_updated_utc": "2026-11-26T01:02:03Z"})

    assert fx_db.read_diagnostics(project) == {
        "protocol": 1, "generatedUtc": "2026-11-26T01:02:03Z", "diagnostics": DIAGNOSTICS}

    found, stamp = read_published(project, "fx")
    assert stamp == "2026-11-26T01:02:03Z"
    assert [d.file for d in found] == ["C:/p/DFX/B.dfs", "C:/p/DFX/A.dfe"], "seq order kept"
    assert found[0].is_error and found[0].code == "DFX3003"


def test_a_database_that_never_held_diagnostics_reads_as_never_ran(project):
    make_fx_db(project)
    assert read_published(project, "fx") == ([], None)


def test_the_database_wins_over_a_stale_legacy_file(project):
    make_fx_db(project, meta={"diagnostics_updated_utc": "new"})
    legacy = fx_db.legacy_bridge_dir(project)
    legacy.mkdir(parents=True)
    (legacy / "diagnostics.json").write_text(json.dumps(
        {"protocol": 1, "generatedUtc": "old", "diagnostics": DIAGNOSTICS}), encoding="utf-8")

    assert read_published(project, "fx") == ([], "new")


def test_without_a_database_the_legacy_file_is_read(project):
    legacy = fx_db.legacy_bridge_dir(project)
    legacy.mkdir(parents=True)
    (legacy / "diagnostics.json").write_text(json.dumps(
        {"protocol": 1, "generatedUtc": "old", "diagnostics": DIAGNOSTICS}), encoding="utf-8")
    # A current plugin's bridge folder going live must not hide the legacy diagnostics.
    write_status(fx_db.bridge_dir(project), project)

    found, stamp = read_published(project, "fx")
    assert stamp == "old" and len(found) == 2


def test_another_diagnostics_schema_is_refused_not_guessed_at(project, monkeypatch):
    make_fx_db(project, DIAGNOSTICS, schema="2", meta={"diagnostics_updated_utc": "x"})
    with pytest.raises(fx_db.SchemaMismatch, match="Update dream-mcp or the DreamFX plugin"):
        read_published(project, "fx")

    monkeypatch.setattr(server, "_project", lambda _: project)
    report = server.dream_diagnostics("fx")
    assert "DreamFX: diagnostics cannot be read" in report and "schema '2'" in report


def test_the_reader_never_creates_a_database(project):
    assert fx_db.read_diagnostics(project) is None
    assert fx_db.read_index(fx_db.index_database_path(project.root / "DFX")) is None
    assert not fx_db.database_path(project).exists()
    assert not (project.root / "DFX").exists()


# -- .dreamfx/index.db: the module index -------------------------------------------


def test_index_rows_rebuild_the_old_file(project):
    source = project.root / "DreamSource/FX"
    path = make_index_db(source, quarantine=["/Niagara/Modules/Z", "/Niagara/Modules/Masks/ConeMask"])

    data, quarantined, meta = fx_db.read_index(path)
    assert data == {
        "version": 1, "generatedUtc": "2026-11-20T00:00:00Z", "project": "Fake",
        "inputsProbed": True, "engine": "C:/UE/Engine/", "plugins": ["Niagara", "DreamFX"],
        "searchPaths": ["/Niagara/Modules", "/Niagara/DynamicInputs"], "modules": MODULES,
    }
    assert list(data) == ["version", "generatedUtc", "project", "inputsProbed", "engine",
                          "plugins", "searchPaths", "modules"]
    assert quarantined == ["/Niagara/Modules/Masks/ConeMask", "/Niagara/Modules/Z"], "by name"
    assert meta["modules_revision"] == "1"


def test_load_reads_the_database(project):
    source = project.root / "DreamSource/FX"
    make_index_db(source, quarantine=["/Niagara/Modules/Masks/ConeMask"])
    # A legacy file beside it is older than the database and must not be read.
    write_legacy_index(source, [], quarantine=["/Old"])

    index = fx_index.load(project)
    assert fx_index.index_path(project) == index.path == source / ".dreamfx/index.db"
    assert index.from_database
    assert [m.name for m in index.modules] == ["GravityForce", "ConeMask", "RandomRangeFloat"]
    assert index.find("RandomRangeFloat").kind == "dynamicInput"
    assert index.find("gravity_force").inputs == [{"name": "Gravity"}]
    assert index.version == 1 and index.engine == "C:/UE/Engine/"
    assert index.search_paths == ["/Niagara/Modules", "/Niagara/DynamicInputs"]
    assert index.quarantined == ["/Niagara/Modules/Masks/ConeMask"]
    assert index.updated_utc == "2026-11-21T00:00:00Z"
    assert index.age_days > 0


def test_load_finds_the_database_in_a_legacy_dfx_folder(project):
    make_index_db(project.root / "DFX")
    index = fx_index.load(project)
    assert index.path == project.root / "DFX/.dreamfx/index.db"
    assert len(index.modules) == 3


def test_without_a_database_the_legacy_index_is_read(project):
    source = project.root / "DFX"
    legacy = write_legacy_index(source, MODULES, quarantine=["/B", "/A"])

    assert fx_index.index_path(project) == legacy
    index = fx_index.load(project)
    assert index.path == legacy and not index.from_database
    assert len(index.modules) == 3
    assert index.quarantined == ["/B", "/A"], "the legacy file's own order"
    assert index.search_paths == ["/Niagara/Modules"]


def test_a_database_with_no_modules_falls_back_to_the_legacy_index(project):
    source = project.root / "DFX"
    make_index_db(source, modules=[], quarantine=["/FromDb"])
    write_legacy_index(source, MODULES, quarantine=["/FromFile"])

    index = fx_index.load(project)
    assert not index.from_database
    assert len(index.modules) == 3
    assert index.quarantined == ["/FromFile", "/FromDb"]


def test_no_index_at_all_says_where_it_looked(project):
    (project.root / "DFX").mkdir()
    with pytest.raises(FileNotFoundError) as error:
        fx_index.load(project)
    message = str(error.value)
    assert ".dreamfx" in message and ".dfx-index.json" in message and "dfx.ps1 index" in message

    make_index_db(project.root / "DFX", modules=[])
    with pytest.raises(FileNotFoundError, match="holds no modules"):
        fx_index.load(project)


def test_another_index_schema_is_refused_not_guessed_at(project, monkeypatch):
    source = project.root / "DFX"
    make_index_db(source, schema="2")
    write_legacy_index(source, MODULES)
    with pytest.raises(fx_index.SchemaMismatch, match="schema '2'"):
        fx_index.load(project)

    monkeypatch.setattr(server, "_project", lambda _: project)
    assert "schema '2'" in server.dream_schema("GravityForce", lang="fx")


# -- server ------------------------------------------------------------------------


def test_a_relative_target_written_before_the_migration_still_resolves(project):
    source = project.root / "DreamSource/FX/Effects"
    source.mkdir(parents=True)
    (source / "Fire.dfs").write_text("System Fire {}", encoding="utf-8")

    for target in ("DFX/Effects/Fire.dfs", "Effects/Fire.dfs", "DreamSource/FX/Effects/Fire.dfs"):
        assert server._resolve_source_path(project, target) == (source / "Fire.dfs").resolve()


def test_status_flags_a_project_still_on_dfx(project, monkeypatch):
    monkeypatch.setattr(server, "_project", lambda _: project)
    write_legacy_index(project.root / "DFX", MODULES)

    report = server.dream_status()
    assert "DreamFX index:  3 entries" in report
    assert "legacy .dfx-index.json" in report
    assert "DFX/ is deprecated" in report
