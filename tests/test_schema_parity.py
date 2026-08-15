"""M1 gate: what this server answers must be what `dfx.ps1 schema` answers.

The facts pinned below were captured from real CLI runs on 2026-08-15 and are quoted in the
comments. If the index is regenerated against a different engine these can legitimately
change -- but they must change *together* with the CLI, and a silent divergence is the bug
this file exists to catch.

Set DREAM_MCP_TEST_PROJECT to run against a different project; the index-backed tests skip
when no index is present.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from dream_mcp.core.locate import Project, find_engine_root
from dream_mcp.fx import index as fx_index
from dream_mcp.shader import manifests as shader

#: Point this at a `.uproject` with both plugins enabled to run the index-backed tests.
#: They skip without it -- the pure-rule tests below always run.
TEST_PROJECT = os.environ.get("DREAM_MCP_TEST_PROJECT")


@pytest.fixture(scope="module")
def project() -> Project:
    if not TEST_PROJECT:
        pytest.skip("set DREAM_MCP_TEST_PROJECT to a .uproject to run these")
    uproject = Path(TEST_PROJECT)
    if not uproject.exists():
        pytest.skip(f"no project at {uproject}")
    return Project(uproject=uproject, engine_root=find_engine_root(uproject))


@pytest.fixture(scope="module")
def index(project: Project) -> fx_index.Index:
    if not fx_index.index_path(project).exists():
        pytest.skip("no .dfx-index.json; run `dfx.ps1 index`")
    return fx_index.load(project)


# -- normalisation: three different rules, and they must stay different ----------


def test_fx_normalisation_strips_spaces_and_underscores():
    assert fx_index.normalize("Loop Duration") == "loopduration"
    assert fx_index.normalize("loop_duration") == "loopduration"
    assert fx_index.normalize("LoopDuration") == "loopduration"


def test_fx_normalisation_keeps_hyphens():
    """DreamFX does not strip hyphens; DreamShader's mapping-key rule does. Collapsing the
    two would resolve names one of the compilers rejects."""
    assert fx_index.normalize("a-b") == "a-b"


def test_shader_mapping_key_strips_hyphens_too():
    # UDreamShaderSettings::NormalizeMappingKey
    assert shader.normalize_mapping_key("Clear Coat") == "clearcoat"
    assert shader.normalize_mapping_key("clear-coat") == "clearcoat"
    assert shader.normalize_mapping_key(" Clear_Coat ") == "clearcoat"


def test_shader_setting_key_strips_nothing_but_whitespace():
    # UE::DreamShader::NormalizeSettingKey -- trim and lowercase, and nothing else.
    assert shader.normalize_setting_key("  Shading Model ") == "shading model"
    assert shader.normalize_setting_key("ShadingModel") == "shadingmodel"


# -- parity with `dfx.ps1 schema` ------------------------------------------------


def test_acceleration_force_signature(index: fx_index.Index):
    """CLI, 2026-08-15:
        Module 'AccelerationForce' -> /Niagara/Modules/Update/Forces/AccelerationForce
          [as it appears in ParticleUpdate]
          2 input(s):
            Acceleration      Vector3f                 [hlsl-ok]
            CoordinateSpace   ENiagaraCoordinateSpace  [hlsl-ok]
    """
    module = index.find("AccelerationForce")
    assert module.path == "/Niagara/Modules/Update/Forces/AccelerationForce"
    assert module.probed_in == "ParticleUpdate"
    assert [i["name"] for i in module.inputs] == ["Acceleration", "CoordinateSpace"]
    assert [i["type"] for i in module.inputs] == ["Vector3f", "ENiagaraCoordinateSpace"]
    assert all(i["expressions"] for i in module.inputs), "both are [hlsl-ok]"


def test_ambiguous_name_is_refused_with_the_same_candidates(index: fx_index.Index):
    """CLI, 2026-08-15:
        'InitializeParticle' is ambiguous -- 2 modules match. Write the full path instead:
        /Niagara/Modules/Spawn/Initialization/InitializeParticle.InitializeParticle,
        /Niagara/Modules/Spawn/Initialization/V2/InitializeParticle.InitializeParticle
    """
    with pytest.raises(fx_index.Ambiguous) as caught:
        index.find("InitializeParticle")

    assert sorted(c.qualified for c in caught.value.candidates) == [
        "/Niagara/Modules/Spawn/Initialization/InitializeParticle.InitializeParticle",
        "/Niagara/Modules/Spawn/Initialization/V2/InitializeParticle.InitializeParticle",
    ]


def test_tail_path_is_anchored_at_the_end(index: fx_index.Index):
    """The whole point of the tail form: it must select the asset and not its V2 sibling."""
    module = index.find("Spawn/Initialization/InitializeParticle")
    assert module.path == "/Niagara/Modules/Spawn/Initialization/InitializeParticle"


def test_qualified_form_round_trips(index: fx_index.Index):
    """The `Path.Name` spelling the CLI prints must be accepted back as input -- otherwise
    the error message tells you to write something that does not work."""
    module = index.find(
        "/Niagara/Modules/Spawn/Initialization/V2/InitializeParticle.InitializeParticle")
    assert module.path == "/Niagara/Modules/Spawn/Initialization/V2/InitializeParticle"


def test_quarantined_module_reports_why_instead_of_lying(index: fx_index.Index):
    """ConeMask cannot be probed -- it stack-overflows the process. Reporting no inputs as
    though that meant 'takes no inputs' would be the worst possible answer."""
    module = index.find("/Niagara/Modules/Masks/ConeMask")
    assert module.inputs_unavailable
    assert "quarantined" in module.inputs_unavailable


def test_kind_filter_separates_modules_from_dynamic_inputs(index: fx_index.Index):
    """ConeMask exists four times, twice as a module and twice as a dynamic input."""
    with pytest.raises(fx_index.Ambiguous) as caught:
        index.find("ConeMask")
    kinds = {c.kind for c in caught.value.candidates}
    assert kinds == {"module", "dynamicInput"}

    with pytest.raises(fx_index.Ambiguous) as narrowed:
        index.find("ConeMask", kind="module")
    assert all(c.kind == "module" for c in narrowed.value.candidates)


def test_typo_suggests_the_real_spelling(index: fx_index.Index):
    with pytest.raises(fx_index.NotFound) as caught:
        index.find("AccelerationForc")
    assert "AccelerationForce" in caught.value.suggestions


# -- DreamShader manifests -------------------------------------------------------


def test_manifests_load(project: Project):
    manifests = shader.load(project)
    if manifests.missing:
        pytest.skip(f"manifests not written yet: {manifests.missing}")
    assert manifests.expressions
    assert any(e.name == "Abs" for e in manifests.expressions)


def test_alias_lookup_uses_the_mapping_rule(project: Project):
    manifests = shader.load(project)
    if not manifests.aliases:
        pytest.skip("no aliases")
    hits = manifests.find_alias("clearcoat", kind="ShadingModel")
    assert hits and hits[0].name == "MSM_ClearCoat", \
        "'clearcoat' must resolve the 'Clear Coat' alias -- spaces are stripped here"
