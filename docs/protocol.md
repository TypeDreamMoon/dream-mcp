# Dream plugin protocol (protocol 1)

This is what a Dream plugin implements so that dream-mcp can turn it into a tool. It has
two parts:

1. a **capability manifest**, a static JSON file shipped with the plugin, readable without
   an engine;
2. an **endpoint**, a set of HTTP routes (and optionally a WebSocket) inside the plugin's
   editor module, served by the editor or by a host process dream-mcp starts (section 3).

dream-mcp contains no plugin-specific code. Everything it knows about a plugin comes from
these two parts.

## 1. Capability manifest

Path: `<Plugin>/Resources/DreamMCP.json`. Ship `Resources/` with the plugin.

```json
{
  "schema": 1,
  "protocol": 1,
  "id": "example",
  "plugin": "ExamplePlugin",
  "title": "Example",
  "description": "One paragraph for the model: what the plugin and its language are, and when to use this tool.",
  "route": "/dream/example",
  "host": { "commandlet": "ExampleHost" },
  "extensions": [".exm"],
  "sourceRoots": ["Example"],
  "reference": [
    { "title": "Language reference", "path": "Docs/reference.md" }
  ],
  "actions": [
    {
      "name": "check",
      "description": "Check one source file. Writes nothing.",
      "needs": "engine",
      "writes": false,
      "long": true,
      "args": {
        "type": "object",
        "properties": { "file": { "type": "string", "description": "Source path relative to the project root." } },
        "required": ["file"]
      }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `schema` | Manifest format version. `1`. |
| `protocol` | Endpoint protocol version. `1`. A server that speaks another number ignores the manifest and says so. |
| `id` | `^[a-z][a-z0-9_]*$`. The tool is named `dream_<id>`. Unique within a project. |
| `plugin` | Plugin name, matching the `.uplugin` file name. |
| `title`, `description` | Shown to the model. English. Keep the description to one paragraph. |
| `route` | HTTP route prefix, starts with `/`, no trailing `/`. |
| `host.commandlet` | The commandlet for the headless host form (section 3). Optional; the rendering host form (a windowless editor) needs none. |
| `extensions`, `sourceRoots` | Where the plugin's sources live; shown in the tool description. |
| `reference` | Docs (paths relative to the plugin root) exposed as MCP resources and through the built-in `reference` action. |
| `actions` | The plugin's actions (below). |

### Actions

| Field | Meaning |
|---|---|
| `name` | `^[a-z][a-z0-9_-]*$`, a plain lowercase verb. `help` and `reference` are reserved: the server adds them to every tool. |
| `description` | One sentence. Say whether it writes assets. |
| `needs` | `engine` (needs an endpoint, rendering not required), `render` (needs a process that can render), `none` (answered from files, see below). Default `engine`. |
| `writes` | `true` if it changes assets. The server runs write actions one at a time per project. Default `false`. |
| `long` | `true` if it runs as a job (section 2.2). Default `false`. |
| `args` | A JSON Schema of type `object`. Keep it flat; avoid nesting and `oneOf`. The server validates arguments against it before calling the endpoint. |
| `offline` | Required when `needs` is `none`, ignored otherwise. |

`offline` is the only way a server does work itself:

```json
{ "kind": "readFile", "path": "Docs/nodes/{name}.md" }
{ "kind": "listFiles", "path": "Example/**/*.exm", "base": "project" }
```

- `kind`: `readFile` returns the file's text; `listFiles` returns matching paths.
- `path`: relative, no `..`. `*` and `?` match within one folder, `**` across folders.
  `{arg}` is replaced by the string argument `arg` (which may not contain `..` or be
  absolute).
- `base`: `plugin` (default) or `project`: what `path` is relative to.

## 2. Endpoint

### 2.1 Listening, discovery, authentication

- Listen on **127.0.0.1 only**. Verify the binding (for Unreal's `HTTPServer` module,
  check its bind-address configuration) in a test or a startup self-check.
- Port: default `47800`; `-DreamMCPPort=<n>` on the command line overrides it. If binding
  fails, try the following ports. Several Dream plugins in one process share one port,
  each under its own route prefix.
- Token: the environment variable `DREAM_MCP_TOKEN` if set, else `-DreamMCPToken=<t>` if
  given, otherwise random per process. dream-mcp passes it only in the environment, because
  a command line is visible to every local process. **Every** request
  must carry `X-Dream-Token: <t>`; otherwise answer `401`. Any request with an `Origin`
  header gets `403` (this keeps browsers out).
- On start, write a discovery file `<Project>/Saved/DreamMCP/<id>.json`; delete it on
  clean exit, **but only if it still names your own pid**: another process for the same
  project may have replaced it in the meantime.

```json
{ "protocol": 1, "id": "example", "pid": 1234, "port": 47800, "token": "…",
  "route": "/dream/example", "ws": "ws://127.0.0.1:47811", "mode": "editor",
  "render": true, "engine": "5.8.4", "plugin": "2.2.0", "startedAt": "2026-11-12T10:00:00Z" }
