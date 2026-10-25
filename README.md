# dsh-native-retract · DSH 原生对话撤回

给 DSH（DeepSeek Harness）Web / Desktop 的**用户消息气泡**加一个原生「撤回」按钮，紧挨着原生「复制」按钮。

点一下就回到那条消息之前：消息本身和之后的所有对话从界面上消失、也不再进入模型的后续上下文，这条消息的文字自动放回输入框，可以直接改完再发。

![原生撤回按钮](docs/native-button.png)

参考 OpenChamber 的「对话内撤回」：**同一个 session、不新开分支**，原始事件日志完整保留，轨迹页（Trajectory）仍然能查到被撤回的每一步。

## 它做了什么

| | 行为 |
|---|---|
| 中止生成 | 正在跑的这一轮立刻取消 |
| 清空队列 | 丢弃尚未发送的排队消息 |
| 摘除区间 | 所选用户消息 `.seq` 到末尾（含当前 open turn）设为不可见 |
| 保留日志 | 原始事件不删除、不改写，仅做 surface 替换，可追溯、可回放 |
| 返回原文 | 所选消息的文本回到输入框并立即持久化草稿 |
| 不建分支 | 仍是同一个 sessionId，历史里没有分叉 |
| 不回滚文件 | 工作区文件、shell 副作用、子代理历史保持现状 |

## 平台支持

| 平台 | Host 逻辑 | 按钮补丁 | 说明 |
|---|---|---|---|
| Linux | ✅ | ✅ | 已验证（DSH 0.2.1-rc.2） |
| macOS | ✅ | ✅ | 逻辑无平台分支；路径自动探测覆盖 `/Applications`、`~/.local/share` |
| **Windows** | ✅ | ✅ | 脚本已适配：自动探测 `%LOCALAPPDATA%\Programs`、`Program Files`，见下方 Windows 小节 |

跨平台的依据：补丁只改 `window.__ModuleLoader__` 那套浏览器 bundle，两个目标文件里没有任何
`process.platform` / `win32` / `file:///` 分支；Host 侧只用 Cordis 的 session API，不碰路径。

## 安装

安装包目录只有编译产物、没有源码构建入口，所以本仓库采用
**「bundle 插件（Host 侧撤回逻辑） + 原生产物补丁（Client 侧按钮）」** 的组合：

```bash
# 1) 挂载插件（Host 侧注册 /native-retract 命令）
dsh profile install ./            # 或把本目录加入 profile 的 bundle 列表

# 2) 给原生客户端产物打按钮补丁（自动探测安装目录 + 自动备份）
node scripts/patch-native.cjs

# 3) 重启 DSH Desktop，或 Web 页面按 Ctrl+Shift+R 强刷
```

### Windows

先在**管理员 PowerShell**里（普通 PowerShell 常因 `Program Files` 写保护失败）：

```powershell
# 必须先完全退出 DSH Desktop，否则 client.js 被占用
node scripts\patch-native.cjs --dry-run   # 只探测、不写文件，先确认找到的目录对不对
node scripts\patch-native.cjs             # 正式打补丁
```

脚本会自动在以下位置找两个目标包：
`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\dsh`、
`%LOCALAPPDATA%\DeepSeek Harness`、`%ProgramFiles%`、`%ProgramFiles(x86)%`、`~\.dsh`
（各自再向下找 `node_modules\@deepseek-ai`）。

探测不到或不放心时手动指定：

```powershell
node scripts\patch-native.cjs --dir "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\dsh\node_modules\@deepseek-ai"
```

### macOS / Linux

```bash
node scripts/patch-native.cjs --dry-run
node scripts/patch-native.cjs
# macOS: sudo 通常不是必需；若 /Applications 下受保护，可先 --dir 指向可写副本
# Linux: 默认 /opt/DeepSeek Harness/resources/dsh
```

Linux 探测顺序：`--dir` → PATH 上的 `/usr/bin/dsh`、`/usr/bin/dsh-desktop` 等 launcher（只读解析，不执行）→
`~/.local/share/applications/*.desktop` 的 `Exec=`/`--app-path=` → `DSH_HOME` →
`/opt`、`/usr/lib`、`/usr/local/lib`、`/usr/share` 下 `DeepSeek Harness`、`DSH Desktop`、`deepseek-harness`、`DSH`、`dsh`
→ `~/.local/share`、`~/Applications`、`~/snap/<name>/current` → `~/.dsh`。

只读安装（Flatpak 沙箱、root 拥有的 `/opt`）需先解压或复制到可写位置，再用 `--dir` 指向副本。

