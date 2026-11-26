"""The DreamSource layout: shader.db, the new bridge folder and the source directory.

Every test here builds the database the way the plugin does -- stdlib sqlite3, the tables of
DreamShaderDatabase -- in a throwaway project, and checks that dream-mcp prefers it, falls
back to the legacy files only when it is absent, and never mistakes it for a running editor.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

import pytest

from dream_mcp import server
from dream_mcp.core import liveness as live
from dream_mcp.core import shader_db
from dream_mcp.core.diagnostics import read_published
from dream_mcp.core.locate import Project
from dream_mcp.shader import manifests as shader_manifests
from dream_mcp.shader import preview


@pytest.fixture
def project(tmp_path):
    uproject = tmp_path / "Fake.uproject"
    uproject.write_text('{"EngineAssociation": "test"}', encoding="utf-8")
    return Project(uproject=uproject, engine_root=tmp_path / "Engine")


def make_db(project: Project, schema: str = "1", meta: dict | None = None,
            documents: dict | None = None, diagnostics: dict | None = None,
            index: dict | None = None):
    path = shader_db.database_path(project)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.executescript("""
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE documents(name TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at_utc TEXT);
        CREATE TABLE diagnostics(path TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at_utc TEXT);
        CREATE TABLE source_index(root TEXT NOT NULL, path TEXT NOT NULL, json TEXT NOT NULL,
                                  updated_at_utc TEXT, PRIMARY KEY(root, path));
    """)
    rows = {"schema": schema, "producer": "DreamShader@test", **(meta or {})}
    connection.executemany("INSERT INTO meta VALUES (?, ?)", rows.items())
    for name, data in (documents or {}).items():
        connection.execute("INSERT INTO documents VALUES (?, ?, '')", (name, json.dumps(data)))
    for source, data in (diagnostics or {}).items():
        connection.execute("INSERT INTO diagnostics VALUES (?, ?, '')",
                           (source, json.dumps(data)))
    for (root, rel), data in (index or {}).items():
        connection.execute("INSERT INTO source_index VALUES (?, ?, ?, '')",
                           (root, rel, json.dumps(data)))
    connection.commit()
    connection.close()
    return path


def write_status(directory, project: Project):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "status.json").write_text(json.dumps({
        "protocol": live.PROTOCOL_VERSION, "pid": 1, "projectDir": str(project.root),
        "busy": False, "pluginVersion": "3.0.0",
        "heartbeatUtc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }), encoding="utf-8")


# -- the database ----------------------------------------------------------------


def test_documents_and_index_are_read_verbatim(project):
    make_db(project, documents={"pass-keys": {"version": 1}},
            index={("Project", "Materials/M_A.dss"): {"symbols": []}})

    assert shader_db.read_document_json(project, "pass-keys") == {"version": 1}
    assert shader_db.read_document(project, "settings") is None
    assert shader_db.read_source_index(project, "Project", "Materials\\M_A.dss") == {"symbols": []}
    assert shader_db.read_source_index(project, "MoonToon", "Materials/M_A.dss") is None
    assert shader_db.read_meta(project)["producer"] == "DreamShader@test"


def test_the_reader_never_creates_the_database(project):
    assert shader_db.read_document(project, "settings") is None
    assert not shader_db.database_path(project).exists()


def test_another_schema_is_refused_not_guessed_at(project):
    make_db(project, schema="2")
    with pytest.raises(shader_db.SchemaMismatch, match="Update dream-mcp or the DreamShader plugin"):
        shader_db.read_document(project, "settings")
    with pytest.raises(shader_db.SchemaMismatch):
        read_published(project, "shader")


def test_diagnostics_rows_rebuild_the_old_envelope(project):
    make_db(project, meta={"diagnostics_updated_utc": "2026-11-26T00:00:00Z"}, diagnostics={
        "C:/x/B.dsm": {"path": "C:/x/B.dsm", "diagnostics": [
            {"message": "boom", "line": 2, "column": 3, "severity": "error", "code": "x"}]},
        "C:/x/A.dsm": {"path": "C:/x/A.dsm", "diagnostics": []},
    })

    envelope = shader_db.read_diagnostics(project)
    assert envelope["version"] == 1
    assert envelope["updatedAtUtc"] == "2026-11-26T00:00:00Z"
    assert [f["path"] for f in envelope["files"]] == ["C:/x/A.dsm", "C:/x/B.dsm"]

    found, stamp = read_published(project, "shader")
    assert stamp == "2026-11-26T00:00:00Z"
    assert len(found) == 1 and found[0].file == "C:/x/B.dsm" and found[0].line == 2


def test_a_database_that_never_held_diagnostics_reads_as_never_ran(project):
    make_db(project)
    found, stamp = read_published(project, "shader")
    assert found == [] and stamp is None


def test_the_database_wins_over_a_stale_legacy_file(project):
    make_db(project, meta={"diagnostics_updated_utc": "new"})
    legacy = shader_db.legacy_bridge_dir(project)
    legacy.mkdir(parents=True)
    (legacy / "diagnostics.json").write_text(json.dumps(
        {"version": 1, "updatedAtUtc": "old", "files": []}), encoding="utf-8")

    assert read_published(project, "shader")[1] == "new"


def test_without_a_database_the_legacy_file_is_read(project):
    legacy = shader_db.legacy_bridge_dir(project)
    legacy.mkdir(parents=True)
    (legacy / "diagnostics.json").write_text(json.dumps(
        {"version": 1, "updatedAtUtc": "old", "files": []}), encoding="utf-8")

    assert read_published(project, "shader")[1] == "old"


def test_manifests_come_from_the_database(project):
    make_db(project, documents={
        "material-expressions": {"generatedAt": "today",
                                 "expressions": [{"name": "Abs", "className": "MaterialExpressionAbs"}]},
        "substrate-builtins": {"supported": True, "builtins": []},
        "settings": {"mappings": {"BlendMode": [{"alias": "Opaque", "value": 0}]}},
    })

    loaded = shader_manifests.load(project)
    assert loaded.directory == shader_db.database_path(project)
    assert not loaded.missing
    assert [e.name for e in loaded.expressions] == ["Abs"]
    assert loaded.aliases[0].alias == "Opaque"
    assert loaded.generated_at == "today"


def test_missing_manifests_are_named_as_documents(project):
    make_db(project, documents={"settings": {"mappings": {}}})
    loaded = shader_manifests.load(project)
    assert loaded.missing == ["material-expressions", "substrate-builtins"]


# -- the bridge folder and liveness ----------------------------------------------


def test_the_bridge_folder_follows_the_status_file(project):
    current, legacy = shader_db.bridge_dir(project), shader_db.legacy_bridge_dir(project)
    assert live.shader_bridge_dir(project) == legacy, "nothing at all: the legacy folder"

    current.mkdir(parents=True)
    assert live.shader_bridge_dir(project) == current

    write_status(legacy, project)
    assert live.shader_bridge_dir(project) == legacy, "only the legacy one is live"

    write_status(current, project)
    assert live.shader_bridge_dir(project) == current


def test_a_current_editor_is_alive_from_the_new_folder(project, monkeypatch):
    monkeypatch.setattr(live, "_process_exists", lambda pid: True)
    make_db(project)
    write_status(shader_db.bridge_dir(project), project)

    status = live.read_shader_status(project)
    assert status.liveness is live.Liveness.ALIVE
    assert status.protocol == live.PROTOCOL_VERSION


def test_a_persistent_database_is_not_a_running_editor(project):
    """shader.db outlives the editor. Reading it as the pre-M3 bridge.db would route every
    compile to an editor that is not there."""
    make_db(project)
    shader_db.bridge_dir(project).mkdir(parents=True)

    status = live.read_shader_status(project)
    assert status.liveness is live.Liveness.DEAD
    assert not any("pre-m3" in w.lower() for w in status.warnings)


def test_a_bridge_db_outside_the_legacy_folder_is_ignored(project):
    current = shader_db.bridge_dir(project)
    current.mkdir(parents=True)
    (current / "bridge.db").write_text("", encoding="utf-8")

    assert live.read_shader_status(project).liveness is live.Liveness.DEAD


# -- the source directory ----------------------------------------------------------


def write_ini(project: Project, name: str, section: str, value: str):
    config = project.root / "Config"
    config.mkdir(exist_ok=True)
    (config / name).write_text(f"[{section}]\nSourceDirectory={value}\n", encoding="utf-8")


NEW = "/Script/DreamShader.DreamShaderSourceSettings"
OLD = "/Script/DreamShader.DreamShaderSettings"


def test_the_default_source_directory(project):
    assert shader_db.configured_source_directory(project) == "DreamSource/Shader"
    assert shader_db.source_directory(project) == project.root / "DreamSource/Shader"


def test_the_new_key_in_either_spelling(project):
    write_ini(project, "DefaultDreamSource.ini", NEW, '(Path="Art/Shaders")')
    assert shader_db.configured_source_directory(project) == "Art/Shaders"
    write_ini(project, "DefaultDreamSource.ini", NEW, "Art\\Bare\\")
    assert shader_db.configured_source_directory(project) == "Art/Bare"


def test_an_absolute_or_empty_value_reads_as_unset(project):
    write_ini(project, "DefaultDreamSource.ini", NEW, '(Path="C:/Elsewhere")')
    assert shader_db.configured_source_directory(project) == "DreamSource/Shader"
    write_ini(project, "DefaultDreamSource.ini", NEW, '(Path="")')
    assert shader_db.configured_source_directory(project) == "DreamSource/Shader"


def test_the_legacy_key_applies_while_the_new_one_is_at_its_default(project):
    write_ini(project, "DefaultDreamSource.ini", NEW, '(Path="DreamSource/Shader")')
    write_ini(project, "DefaultEngine.ini", OLD, '(Path="OldShaders")')
    assert shader_db.configured_source_directory(project) == "OldShaders"

    write_ini(project, "DefaultEngine.ini", OLD, '(Path="DShader")')
    assert shader_db.configured_source_directory(project) == "DreamSource/Shader", \
        "the legacy key at its own old default is no configuration"


def test_a_project_still_on_dshader_uses_it_until_it_migrates(project):
    (project.root / "DShader").mkdir()
    assert shader_db.source_directory(project) == project.root / "DShader"
    (project.root / "DreamSource/Shader").mkdir(parents=True)
    assert shader_db.source_directory(project) == project.root / "DreamSource/Shader"


def test_plugin_source_directory(tmp_path):
    assert shader_db.plugin_source_directory(tmp_path) is None
    (tmp_path / "DShader").mkdir()
    assert shader_db.plugin_source_directory(tmp_path) == tmp_path / "DShader"
    (tmp_path / "DreamSource/Shader").mkdir(parents=True)
    assert shader_db.plugin_source_directory(tmp_path) == tmp_path / "DreamSource/Shader"


def test_a_relative_shader_path_resolves_in_the_source_directory(project):
    sources = project.root / "DreamSource/Shader/Materials"
    sources.mkdir(parents=True)
    (sources / "M_A.dsm").write_text("", encoding="utf-8")

    assert server._resolve_source_path(project, "Materials/M_A.dsm") == (sources / "M_A.dsm").resolve()
    assert server._resolve_source_path(project, "DreamSource/Shader/Materials/M_A.dsm") \
        == (sources / "M_A.dsm").resolve()
    missing = server._resolve_source_path(project, "Materials/Nope.dsm")
    assert missing == (project.root / "Materials/Nope.dsm").resolve(), \
        "a file that is nowhere is reported against the project root"


# -- preview -------------------------------------------------------------------------


def test_preview_result_comes_from_the_database(project):
    make_db(project, documents={"preview": {"requestId": "theirs", "status": "ready"}})
    shader_db.bridge_dir(project).mkdir(parents=True)

    with pytest.raises(preview.PreviewFailed, match="something else rendered"):
        preview._read_preview_json(project, "mine")
    assert preview._read_preview_json(project, "theirs")["status"] == "ready"
    assert preview._preview_dir(project) == shader_db.preview_dir(project)


def test_a_missing_preview_document_is_a_clear_failure(project):
    make_db(project)
    shader_db.bridge_dir(project).mkdir(parents=True)
    with pytest.raises(preview.PreviewFailed, match="no 'preview' document"):
        preview._read_preview_json(project, "mine")