```

`mode` is `editor` (a user's editor) or `host` (a process started with `-DreamMCPHost`, section 3). `ws` is `null`
when there is no WebSocket. Write it by writing a temporary file and renaming it over the
target.

- A switch in project settings can turn the endpoint off; `-NoDreamMCP` forces it off. On
  by default.

The server treats an endpoint as alive only when the discovery file exists, its `pid` is
running and `GET <route>/hello` answers with protocol `1`. If the file and the process
exist but `hello` does not answer, the server **does not** start another process: the
project is still held by something.

### 2.2 Routes

| Method and path | Purpose |
|---|---|
| `GET <route>/hello` | `{ protocol, id, plugin, engine, mode, render, busy, ws, actions: [names] }` |
| `POST <route>/call` | Run an action. Body: `{ "id": "<caller-generated>", "action": "check", "args": { … } }` |
| `GET <route>/jobs/<job>` | `{ state, progress?, result? }`; `state` is `queued`, `running`, `done`, `failed` or `cancelled`. |
| `POST <route>/jobs/<job>/cancel` | `{ "cancelled": true \| false, "state": "<state>" }`. Cancel if you can; say so if you cannot. |
| `POST <route>/shutdown` | Host mode only: exit cleanly. In editor mode answer `4xx` with a refusal. |

- Short actions: `/call` answers `200` with a result body (section 2.4).
- Long actions (`long: true`): `/call` answers `202 { "id": …, "job": "<job id>" }`; the
  caller then polls `jobs/<job>` or listens on the WebSocket.
- Requests are handled on the game thread. Long work must be split across frames or
  deferred to later ticks so that `hello` still answers; set `hello.busy` while working.
- Unknown action: `404`. Arguments that do not match the manifest: `400`. Both with a
  result body whose `outcome` is `refused`. Unknown job: `404`.
- `progress` is either a fraction in `[0, 1]` or `{ "current": n, "total": n, "message": "…" }`.
  The server forwards it as MCP progress notifications.

### 2.3 WebSocket (optional)

- Advertise it in `hello.ws` and the discovery file. The client's first frame is
  `{ "type": "auth", "token": "…" }`; close the socket if it is wrong.
- Server-to-client messages are JSON text frames with a `type`:
  - `job`: `{ type, job, state, progress?, result? }`: a job changed state.
  - `diagnostics`: `{ type, file, diagnostics: […] }`: a file's standing diagnostics changed.
  - `frame`: `{ type, stream, path }`: a preview produced a new frame (written to disk; path given).
- Without a WebSocket the server polls `jobs/<job>` every 200 ms. Both must give the same
  final result.

### 2.4 Result body (every action)

```json
{
  "ok": true,
  "outcome": "ok",
  "reason": null,
  "summary": "One line for the model: what happened.",
  "diagnostics": [
    { "code": "ABC1234", "severity": "error", "file": "Example/Panel.exm",
      "line": 12, "column": 5, "message": "…", "hint": "…", "doc": "https://…" }
  ],
  "writes": [ { "asset": "/Game/UI/Panel", "state": "memory" } ],
  "artifacts": [ { "kind": "image", "path": "Saved/DreamMCP/artifacts/<job>.png", "title": "…" } ],
  "data": { },
  "next": [ "What the model should do next, one sentence each." ]
}
```

- `outcome`: `ok`; `source-error` (the source is wrong; fix the source); `refused` (not the
  source's fault: the asset is open in the editor, held by someone else, bad arguments…;
  `reason` carries a stable machine code); `engine-error` (an internal failure). The server
  never parses message text; it only reads these fields.
- `writes[].state`: `memory`, `saved`, `created` or `deleted`.
- All paths are relative to the project root with forward slashes. Never return absolute
  paths.
- Use text that does not depend on the editor's display language.
- Large outputs such as images go to `<Project>/Saved/DreamMCP/artifacts/`; the result gives
  the relative path, and the server returns images as MCP image content.

## 3. Host processes

When no editor serves the project, the server starts a **host**: an Unreal process it owns,
started directly (no shell), whose pid it records. There are two forms, chosen by the
project's `engine.mode` setting and fixed by the protocol (not by manifests):

```
environment:  DREAM_MCP_TOKEN=<t>

render (default) - a windowless full editor, which can render previews:
UnrealEditor-Cmd <uproject> -DreamMCPHost -RenderOffscreen -unattended -nosplash -nosound -DreamMCPPort=<p> -DreamMCPParentPid=<pid>

