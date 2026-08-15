"""dream-mcp -- the MCP surface for DreamFX and DreamShader.

Phase M0 (liveness) and M1 (the disk knowledge face). Neither tool here touches the bridge
or starts an editor: `dream_status` reads one status file, `dream_schema` reads cached
manifests. The build/verify routing that needs the bridge is phase M2.

Tool count is capped at six by the plan. A tool schema is resident context in every session,
where a SKILL.md is loaded on demand -- that is the one place MCP loses to the existing
skills, and adding narrow tools is how it would lose badly.
"""

from __future__ import annotations

from pathlib import Path

from mcp.server.fastmcp import FastMCP, Image

from .core import assets, cli, liveness as live, routing, transport
from .core.diagnostics import read_published, summarize
from .core.locate import LocateError, Project, resolve
from .fx import index as fx_index
from .shader import manifests as shader_manifests, preview as shader_preview

mcp = FastMCP("dream")


def _project(project_dir: str | None) -> Project:
    return resolve(project_dir=project_dir)


def _bullets(items: list[str], prefix: str = "  - ") -> str:
    return "\n".join(prefix + item for item in items)


# ---------------------------------------------------------------- dream_status


@mcp.tool()
def dream_status(project_dir: str | None = None) -> str:
    """Report whether a warm Unreal editor is available for DreamFX / DreamShader work.

    Use this before any build or compile: a live editor serves requests in the time the work
    takes, while the CLI pays a 12-24 s engine boot, and running the CLI while an editor
    holds the same packages open causes a silent double-write where the later save wins.

    Also reports the cached module index and manifests that dream_schema reads.
    """
    try:
        project = _project(project_dir)
    except LocateError as error:
        return f"Could not locate the project: {error}"

    lines = [
        f"project:  {project.uproject}",
        f"engine:   {project.engine_root}",
        "",
    ]

    fx = live.read_fx_status(project)
    lines.append(f"DreamFX bridge:      {fx.liveness.value.upper()} -- {fx.detail}")
    if fx.pid:
        lines.append(f"  pid {fx.pid}, protocol {fx.protocol}, plugin {fx.plugin_version}")
    if fx.heartbeat_age_seconds is not None:
        lines.append(f"  heartbeat {fx.heartbeat_age_seconds:.1f}s ago")
    if fx.last_result:
        lines.append(f"  last result: {fx.last_result}")
    for warning in fx.warnings:
        lines.append(f"  ! {warning}")

    sh = live.read_shader_status(project)
    lines.append(f"DreamShader bridge:  {sh.liveness.value.upper()} -- {sh.detail}")
    for warning in sh.warnings:
        lines.append(f"  ! {warning}")

    lines.append("")
    lines.append("Knowledge face (read by dream_schema, no editor needed):")

    try:
        index = fx_index.load(project)
        modules = sum(1 for m in index.modules if m.kind == "module")
        dynamic = sum(1 for m in index.modules if m.kind == "dynamicInput")
        lines.append(
            f"  DFX index:  {len(index.modules)} entries "
            f"({modules} modules, {dynamic} dynamic inputs), "
            f"generated {index.generated_utc}, {index.age_days:.0f}d old"
        )
        for warning in index.freshness_warnings(project):
            lines.append(f"  ! {warning}")
    except (FileNotFoundError, OSError, ValueError) as error:
        lines.append(f"  DFX index:  unavailable -- {error}")

    manifests = shader_manifests.load(project)
    if manifests.missing:
        lines.append(f"  DShader manifests: missing {', '.join(manifests.missing)} "
                     f"-- open the editor once to write them")
    else:
        lines.append(
            f"  DShader manifests: {len(manifests.expressions)} expressions, "
            f"{len(manifests.builtins)} Substrate builtins, {len(manifests.aliases)} enum "
            f"aliases, generated {manifests.generated_at}"
        )
    if not manifests.substrate_supported and manifests.substrate_unsupported_reason:
        lines.append(f"  ! {manifests.substrate_unsupported_reason}")

    lines.append("")
    for lang, label in (("fx", "DreamFX"), ("shader", "DreamShader")):
        decision = routing.decide(project, lang)
        lines.append(f"Routing {label}: {decision.route.value.upper()} "
                     f"-- {decision.reason}")

    return "\n".join(lines)


