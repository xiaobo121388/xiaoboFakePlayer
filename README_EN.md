# Xiaobo Fake Player

<p align="center">
  <a href="README.md">简体中文</a> | <strong>English</strong>
</p>

A simulated-player management add-on for Minecraft Bedrock. You can create persistent fake players whose inventories and states are saved, manage them through graphical menus, and have them move, fight, mine, interact, and use items.

## Requirements

- Minecraft Bedrock release **1.26.33**.
- The world must have the **Beta APIs** experiment enabled.
- Both the behavior pack and resource pack must be enabled in the world.
- Back up your world first. Changes to Beta APIs or the game version may affect the add-on.

## Installation

1. Download the `.mcaddon` file for your version from the project's [Releases](https://github.com/xiaobo121388/xiaoboFakePlayer/releases) page.
2. Open the file with Minecraft and wait for both the behavior pack and resource pack to import successfully.
3. Create a world or edit an existing one, then enable "Xiaobo Fake Player" under both Behavior Packs and Resource Packs.
4. Enable **Beta APIs** under Experiments, then enter the world.
5. Enter `/xiaobo:fpset` in chat to open the management menu.

Back up your world and read the release notes before updating the add-on. Do not install a package intended for another Minecraft version over an important world.

## Features

- Manage up to 10 fake players. Each fake player has a stable ID such as `fp0001`, so duplicate names remain unambiguous.
- Save each fake player's position, dimension, rotation, game mode, experience, inventory, equipment, offhand item, skin, respawn rule, and behavior settings.
- Safely bring fake players online or offline, rename, respawn, teleport, recycle their resources, or permanently delete them.
- Support all 41 item slots: inventory and hotbar slots 0-35, head/chest/legs/feet slots 36-39, and offhand slot 40.
- Exchange inventories, equipment, mainhand items, offhand items, or individual slots between a real player and a fake player, and transfer items or experience.
- Look, move, navigate, jump, sneak, attack, mine, use items, interact with blocks, and interact with entities.
- Configure persistent behaviors including following, automatic attacking, automatic mining, automatic interaction, timed item use, and trident/arrow ownership.
- Copy an online player's Persona appearance. The default skin is used when a classic skin texture cannot be copied.
- Interact with an online fake player while empty-handed to open that fake player's settings directly.
- Use the operator recovery center to resume interrupted item operations instead of overwriting items.

## Permissions

| Role/permission | Capabilities |
|---|---|
| Operator | Always has full access, including permission management, recovery, and diagnostics |
| `can_place` | May only create fake players |
| `can_set` | May view and manage every fake player, including behavior, inventory, and lifecycle operations |
| Unauthorized player | Cannot create or manage fake players |

Permissions are granted by an operator and stored against each real player's PlayFab ID. Renaming a player neither removes nor bypasses permissions. Simulated players are not shown in the authorization target list.

## Command Guide

The graphical menus are recommended for everyday management. The following 29 commands are all commands currently registered by this add-on.

- `<argument>` indicates a required argument and `[argument]` indicates an optional argument. Do not type the angle or square brackets.
- `<id or name>` accepts either a stable ID or a full name. Prefer an ID such as `fp0001` shown by `/xiaobo:fp_list`. Wrap names containing spaces in straight double quotes.
- Coordinates may be absolute or relative with `~`. They use the command executor's current dimension, and the relevant chunks must be loaded.
- `<entity selector>` must select exactly one valid entity, for example `@e[type=minecraft:zombie,r=10,c=1]`.
- `<slot>` ranges from 0 through 40: inventory and hotbar slots 0-35, head/chest/legs/feet slots 36-39, and offhand slot 40.
- `<block face>` may be `down`, `east`, `north`, `south`, `up`, or `west`.
- `[speed]` ranges from 0 through 1 and defaults to 1 when omitted.
- Commands can only be executed by real players and are subject to the `can_place`, `can_set`, and operator permissions described above.

### Management Commands

| Command | Usage |
|---|---|
| `/xiaobo:fpset` | Open the fake-player management menu. |
| `/xiaobo:fp_spawn [name] [game mode] [skin]` | Create a fake player at your location. The name defaults to `假人`. Game mode may be `survival`, `creative`, `adventure`, or `spectator` and defaults to `survival`. Skin may be `default` or `copy_actor` and defaults to `default`. |
| `/xiaobo:fp_list` | List every fake player's stable ID, name, online state, dimension, and saved position. |
| `/xiaobo:fp_online <id or name> [saved\|here]` | Bring a fake player online at its saved position, or at the executor's current position when `here` is specified. |
| `/xiaobo:fp_offline <id or name>` | Save the fake player's current state and items, then take it safely offline. |
| `/xiaobo:fp_rename <id or name> <new name>` | Rename a fake player. Wrap a new name containing spaces in straight double quotes. |
| `/xiaobo:fp_delete <id or name> [recycle\|purge]` | Delete an offline fake player. The default `recycle` mode gives its items and experience to the executor first. `purge` permanently destroys its record and snapshots and cannot be undone. |
| `/xiaobo:fp_respawn <id or name>` | Manually respawn a fake player that is in the dead state. |
| `/xiaobo:fp_respawnrule <id or name> <death_location\|manual\|player_spawn>` | Set the respawn position to the death location, the executor's current position when choosing `manual`, or the player spawn point. |
| `/xiaobo:fp_permission <player selector> <can_place\|can_set> <on\|off>` | Operators only. Grant or revoke a permission for exactly one online real player. |
| `/xiaobo:fp_recovery` | Operators only. Open the recovery center for pending item operations. |
| `/xiaobo:fp_diagnose [id or name]` | Operators only. View system status, optionally limited to one fake player. |

