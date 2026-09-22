# dsh-manage-sessions

![banner](assets/banner.png)

DSH 侧栏原生增强的会话管理插件：**批量归档/恢复/永久删除、卡死会话一键强停复活、工作区行一键复制绝对路径**——全部长在 DSH 原生界面里，不另起炉灶。

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
# 或 npm
dsh plugin add dsh-manage-sessions
```

**零配置**，装完即用。要求 DSH `0.1.5-rc.1`（其他版本未实测，不承诺）。

## 有啥用

- **批量管理浮窗**：侧栏「工作区」标题右侧一个入口，按工作区分组的会话清单——**多选批量归档 / 恢复 / 永久删除**，附带 context 压力、token 用量、执行统计与最近活动，破坏性操作前强制确认并列出完整 blocker。
- **会话强停（两段式）**：agent 卡死、停止按钮无效时，标题栏的 **⟳|⏻** 分段组一键强停——**⟳ 自动复活**（强停后立即 resume，排队消息保留）或 **⏻ 停在离线**。L1 官方 cancel → 验证 → L2 phase 复位，全路径留痕，绝不伪造成功。
- **工作区行一键复制路径**：悬停侧栏工作区行，⋯ 与 + 左侧多一枚官方同款复制按钮，点击**瞬间**复制该工作区绝对路径（42ms 实测），✓ 反馈 + toast 显示完整路径。
- **双击重命名**：侧栏会话条双击直接打开官方重命名弹窗（驱动原生菜单路径，不是山寨弹窗）。

与同类插件的差异：强停走分级升级且**不做** scope 强拆（实测会砸机器）；复制路径走 registry 直读**不做**全量扫描；所有注入只 append，**不改**官方 DOM 既有节点。

## 30 秒上手

1. 安装插件（上面两条命令任选其一），侧栏「工作区」标题右侧出现会话管理图标；
2. 点图标打开管理浮窗，勾选要归档的会话 → 「归档」；
3. 侧栏悬停任意工作区行 → 点最左侧复制按钮 → 路径已在剪贴板；
4. 某个会话卡死？标题栏 **⟳** 强停并自动复活；
5. 双击任意会话条 → 官方重命名弹窗。

## 进阶用法

**永久删除**依赖一组 core 兼容补丁（安装时自动提示）。DSH 升级或重装后需要重打：

```bash
node scripts/core-patch.mjs --check   # 检查
node scripts/core-patch.mjs --apply   # 应用（自动 .bak 备份）
node scripts/core-patch.mjs --revert  # 回退
```

未打补丁时永久删除 fail-closed（UI 明确提示），其余功能不受影响。

## 工作原理

管理浮窗读 DSH 官方 useSessions / useWorkspaces runtime hooks（与首页同一数据源）；复制路径走插件自建的 loopback-only HTTP 路由 /dsh-manage-sessions/workspaces（workspace registry 直读，无会话扫描）；强停通过 agents 契约（cancel → phase 复位）分级执行。侧栏增强采用「官方插槽 + 尾部 append」两种挂载方式，不改动官方 DOM 既有节点，卸载即还原。

## 可靠性与验收

- **99/99** 单元测试（node:test；含传输门禁、强停升级路径、复制桥、入口桥、状态迁移）；
- typecheck 双 tsconfig、冷启动静态检测（junction/bundle manifest/路由重复/client 注册一致性）全绿；
- 强停/复制/批量删除均在主线实例真实验证过（非模拟）。

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