# ---------------------------------------------------------------- dream_schema


def _format_fx(module: fx_index.Module) -> str:
    lines = [
        f"{module.name}  [{module.kind}]",
        f"  path:     {module.path}",
    ]
    if module.category:
        lines.append(f"  category: {module.category}")
    if module.stacks:
        lines.append(f"  stacks:   {', '.join(module.stacks)}")
    if module.probed_in:
        lines.append(f"  probed in: {module.probed_in}")
    if module.description:
        lines.append(f"  {module.description}")

    if module.inputs_unavailable:
        lines.append("")
        lines.append(f"  INPUTS UNAVAILABLE -- {module.inputs_unavailable}")
        return "\n".join(lines)

    lines.append("")
    lines.append("  inputs:")
    for item in module.inputs or []:
        row = f"    {item['name']} : {item.get('type', '?')}"
        if item.get("enum"):
            row += f"  = {' | '.join(item['enum'])}"
        # The CLI prints this as [hlsl-ok]; it means the input accepts an expression and
        # not only a literal, which decides how you can write the value.
        if not item.get("expressions", False):
            row += "  [literal only]"
        lines.append(row)
        if item.get("description"):
            lines.append(f"        {item['description']}")
    if not module.inputs:
        lines.append("    (none)")

    lines.append("")
    lines.append("  Write these without spaces or underscores in source: matching is on a "
                 "normalised form (lowercase, spaces and underscores removed), so a real "
                 "input named 'Loop Duration' is written LoopDuration.")
    return "\n".join(lines)


def _format_expression(expression: shader_manifests.Expression) -> str:
    lines = [
        f"{expression.name}  [{expression.class_name}]",
        f"  default output: {expression.default_output_type}",
    ]
    if expression.inputs:
        lines.append("  inputs:")
        for item in expression.inputs:
            lines.append(f"    {item.get('name')} : {item.get('type', '?')}")
    if expression.outputs:
        lines.append("  outputs:")
        for item in expression.outputs:
            lines.append(f"    [{item.get('index')}] {item.get('name')} : "
                         f"{item.get('outputType')} ({item.get('componentCount')} comp)")
    return "\n".join(lines)


def _format_builtin(builtin: shader_manifests.Builtin) -> str:
    lines = [f"{builtin.qualified_name}  -> {builtin.output_type}"]
    if builtin.detail:
        lines.append(f"  {builtin.detail}")
    if builtin.parameters:
        lines.append("  parameters:")
        for item in builtin.parameters:
            lines.append(f"    {item.get('qualifier', 'in')} {item.get('type')} "
                         f"{item.get('name')}")
    if builtin.example:
        lines.append(f"  example: {builtin.example}")
    return "\n".join(lines)