```bash
# Linux 适配回归（临时副本，不动真实安装）
DSH_ROOT="/opt/DeepSeek Harness/resources/dsh" node scripts/test-linux.cjs
```

### 还原

```bash
node scripts/patch-native.cjs --restore
```

### 其它参数

| 参数 / 环境变量 | 作用 |
|---|---|
| `--dry-run` | 只报告探测目录与「能否打补丁」，不写任何文件 |
| `--dir <path>` | 指定 `@deepseek-ai` 目录（也接受 `node_modules` 或安装根目录） |
| `DSH_NODE_MODULES` | 同 `--dir`，优先级最高 |
| `DSH_HOME` | dsh 安装根目录，脚本会拼 `resources/dsh` |
| `DSH_PROFILE_DIR` | 正在运行的 dsh 提供的 profile 目录 |

### 安全性

- **幂等**：目标已是补丁版本时整轮跳过，不会叠加；
- **两阶段写入**：先算完两个包的补丁，全部成功才落盘。任一锚点不匹配（典型是 DSH 升级后）会报出缺失的锚点并**不修改任何文件**，不会留下半成品；
- **备份**：首次打补丁把原文件存到 `backups/`，`--restore` 用它们还原；
- **只读/占用**：Windows 上会尝试去掉只读位，仍失败则提示「关程序 + 管理员终端」或杀软受控文件夹访问。

### 补丁改了哪两处

| 包 | 改动 |
|---|---|
| `@deepseek-ai/dsh-client-ui-chat` | `MessageIconActions` 增加 `onRetract` 按钮（复制之后、分支之前）；`UserMessageNodeView` 接上撤回动作，注入 `remote.commands` |
| `@deepseek-ai/dsh-client-ui-conversation` | 历史重放时过滤掉被撤回区间的记录，以及这次撤回自身产生的 command 行 |

## Host 侧实现

`index.js` 注册一个 Cordis command `/native-retract <seq>`：

1. 校验 `seq` 指向一条 `user/message`、`surfaceOp === 'append'`、`source.kind === 'user'` 的事件；
2. 校验它仍在当前 surface 上（没被撤回、没被压缩替换掉）；
3. `agent.cancel()` + `whenIdle()`；
4. 在 `agent.runMaintenance()` 里追加一条空的 `user/message` 做 **surface replace**，区间是 `[seq, 末尾]`；
5. `ctx.sessions.flush(session)` 落盘，并把原文返回给 Client。

Client 侧只通过 `ctx.remote.commands.execute()` 调这一个命令，没有第二套逻辑。

## 验证

```bash
# 单元/集成：边界、保留前缀、日志完整、模型上下文、草稿、重复撤回保护、后续新消息、UI 回放过滤
node scripts/test.mjs

# 真实 GUI：点击撤回 → 草稿恢复 → 页面刷新后仍隐藏
PLAYWRIGHT_MODULE=/path/to/playwright REMOTE_BASE=http://127.0.0.1:3080/myremote node scripts/e2e.cjs
```

脚本支持 `DSH_ROOT`（dsh 安装根，默认 `/opt/DeepSeek Harness/resources/dsh`）覆盖路径，Windows 上：

```powershell
$env:DSH_ROOT = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\dsh"
node scripts\test.mjs
```

端到端已核对：撤回按钮与原生复制按钮紧邻、无页面 JS 异常、点击后草稿恢复为上一条原文、刷新后消息仍不可见且草稿保留。

![会话内效果](docs/conversation.png)

## 已知边界

- 只恢复**文本**，不自动恢复图片、文件附件与引用 chip；
- 不回滚工作区文件、shell 副作用、子代理历史；
- 没有 Restore / redo 暂存条（撤销即重发）；
- 若目标消息已被压缩替换，会明确报错而不是冒险改写历史；
- 撤回会清空待发送队列；
- 补丁作用在安装包的编译产物上，**不覆盖第三方杀软/EDR 对安装目录的实时防护**。

## 升级注意

DSH（含 Windows 版 Desktop）升级会整包替换 `client.js`，补丁会被覆盖；部分版本还可能做文件校验
（校验失败会提示修复/重装）。标准流程：

```
升级 → 完全退出 DSH
     → node scripts\patch-native.cjs --restore     # 清掉旧备份（升级后原文件已变）
     → node scripts\patch-native.cjs               # 重新适配
     → 启动
```

若锚点不匹配，脚本会指出缺失的锚点并保持文件不变，按新产物更新锚点即可。

## License

MIT © 2026 emocow-liuyun
