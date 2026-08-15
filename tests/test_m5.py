"""M5: the expression-name rule, the published-diagnostics reader, and the write report."""

from __future__ import annotations

import json
import os
import time

import pytest

from dream_mcp.core import assets
from dream_mcp.core.diagnostics import read_published
from dream_mcp.core.locate import Project
from dream_mcp.shader import manifests as shader


@pytest.fixture
def project(tmp_path):
    uproject = tmp_path / "Fake.uproject"
    uproject.write_text('{"EngineAssociation": "test"}', encoding="utf-8")
    (tmp_path / "Saved/DreamFX/Bridge").mkdir(parents=True)
    (tmp_path / "Saved/DreamShader/Bridge").mkdir(parents=True)
    return Project(uproject=uproject, engine_root=tmp_path / "Engine")


# -- the fourth matching rule ----------------------------------------------------


def test_expression_candidates_match_the_engine_order():
    assert shader.expression_class_candidates("Abs") == [
        "Abs", "UAbs", "MaterialExpressionAbs", "UMaterialExpressionAbs"]


def test_already_prefixed_names_are_not_prefixed_again():
    """UE's FString::StartsWith is case-insensitive by default, so a lowercase spelling
    counts as already prefixed. Python's startswith is not, which is the trap.

    The engine's three guards are independent ifs, not a chain, so a name can skip one and
    still pick up another -- which is why the lists below are not simply shorter.
    """
    assert shader.expression_class_candidates("materialexpressionabs") == [
        "materialexpressionabs",
        "Umaterialexpressionabs",
        "UMaterialExpressionmaterialexpressionabs",
    ]
    assert shader.expression_class_candidates("UMaterialExpressionAbs") == [
        "UMaterialExpressionAbs",
        "MaterialExpressionUMaterialExpressionAbs",
    ]


def _manifests(expressions):
    return shader.Manifests(
        directory=None, generated_at=None, expressions=expressions, builtins=[],
        aliases=[], substrate_supported=True, substrate_unsupported_reason=None)


ABS = shader.Expression(name="Abs", class_name="MaterialExpressionAbs",
                        path_name="/Script/Engine.MaterialExpressionAbs",
                        default_output_type="float1")


@pytest.mark.parametrize("written", ["Abs", "abs", "MaterialExpressionAbs",
                                     "materialexpressionabs"])
def test_spellings_the_compiler_accepts_resolve(written):
    """Measured against the real compiler on 2026-08-15: `Abs` and `MaterialExpressionAbs`
    both get past class resolution (they fail later, on unrelated source syntax)."""
    assert _manifests([ABS]).find_expression(written) == [ABS]


def test_the_u_prefixed_spelling_does_not_resolve():
    """Also measured: `UE.Expression(Class="UMaterialExpressionAbs")` fails with
    "could not resolve MaterialExpression class 'UMaterialExpressionAbs'". UClass::GetName()
    carries no U prefix, so nothing can match it. Resolving it here would promise something
    the compiler then refuses.
    """
    assert _manifests([ABS]).find_expression("UMaterialExpressionAbs") == []


# -- published diagnostics -------------------------------------------------------


def test_fx_diagnostics_are_read_flat(project):
    (project.saved / "DreamFX/Bridge/diagnostics.json").write_text(json.dumps({
        "protocol": 1, "generatedUtc": "2026-08-15T00:00:00Z",
        "diagnostics": [{"file": "a.dfe", "line": 3, "column": 4,
                         "severity": "warning", "code": "DFX5099", "message": "x"}],
    }), encoding="utf-8")

    found, stamp = read_published(project, "fx")
    assert stamp == "2026-08-15T00:00:00Z"
    assert found[0].file == "a.dfe" and found[0].code == "DFX5099"
    assert not found[0].is_error, "a warning must not be counted as an error"


def test_shader_diagnostics_take_the_path_from_their_group(project):
    """DreamShader groups by file and puts the path on the group, not on each diagnostic.
    Reading it like DreamFX's flat array would produce entries with no location at all."""
    (project.saved / "DreamShader/Bridge/diagnostics.json").write_text(json.dumps({
        "version": 1, "updatedAtUtc": "2026-08-15T00:00:00Z",
        "files": [{"path": "C:/x/M.dsm",
                   "diagnostics": [{"message": "boom", "line": 2, "column": 1,
                                    "severity": "error", "code": "generate-error"}]}],
    }), encoding="utf-8")

    found, stamp = read_published(project, "shader")
    assert stamp == "2026-08-15T00:00:00Z"
    assert found[0].file == "C:/x/M.dsm" and found[0].is_error


def test_a_missing_file_is_not_an_empty_result(project):
    """'No diagnostics' and 'never ran' are different answers, and conflating them reports a
    project that has never compiled as clean."""
    found, stamp = read_published(project, "fx")
    assert found == [] and stamp is None


# -- the write report ------------------------------------------------------------


def test_only_assets_newer_than_the_floor_are_reported(project):
    content = project.root / "Content"
    content.mkdir()
    old, new = content / "Old.uasset", content / "New.uasset"
    old.write_bytes(b"x")
    os.utime(old, (time.time() - 3600, time.time() - 3600))

    floor = assets.floor_now()
    time.sleep(0.01)
    new.write_bytes(b"y")

    changed = assets.changed_since(project, floor)
    assert changed.paths == ["Content/New.uasset"]
    assert changed.scanned == 2, "both are scanned; only one is reported"


def test_the_report_says_it_cannot_attribute_writes(project):
    """It reports what changed in a time window, which is not the same claim as what this
    request wrote -- an autosave lands in it too. The wording has to carry that."""
    (project.root / "Content").mkdir()
    (project.root / "Content/A.uasset").write_bytes(b"x")

    text = assets.changed_since(project, assets.floor_now()).describe()
    assert "during this run" in text
    assert "Anything else writing during the window" in text