@mcp.tool()
def dream_schema(name: str,
                 lang: str = "auto",
                 kind: str | None = None,
                 project_dir: str | None = None) -> str:
    """Look up the real signature of a DreamFX module / dynamic input, or a DreamShader
    material expression, Substrate builtin or enum alias.

    Reads cached manifests off disk -- no editor, no bridge, milliseconds. Use it instead of
    guessing an input name or reading one off a design document: modules get revised, and a
    wrong name fails the build with DFX3003.

    name:  a bare name (GravityForce), a full path, or any tail of one
           (Spawn/Initialization/InitializeParticle -- anchored at the end, so it selects
           that asset and not its V2/ sibling). Ambiguous short names are refused with the
           full candidate list rather than resolved arbitrarily.
    lang:  "fx", "shader", or "auto" to try DreamFX first and fall back to DreamShader.
    kind:  optional filter -- "module" or "dynamicInput" for fx.
    """
    try:
        project = _project(project_dir)
    except LocateError as error:
        return f"Could not locate the project: {error}"

    want = lang.strip().lower()
    sections: list[str] = []

    if want in ("fx", "auto"):
        try:
            index = fx_index.load(project)
        except (FileNotFoundError, OSError, ValueError) as error:
            if want == "fx":
                return str(error)
            sections.append(f"[DreamFX index unavailable: {error}]")
        else:
            try:
                module = index.find(name, kind=kind)
            except fx_index.Ambiguous as error:
                return str(error)
            except fx_index.NotFound as error:
                if want == "fx":
                    hits = index.search(name, kind=kind)
                    if hits:
                        listing = _bullets([f"{m.name}  ({m.kind})  {m.path}" for m in hits])
                        return f"{error}\n\nEntries whose name or path contains it:\n{listing}"
                    return str(error)
            else:
                body = _format_fx(module)
                warnings = index.freshness_warnings(project, include_quarantine=False)
                if warnings:
                    body += "\n\n" + _bullets([f"! {w}" for w in warnings], "  ")
                return body

    if want in ("shader", "auto"):
        manifests = shader_manifests.load(project)
        if manifests.missing and want == "shader":
            return (f"DreamShader manifests are missing ({', '.join(manifests.missing)}). "
                    f"Open the project in the editor once -- the bridge writes them at "
                    f"startup.")

        expressions = manifests.find_expression(name)
        builtins = manifests.find_builtin(name)
        aliases = manifests.find_alias(name)

        if len(expressions) == 1 and not builtins:
            return _format_expression(expressions[0])
        if len(builtins) == 1 and not expressions:
            return _format_builtin(builtins[0])

        if expressions or builtins or aliases:
            parts = []
            if expressions:
                parts.append("material expressions:\n" +
                             _bullets([e.name for e in expressions]))
            if builtins:
                parts.append("Substrate builtins:\n" +
                             _bullets([b.qualified_name for b in builtins]))
            if aliases:
                parts.append("enum aliases:\n" + _bullets(
                    [f"{a.kind}: '{a.alias}' = {a.name} ({a.value}, {a.source})"
                     for a in aliases]))
            sections.append(f"'{name}' matches several things in DreamShader:\n\n"
                            + "\n\n".join(parts))
        elif want == "shader":
            return f"Nothing in the DreamShader manifests matches '{name}'."

    if sections:
        return "\n\n".join(sections)
    return (f"'{name}' was not found in the DreamFX module index or the DreamShader "
            f"manifests. Check dream_status for whether either is present and current.")


# ---------------------------------------------------------------- build / verify


def _resolve_target(project: Project, target: str) -> tuple[str, Path | None]:
    """Returns (lang, absolute path) -- path is None for a whole-tree run."""
    if target.strip().lower() in ("all", "-all", "*"):
        return "", None

    path = Path(target)
    if not path.is_absolute():
        path = (project.root / path).resolve()
    if not path.exists():
        raise FileNotFoundError(f"No such source file: '{path}'.")
    return routing.language_for(str(path)) or "", path


def _report(header: str, decision: routing.Decision, lines: list[str]) -> str:
    body = [header, f"  route: {decision.route.value} ({decision.reason})", ""]
    body.extend(lines)
    return "\n".join(body)


