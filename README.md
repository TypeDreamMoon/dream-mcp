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

dream-mcp is not on npm yet. Run it from a clone or from git:

```bash
git clone https://github.com/TypeDreamMoon/dream-mcp
cd dream-mcp
npm install      # also builds dist/
npx .            # starts the server on stdio (it waits for an MCP client)
```

or, without a clone:

```bash
npx -y github:TypeDreamMoon/dream-mcp
```

`npx <path to the clone>` works from anywhere.

### Register it with Claude Code

From the Unreal project folder:

```bash
claude mcp add dream -- npx -y <path to the clone>
```

or in the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "dream": {
      "command": "npx",
      "args": ["-y", "<path to the clone>"],
      "env": { "DREAM_MCP_PROJECT": "<path to>/MyGame.uproject" }
    }
  }
}
```

`DREAM_MCP_PROJECT` is optional when the client starts the server inside the project
folder. On Windows some clients need `"command": "cmd", "args": ["/c", "npx", "-y", "…"]`.

### Other MCP clients

Any client that can start a stdio server works. The command is `npx -y <path or git URL>`
(or `node <clone>/dist/cli.js`); pass `--project <path>` or set `DREAM_MCP_PROJECT` to pick
the project.

| Variable | Meaning |
|---|---|
| `DREAM_MCP_PROJECT` | Project to use: a `.uproject`, its folder, or a registered workspace name. |
| `DREAM_MCP_HOME` | Where the workspace registry, start locks and host logs live. Default `~/.dream-mcp`. |
| `DREAM_MCP_JOB_WAIT_MS` | How long one tool call waits for a long job before handing back a job id. Default 10 min. |
| `DREAM_MCP_START_TIMEOUT_MS` | How long to wait for a started engine to answer. Default 10 min. |

## Workspaces

A workspace is a `.uproject`, the engine it uses, and the Dream plugins installed in it.
The current workspace is, in order:

1. the one picked with `dream_workspace use` (for the life of the server);
2. `DREAM_MCP_PROJECT`;
3. the nearest `.uproject` above the folder the server was started in.

Registered workspaces and their settings live in `~/.dream-mcp/workspaces.json`:

| Setting | Default | Meaning |
|---|---|---|
| `mode` | `render` | `render`: the background host can render (previews work). `headless`: no rendering, less memory; actions that need rendering get a temporary rendering process. |
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

Results start with a one-line summary, then one line per diagnostic
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

## Adding dream-mcp support to a plugin

1. Ship `Resources/DreamMCP.json` with the plugin: an id, a route, a description for the
   model, and one entry per action with a JSON Schema for its arguments.
2. Implement the endpoint in the plugin's editor module: `hello`, `call`, `jobs`, `cancel`
   and, for the host, `shutdown`, on 127.0.0.1 with the token check. Write the discovery
   file on start.
3. Optionally provide a host commandlet that keeps ticking so the endpoint is available
   without an editor.

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
