# dream-mcp

[English](README.md)

给 Dream 系列 Unreal Engine 插件(DreamShader、DreamFX、DreamGUI 等)用的
[MCP](https://modelcontextprotocol.io) 服务。它为每个装了的 Dream 插件提供一个工具,
并把每次调用交给合适的 Unreal 进程:你开着的编辑器,或者它自己起、自己关的后台引擎宿主。

服务端不认识任何具体插件。每个插件自带一份能力清单和一个引擎内的 HTTP 端点;
dream-mcp 读清单生成工具。装上带清单的插件,工具就出现,服务端不用改。

## 环境要求

- Node.js 20 或更新。
- 一个 Unreal 工程,里面至少有一个带 `Resources/DreamMCP.json` 的 Dream 插件。
- 需要引擎的调用:工程所用的引擎(从 `.uproject` 找),编辑器已编好。

## 安装与运行

还没发布到 npm,从克隆或 git 地址运行:

```bash
git clone https://github.com/TypeDreamMoon/dream-mcp
cd dream-mcp
npm install      # 同时构建 dist/
npx .            # 在 stdio 上启动服务(等待 MCP 客户端连接)
```

不克隆也可以:

```bash
npx -y github:TypeDreamMoon/dream-mcp
```

在任何目录下都可以 `npx <克隆目录的路径>`。

用 `npm pack` 打出的压缩包运行时,要显式写包名:

```bash
npx -y --package <路径>/dream-mcp-<版本>.tgz dream-mcp
```

不要写 `npx -y <文件>.tgz`:npx 会去执行压缩包本身,Windows 上会用关联 `.tgz` 的程序打开它,
MCP 客户端随后超时。

### 在 Claude Code 里注册

在 Unreal 工程目录下:

```bash
claude mcp add dream -- npx -y <克隆目录的路径>
```

或者写进工程的 `.mcp.json`:

```json
{
  "mcpServers": {
    "dream": {
      "command": "npx",
      "args": ["-y", "<克隆目录的路径>"],
      "env": { "DREAM_MCP_PROJECT": "<路径>/MyGame.uproject" }
    }
  }
}
```

客户端在工程目录里启动服务时可以不设 `DREAM_MCP_PROJECT`。Windows 上有的客户端要写成
`"command": "cmd", "args": ["/c", "npx", "-y", "…"]`。

### 其他 MCP 客户端

能启动 stdio 服务的客户端都行。命令是 `npx -y <路径或 git 地址>`(或 `node <克隆目录>/dist/cli.js`);
用 `--project <路径>` 或 `DREAM_MCP_PROJECT` 选工程。

| 环境变量 | 含义 |
|---|---|
| `DREAM_MCP_PROJECT` | 要用的工程:`.uproject`、它所在的文件夹,或登记过的工程名。 |
| `DREAM_MCP_HOME` | 工程登记表、启动锁和宿主日志的位置。默认 `~/.dream-mcp`。 |
| `DREAM_MCP_JOB_WAIT_MS` | 一次工具调用等长任务多久,超时就交回任务 id。默认 10 分钟。 |
| `DREAM_MCP_START_TIMEOUT_MS` | 等新起的引擎应答多久。默认 10 分钟。 |
| `DREAM_MCP_EDITOR_WAIT_MS` | 写动作等「正在打开工程的编辑器」发布端点(或发布后开始应答)等多久。默认 2 分钟。 |
| `DREAM_MCP_EDITOR_WARMUP_MS` | 服务端自己没有宿主时,等「刚发布端点的编辑器」开始应答等多久。默认 30 秒。 |

## 工程(workspace)

一个工程 = 一个 `.uproject` + 它用的引擎 + 里面装的 Dream 插件。当前工程按顺序取:

1. `dream_workspace use` 选的(在服务这次运行期间有效);
2. `DREAM_MCP_PROJECT`;
3. 从服务启动目录往上找到的第一个 `.uproject`。

登记过的工程和设置存在 `~/.dream-mcp/workspaces.json`:

| 设置 | 默认 | 含义 |
|---|---|---|
| `mode` | `render` | `render`:后台宿主是无窗口的完整编辑器,能渲染(预览可用),首次启动较慢。`headless`:不渲染的宿主 commandlet,省内存;要渲染的动作临时另起一个无窗口编辑器。需要有插件声明宿主 commandlet,否则退回 `render`。 |
| `idleMinutes` | `15` | 后台宿主空闲这么久就关。 |
| `engineRoot` | 取自 `.uproject` | 用这个引擎,而不是 `EngineAssociation` 指的那个。 |
| `port` | 空闲端口 | 后台宿主的端口。 |

引擎从 `EngineAssociation` 解析:GUID 是登记过的源码版(Windows 查
`HKCU\Software\Epic Games\Unreal Engine\Builds`,其他平台查 `Install.ini`),版本号是安装版
(`LauncherInstalled.dat`),空值表示工程在引擎目录树里。插件在 `Plugins/` 下找(最多三层),
外加引擎的 `Plugins/Marketplace`,并遵守 `.uproject` 里的启用规则。

## 工具

所有工具的输入都是 `{ "action": "<名字>", "args": { … } }`。每个工具的说明里逐行列出动作和参数。

### `dream_workspace`

| 动作 | 参数 | 作用 |
|---|---|---|
| `status` | | 当前工程、怎么选中的、引擎、发现的 Dream 插件和对应工具。 |
| `list` | | 登记过的工程。 |
| `use` | `project` | 本次会话切换工程;插件工具随之变化并通知客户端。 |
| `add` | `project`、`name?`、`mode?`、`idleMinutes?`、`engineRoot?`、`port?` | 登记工程或改设置。 |
| `remove` | `project` | 从登记表删掉(不动文件)。 |
| `doctor` | | 自检 Node、引擎、清单和端点,并说明怎么修。 |

### `dream_engine`

| 动作 | 参数 | 作用 |
|---|---|---|
| `status` | | 每个插件由哪个进程服务、忙不忙,以及本服务起的宿主。 |
| `start` | `mode?` | 现在就起后台宿主。编辑器开着时什么都不做。 |
| `stop` | | 关掉本服务起的宿主。绝不碰编辑器。 |
| `restart` | `mode?` | 先关再起。 |
| `logs` | `lines?`、`find?` | 宿主最近的输出。 |
| `job` | `job` | 继续等一个交回了任务 id 的长动作。 |
| `cancel` | `job` | 取消它。 |

### `dream_<插件>`

每个带清单的插件一个(比如 `dream_shader`)。动作来自清单;服务端给每个插件工具补两个:

- `help(action?)`:列出动作,或给出某个动作的完整参数和示例;
- `reference(doc?, offset?, limit?)`:列出插件的参考文档,或分页读一篇。这些文档也作为
  MCP 资源提供(`dream://<id>/reference/<路径>`)。

结果先给一行摘要,然后每条诊断一行(`error 代码 文件:行:列 消息 (hint: …)`)、写了哪些资产、
下一步做什么。完整结果作为结构化内容附上,预览图作为图片内容返回。

## 调用怎么分派

- 编辑器开着这个工程且插件端点在跑:交给编辑器,不起别的进程。
- 否则交给后台宿主。第一次调用会起一个(耗时等于一次引擎启动,结果里会写明),之后复用。
  空闲、编辑器打开、服务退出时它会关掉。
- 有进程握着工程却不应答(编辑器卡死、旧版插件没有端点):拒绝执行并说明原因和办法,
  而不是让第二个进程去写同一批资产。只读动作仍可在宿主里跑。
- 写资产的动作同一工程内一个一个执行。
- dream-mcp 只关自己起的进程,而且只按它记下的进程号关。
- dream-mcp 自己起引擎之前(不论什么调用),以及在自己的宿主上执行写动作之前,会检查有没有别的
  Unreal 进程开着这个工程。5 分钟内启动的,当作正在打开的编辑器:调用等它的端点出现
  (上限 `DREAM_MCP_EDITOR_WAIT_MS`,默认 2 分钟)再交给编辑器,所以正在打开的编辑器不会让 dream-mcp
  再起一个引擎。等不到端点,或者那个进程已经开了很久:写动作拒绝并说明原因,只读可以起宿主。
  已经在跑的宿主上的只读调用不受影响。

## 已知限制

- MCP 客户端如果按整棵进程树结束服务端(有的客户端退出时会这样),引擎宿主会被一起硬结束:
  收不到 `/shutdown`,正在存盘的话可能被打断。它的发现文件会残留,下次运行时因 pid 已不在而被识别为陈旧并覆盖。
  正常关闭服务端 stdin 的客户端会让宿主干净退出。
- 不是本服务起的宿主(别的 dream-mcp 起的)从这里永远不会被停掉,所以工程被另一个会话的 headless 宿主占着时,要渲染的动作会被拒绝。

## 给插件加 dream-mcp 支持

1. 随插件发布 `Resources/DreamMCP.json`:id、路由、给模型看的说明,每个动作一条,参数用 JSON Schema。
2. 在插件的编辑器模块里实现端点:`hello`、`call`、`jobs`、`cancel`,宿主还要 `shutdown`;
   只监听 127.0.0.1 并校验令牌。令牌先读环境变量 `DREAM_MCP_TOKEN`(dream-mcp 起宿主时
   就是这样传的,绝不放命令行),其次 `-DreamMCPToken=`。启动时写发现文件。
3. 让端点认 `-DreamMCPHost`:发布 `mode: "host"`、接受 `/shutdown`、`-DreamMCPParentPid` 指的进程没了就退出。
   无窗口编辑器当渲染宿主只需要这一条。可选:再提供一个持续 tick 的宿主 commandlet,用于 headless 形态
   (见 [docs/protocol.md](docs/protocol.md#3-host-processes))。

完整契约见 [docs/protocol.md](docs/protocol.md)(英文)。测试里的假端点
(`test/fake/endpoint.ts`)就是一份能跑的参考实现,契约测试拿真端点和它对照:

```bash
DREAM_MCP_E2E_PROJECT=<路径>/MyGame.uproject npm run test:contract
```

| 环境变量 | 含义 |
|---|---|
| `DREAM_MCP_E2E_PROJECT` | 要测的工程(必填,不设就跳过契约测试)。 |
| `DREAM_MCP_E2E_PLUGIN` | 只测这个清单 id。 |
| `DREAM_MCP_E2E_MODE` | 测试自己起宿主时用 `render` 还是 `headless`。 |
| `DREAM_MCP_E2E_NO_START` | `1`:要求编辑器或宿主已经开着,绝不自己起。 |
| `DREAM_MCP_E2E_ACTIONS` | 要经工具跑的调用,JSON 列表,如 `[{"action":"check","args":{"file":"Example/A.exm"}}]`。 |

## 开发

```bash
npm install
npm test          # 构建到 build/ 并跑单元测试(不需要引擎)
npm run build     # 构建 dist/
```

测试从不启动 Unreal:由一个 Node 写的替身(`test/fake/host.ts`)扮演引擎宿主。
用 `DREAM_MCP_TEST_TMP` 指定测试临时工程放在哪。

## 许可

MIT