def _run(verify_only: bool, target: str, lang: str, project_dir: str | None,
         report_writes: bool = False) -> str:
    try:
        project = _project(project_dir)
    except LocateError as error:
        return f"Could not locate the project: {error}"

    try:
        detected, path = _resolve_target(project, target)
    except FileNotFoundError as error:
        return str(error)

    resolved = (lang if lang and lang != "auto" else detected)
    if not resolved:
        return (f"Cannot tell which plugin '{target}' belongs to. Pass lang=\"fx\" or "
                f"lang=\"shader\" (.dfs/.dfe/.dfm are DreamFX; .dsm/.dsf are DreamShader).")

    action = "verify" if verify_only else "build"
    decision = routing.decide(project, resolved)
    header = f"{action} {target}  [{resolved}]"

    if decision.route is routing.Route.REFUSE:
        return _report(header, decision, [decision.reason])

    # Taken before anything runs. Verify writes nothing, so asking there would spend two
    # seconds proving it.
    floor = assets.floor_now() if (report_writes and not verify_only) else None

    if decision.route is routing.Route.BRIDGE:
        try:
            if resolved == "fx":
                reply = (transport.send(project, action, scope="all") if path is None
                         else transport.send(project, action, sourceFile=str(path)))
            else:
                reply = transport.send_shader(project, path)
        except transport.BridgeUnavailable as error:
            # The editor stopped being usable between deciding and sending. Whether that
            # permits a cold retry depends entirely on *why*: a closed editor holds nothing,
            # but a hung one or a protocol-mismatched one is still holding every package it
            # has open, and retrying cold there is the double-write in a different costume.
            # So re-decide rather than assume, and refuse if the answer is not CLI.
            again = routing.decide(project, resolved)
            if again.route is not routing.Route.CLI:
                return _report(header, again, [
                    f"The bridge stopped being usable mid-request: {error}",
                    again.reason if again.route is routing.Route.REFUSE else
                    "Retry once the editor settles.",
                ])
            decision = routing.Decision(routing.Route.CLI,
                                        f"bridge became unavailable ({error})",
                                        again.status)
        except TimeoutError as error:
            return _report(header, decision, [str(error)])
        else:
            lines = [f"{'OK' if reply.ok else 'FAILED'} in {reply.duration_ms} ms",
                     reply.message]
            if reply.inferred:
                lines.append(
                    "This result is INFERRED -- the editor is running a DreamShader build "
                    "older than the M3 bridge, which sends no reply, so completion was read "
                    "off the diagnostics timestamp. Rebuild the plugin.")
            if resolved == "shader":
                lines.append(
                    "The editor generates in memory: no .uasset was written. Use the CLI "
                    "path (close the editor) when you need assets on disk.")
            if path is None and resolved == "fx":
                lines.append(
                    "A whole-tree request is QUEUED, not completed -- the editor drains it "
                    "across ticks and reports the outcome itself. This is not a result.")
            if reply.diagnostics:
                lines.append("")
                lines.append(summarize(reply.diagnostics))
                lines.extend(f"  {d}" for d in reply.diagnostics)
            if floor is not None:
                lines.append("")
                lines.append(assets.changed_since(project, floor).describe())
            return _report(header, decision, lines)

    # -- cold path
    if resolved == "fx":
        command = "verify" if verify_only else "build"
        flags = ["-Force"] if not verify_only else []
    else:
        if verify_only:
            return _report(header, decision, [
                "DreamShader has no write-free compile in the commandlet, so there is no "
                "way to verify a .dsm without writing assets while the editor is closed. "
                "Open the editor and re-run: the in-editor path generates in memory."])
        command, flags = "compile", ["-Force"]

    result = cli.run(project, resolved, command,
                     target=None if path is None else str(path),
                     flags=(flags + (["-All"] if path is None else [])))

    lines = [f"{'OK' if result.ok else 'FAILED'} (exit {result.exit_code})", result.message]
    if result.diagnostics:
        lines.append("")
        lines.append(summarize(result.diagnostics))
        lines.extend(f"  {d}" for d in result.diagnostics)
    if floor is not None:
        lines.append("")
        lines.append(assets.changed_since(project, floor).describe())
    return _report(header, decision, lines)


@mcp.tool()
def dream_build(target: str, lang: str = "auto", project_dir: str | None = None,
                report_writes: bool = False) -> str:
    """Generate Unreal assets from a DreamFX or DreamShader source file.

    Routes to a running editor when one is there, which costs what the work costs instead of
    the work plus a 12-24 s engine boot, and removes the second writer entirely -- the
    silent double-write where two processes save the same package and the later one wins.
    Falls back to the CLI when no editor is running, and REFUSES when the editor is hung,
    because that is the one state where both paths are unsafe.

    target: a source file (absolute, or relative to the project root), or "all".
            "all" through a live editor is QUEUED, not completed -- it returns immediately.
    lang:   "auto" reads the extension (.dfs/.dfe/.dfm = fx, .dsm/.dsf = shader).
    report_writes: also list which .uasset files changed on disk. Off by default because it
            costs a full scan of Content/ and Plugins/ -- about two seconds here, against a
            warm build that finishes in half of one. Ask for it when what moved matters.
    """
    return _run(False, target, lang, project_dir, report_writes)


@mcp.tool()
def dream_verify(target: str, lang: str = "auto", project_dir: str | None = None) -> str:
    """Check a source against its generated asset without writing anything.

    This is the drift gate: it catches the case nobody notices, where someone edited a
    source, did not rebuild, and committed both. A build alone passes, because a build fixes
    it. Same routing as dream_build.
    """
    return _run(True, target, lang, project_dir)


# ---------------------------------------------------------------- diagnostics


