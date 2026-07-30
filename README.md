# 小波挂机假人

将网易版“挂机假人”的核心管理能力迁移到国际版 Minecraft Bedrock 1.26.33。实现基于公开 Script API 与 `SimulatedPlayer`，不读取网易世界的 ExtraData，也不依赖隐藏 GameTest、私有 NBT 或跨 Mod Python OpenAPI。

## 运行要求

- Minecraft Bedrock 正式版 1.26.33。
- 世界必须启用 **Beta APIs** 实验。
- 行为包和资源包必须同时启用。
- 开发构建需要 Node.js 22 或更高版本。

项目锁定以下精确开发类型：

| 模块 | 版本 |
|---|---|
| `@minecraft/server` | `2.9.0-beta.1.26.33-stable` |
| `@minecraft/server-ui` | `2.2.0-beta.1.26.33-stable` |
| `@minecraft/server-gametest` | `1.0.0-beta.1.26.33-stable` |

未来游戏版本可能改变 Beta API 行为。升级版本前应更新依赖并重新执行自动测试和实机验收矩阵。

## 安装与构建

1. 安装依赖并构建：

   ```powershell
   npm ci
   npm run build
   ```

2. 将 `xiaoboFakePlayerbp` 作为行为包、`xiaoboFakePlayerp` 作为资源包导入或放入对应开发包目录。
3. 在世界设置中同时启用两个包和 **Beta APIs**。
4. 进入世界后执行 `/xiaobo:fpset` 打开管理界面。

开发检查：

```powershell
npm run typecheck
npm test
npm run build
```

## 脚本调试

