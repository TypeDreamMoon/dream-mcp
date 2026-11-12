# dream-mcp

[中文](README.zh-CN.md)

An [MCP](https://modelcontextprotocol.io) server for the Dream family of Unreal Engine
plugins (DreamShader, DreamFX, DreamGUI and others). It gives an AI agent one tool per
installed Dream plugin, and routes every call to the right Unreal process: the editor you
have open, or a background engine host it starts and stops on its own.

The server knows nothing about any particular plugin. Each plugin ships a small
capability manifest and an HTTP endpoint inside the engine; dream-mcp reads the manifests
and turns them into tools. Install a plugin that ships a manifest and its tool appears.
No server update is needed.

## Requirements

- Node.js 20 or newer.
- An Unreal project with at least one Dream plugin that ships `Resources/DreamMCP.json`.
- For calls that need the engine: the engine the project uses (found from the
  `.uproject`), with its editor built.

## Install and run

Straight from GitHub (needs Node 20+ and `git` on the PATH):

```bash
npx -y github:TypeDreamMoon/dream-mcp
```

npx clones the repository, installs its dependencies and builds it (the `prepare` script
compiles the TypeScript), then starts the server on stdio, where it waits for an MCP
client. The first start takes a while (about 20 s for a first install); later starts use npx's cache. Add
`#<branch or tag>` to pin a version, for example `github:TypeDreamMoon/dream-mcp#v2`.

After dream-mcp is published to npm (not yet), this will also work:

```bash
npx -y dream-mcp
```

From a clone, for development:

```bash
git clone https://github.com/TypeDreamMoon/dream-mcp
cd dream-mcp
npm install      # also builds dist/
npx .            # or, from anywhere: npx -y <path to the clone>
```

From a packed tarball (`npm pack`), name the package explicitly:

```bash
npx -y --package <path>/dream-mcp-<version>.tgz dream-mcp
```

Do not run `npx -y <file>.tgz`: npx then tries to execute the tarball itself, which on
Windows opens it with whatever program is associated with `.tgz`, and the MCP client
times out.

### Register it with Claude Code

From the Unreal project folder:

```bash
claude mcp add dream -- npx -y github:TypeDreamMoon/dream-mcp
```

or in the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "dream": {
      "command": "npx",
      "args": ["-y", "github:TypeDreamMoon/dream-mcp"],
      "env": { "DREAM_MCP_PROJECT": "<path to>/MyGame.uproject" }
    }
  }
}
```

`DREAM_MCP_PROJECT` is optional when the client starts the server inside the project
folder. On Windows some clients need `"command": "cmd", "args": ["/c", "npx", "-y", "…"]`.

### Other MCP clients

Any client that can start a stdio server works. The command is `npx -y github:TypeDreamMoon/dream-mcp`
(or a path to a clone, or `node <clone>/dist/cli.js`); pass `--project <path>` or set `DREAM_MCP_PROJECT` to pick
the project.

| Variable | Meaning |
|---|---|
| `DREAM_MCP_PROJECT` | Project to use: a `.uproject`, its folder, or a registered workspace name. |
| `DREAM_MCP_HOME` | Where the workspace registry, start locks and host logs live. Default `~/.dream-mcp`. |
| `DREAM_MCP_JOB_WAIT_MS` | How long one tool call waits for a long job before handing back a job id. Default 10 min. |
| `DREAM_MCP_START_TIMEOUT_MS` | How long to wait for a started engine to answer. Default 10 min. |
| `DREAM_MCP_EDITOR_WAIT_MS` | How long a write waits for an editor that is opening the project to publish its endpoint (or to answer once published). Default 2 min. |
| `DREAM_MCP_EDITOR_WARMUP_MS` | With no host of its own, how long the server waits for an editor that has just published its endpoint to start answering. Default 30 s. |

## Workspaces

A workspace is a `.uproject`, the engine it uses, and the Dream plugins installed in it.
The current workspace is, in order:

1. the one picked with `dream_workspace use` (for the life of the server);
2. `DREAM_MCP_PROJECT`;
3. the nearest `.uproject` above the folder the server was started in.

Registered workspaces and their settings live in `~/.dream-mcp/workspaces.json`:

| Setting | Default | Meaning |
|---|---|---|
| `mode` | `render` | `render`: the background host is a windowless editor and can render (previews work); its first start is the slower one. `headless`: a host commandlet without rendering, less memory; actions that need rendering get a temporary windowless editor. Needs a plugin that declares a host commandlet, otherwise it falls back to `render`. |
| `idleMinutes` | `15` | Stop the background host after this long without calls. |
| `engineRoot` | from `.uproject` | Use this engine instead of the one `EngineAssociation` names. |
| `port` | free port | Port for the background host. |

The engine is found from `EngineAssociation`: a GUID is a registered source build
(`HKCU\Software\Epic Games\Unreal Engine\Builds` on Windows, `Install.ini` elsewhere), a
version is a launcher install (`LauncherInstalled.dat`), and an empty value means the
project lives inside an engine tree. Plugins are found under `Plugins/` (up to three
folders deep) and in the engine's `Plugins/Marketplace`, following the `.uproject`'s
enable rules.

## Tools

Every tool takes `{ "action": "<name>", "args": { … } }`. Each tool's description lists its
actions and their arguments, one per line.

### `dream_workspace`

| Action | Arguments | What it does |
|---|---|---|
| `status` | | Current project, how it was chosen, engine, Dream plugins and their tools. |
| `list` | | Registered workspaces. |
| `use` | `project` | Switch project for this session; the plugin tools change and the client is notified. |
| `add` | `project`, `name?`, `mode?`, `idleMinutes?`, `engineRoot?`, `port?` | Register a project or change its settings. |
| `remove` | `project` | Forget a registered project (files untouched). |
| `doctor` | | Check Node, engine, manifests and endpoints; say what to fix. |

### `dream_engine`

| Action | Arguments | What it does |
|---|---|---|
| `status` | | Which process serves each plugin, busy or idle, and the host this server started. |
| `start` | `mode?` | Start the background host now. Does nothing while the editor is open. |
| `stop` | | Stop the host this server started. Never touches an editor. |
| `restart` | `mode?` | Stop, then start. |
| `logs` | `lines?`, `find?` | Recent output of the host. |
| `job` | `job` | Keep waiting for a long action that returned a job id. |
| `cancel` | `job` | Cancel it. |

### `dream_<plugin>`

One per installed plugin with a manifest (for example `dream_shader`). The actions come
from the manifest; the server adds two to every plugin tool:

- `help(action?)`: list the actions, or one action's full arguments with an example;
- `reference(doc?, offset?, limit?)`: list the plugin's reference docs, or read one in
  pages. The docs are also MCP resources (`dream://<id>/reference/<path>`).