@mcp.tool()
def dream_diagnostics(lang: str = "both", project_dir: str | None = None) -> str:
    """Show what the editor currently believes is wrong, without compiling anything.

    Both bridges republish their findings to `diagnostics.json` after every run, so this
    reads the last result for free -- useful when someone else's compile produced the
    errors, when a response was already consumed, or just to see the standing state before
    deciding what to rebuild.

    lang: "fx", "shader", or "both".

    Not a substitute for dream_build: this reports the last run, not the current source. A
    file edited since then is not represented here.
    """
    try:
        project = _project(project_dir)
    except LocateError as error:
        return f"Could not locate the project: {error}"

    wanted = ["fx", "shader"] if lang.strip().lower() == "both" else [lang.strip().lower()]
    blocks: list[str] = []

    for which in wanted:
        if which not in ("fx", "shader"):
            return f"lang must be \"fx\", \"shader\" or \"both\", not '{lang}'."

        found, stamp = read_published(project, which)
        label = "DreamFX" if which == "fx" else "DreamShader"

        if stamp is None:
            blocks.append(f"{label}: no diagnostics.json -- the bridge has not run in this "
                          f"project yet.")
            continue

        head = f"{label}: {summarize(found)}, last written {stamp}"
        if not found:
            blocks.append(f"{head}\n  (clean)")
            continue

        by_file: dict[str, list] = {}
        for item in found:
            by_file.setdefault(item.file or "(no file)", []).append(item)

        lines = [head]
        for name in sorted(by_file):
            lines.append(f"  {name}")
            for item in by_file[name]:
                code = f" {item.code}" if item.code else ""
                lines.append(f"    ({item.line},{item.column}) {item.severity}{code}: "
                             f"{item.message}")
        blocks.append("\n".join(lines))

    return "\n\n".join(blocks)


# ---------------------------------------------------------------- preview


@mcp.tool()
def dream_preview(source_file: str,
                  mesh: str = "sphere",
                  width: int = 512,
                  height: int = 512,
                  project_dir: str | None = None) -> list:
    """Render a DreamShader material and return the picture, so you can see what it looks
    like rather than infer it from the source.

    Worth reaching for whenever the question is visual -- does this actually look metallic,
    did the mask land where it should, is the emissive blown out -- and after any change
    where a green compile does not mean a correct result. A build that passes every static
    check can still draw the wrong thing.

    source_file: a .dsm (absolute, or relative to the project root). Only .dsm renders; a
                 .dsf is a function with no material to draw.
    mesh:        plane | cube | cylinder | shaderball | sphere. A UI-domain material is
                 always drawn on a plane whatever you ask for, and the reply says so.
    width/height: 64-2048, default 512.

    Requires a running editor. There is no headless preview -- the commandlet runs with no
    GPU -- so this reports that plainly rather than falling back to something useless.
    DreamFX has no equivalent: Niagara has no preview render behind this API.
    """
    try:
        project = _project(project_dir)
    except LocateError as error:
        return [f"Could not locate the project: {error}"]

    path = Path(source_file)
    if not path.is_absolute():
        path = (project.root / path).resolve()
    if not path.exists():
        return [f"No such source file: '{path}'."]

    if routing.language_for(str(path)) == "fx":
        return ["DreamFX has no preview. Niagara exposes no equivalent render behind this "
                "API, so there is nothing to show for a .dfs."]

    decision = routing.decide(project, "shader")
    if decision.route is not routing.Route.BRIDGE:
        return [f"A preview needs a running editor ({decision.reason}). The commandlet runs "
                f"with -nullrhi, so there is no headless path to fall back to -- open the "
                f"project in the editor and try again."]

    try:
        result = shader_preview.render(project, path, mesh=mesh, width=width, height=height)
    except shader_preview.PreviewFailed as error:
        return [f"Preview failed: {error}"]
    except transport.BridgeUnavailable as error:
        return [f"The editor became unavailable: {error}"]
    except TimeoutError as error:
        return [str(error)]

    lines = [
        f"{result.asset_path or path.stem} on a {result.mesh}, "
        f"{width}x{height}, rendered in {result.duration_ms} ms",
    ]
    lines.extend(f"  ! {note}" for note in result.notes)

    return ["\n".join(lines), Image(path=str(result.image))]


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
