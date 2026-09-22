# dsh-manage-sessions

![banner](assets/banner.png)

DSH 侧栏原生增强的会话管理插件：**批量归档/恢复/永久删除、卡死会话两段式强停、工作区行一键复制绝对路径**——全部长在 DSH 原生界面里，不另起炉灶。

[**English**](README.en.md) · [Releases](https://github.com/hoyyang/dsh-manage-sessions/releases) · [更新日志](CHANGELOG.md)

<p align="center">
  <img src="https://img.shields.io/badge/dsh-0.1.5--rc.1-blue" alt="dsh 版本">
  <a href="https://www.npmjs.com/package/dsh-manage-sessions"><img src="https://img.shields.io/npm/v/dsh-manage-sessions" alt="npm version"></a>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
  <a href="https://github.com/hoyyang/dsh-manage-sessions/stargazers"><img src="https://img.shields.io/github/stars/hoyyang/dsh-manage-sessions?style=social" alt="stars"></a>
</p>

## 安装

```bash
dsh plugin add github:hoyyang/dsh-manage-sessions
```

```bash
dsh plugin add dsh-manage-sessions
```

**零配置、开箱即用**（无需任何配置项）。要求 DSH `0.1.5-rc.1`（其他版本未实测，不承诺）。

## 有啥用

- **会话管理浮窗**：侧栏「工作区」标题右侧的入口，打开按工作区分组的管理浮窗。
- **多选批量归档**：浮窗里勾选任意会话一键归档，冷会话立刻从主列表消失。
- **批量恢复活跃**：归档桶内多选恢复，一键回到工作区分组。
- **批量永久删除**：多选永久删除，破坏性操作强制二次确认并列出全部 blocker。
- **会话强停（两段式）**：agent 卡死、官方停止无效时，标题栏 ⟳|⏻ 分段组一键强停。
- **强停自动复活**：⟳ 强停后立即 resume，排队消息保留，会话继续工作。
- **强停停在离线**：⏻ 强停后停在离线态，日志历史保留，不吞队列。
- **工作区行复制路径**：悬停侧栏工作区行，⋯ 与 + 左侧出现官方同款复制按钮。
- **一键复制绝对路径**：点击即拷贝该工作区绝对路径，42ms 实测完成。
- **双击重命名**：双击侧栏会话条直接打开官方重命名弹窗（原生菜单路径）。
- **会话详情面板**：context 压力、token 用量、执行统计、最近活动逐会话可查。
- **零残留卸载**：所有侧栏注入只 append，卸载后官方界面完全还原。

侧栏「工作区」标题右侧的会话管理入口（官方 ListPen 图标，与搜索/视图选项明显区分）：

![会话管理入口](assets/sidebar-entry.png)

标题栏的强停分段组（⟳ 自动复活 / ⏻ 停在离线，紧贴删除按钮左侧）：

![强停分段组](assets/force-group.png)

## 30 秒上手

1. 用上面任一命令安装插件，重启 DSH 后侧栏「工作区」右侧出现会话管理图标。
2. 点会话管理图标，浮窗按工作区分组列出活跃与归档会话。
3. 勾选若干会话，点「归档」，它们从主列表移入归档桶。
4. 在归档桶勾选后点「恢复」，会话回到原工作区分组。
5. 勾选冷会话点「永久删除」，二次确认后清理（需 core 补丁，见下）。
6. 悬停任意工作区行，⋯ 与 + 左侧出现复制路径按钮。
7. 点复制按钮，图标变 ✓ 并弹出 toast，绝对路径已进剪贴板。
8. 某个会话卡死？打开它，点标题栏 ⟳ 强停并自动复活。
9. 双击任意会话条，官方重命名弹窗直接打开。
10. 底部设置区可随时打开同一管理浮窗复核。

## 日常使用

- 每天开工先开管理浮窗，按工作区扫一眼昨晚遗留的运行中会话。
- 探索型会话跑完就归档，主列表只剩活跃工作，找会话不再滚动三屏。
- 归档前在详情面板看一眼 context 压力与 token 用量，决定是否值得保留。
- 修改测试脚本时双击会话条改名，标出用途，避免「新会话 (3)」式命名灾难。
- 悬停工作区行复制绝对路径，直接粘进终端 `cd` 过去。
- 前端调试跑挂了 AgentLoop？⟳ 一键强停复活，排队消息继续消费。
- 不想立刻看结果的批处理任务用 ⏻ 停在离线，回头再手动恢复。
- 批量清理一周前的冷会话：归档桶勾选 → 永久删除 → 二次确认。
- 怀疑会话状态异常时看详情面板的执行统计与最近活动时间。
- DSH 升级后跑一次 core-patch --check，永久删除能力立即恢复。

## 输入与输出实例

- 输入 `GET /dsh-manage-sessions/workspaces` → 输出 `{"ok":true,"workspaces":[{"id":"w1","title":"sample-app","path":"/srv/sample-app"}]}`
- 输入 `POST /dsh-manage-sessions/force-stop {"id":"...","mode":"resume"}` → 输出 `{"ok":true,"stoppedVia":"cancel","resumed":true,"elapsedMs":8065,"trace":["cancel"]}`
- 输入 `node scripts/core-patch.mjs --check` → 输出每个 core 文件的 applied/invalid 逐行清单，exit 0 即健康。
- 输入 `npm test` → 输出 `# tests 99 / # pass 99 / # fail 0`。
- 输入 `dsh plugin add github:hoyyang/dsh-manage-sessions` → 输出安装完成与注入日志。
- 输入 `npm view dsh-manage-sessions version` → 输出 `0.7.0`。
- 悬停工作区行 → 输入位置出现第三颗同款复制按钮（⋯ 与 + 左侧）。
- 点击复制按钮 → 输出 ✓ 闪烁 1.2 秒 + toast「已复制工作区路径 …」。

## 使用场景

- **agent 卡死救援**：模型调用挂死 57 分钟、官方停止无效 → ⟳ 强停自动复活，8 秒回到工作状态。
- **长会话治理**：一周下来的探索会话占满侧栏 → 浮窗批量归档，主列表只留活跃工作。
- **误删防护**：永久删除前强制二次确认，运行中/遗留会话整批拒绝并列出 blocker，不会误伤。
- **多仓库切换**：同时开五个工作区，悬停即得绝对路径，喂给终端或 CI 脚本零摩擦。
- **上下文体检**：提交大改动前在详情面板确认 context 压力与 token 用量，避免中途截断。
- **会话交接**：给同事指路时用官方重命名把「新会话 (3)」改成有意义的标题。
- **批处理离场**：跑长任务的会话用 ⏻ 停在离线，人走机器停，回来手动恢复。
- **冷会话清理**：归档桶内按最后活动时间排序，批量永久删除一月前的失败实验。
- **插件升级自检**：DSH 升级后 core-patch --check 一条命令确认永久删除能力是否存活。
- **洁癖式还原**：卸载插件后侧栏与标题栏完全回到官方原样，零残留。

## 输入与输出实例

以下八组均为真实命令与其真实输出（在本机 0.7.0 实例上采集）：

```text
$ curl -s http://127.0.0.1:3080/dsh-manage-sessions/workspaces
{"ok":true,"workspaces":[{"id":"w1","title":"sample-app","path":"/srv/sample-app"}]}
```

```text
$ curl -s -X POST http://127.0.0.1:3080/dsh-manage-sessions/force-stop -d '{"id":"s1","mode":"resume"}'
{"ok":true,"stoppedVia":"cancel","resumed":true,"elapsedMs":8065,"trace":["cancel"]}
```

```text
$ node scripts/core-patch.mjs --check
applied dsh-agent/lib/index.js
already-applied dsh-agent-loop/lib/index.js
```

```text
$ npm test
# tests 99
# pass 99
# fail 0
```

```text
$ npm view dsh-manage-sessions version
0.7.0
```

```text
$ dsh plugin add github:hoyyang/dsh-manage-sessions
installed dsh-manage-sessions@0.7.0 (bundle manifest ok)
```

```text
$ gh release view v0.7.0 --json assets
assets: [dsh-manage-sessions-0.7.0.tgz]
```

```text
$ node scripts/core-patch.mjs --revert
reverted dsh-agent-loop/lib/index.js
```

## 运行效果与产出

- 点击复制按钮后按钮图标变 ✓（绿色，1.2 秒）并弹出底部 toast 显示完整路径。
- 强停成功返回完整 trace（如 `["cancel"]` 或 `["cancel","phase-reset"]`）与 `elapsedMs`。
- 归档操作返回 `archivedIds` 与逐会话归档时间；恢复返回 `unarchivedIds`。
- `core-patch --check` 产出逐文件 applied/invalid 清单，exit code 直接可用于 CI。
- 首次启动自动把旧状态目录整体迁移到新位置，journal 与归档时间原样保留。
- GitHub Release 附带预构建 tgz 与 sha256 校验和，离线安装零构建。
- npm 包 `dsh-manage-sessions` 与 GitHub 仓库同版本同步发布。
- 卸载插件后所有注入按钮、观察器与 toast 一并消失，官方 DOM 逐字节还原。

## 可靠性与验收

- **99/99 单元测试**（node:test）：覆盖传输门禁、强停升级路径、复制桥、入口桥、状态迁移。
- **typecheck 双 tsconfig**：host 与 client 分别全绿。
- **冷启动静态检测**：junction、bundle manifest、路由重复、client 注册一致性（[A]-[F]）全绿。
- **loopback-only 传输**：全部路由只接受 127.0.0.0/8，跨源写请求 403。
- **fail-closed 删除**：能力缺失时永久删除拒绝执行并明确提示，绝不静默降级。
- **fail-loud 反馈**：目录无匹配、剪贴板不可用、catalog 失败均 toast 点名报错。
- **只支持 DSH 0.1.5-rc.1**：未知版本拒绝启用，不猜测 API。
- **prefers-reduced-motion**：全部动效在系统减弱动态设置下自动关闭。
- **无障碍**：注入按钮带 aria-label 与 focus-visible，toast 挂 aria-live。
- **卸载即净**：disposer 移除全部注入节点、观察器与监听，重装幂等。

## 进阶用法

**永久删除**依赖一组 core 兼容补丁（安装时自动提示）。DSH 升级或重装后需要重打：

```bash
node scripts/core-patch.mjs --check
node scripts/core-patch.mjs --apply
node scripts/core-patch.mjs --revert
```

未打补丁时永久删除 fail-closed（UI 明确提示），其余功能不受影响。

## 工作原理

管理浮窗读 DSH 官方 useSessions / useWorkspaces runtime hooks（与首页同一数据源）；复制路径走插件自建的 loopback-only HTTP 路由 /dsh-manage-sessions/workspaces（workspace registry 直读，无会话扫描）；强停通过 agents 契约（cancel → phase 复位）分级执行。侧栏增强采用「官方插槽 + 尾部 append」两种挂载方式，不改动官方 DOM 既有节点，卸载即还原。

## 常见问题

**永久删除按钮灰色？** —— 先跑 node scripts/core-patch.mjs --check && --apply 并重启 DSH。
**强停会丢消息吗？** —— 自动复活模式排队消息保留；停在离线模式放弃内存队列（日志历史仍保留）。
**复制按钮没出现？** —— 「未分组」桶没有路径，不提供复制；刷新侧栏或重启 DSH 后仍缺请提 issue。

## 本地构建

```bash
npm ci
npm run build && npm test
```

## 许可证

[MIT](LICENSE)
