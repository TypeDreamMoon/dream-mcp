# dream-mcp

An MCP server for the [DreamFX](https://github.com/TypeDreamMoon/DreamFX) and
[DreamShader](https://github.com/TypeDreamMoon/DreamShader) Unreal plugins.

Both plugins already run an editor-side bridge, and both AI entry points ignore it: `dfx.ps1`
and `dsc.ps1` always spawn a cold commandlet, paying 12–24 s of engine boot and warning you
to close the editor first so the two processes do not silently overwrite each other's
packages. A `pwsh -File` invocation cannot do better — every call is a fresh process, so it
can hold no connection, cache no liveness, and reuse no session.

A resident MCP server can. That is what this is for.

## Status

| Phase | | |
| :-- | :-- | :-- |
| **M0** | liveness — `dream_status` | done |
| **M1** | disk knowledge face — `dream_schema` | done |
| **M2** | warm-editor routing — `dream_build`, `dream_verify` | done |
| **M3** | DreamShader bridge symmetry (C++) | done |
| **M4** | `dream_preview` → image | done |
| **M5** | `dream_diagnostics`, SKILL.md split | done |

All six tools are in place, which is the cap: `dream_status`, `dream_schema`, `dream_build`,
`dream_verify`, `dream_preview`, `dream_diagnostics`.

Plan: `DevTest/Plan/dream-mcp-plan.md`.

Tool count is capped at six. A tool schema is resident context in every session where a
`SKILL.md` is loaded on demand — that is the one place MCP loses to the existing skills, and
a pile of narrow tools is how it would lose badly.

## Install

```bash
git clone https://github.com/TypeDreamMoon/dream-mcp && cd dream-mcp && uv venv --python 3.12 && uv pip install -e .
```

Register it in your Unreal project's `.mcp.json`, pointing `command` at the venv you just
made. The server finds the project by walking up from its working directory, so it needs no
path configuration of its own.

```json
{
  "mcpServers": {
    "dream": {
      "command": "<path to dream-mcp>/.venv/Scripts/python.exe",
      "args": ["-W", "ignore", "-m", "dream_mcp.server"]
    }
  }
}
```

## Tools

### `dream_status`

Whether a warm editor is available, and whether the cached knowledge face is current.

DreamFX liveness is a **fact**: the bridge publishes `status.json` every 2 s and deletes it
on shutdown, so a missing file means "gone", not "timed out". Three details of that contract
are load-bearing and all three are implemented here:

- `busy` must be read before the heartbeat age. A long build blocks the game thread, so the
  heartbeat stops during it — without `busy`, every real build looks like a crash.
- A missing file is a definite answer, so the CLI fallback is immediate with no liveness
  window to wait out.
- A crash leaves the file behind. The recorded pid is what closes that gap.

DreamShader liveness is a **heuristic** until M3 — the plugin publishes no heartbeat, so
`bridge.db`'s presence is all there is, and the output says so.

### `dream_schema`

The real signature of a DreamFX module or dynamic input, or a DreamShader material
expression, Substrate builtin or enum alias. Reads cached manifests off disk: no editor, no
bridge, milliseconds.

Not going through the bridge is deliberate. The bridge's own `refreshIndex` **refuses** to
probe input signatures, because probing walks the module graphs and
`/Niagara/Modules/Masks/ConeMask` sends `UNiagaraGraph::ReferencesStaticVariable` into
unbounded recursion — 81 frames, then an uncatchable stack overflow that takes the editor
down with everything unsaved in it. Signatures can only come from a process that is allowed
to die and be restarted, which is `dfx.ps1 index` with its quarantine list. This reads what
that run leaves behind.

Ambiguous names are refused with the full candidate list rather than resolved arbitrarily —
`ConeMask` matches four different assets.

### `dream_build` / `dream_verify`

Generate assets from source, or check source against the assets without writing. Both route
the same way:

| Editor state | Route | Why |
| :-- | :-- | :-- |
| alive / busy | bridge | costs what the work costs; no second writer exists |
| hung (heartbeat stopped, not busy) | **refuse** | it still holds the packages, so both paths are unsafe |
| protocol mismatch | **refuse** | a mismatched editor is still a running editor |
| closed | CLI | nothing is holding anything |

The refusal is the point. Everything else is transport.

Measured on this project, 2026-08-15, against a live editor — and against the same calls with
it closed:

| | warm | cold |
| :-- | :-- | :-- |
| verify one `.dfs` | 537 ms | ~12 s of engine boot before any work |
| build a failing source | 80 ms, identical DFX3003 | exit 1, identical DFX3003 |
| build a real system | 547 ms, asset written | — |

`UnrealEditor-Cmd` process count throughout: zero. One writer, so the double-write is not
merely avoided but unreachable.

**Known gap:** the bridge reply carries no list of what it wrote, where the CLI driver prints
`Assets written to disk by this run:`. On the warm path "what did it touch" has to come from
mtimes or git. Phase M5.

Three things this reports rather than smooths over:

- **`all` through a live editor is queued, not done.** It goes through the watcher queue and
  drains across ticks, so the bridge answers "queued N". Presenting that as a result would
  be a lie.
- **A DreamShader compile through the editor writes no `.uasset`.** The editor generates in
  memory by design. If you need assets on disk, that is the CLI path.
- **A DreamShader result is inferred, on old plugin builds only.** Before phase M3 that
  bridge sent no reply at all, so completion had to be read off the diagnostics timestamp.
  An editor running a post-M3 build gets the real round trip; one running an older build
  still gets the inferring path, marked as such, because fire-and-forget was never *unsafe*
  there — only uninformative — and refusing it would be a regression.

### `dream_diagnostics`

The editor's standing findings, from whichever plugin, without compiling anything. Both bridges
republish to `diagnostics.json` after every run precisely so a client that did not make the request
can still read the result. The two file shapes differ — DreamFX writes a flat array where each entry
names its own file, DreamShader groups by file and puts the path on the group — and both land in one
shape here.

Reports the *last run*, not the current source. A file edited since is not represented.

### `dream_preview`

Renders a `.dsm` and returns the picture. See [Preview](#preview) below.

## Four matching rules, and they are not the same

Discovered by reading the source, after nearly collapsing them into one:

| Rule | Applies to | trim | lower | space | `_` | `-` |
| :-- | :-- | :-: | :-: | :-: | :-: | :-: |
| DreamFX | module and input names | | ✓ | ✓ | ✓ | |
| `NormalizeSettingKey` | `.dsm` setting keys, `UE.Expression` argument names | ✓ | ✓ | | | |
| `NormalizeMappingKey` | enum aliases | ✓ | ✓ | ✓ | ✓ | ✓ |

The fourth is not a normalisation at all. `ResolveMaterialExpressionClass` does **prefix
expansion**: a bare `Abs` is tried as `Abs`, `UAbs`, `MaterialExpressionAbs` and
`UMaterialExpressionAbs`, each compared case-insensitively against every concrete
`UMaterialExpression` subclass. The three guards are independent ifs, not a chain, so a name can
skip one and still pick up another. UE's `FString::StartsWith` is case-insensitive by default and
Python's is not — that difference is the trap.

Measured against the real compiler on 2026-08-15: `Abs` and `MaterialExpressionAbs` both resolve;
`UMaterialExpressionAbs` fails with *could not resolve MaterialExpression class*, because
`UClass::GetName()` carries no `U` prefix and so nothing can ever match it. This server refuses it
too — resolving a name the compiler then rejects is worse than not resolving it.

Collapsing any of the four would produce exactly that failure. `tests/test_schema_parity.py` and
`tests/test_m5.py` pin them apart.

## Tests

```bash
.venv/Scripts/python.exe -m pytest -q
```

`test_liveness.py` covers the four states with synthetic status files — BUSY, STALE and the
crashed-editor case only occur when something has gone wrong, which is when a bug here costs
most. `test_schema_parity.py` pins signatures against captured `dfx.ps1 schema` output; the
CLI runs it was checked against are quoted in the docstrings.
