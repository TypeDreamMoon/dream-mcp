"""Rendering a material and handing the picture back.

This is the one capability with no cold fallback. The commandlet runs `-nullrhi`, so there
is no GPU to render with when the editor is closed; "open the editor" is the only answer,
and saying so plainly beats a fallback that returns something worthless.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

from ..core.liveness import shader_bridge_dir
from ..core.locate import Project
from . import preview_ws

#: Compared case-insensitively by the editor; anything else silently becomes `sphere`.
#: Validated here instead so a typo is a message rather than a surprising picture.
MESHES = ("plane", "cube", "cylinder", "shaderball", "sphere")

MIN_SIZE, MAX_SIZE = 64, 2048


class PreviewFailed(Exception):
    pass


@dataclass
class Preview:
    image: Path
    asset_path: str
    mesh: str
    message: str
    duration_ms: int
    notes: list[str]


def render(project: Project,
           source_file: Path,
           mesh: str = "sphere",
           width: int = 512,
           height: int = 512,
           timeout: float = 180.0) -> Preview:
    started = time.monotonic()
    if source_file.suffix.lower() != ".dsm":
        raise PreviewFailed(
            f"Only a .dsm renders a preview; '{source_file.name}' is not one. A .dsf is a "
            f"function with no material to draw, and a .dsh generates nothing at all."
        )

    wanted = mesh.strip().lower() or "sphere"
    if wanted not in MESHES:
        raise PreviewFailed(
            f"'{mesh}' is not a preview mesh. Choose one of: {', '.join(MESHES)}. "
            f"(The editor would silently fall back to a sphere rather than tell you.)"
        )

    for name, value in (("width", width), ("height", height)):
        if not MIN_SIZE <= value <= MAX_SIZE:
            raise PreviewFailed(
                f"{name}={value} is outside [{MIN_SIZE}, {MAX_SIZE}]; the editor clamps "
                f"silently, so the picture would not be the size you asked for."
            )

    # Over the socket, not the request file. The file transport reaches the same renderer
    # but returns its first frame, which is the engine's default material and not yours --
    # see preview_ws for the measurement. This also keeps `preview.json` out of it.
    try:
        result, png = preview_ws.render(
            str(source_file).replace("\\", "/"),
            mesh=wanted, width=width, height=height, timeout=timeout,
        )
    except preview_ws.PreviewSocketError as error:
        raise PreviewFailed(str(error)) from error

    image = _cache_frame(project, source_file, png)

    notes: list[str] = []
    resolved = str(result.get("mesh", wanted)).lower()
    if resolved != wanted:
        # A UI-domain material is always drawn on a plane whatever you ask for.
        notes.append(f"Rendered on a {resolved}, not the {wanted} that was requested.")
    notes.extend(_legibility_notes(source_file))

    return Preview(
        image=image,
        asset_path=str(result.get("assetPath", "")),
        mesh=resolved,
        message=str(result.get("message", "")),
        duration_ms=int((time.monotonic() - started) * 1000),
        notes=notes,
    )


def _cache_frame(project: Project, source_file: Path, png: bytes) -> Path:
    """Put the bytes somewhere the MCP layer can hand back as an image.

    Named after the source and written under the bridge's own Preview directory, so it sits
    with the plugin's own renders and gets cleaned up the same way. One file per source, as
    the plugin does -- a preview is a current view, not a history.
    """
    directory = shader_bridge_dir(project) / "Preview"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{source_file.stem}-mcp.png"
    path.write_bytes(png)
    return path


#: Blend modes whose output is a *contribution* to what is behind them rather than a
#: replacement for it. The preview draws against a dark checkerboard, so one of these with a
#: quiet emissive is nearly invisible -- correctly.
_SEE_THROUGH = {
    "additive": "adds to the background rather than replacing it",
    "translucent": "blends with the background",
    "modulate": "multiplies the background",
    "alphacomposite": "blends with the background",
    "alphaholdout": "cuts out of the background",
}

_SETTING = r'{key}\s*=\s*"([^"]+)"'


def _legibility_notes(source_file: Path) -> list[str]:
    """Say when a dark or empty-looking picture is the correct answer.

    Written after an Additive Unlit portal rendered as what looked like a bare checkerboard,
    to say that such a picture can be correct.

    **It was not correct in that case.** 2026-08-16: the same material over the streaming
    path shows a bright glow by frame 2, and the empty picture was the one-shot path
    capturing frame 0 before the material was bound (see the README's known-broken note).
    The note below is true in general and wrong about that instance -- which is exactly how
    a plausible explanation suppresses a real bug. Keep it, because an additive material
    genuinely can look like nothing; but never read it as evidence that nothing is wrong.
    """
    # Reads the first match in the whole file rather than scoping to a block, which is safe
    # because a valid .dsm declares exactly one Shader -- two is a parse error, and the only
    # file in the corpus with two is the fixture that proves it (T_TwoShaders.bad.dsm).
    # Such a file fails to compile long before anything asks it for a preview.
    import re

    try:
        text = source_file.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []

    def setting(key: str) -> str | None:
        found = re.search(_SETTING.format(key=key), text, re.IGNORECASE)
        return found.group(1).strip().lower() if found else None

    notes: list[str] = []
    blend = setting("BlendMode")
    if blend:
        # Normalised the way DreamShader normalises an enum alias, so "Alpha Composite"
        # and "alphacomposite" reach the same entry.
        key = blend.replace(" ", "").replace("_", "").replace("-", "")
        if key in _SEE_THROUGH:
            notes.append(
                f"BlendMode is {blend} -- it {_SEE_THROUGH[key]}, so against the preview's "
                f"dark checkerboard a quiet material looks like nothing was drawn. An empty "
                f"picture here is not by itself evidence of a problem."
            )

    if setting("ShadingModel") == "unlit":
        notes.append("ShadingModel is Unlit, so the preview's lights do not affect it; "
                     "everything visible comes from Emissive.")

    domain = setting("Domain")
    if domain and domain not in ("surface", ""):
        notes.append(f"Domain is {domain}; the preview draws it as a surface, which is not "
                     f"how it will look in use.")

    return notes


def _read_preview_json(project: Project, request_id: str) -> dict:
    """Read the result, and refuse one that belongs to somebody else.

    `preview.json` is a single file that every preview overwrites, whichever transport asked
    for it -- the WebSocket panel and the VSCode extension write it too. Without checking the
    echoed id, a preview racing another one hands back the wrong picture, which is the kind
    of wrong answer that looks completely plausible.
    """
    path = shader_bridge_dir(project) / "preview.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise PreviewFailed(f"Could not read preview.json: {error}") from error

    echoed = str(data.get("requestId", ""))
    if request_id and echoed and echoed != request_id:
        raise PreviewFailed(
            f"preview.json holds result '{echoed}', not '{request_id}' -- something else "
            f"rendered a preview at the same time. Retry."
        )
    return data