项目已按 Mojang 官方 [Minecraft Bedrock Debugger](https://marketplace.visualstudio.com/items?itemName=mojang-studios.minecraft-debugger) 配置 TypeScript 源码调试。VS Code 会推荐安装该扩展；调试器的官方说明见 [Script developer tools](https://learn.microsoft.com/minecraft/creator/documents/scripting/developer-tools?view=minecraft-bedrock-stable)。

同一台 Windows 电脑首次连接正式版 Minecraft Bedrock 前，需要在管理员终端添加官方要求的回环豁免：

```powershell
CheckNetIsolation.exe LoopbackExempt -a -p=S-1-15-2-1958404141-86561845-1752920682-3514627264-368642714-62675701-733520436
```

1. 在 VS Code 的“运行和调试”中选择 `Minecraft Bedrock: Listen` 并按 F5。预启动任务会构建源码，并用 `robocopy /MIR` 将两个完整开发包同步到 Minecraft Bedrock 开发目录。
2. 进入已启用本行为包的世界。世界需要开启作弊，执行者需要拥有 2 级命令权限。
3. 在游戏聊天栏执行 `/script debugger connect localhost 19144`。出现 `Debugger connected to host` 后，可直接在 `src/**/*.ts` 中使用断点、单步、局部变量和监视。
4. 调试结束后执行 `/script debugger close`，或在 VS Code 中停止调试。

端口 `19144` 是官方默认脚本调试端口。配置通过脚本模块 UUID 锁定本行为包，避免同时启用多个脚本包时连接到错误目标。调试器不支持修改变量状态或立即执行模式。

## 已实现能力

- 最多 10 个假人，使用 `fp0001` 形式的持久稳定 ID，并自动处理重名。
- 创建、安全下线、恢复上线、重命名重载、手动或自动复活、默认无损删除和明确销毁。
- 保存维度、位置、旋转、游戏模式、选中槽、总经验、复活规则、皮肤、行为配置和期望在线状态。
- 完整 41 槽管理：库存 0-35、头胸腿脚 36-39、副手 40。
- 在线假人直接读取活体背包；在线写操作先建立即时检查点，再通过与离线操作相同的可恢复事务写回活体。
- 两木桶结构快照保留完整 `ItemStack`，包含公开 API 可保存的组件数据。
- 玩家与假人之间支持主手/副手单独交换、36 格背包原位整槽交换、盔甲与副手原位整槽交换，以及单槽交换、拿取、放入、保留假人的资源回收和经验转移；所有操作使用可恢复事务。
- 即时动作：看向、旋转、移动、导航、跳跃、潜行、站立、停止、传送、攻击、挖掘、使用物品及方块/实体交互。
- 集中式自动行为：跟随、攻击、挖掘、按视线或指定坐标自动交互（放置），以及定时使用物品；自动交互可指定库存槽位，也可按物品 ID 在每次动作时遍历 36 格背包，物品 ID 留空表示空手；指定物品表单可在本次保存时读取玩家当前主手并忽略输入的 ID；攻击、挖掘、自动交互和定时使用互斥，启用其中一项会自动关闭其余三项，跟随可独立运行；每 tick 有公平调度和方块读取预算。
- 默认皮肤与在线真人 Persona 外观复制。Persona 数据会随记录保存，并在重新上线时恢复。
- 空手对在线假人按下使用键（鼠标右键或触屏长按）可直接打开该假人的设置界面。
- Forms 管理、`xiaobo:` 自定义命令、PlayFab 稳定身份权限和 OP 恢复中心。

## 权限

| 身份/授权 | 能力 |
|---|---|
| OP | 始终拥有全部能力，可管理授权、恢复和诊断 |
| `can_place` | 只允许创建假人 |
| `can_set` | 允许查看和管理全部假人，包括行为、背包和生命周期 |
| 未授权玩家 | 不能创建或管理假人 |

权限按真人玩家的 PlayFab ID 保存，玩家改名不会获得或绕过权限。模拟玩家不会出现在授权目标列表中。

## 常用命令

Forms 是完整管理入口，命令和 Forms 调用相同的应用用例与权限检查。

| 命令 | 用途 |
|---|---|
| `/xiaobo:fpset` | 打开管理界面 |
| `/xiaobo:fp_spawn [name] [gameMode] [default\|copy_actor]` | 在执行者位置创建假人 |
| `/xiaobo:fp_list` | 列出假人稳定 ID、名称和状态 |
| `/xiaobo:fp_online <id或名称> [saved\|here]` | 在保存位置或执行者位置上线 |
| `/xiaobo:fp_offline <id或名称>` | 建立已验证快照后安全下线 |
| `/xiaobo:fp_rename <id或名称> <新名称>` | 安全重命名并按原状态恢复 |
| `/xiaobo:fp_delete <id或名称> [recycle\|purge]` | 默认回收物品和经验；`purge` 明确销毁 |
| `/xiaobo:fp_respawn <id或名称>` | 手动复活死亡假人 |
| `/xiaobo:fp_respawnrule <id或名称> <death_location\|manual\|player_spawn>` | 设置复活规则 |
| `/xiaobo:fp_permission <玩家> <can_place\|can_set> <on\|off>` | OP 修改权限 |
| `/xiaobo:fp_recovery` | OP 打开待恢复事务中心 |
| `/xiaobo:fp_diagnose [id或名称]` | OP 只读查看启动、record、snapshot、pending 和能力状态 |

动作命令还包括 `fp_lookat`、`fp_navigate`、`fp_move`、`fp_rotate`、`fp_setrotation`、`fp_tp_here`、`fp_jump`、`fp_sneak <id或名称> <on|off>`、`fp_stop`、`fp_useitem`、`fp_break`、`fp_interactblock`、`fp_useitemonblock`、`fp_attack`、`fp_interactentity`、`fp_lookatentity` 和 `fp_follow`。坐标、距离、维度、视线、区块加载与真实库存槽会在应用层统一校验。

## 物品与存档安全

世界动态属性保存三个独立聚合：catalog、permissions 和 operations。每个聚合使用 A/B bank、active pointer、revision、UTF-8 容量预检和 FNV-1a 校验。提交时先写并回读非活动 bank，验证成功后才切换 active pointer。

物品事务保存完整 before/after image，并按 `prepared -> staged -> applying -> committed -> checkpointed` 推进：

- 当前状态完整匹配 before 时可继续应用。
- 当前状态完整匹配 after 时可继续提交，避免重复写入。
- mixed/conflict 状态会保留事务和两份 image，不自动覆盖玩家后来获得的物品。
- catalog 指向已验证的新快照后，旧权威快照才允许清理。
- 默认删除先将全部物品和经验转给执行者；空间不足或事务冲突时不会删除记录。
- 同一假人存在待恢复物品或经验事务时，周期检查点和自动行为暂停，避免活体状态绕过事务发生变化。

在线假人每秒错峰检查一个，世界最多 10 个假人，因此正常情况下每个假人最长约 10 秒得到一次完整检查点。生命周期、Forms 转移和删除事务具有可恢复保证；如果游戏进程在脚本来不及运行时被强杀，在线实体刚发生的外部背包变化最多只能恢复到最近一次已验证检查点。这是公开 Script API 的一致性边界，应在重要操作前正常退出世界并保留世界备份。

若启动恢复发现损坏 bank、非法生命周期组合或无法判定的物品冲突，系统会阻止普通写操作。OP 可使用 `/xiaobo:fp_diagnose` 查看只读状态，并在系统 ready 时通过恢复中心沿原状态机重试。恢复中心不会提供任意跳阶段、覆盖槽位或删除唯一快照的按钮。

重进世界时，假人或遗留结构工作区所在区块可能晚于脚本完成加载。系统会保持 `recovering` 并每秒按真实区块可读性重试，区块就绪后继续幂等恢复；只有持久数据冲突或引擎异常才进入只读隔离。

## 能力矩阵

源码中的 `CAPABILITY_MATRIX` 固定到 Bedrock 1.26.33，并控制未验证功能是否出现在 Forms 和命令中。

| 能力 | 当前状态 | 说明 |
|---|---|---|
| 模拟玩家生命周期 | 已实现，需 1.26.33 实机验收 | 顶层生成、断开、复活和稳定标签重绑定 |
| 自动交互（放置） | 已实现，需 1.26.33 实机验收 | 支持指定槽位、动态查找指定物品及空手交互；指定物品时可将玩家当前主手保存为物品 ID；方块物品在既有箱子兼容路径中直接放置并同步真实库存 |
| 空手交互打开设置 | 已实现，需 1.26.33 实机验收 | 使用稳定的 `playerInteractWithEntity` 事件；长按重复事件只打开一个界面 |
| 在线/离线 41 槽背包 | 已实现，需 1.26.33 实机验收 | 在线读取活体、离线读取快照；Node 测试覆盖事务，ItemStack 组件保真必须实机验证 |
| Persona 皮肤复制 | 已实现，需 1.26.33 实机验收 | 保存公开 Persona 部件、手臂尺寸和肤色 |
| 经典皮肤纹理复制 | 不支持 | `PlayerSkinData` 不公开纹理；明确回退默认皮肤 |
| 潜行 | 已实现，需 1.26.33 实机验收 | Forms 可切换开始潜行/停止潜行，命令可通过 `fp_sneak on|off` 切换 |
| 饥饿/饱和度写入 | 隐藏，待实机验证 | 组件存在，写入语义尚未验收 |
| 自动钓鱼 | 隐藏，待实机验证 | 未证明可可靠关联钓鱼钩和收杆时机，不使用固定延时伪实现 |
| 玩家列表隐藏 | 不支持 | 公开 API 没有网易开关的等价能力 |
| 网易私有属性/NBT/OpenAPI | 不支持 | 不通过命令或假状态伪造 |

本项目不迁移娱乐假人、刷怪假人、CSM/YSM、机械动力联动、自定义拖拽容器、生成/控制物品或网易跨 Mod Python API。当前目标是本地世界和房主联机场景，不承诺 Realm、Dedicated Server 或无真人长期加载。

## 实机发布门槛

自动检查通过并不等于 Minecraft 引擎契约已经验收。发布前至少在 Bedrock 1.26.33 正式版验证：

1. 主世界、下界和末地的创建、重进世界、重命名、下线、上线和复活。
2. 附魔耐久工具、重命名/Lore 物品、护甲、副手、书、染色物品和容器物品的 41 槽往返。
3. 在快照和转移各阶段强制退出后的恢复，确认原方块、旧快照或事务 image 至少有一个权威副本。
4. Persona 复制和重载恢复；经典皮肤回退提示。
5. 10 个假人同时运行自动行为至少 10 分钟，无 watchdog 或持续预算超时。
6. 自动交互（放置）分别验证面前视线与指定坐标模式，并验证指定槽位、指定物品和空手三种来源；指定物品表单的主手开关应默认关闭，开启后本次保存忽略输入 ID 并记录玩家当前主手，下次打开应显示该 ID 且开关恢复关闭。移动指定物品到其他背包槽后应在下一次动作重新找到，物品不存在时不交互，留空时应临时清空主手槽完成交互并原样恢复物品。两种目标模式对普通支撑使用模拟玩家 API；面前模式仅在假人潜行命中箱子、所选物品为方块且目标为空气时直接设块，坐标模式遇到箱子支撑、所选物品为方块且目标为空气时直接设块；面前模式只处理 6 格内的视线命中，目标格被占时不操作，生存模式成功后只消耗一个实际命中槽的方块，创造模式不消耗。
7. 空手鼠标右键和触屏长按在线假人都只打开一次对应设置界面；手持物品、普通玩家和无权限玩家不会绕过既有行为或权限。
8. 分别在假人在线和安全下线时验证主手、副手、36 格背包、盔甲与副手交换，以及保留假人的物品/经验回收；确认在线活体立即更新，附魔、耐久、名称、Lore 和容器物品不丢失，强制退出后的事务可从恢复中心继续。
9. 分别通过 Forms 和 `/xiaobo:fp_sneak <id或名称> on|off` 切换站立、静止潜行和移动中潜行，确认姿态可见且关闭后恢复站立。

内部设计和恢复不变量见 [docs/architecture.md](docs/architecture.md)。