headless - a host commandlet without rendering:
UnrealEditor-Cmd <uproject> -run=<host.commandlet> -nullrhi -DreamMCPHost -unattended -nosplash -nopause -DreamMCPPort=<p> -DreamMCPParentPid=<pid>
```

dream-mcp also appends `-stdout` (it keeps the output for `dream_engine logs`). The token is
never put on the command line.

- **`-DreamMCPHost`** is a switch every Dream endpoint understands. With it the endpoint
  publishes `mode: "host"`, accepts `/shutdown`, and exits when its parent process goes away.
  Without it the endpoint is `mode: "editor"`.
- **`-DreamMCPParentPid=<pid>`** names the process to watch (dream-mcp passes its own pid);
  `0` turns the watch off (for a host started by hand). Without the flag the endpoint watches
  the process that started it.
- **render** needs no `-run=`: the editor's own engine loop keeps the endpoint ticking.
  Commandlets cannot render previews (their preview scenes come out empty), which is why the
  rendering form is an editor.
- **headless** runs the `host.commandlet` of the **first** plugin (project plugins by name,
  then engine plugins) that declares one. Its main loop must keep ticking the game thread
  (HTTP listeners and async work depend on it). Other Dream plugins in the same process
  register their endpoints from their own module startup. If no plugin declares a
  commandlet, a headless setting falls back to the render form, and `dream_workspace status`
  and `doctor` say so.
- A windowless editor's first start (shader compilation, DDC warm-up) is slower than a
  commandlet's. While a host starts, dream-mcp sends MCP progress notifications every few
  seconds and waits up to `DREAM_MCP_START_TIMEOUT_MS` (default 10 minutes).

## 4. How the server routes a call

1. A live `mode: editor` endpoint serves everything; nothing else is started.
2. Otherwise a live host (one this server started, or one another dream-mcp started) is used.
3. Otherwise the server starts a host, waits for `hello`, and tells the model how long the
   first start took.

It refuses instead of starting a second process when the project may still be held:

- discovery file present, pid alive, `hello` not answering (or another protocol):
  `refused`, reason `endpoint-unresponsive`;
- an editor (or any Unreal process) has the project open without an endpoint for this
  plugin: write actions wait for its endpoint to appear (an editor publishes it some seconds
  after it starts) and then go to the editor; if it does not appear within
  `DREAM_MCP_EDITOR_WAIT_MS` they are refused (`editor-without-endpoint`). Read-only actions
  are not held up and may start a host.

An editor publishes its discovery file a few seconds before it can answer `hello`. An editor
endpoint that does not answer yet, whose `startedAt` is less than two minutes old, is treated
as **starting**, not hung: read-only calls keep using a host this server already runs, and
other calls wait for the editor to answer (up to `DREAM_MCP_EDITOR_WAIT_MS` with a host to
fall back on, `DREAM_MCP_EDITOR_WARMUP_MS`, default 30 s, without) and then go to it; only
then does the server's own host retire. An endpoint that answers with the wrong protocol or
id, or an editor that started long ago and does not answer, is refused at once as before.

The check for "another Unreal process has the project open" runs before every write in a
process the server owns: a cheap process list, refreshed in the background every two seconds
while a host runs, and a command-line scan only when that list changes.

When the editor opens while a host is running, the host finishes its current work and is
shut down. A host is shut down after `engine.idleMinutes` without calls and when the server
exits. A host that ignores `/shutdown` is killed by the pid recorded when it was started;
nothing is ever killed by name. A host that is shutting down, or has died, is never given
new calls; the next call starts a fresh one.

A headless project runs `needs: "render"` actions in a separate rendering host (a windowless
editor) started for that one call (the headless host is stopped first, since both would write
the same discovery files), and the result's `next` explains why it was slow. The next
non-rendering call starts the headless host again.

## 4a. Known limitations

- If the MCP client ends dream-mcp by killing its process tree, the host dies with it
  without `/shutdown`; a save in progress can be cut off. The discovery file it leaves is
  recognised as stale on the next run (its pid is gone) and replaced. Endpoints should keep
  writes short and atomic where they can.
- The window between an editor process starting and its endpoint appearing is covered for
  writes from hosts dream-mcp owns (above), not for other tools that write assets.

## 5. Refusal reasons the server itself produces

| `reason` | When |
|---|---|
| `unknown-action`, `bad-args` | The action or its arguments do not match the manifest. The tool schema does not enumerate actions, so an unknown name always gets this answer with the list of actions. |
| `engine-exited` | A job was lost because its engine process exited. |
| `endpoint-unresponsive` | Something holds the project but does not answer. |
| `editor-without-endpoint` | An editor holds the project without this plugin's endpoint; write refused. |
| `plugin-not-loaded` | A host runs but this plugin has no endpoint in it. |
| `render-unavailable` | The serving process cannot render and another one cannot be started safely. |
| `engine-not-found`, `no-plugins` | No engine to start, or no active plugin for a host to serve. |
| `bad-token` | The endpoint rejected the token (stale discovery file). |
| `not-found`, `unknown-job`, `cancelled`, `no-workspace` | As named. |