### Immediate Action Commands

These commands require the target fake player to be online. The add-on subsequently saves inventory state when attacking, mining, using an item, or interacting may have changed items.

| Command | Usage |
|---|---|
| `/xiaobo:fp_lookat <id or name> <x y z>` | Make the fake player look at coordinates in the same dimension. |
| `/xiaobo:fp_navigate <id or name> <x y z> [speed]` | Pathfind to coordinates in the same dimension. |
| `/xiaobo:fp_move <id or name> <x y z> [speed]` | Move directly toward coordinates in the same dimension without full pathfinding. |
| `/xiaobo:fp_rotate <id or name> <angle>` | Rotate by a relative angle. Positive and negative values turn in opposite directions. |
| `/xiaobo:fp_setrotation <id or name> <angle>` | Set the body to an absolute rotation angle. |
| `/xiaobo:fp_tp_here <id or name>` | Teleport the fake player to the executor's current position and dimension. |
| `/xiaobo:fp_jump <id or name>` | Make the fake player jump once. |
| `/xiaobo:fp_sneak <id or name> <on\|off>` | Start or stop sneaking. |
| `/xiaobo:fp_stop <id or name>` | Stop the current movement, navigation, mining, or other immediate action. |
| `/xiaobo:fp_useitem <id or name> <slot>` | Use the item in the specified real inventory slot. |
| `/xiaobo:fp_break <id or name> <x y z> <block face>` | Mine a solid block that is in the same dimension, visible, and within interaction range. |
| `/xiaobo:fp_interactblock <id or name> <x y z> <block face>` | Interact with a block that is in the same dimension, visible, and within interaction range. |
| `/xiaobo:fp_useitemonblock <id or name> <slot> <x y z> <block face>` | Use the item in the specified slot on the target block. |
| `/xiaobo:fp_attack <id or name> <entity selector>` | Attack exactly one entity that is in the same dimension, visible, and within attack range. |
| `/xiaobo:fp_interactentity <id or name> <entity selector>` | Interact with exactly one entity that is in the same dimension, visible, and within 10 blocks. |
| `/xiaobo:fp_lookatentity <id or name> <entity selector>` | Look at exactly one entity that is in the same dimension, visible, and within interaction range. |
| `/xiaobo:fp_follow <id or name> <entity selector> [speed]` | Pathfind toward exactly one entity in the same dimension. Configure persistent following in the graphical behavior settings. |

### Command Examples

```text
/xiaobo:fp_spawn "Iron Farm Bot" survival copy_actor
/xiaobo:fp_online fp0001 here
/xiaobo:fp_navigate fp0001 ~10 ~ ~-5 0.8
/xiaobo:fp_interactentity fp0001 @e[type=minecraft:cow,r=10,c=1]
/xiaobo:fp_permission @a[name=Steve] can_set on
```

## World and Item Safety

- Back up your world regularly, especially before updating Minecraft or the add-on, transferring many items, or changing experiments.
- Leave the world using the normal Save & Quit option instead of terminating the game process. A forced exit may roll back recent fake-player inventory changes to the latest saved checkpoint.
- Do not manually delete structures, world dynamic properties, or tagged fake-player entities created by this add-on, as doing so may prevent inventory snapshots from being recovered.
- Prefer the default `recycle` mode when deleting a fake player. Use the irreversible `purge` mode only after confirming that its items, experience, and snapshots are no longer needed.
- If an operation is interrupted, ask an operator to open `/xiaobo:fp_recovery` first. Do not repeatedly delete, recreate, or overwrite the same fake player.
- Wait for the relevant chunks to load while the system reports that it is recovering. If it reports read-only isolation, an operator can use `/xiaobo:fp_diagnose` to inspect the reason.
- Before uninstalling the add-on or rolling back to an earlier version, safely take important fake players offline and make a separate world backup.

## Limitations

- The current version targets Minecraft Bedrock 1.26.33 only. Other versions are not guaranteed to work.
- Classic skin textures cannot be copied. `copy_actor` is intended primarily for Persona appearances and falls back to the default skin when copying is unavailable.
- Automatic fishing, hiding fake players from the player list, NetEase-only private properties, and private NBT are not supported.
- Fake players do not load chunks at unlimited distances. Actions fail when a target chunk is unloaded, a target is in another dimension, or a target is too far away.
- The add-on primarily targets local worlds and host-led multiplayer. Long-term chunk loading on Realms, Dedicated Servers, or without a real player online is not guaranteed.

## License and Acknowledgements

Copyright (C) 2026 xiaobo

The original code and assets in this project are licensed under the [GNU General Public License v3.0](LICENSE), with the SPDX identifier `GPL-3.0-only`. A distributed `.mcaddon` is an executable form; the complete corresponding source for each version is available from the matching project Release or Git repository revision.

When redistributing the original or a modified version, you must also:

- Preserve the GPLv3 license, copyright notice, and [third-party notices](THIRD_PARTY_NOTICES.md).
- Provide recipients with the corresponding source as required by GPLv3, and keep the modified work as a whole under GPLv3.
- Clearly identify your modifications and their dates, and do not present yourself as the original author.
- Do not include third-party code or assets that you are not authorized to distribute.

This add-on took design and implementation references from the following projects:

- [ForestOfLight/Understudy](https://github.com/ForestOfLight/Understudy), released by ForestOfLight under the MIT License. Redistributions of its code or substantial portions must preserve its copyright and MIT license notice.
- [xBoyMinemc/FlashFakePlayerPack](https://github.com/xBoyMinemc/FlashFakePlayerPack).

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the complete third-party copyright and license texts. This project is not affiliated with or endorsed by Mojang Studios or Microsoft.