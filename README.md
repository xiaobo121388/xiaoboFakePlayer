# 小波挂机假人

面向 Minecraft Bedrock 的模拟玩家管理 Add-on。你可以创建能够保存背包和状态的挂机假人，通过图形界面管理它们，并让它们执行移动、战斗、挖掘、交互和物品操作。

## 运行要求

- Minecraft Bedrock 正式版 **1.26.33**。
- 世界必须启用 **Beta APIs（测试版 API）** 实验。
- 世界中必须同时启用本模组的行为包和资源包。
- 建议先备份世界；测试版 API 和游戏版本变化都可能影响模组运行。

## 安装

1. 从本项目的 [Releases](https://github.com/xiaobo121388/xiaoboFakePlayer/releases) 下载对应版本的 `.mcaddon` 文件。
2. 使用 Minecraft 打开该文件，等待行为包和资源包均显示导入成功。
3. 创建世界或编辑已有世界，在“行为包”和“资源包”中启用“小波挂机假人”。
4. 在“实验”中启用 **Beta APIs（测试版 API）**，然后进入世界。
5. 在聊天栏输入 `/xiaobo:fpset` 打开管理界面。

更新模组前请备份世界，并先阅读对应 Release 的版本说明。不要把面向其他 Minecraft 版本的包直接覆盖到重要存档中。

## 主要功能

- 最多管理 10 个假人；每个假人都有 `fp0001` 形式的稳定 ID，重名时也能准确识别。
- 保存假人的位置、维度、朝向、游戏模式、经验、背包、装备、副手、皮肤、复活规则和行为设置。
- 支持安全上线、下线、重命名、复活、传送、资源回收和彻底删除。
- 支持 41 个物品槽：背包与快捷栏 0-35、头胸腿脚 36-39、副手 40。
- 可在玩家与假人之间交换背包、装备、主手、副手或单个槽位，并转移物品和经验。
- 可执行看向、移动、导航、跳跃、潜行、攻击、挖掘、使用物品、方块交互和实体交互。
- 可设置跟随、自动攻击、自动挖掘、自动交互、定时使用物品，以及“三叉戟、箭挂机”等持续行为。
- 可复制在线玩家的 Persona 外观；经典皮肤纹理无法复制时会使用默认皮肤。
- 空手对在线假人使用交互键，可直接打开该假人的设置界面。
- 提供 OP 恢复中心；遇到中断的物品操作时，可以继续恢复而不是直接覆盖物品。

## 权限

| 身份/授权 | 能力 |
|---|---|
| OP | 始终拥有全部能力，可管理授权、恢复和诊断 |
| `can_place` | 只允许创建假人 |
| `can_set` | 允许查看和管理全部假人，包括行为、背包和生命周期 |
| 未授权玩家 | 不能创建或管理假人 |

权限由 OP 授予，并按真人玩家的 PlayFab ID 保存；玩家改名不会丢失或绕过权限。模拟玩家不会出现在授权目标列表中。

## 指令说明

图形界面是日常管理的推荐入口；以下 29 条指令是本模组当前注册的全部指令。

- `<参数>` 表示必填，`[参数]` 表示可选；输入时不要保留尖括号或方括号。
- `<id或名称>` 可以填写稳定 ID 或完整名称，建议优先使用 `/xiaobo:fp_list` 显示的 `fp0001` 类 ID。名称包含空格时要用英文双引号包住。
- 坐标支持绝对坐标和 `~` 相对坐标，并以命令执行者当前所在维度为准；相关区块必须已加载。
- `<实体选择器>` 必须恰好选中一个有效实体，例如 `@e[type=minecraft:zombie,r=10,c=1]`。
- `<槽位>` 的范围是 0-40：背包与快捷栏 0-35、头胸腿脚 36-39、副手 40。
- `<方块面>` 可用 `down`、`east`、`north`、`south`、`up` 或 `west`。
- `[速度]` 的范围是 0-1，省略时为 1。
- 指令只能由真人玩家执行，并遵循上方的 `can_place`、`can_set` 和 OP 权限。

### 管理指令

| 指令 | 用法 |
|---|---|
| `/xiaobo:fpset` | 打开挂机假人管理界面。 |
| `/xiaobo:fp_spawn [名称] [游戏模式] [皮肤]` | 在自己所在位置创建假人。名称默认“假人”；游戏模式可用 `survival`、`creative`、`adventure`、`spectator`，默认 `survival`；皮肤可用 `default` 或 `copy_actor`，默认 `default`。 |
| `/xiaobo:fp_list` | 列出所有假人的稳定 ID、名称、在线状态、维度和保存位置。 |
| `/xiaobo:fp_online <id或名称> [saved\|here]` | 让假人在保存位置上线；填写 `here` 时改为在执行者当前位置上线。 |
| `/xiaobo:fp_offline <id或名称>` | 保存假人当前状态和物品后安全下线。 |
| `/xiaobo:fp_rename <id或名称> <新名称>` | 重命名假人；新名称包含空格时使用英文双引号。 |
| `/xiaobo:fp_delete <id或名称> [recycle\|purge]` | 删除已下线的假人。默认 `recycle`，先把物品和经验交给执行者；`purge` 会彻底销毁记录和快照，无法撤销。 |
| `/xiaobo:fp_respawn <id或名称>` | 手动复活处于死亡状态的假人。 |
| `/xiaobo:fp_respawnrule <id或名称> <death_location\|manual\|player_spawn>` | 设置复活位置：死亡地点、设置 `manual` 时执行者所在的位置，或玩家出生点。 |
| `/xiaobo:fp_permission <玩家选择器> <can_place\|can_set> <on\|off>` | 仅 OP 可用。为恰好一名在线真人授予或撤销权限。 |
| `/xiaobo:fp_recovery` | 仅 OP 可用。打开待恢复物品操作中心。 |
| `/xiaobo:fp_diagnose [id或名称]` | 仅 OP 可用。查看系统状态；可选填一个假人以缩小输出范围。 |

### 即时动作指令

这些指令要求目标假人在线。攻击、挖掘、使用或交互可能改变物品时，模组会随后保存背包状态。

| 指令 | 用法 |
|---|---|
| `/xiaobo:fp_lookat <id或名称> <x y z>` | 让假人看向同维度坐标。 |
| `/xiaobo:fp_navigate <id或名称> <x y z> [速度]` | 使用寻路移动到同维度坐标。 |
| `/xiaobo:fp_move <id或名称> <x y z> [速度]` | 直线移动到同维度坐标，不进行完整寻路。 |
| `/xiaobo:fp_rotate <id或名称> <角度>` | 按给定角度相对旋转。正负数表示相反方向。 |
| `/xiaobo:fp_setrotation <id或名称> <角度>` | 将身体朝向设置为给定绝对角度。 |
| `/xiaobo:fp_tp_here <id或名称>` | 将假人传送到执行者当前位置和维度。 |
| `/xiaobo:fp_jump <id或名称>` | 让假人跳跃一次。 |
| `/xiaobo:fp_sneak <id或名称> <on\|off>` | 开启或关闭潜行状态。 |
| `/xiaobo:fp_stop <id或名称>` | 停止当前移动、导航、挖掘或其他即时动作。 |
| `/xiaobo:fp_useitem <id或名称> <槽位>` | 使用指定真实物品槽中的物品。 |
| `/xiaobo:fp_break <id或名称> <x y z> <方块面>` | 挖掘同维度、可见且在交互距离内的固体方块。 |
| `/xiaobo:fp_interactblock <id或名称> <x y z> <方块面>` | 与同维度、可见且在交互距离内的方块交互。 |
| `/xiaobo:fp_useitemonblock <id或名称> <槽位> <x y z> <方块面>` | 使用指定槽位中的物品作用于目标方块。 |
| `/xiaobo:fp_attack <id或名称> <实体选择器>` | 攻击恰好一个同维度、可见且在攻击距离内的实体。 |
| `/xiaobo:fp_interactentity <id或名称> <实体选择器>` | 与恰好一个同维度、可见且在 10 格内的实体交互。 |
| `/xiaobo:fp_lookatentity <id或名称> <实体选择器>` | 让假人看向恰好一个同维度、可见且在交互距离内的实体。 |
| `/xiaobo:fp_follow <id或名称> <实体选择器> [速度]` | 让假人寻路接近恰好一个同维度实体。持续跟随请在图形界面的自动行为中设置。 |

### 指令示例

```text
/xiaobo:fp_spawn "刷铁机 假人" survival copy_actor
/xiaobo:fp_online fp0001 here
/xiaobo:fp_navigate fp0001 ~10 ~ ~-5 0.8
/xiaobo:fp_interactentity fp0001 @e[type=minecraft:cow,r=10,c=1]
/xiaobo:fp_permission @a[name=Steve] can_set on
```

## 存档与物品安全

- 定期备份世界，尤其是在更新 Minecraft、更新模组、转移大量物品或调整实验选项之前。
- 退出世界时请使用游戏内正常的“保存并退出”，不要直接结束游戏进程。强制退出可能使假人刚刚发生的背包变化回退到最近一次已保存的检查点。
- 不要手动删除本模组创建的结构、世界动态属性或假人标签实体，否则可能导致背包快照无法恢复。
- 删除假人时优先使用默认的 `recycle`。只有确认不需要其物品、经验和快照时，才使用不可撤销的 `purge`。
- 如果操作中途退出，先让 OP 打开 `/xiaobo:fp_recovery`；不要反复删除、重建或覆盖同一个假人。
- 系统显示“正在恢复”时请等待相关区块加载。显示“只读隔离”时，可由 OP 使用 `/xiaobo:fp_diagnose` 查看原因。
- 卸载模组或回退版本前先让重要假人安全下线，并保存一份独立世界备份。

## 使用限制

- 当前版本只面向 Minecraft Bedrock 1.26.33；其他版本不保证可用。
- 经典皮肤的纹理无法复制；`copy_actor` 主要用于 Persona 外观，无法复制时会回退到默认皮肤。
- 自动钓鱼、隐藏玩家列表、网易版私有属性和私有 NBT 不受支持。
- 假人不会自行加载无限远区块。目标区块未加载、目标不在同一维度或距离过远时，相关操作会失败。
- 当前主要面向本地世界和房主联机场景，不承诺 Realm、Dedicated Server 或没有真人在线时的长期区块加载。

## 开源协议与致谢

Copyright (C) 2026 xiaobo

本项目原创代码与资源采用 [GNU General Public License v3.0](LICENSE)，SPDX 标识为 `GPL-3.0-only`。发行的 `.mcaddon` 属于可执行形式；对应版本的完整源码可在本项目同版本 Release 或 Git 仓库中获取。

再分发原版或修改版时，请同时：

- 保留 GPLv3 许可证、版权声明和 [第三方声明](THIRD_PARTY_NOTICES.md)。
- 依照 GPLv3 向接收者提供对应源码，并让修改后的整体继续采用 GPLv3。
- 明确标注你修改过的内容和修改日期，不要冒充原作者发布。
- 不要把未获得许可的第三方代码或资源加入发行包。

本模组在设计与实现过程中参考了以下项目：

- [ForestOfLight/Understudy](https://github.com/ForestOfLight/Understudy)，由 ForestOfLight 以 MIT License 发布。再分发其代码或实质性部分时必须保留其版权与 MIT 许可声明。
- [xBoyMinemc/FlashFakePlayerPack](https://github.com/xBoyMinemc/FlashFakePlayerPack)。

完整的第三方版权与许可文本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目与 Mojang Studios 或 Microsoft 无隶属或背书关系。
