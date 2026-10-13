# Bedrock 26.52 SAPI 适配记录

查证日期：2026-10-13。目标为国际版 Bedrock 正式版 **26.52**；manifest、npm 和诊断输出使用引擎版本 **1.26.52**，不是 26.60 Preview，也不是网易 ModSDK。

## 官方更新记录

| 版本 | 发布日期 | 与本项目的关系 |
|---|---|---|
| [26.50](https://www.minecraft.net/en-us/article/minecraft--bedrock-edition-26-50-changelog) | 2026-09-15 | 发布稳定 server 2.10.0、server-ui 2.2.0 和 server 2.11.0-beta；结构文件升级 v2；带乘客实体跨维度 Entity.teleport 改为抛错；加入世界时钟与 POI 等实验接口 |
| [26.51 热修复](https://feedback.minecraft.net/hc/en-us/articles/48915928859789-Minecraft-Bedrock-Edition-26-51-Hotfix-Changelog) | 2026-09-15 | 修复包含大量密集连接方块的世界加载崩溃，没有列出新的 SAPI 接口 |
| [26.52 热修复](https://feedback.minecraft.net/hc/en-us/articles/49175370527501-Minecraft-Bedrock-Edition-26-52-Hotfix-Changelog) | 2026-09-25 | 修复旁观玩家被投射物击中、未加载区块中的坐垫丢失、平台稳定性、物品显示与旧世界 Marketplace 附加包成就问题，没有列出新的 SAPI 接口 |

因此不能把 26.52 当作全新的 SAPI 主版本：它继承 26.50 的接口基线，类型包仍应使用实际发布的 26.52 构建。本项目依赖实验接口，不能仅改成上述稳定模块而保留 Beta 功能调用。

26.50 将以下接口移入 server 2.10.0 稳定版，完整逐成员记录见 [Microsoft Learn server 更新日志](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/changelog?view=minecraft-bedrock-stable)：

- Dimension.cloneBlocks、CloneMode、BlockQueryOptions，以及 BlockVolumeBase.getClosest/getFarthest。
- 驯服事件与 EntityTamedEventOptions、开始/停止潜行事件，以及 Player.fogSettings。
- BlockDynamicPropertiesComponent、ItemBlockDynamicPropertiesComponent、Camera.addShake/stopShaking 与 PrimitiveShapesManager.getShapes。

新结构格式仍可读取 v1，并在下次保存时升级为 v2。本模组通过 structureManager 保存完整物品，不自行读写结构 NBT；版本迁移不改写历史快照或回退记录。

## 已核实的依赖

以下版本已通过 npm registry 的精确版本查询确认存在，再使用 lockfile 安装。manifest 不写 npm 的游戏构建后缀。

| 用途 | package.json / package-lock.json | BP manifest |
|---|---|---|
| Server SAPI | @minecraft/server 2.11.0-beta.1.26.52-stable | 2.11.0-beta |
| Forms / UI | @minecraft/server-ui 2.3.0-beta.1.26.52-stable | 2.3.0-beta |
| 模拟玩家 | @minecraft/server-gametest 1.0.0-beta.1.26.52-stable | 1.0.0-beta |
| 原版类型枚举 | @minecraft/vanilla-data 1.26.52 | 不添加运行时依赖 |

两个包均使用 min_engine_version: [1, 26, 52]。所有上述开发依赖都精确固定，不使用 ^、~、latest 或 Preview 构建；独立版本的 @minecraft/common 保持原有 peer dependency。Beta APIs 实验继续必须开启。

核对命令示例：

    npm.cmd view @minecraft/server@2.11.0-beta.1.26.52-stable version dist.integrity peerDependencies --json
    npm.cmd view @minecraft/server-ui@2.3.0-beta.1.26.52-stable version dist.integrity peerDependencies --json
    npm.cmd view @minecraft/server-gametest@1.0.0-beta.1.26.52-stable version dist.integrity peerDependencies --json
    npm.cmd view @minecraft/vanilla-data@1.26.52 version --json

## 对实际调用的核对

使用 TypeScript AST 比较迁移前实际安装的 26.44 声明与 26.52 声明，忽略注释，只检查导出、成员和签名。不能以旧 README 的 26.33 或能力矩阵的 26.45 标记代替实际类型依赖。

| 接口范围 | 26.52 声明核对结果 | 适配决定 |
|---|---|---|
| server-gametest | 26.44 至 26.52 无导出或成员签名变化；spawnSimulatedPlayer、getPlayerSkin、PlayerSkinData、SimulatedPlayer 均保留 | 保留现有模拟玩家生命周期、动作和 Persona 实现 |
| 物品与快照 | 现有 ItemStack、Container、装备、经验、world.structureManager 调用可以通过 26.52 类型检查 | 不修改 41 槽映射、ItemStack 保真策略或恢复顺序；结构 v2 和旧存档兼容必须实测 |
| 事件与指令 | startup/customCommandRegistry、worldLoad、entityDie、playerBreakBlock、playerInteractWithEntity 保留 | 保留注册与 worldLoad 后恢复边界，不提前执行需要已加载世界的操作 |
| Forms | ActionFormData、MessageFormData、ModalFormData 现有调用保留；新增项主要属于实验数据驱动 UI 选项 | 不改造现有表单，不改变等待后的重新鉴权、revision 检查与 lease 释放 |
| TeleportOptions | 新增 forceProvidedPositionOnDimensionChange?: boolean；对应精确类型没有说明默认值或完整运行语义 | 本次不猜测启用；跨维度指定坐标、末地及乘客异常列为实机验收项 |

主要接口资料：Microsoft Learn 的 [server](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/minecraft-server?view=minecraft-bedrock-stable)、[server-gametest](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server-gametest/minecraft-server-gametest?view=minecraft-bedrock-experimental)、[SimulatedPlayer](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server-gametest/simulatedplayer?view=minecraft-bedrock-experimental)、[server-ui](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server-ui/minecraft-server-ui?view=minecraft-bedrock-experimental)。这些页面持续更新，不能用其中更晚的 Preview 声明推断 26.52 支持；最终签名以本仓库固定的 npm 包 index.d.ts 为准。

### 新增或变更的接口信息

以下来自精确 26.52 类型与原先 26.44 类型的差异，供后续开发参考，不代表本次新增功能或实机认证。

- 世界时钟：WorldClock、TimeMarker、WorldClockRegistry、StartupEvent.worldClockRegistry、World.getClock() 及暂停/恢复/重启/时间标记事件。本次不把 system.currentTick 的检查点与行为调度换成可修改的世界时钟。
- POI：Dimension.poiManager、PoiManager、PoiBlockManager、PoiBlockType、PoiBlockInstance 等；无需为假人引入兴趣点系统。
- 驯服事件：EntityTamedEventFilter 替换为 EntityTamedEventOptions，EntityIsTamedComponent 新增 tamedToPlayer 与 tamedToPlayerId；本项目没有使用受影响事件过滤器。
- 移除：CompoundBlockVolume、CompoundBlockVolumeItem 及对应枚举；本项目没有导入这些类型。
- UI：ImageDetails、MessageBoxButtonOptions、MessageBox.button1WithOptions/button2WithOptions；若干数据驱动 UI 选项新增 tooltip，SliderOptions 新增 fixedFormatDigits。它们不是现有 ModalFormData 调用的强制替代。
- 其他：WorldSoundOptions.isBroadcast、TextPrimitive.lineGapHeight，以及聊天 targets 与 pack-settings 值的类型调整；本项目没有依赖受影响成员。

## 迁移范围与安全边界

- 统一 manifest、固定依赖、能力矩阵、开发约束、中英文 README 和全部语言的版本提示。
- 保留 BP/RP 与脚本模块 UUID；不清空世界动态属性、结构快照或稳定 ID，不改变 schema 与 A/B bank 恢复逻辑。
- Persona 外观复制仍仅限公开部件、手臂尺寸与颜色；经典皮肤纹理没有被此迁移解锁。
- 直接写饥饿/饱和组件与自动钓鱼继续隐藏；隐藏玩家列表、网易私有属性和 NBT 继续不受支持。
- test/bedrockCompatibility.test.ts 检查精确依赖与 lockfile、manifest 模块/引擎/包身份、安装的类型包、能力矩阵及文档/翻译基线；能力测试保留 bedrock_26_52_required 门控。

## 验证与部署

### 旧假人升级恢复修复

在本机正式版 26.52 旧世界复现了 fp0002 背包恢复回读失败。catalog 可以加载、pending=0，故不是 schema 或事务丢失。实际第 0 槽的期望/实读物品均为下界合金剑，组件包括 block_actor_dynamic_properties、durability、enchantable；原先的非堆叠物品组件白名单不包含新暴露的空 block-actor 动态属性组件，因而把相同物品误判为不可比较。

依据固定 26.52 声明中的 ItemBlockDynamicPropertiesComponent.totalByteCount()，比较器仅接纳可读取且字节数严格为 0 的该组件；非空内容不能公开枚举，仍然拒绝。耐久、附魔、名称、lore、普通动态属性和嵌套库存仍参与比较，不更改恢复顺序或丢弃历史快照。新增槽位级差异诊断和专门回归测试。

修复后的定向验收：typecheck、152 项测试和 build 全部通过；BP/RP 已同步。国际版 26.52 的同一旧世界正常保存退出后创建了独立备份，再复现并加载修复；/xiaobo:fpset 恢复普通管理界面，/xiaobo:fp_list 确认 fp0001-fp0007 全部 online。没有清空 catalog、销毁旧假人或通过跳过库存校验解除隔离。三维度传送、完整 Persona、强退事务与 watchdog 全矩阵仍需独立验收。

按顺序执行 npm run typecheck、npm test、npm run build；成功后才按开发包同步约束镜像 BP/RP，并核对目的目录的 manifest 与源文件。自动化结果和部署结果由本次任务报告说明，不代替引擎验收。

已确认本机安装了国际版 Microsoft.MinecraftUWP 1.26.5203.0。最初版本查证时仅运行网易进程；后续旧假人修复已明确选择国际版窗口执行上述定向回归。网易 Python bridge 和 Node 测试都不能代替国际版引擎验收。

实机验收矩阵见 [README 的实机发布门槛](../README.md#实机发布门槛)。旧世界库存回读误隔离修复已经通过定向实测；完整发布验收仍未完成，尤其是死亡重生、三个维度传送、Persona、物品事务中断恢复和 watchdog 调度。
