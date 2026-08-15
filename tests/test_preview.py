"""M4: the preview's refusals and its notes.

The render itself needs a GPU and a live editor and is verified by looking at the picture.
What is testable here is everything around it -- the validation that stops a silently wrong
result, and the notes that stop a correct result from being misread.
"""

from __future__ import annotations

import json

import pytest

from dream_mcp.core.locate import Project
from dream_mcp.shader import preview


@pytest.fixture
def project(tmp_path):
    uproject = tmp_path / "Fake.uproject"
    uproject.write_text('{"EngineAssociation": "test"}', encoding="utf-8")
    (tmp_path / "Saved/DreamShader/Bridge").mkdir(parents=True)
    return Project(uproject=uproject, engine_root=tmp_path / "Engine")


def write_source(project: Project, name: str, body: str):
    path = project.root / name
    path.write_text(body, encoding="utf-8")
    return path


# -- refusals --------------------------------------------------------------------


def test_only_dsm_renders(project):
    path = write_source(project, "Lib.dsf", "Function()\n{\n}\n")
    with pytest.raises(preview.PreviewFailed, match="Only a .dsm"):
        preview.render(project, path)


def test_unknown_mesh_is_refused_not_silently_substituted(project):
    """The editor falls back to a sphere without saying so, which means asking for a
    'shaderbal' returns a real picture of the wrong thing."""
    path = write_source(project, "M.dsm", 'Shader(Name = "M")\n{\n}\n')
    with pytest.raises(preview.PreviewFailed, match="not a preview mesh"):
        preview.render(project, path, mesh="shaderbal")


@pytest.mark.parametrize("width,height", [(32, 512), (512, 4096), (0, 0)])
def test_out_of_range_sizes_are_refused(project, width, height):
    """The editor clamps to [64, 2048] silently, so the returned image would not be the
    size that was asked for and nothing would say so."""
    path = write_source(project, "M.dsm", 'Shader(Name = "M")\n{\n}\n')
    with pytest.raises(preview.PreviewFailed, match="outside"):
        preview.render(project, path, width=width, height=height)


# -- correlation -----------------------------------------------------------------


def test_a_preview_json_from_another_request_is_refused(project):
    """One file, overwritten by every preview from every transport. Reading it without
    checking whose result it holds returns the wrong picture, convincingly."""
    (project.saved / "DreamShader/Bridge/preview.json").write_text(
        json.dumps({"requestId": "somebody-else", "status": "ready"}), encoding="utf-8")

    with pytest.raises(preview.PreviewFailed, match="something else rendered"):
        preview._read_preview_json(project, "mine")


def test_an_unstamped_preview_json_is_accepted(project):
    """A result with no id cannot be proven to be someone else's, and the WebSocket panel
    writes one without an id. Refusing it would break the common single-client case."""
    (project.saved / "DreamShader/Bridge/preview.json").write_text(
        json.dumps({"status": "ready", "imagePath": "x.png"}), encoding="utf-8")

    assert preview._read_preview_json(project, "mine")["status"] == "ready"


# -- legibility notes ------------------------------------------------------------


def test_additive_says_an_empty_picture_may_be_correct(project):
    """The finding that produced this file: an Additive Unlit portal rendered as what looked
    like a bare checkerboard, and reading that as a broken renderer is the obvious mistake.
    Measured against the background, the geometry was there."""
    path = write_source(project, "M.dsm", '''Shader(Name = "M")
{
    Settings
    {
        Domain = "Surface";
        ShadingModel = "Unlit";
        BlendMode = "Additive";
    }
}
''')
    notes = preview._legibility_notes(path)
    assert any("not by itself evidence of a problem" in n for n in notes)
    assert any("Unlit" in n for n in notes)


def test_opaque_lit_material_gets_no_noise(project):
    """Notes have to stay rare to stay read."""
    path = write_source(project, "M.dsm", '''Shader(Name = "M")
{
    Settings
    {
        Domain = "Surface";
        ShadingModel = "DefaultLit";
        BlendMode = "Opaque";
    }
}
''')
    assert preview._legibility_notes(path) == []


@pytest.mark.parametrize("written", ["Alpha Composite", "alpha_composite", "AlphaComposite"])
def test_blend_alias_spellings_all_resolve(project, written):
    """Matched on DreamShader's own mapping-key rule -- trim, lowercase, drop spaces,
    underscores and hyphens -- so an alias the compiler accepts is one this recognises."""
    path = write_source(project, "M.dsm",
                        f'Shader(Name = "M")\n{{\n  Settings {{ BlendMode = "{written}"; }}\n}}\n')
    assert any("blends with the background" in n for n in preview._legibility_notes(path))


def test_non_surface_domain_is_called_out(project):
    path = write_source(project, "M.dsm",
                        'Shader(Name = "M")\n{\n  Settings { Domain = "UI"; }\n}\n')
    assert any("Domain is ui" in n for n in preview._legibility_notes(path))
