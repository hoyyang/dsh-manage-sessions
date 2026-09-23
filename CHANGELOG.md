# Changelog

## 0.7.1

- 安装文档调整：npm 独占名（全局唯一包标识）列为推荐安装方式并置于首位，GitHub 源码渠道降为备选；无代码变更。

## 0.7.0

- 插件更名为 **dsh-manage-sessions**（原 dsh-session-manager；npm 上同名同功能包已被占用）：package.json、HTTP 路由前缀（/dsh-manage-sessions/*）、client 注册 id、样式 owner 全量同步。
- 状态目录迁移：~/.dsh/dsh-session-manager → ~/.dsh/dsh-manage-sessions，首次启动自动整体搬迁（归档时间与 journal 保留），失败则落新目录并 warn。
- 路由路径为破坏性变更（外部脚本若直调旧路径需同步）；管理浮窗/侧栏交互不受影响。

## 0.6.0

- 复制路径提速（根因修复）：新增轻量路由 GET /dsh-manage-sessions/workspaces（registry 元数据直读，无会话快照扫描），client 换走新路由并在悬停工作区行时预取（60s 缓存）——点击瞬间出 ✓ 与 toast；轻路由不可用时回退 catalog，再失败 toast 点名报错。
- 「会话管理」入口移位：从侧栏底部（DSH 商场旁）移到「工作区」标题紧贴右侧（官方 sectionHeader 内、标题后插入），图标换官方 IconListPenOutline16（列表+笔 = 管理，与视图选项滑杆/搜索放大镜明显区分）；底部旧入口移除。
- 强停按钮合成一个分段组：一个圆角描边容器（危险淡染）内两个分区——⟳ 官方 IconRefreshOutline16（自动复活，蓝色悬停）/ ⏻ 纯电源符号（停在离线，红色悬停），分段独立高亮与 tooltip，位置不变（删除按钮左侧）。
- 测试 99/99（新增 routes workspaces 用例、manager-entry 桥 2 例、hover 预取 2 例）；semver minor（新增路由）。

## 0.5.1

- 图标修正（用户反馈：原「文件夹+复制方块」复合图形 15px 下不可读）：主图标换官方 IconCopyOutline16 同款（双叠圆角方块 = VS Code/GitHub/Finder 复制路径操作的业界标准形态），✓ 反馈态换官方 IconCheckOutline16 同款；与侧栏原生图标族完全一致。原 AI 生成设计稿退役。

## 0.5.0

- 新增「工作区复制路径」：侧边栏工作区行悬停时，在 ⋯ 与 + 两颗官方按钮的**紧贴左侧**出现第三颗同款按钮（图标 = 文件夹+复制方块，由 /dsh-image-gen 生成设计稿后 1:1 描摹为单色 SVG，currentColor 适配深浅主题）。
- 点击复制该工作区的**绝对路径**到剪贴板；成功反馈 = 按钮图标变 ✓（1.2s）+ 底部 toast 显示完整路径，失败 toast 点名报错（目录无匹配 / 剪贴板不可用 / catalog 失败），绝不静默。
- 实现约束：按钮 append 到官方 rowActions 尾部 + CSS order:-1 视觉置左（React 索引协调零干扰）；样式类运行时克隆自官方兄弟按钮；路径来自既有 catalog 路由按行标题精确匹配（host 零改动）；「未分组」桶（无路径）不加按钮；disposer 移除全部注入节点与观察器。
- 测试 94/94（新增 10 个 copy-path 用例）；semver minor。

## 0.4.1

- 强停升级路径修订：移除 scope 强拆层——实测 cordis 停用 fiber 上 spawn effect 会抛错（cannot create effect on inactive context），强拆会把仍挂载在注册表里的机器变成死机器、砸掉下一个 turn。升级路径收敛为 **L1 cancel → 验证 → L2 phase 复位**，全程不破坏运行时作用域。
- 主线实测（一个真实卡死 57 分钟、无视中止信号的会话）：0.4.0 全升级路径 8s 恢复 idle 并保持在线，排队消息保留；0.4.1 起同等场景不再有死作用域风险。
- stoppedVia 收敛为 not-running / cancel / phase-reset；测试 84/84 同步修订。

## 0.4.0

- 新增「会话强停」：会话标题栏删除按钮左侧两枚强停按钮（自动复活 / 停在离线）。
- host 侧 `POST /dsh-manage-sessions/force-stop`：L1 官方 cancel → 验证 → L2a agent scope 强拆 → 验证 → L2b phase 复位，全路径留痕（trace），失败返回完整升级路径，绝不伪造成功。
- 能力探针新增 `forceStop` / `forceStopResume`；子会话拒绝强停；不依赖 core patch。
- client：新增强停确认弹窗（展示升级路径与排队消息数）与结果视图；按钮悬停霓虹脉冲动效（蓝=复活 / 红=离线），支持 prefers-reduced-motion。
- 测试 84/84（新增 11 个强停用例）；semver minor。

## 0.3.0

- 双击侧边栏会话条打开官方「重命名会话」弹窗（驱动官方菜单路径，不改官方 bundle）。
- 已知副作用：被双击会话会先被打开（用户知情接受）。

## 0.2.0

- 适配 DSH 0.1.5-rc.1（0.1.0-rc.8 不再支持）；UI 重做为三个原生 slot；core patch 缩减为纯 host 侧。

## 0.1.0

- 首版：会话管理浮窗、批量归档/恢复/永久删除（ADR-0001 core patch 预留租约）。