Results start with a one-line summary, then any pre-formatted text the plugin sends (a
layout tree, say), one line per diagnostic
(`error CODE file:line:col message (hint: …)`), the assets written, and what to do next.
The full result is attached as structured content, and preview images come back as image
content.

## How calls are routed

- If the editor has the project open with the plugin's endpoint running, the editor serves
  the call. Nothing else is started.
- Otherwise a background host serves it. The first call starts one (this takes as long as
  an engine boot; the result says how long) and later calls reuse it. It stops when idle,
  when the editor opens, or when the server exits.
- If something holds the project but does not answer (a hung editor, an old plugin build
  without an endpoint), the call is refused with the reason and what to do, rather than a
  second process writing the same assets. Read-only actions may still run in a host.
- Actions that write assets run one at a time per project.
- dream-mcp only ever stops processes it started itself, by the process id it recorded.
- Before it starts an engine of its own (for any call), and before a write runs in its own
  host, dream-mcp checks whether another Unreal process has the project open. One that
  started in the last 5 minutes is taken to be an editor still opening: the call waits for
  its endpoint (up to `DREAM_MCP_EDITOR_WAIT_MS`, default 2 min) and goes to the editor, so an
  editor that is opening does not make dream-mcp start a second engine. If no endpoint appears, or
  the process has been open for longer, writes are refused with the reason and reads may
  start a host. Reads on a host dream-mcp already runs are not held up.

## Known limitations

- If the MCP client ends the server by killing its whole process tree (some clients do on
  exit), the engine host is killed with it: it gets no `/shutdown`, and a save in progress
  at that moment can be cut off. Its discovery file is left behind; the next run sees that
  its pid is gone, treats it as stale and replaces it. Clients that close the server's
  stdin (the normal way) give the host a clean shutdown.
- A host this server did not start (another dream-mcp's) is never stopped from here, so a
  rendering action on a project held by another session's headless host is refused.

## Adding dream-mcp support to a plugin

1. Ship `Resources/DreamMCP.json` with the plugin: an id, a route, a description for the
   model, and one entry per action with a JSON Schema for its arguments.
2. Implement the endpoint in the plugin's editor module: `hello`, `call`, `jobs`, `cancel`
   and, for the host, `shutdown`, on 127.0.0.1 with the token check. Read the token from
   the `DREAM_MCP_TOKEN` environment variable first (that is how dream-mcp passes it to a
   host it starts; it never puts the token on the command line), then `-DreamMCPToken=`.
   Write the discovery file on start.
3. Honour `-DreamMCPHost`: publish `mode: "host"`, accept `/shutdown`, and exit when the
   process named by `-DreamMCPParentPid` goes away. That is all a windowless editor needs to
   act as the rendering host. Optionally provide a host commandlet that keeps ticking, for
   the headless form (see [docs/protocol.md](docs/protocol.md#3-host-processes)).

The full contract is in [docs/protocol.md](docs/protocol.md). The test suite's fake endpoint
(`test/fake/endpoint.ts`) is a working reference implementation, and the contract tests check
a real endpoint against it:

```bash
DREAM_MCP_E2E_PROJECT=<path>/MyGame.uproject npm run test:contract
```

| Variable | Meaning |
|---|---|
| `DREAM_MCP_E2E_PROJECT` | Project to test (required; otherwise the contract tests are skipped). |
| `DREAM_MCP_E2E_PLUGIN` | Only this manifest id. |
| `DREAM_MCP_E2E_MODE` | `render` or `headless` for a host the test starts. |
| `DREAM_MCP_E2E_NO_START` | `1`: require an open editor or host; never start one. |
| `DREAM_MCP_E2E_ACTIONS` | JSON list of calls to run through the tools, e.g. `[{"action":"check","args":{"file":"Example/A.exm"}}]`. |

## Development

```bash
npm install
npm test          # builds into build/ and runs the unit tests (no engine needed)
npm run build     # builds dist/
```

The tests never start Unreal: a Node stand-in (`test/fake/host.ts`) plays the engine host.
Set `DREAM_MCP_TEST_TMP` to choose where they create temporary projects.

## License

MIT
