# Changelog

<p align="center">
  <a href="CHANGELOG.md">简体中文</a> | <strong>English</strong>
</p>

This file records the important player-facing changes in each stable release of Xiaobo Fake Player.

## [1.3.0] - 2026-10-13

### Compatibility

- The runtime baseline is now Minecraft Bedrock release 26.52. The Beta APIs experiment remains required.
- Pin server, server-ui, and server-gametest types to matching 1.26.52-stable builds and vanilla type data to 1.26.52.
- Align the capability matrix, development rules, and all localized version notices with this baseline.

### Fixed

- Fix false inventory readback failures and read-only isolation after upgrading older fake players when nonstackable items expose an empty block-actor dynamic-property component.
- Accept that component only when its byte count is readable and exactly zero. Nonempty or unreadable data still fails closed; durability, enchantments, and other metadata remain checked.
- Report the first differing slot, item type, and field names after an inventory readback failure without exposing item names, book contents, or dynamic-property values.

### Verification

- Add focused regression coverage for game/API baselines, release-version consistency, and item comparisons.
- Verify upgrade recovery in an existing world on international Bedrock 26.52: the normal management menu returns and fp0001-fp0007 are online. The full real-game acceptance matrix remains in the README.

### Upgrade Notes

- Set the project, BP, RP, modules, and BP-to-RP dependency versions to 1.3.0 without changing pack UUIDs or world schemas.
- Back up the world and replace both packs together. The minimum engine version is 1.26.52.
- Worlds isolated by the empty-component comparison bug recover automatically after loading the update; deleting old fake players or clearing inventories is not required. Actual corruption, unknown components, and inventory conflicts remain isolated.

## [1.1.0] - 2026-08-01

### Added

- Added coordinate look controls. The management UI and `/xiaobo:fp_lookat <id or name> <x y z>` can now make a fake player look at absolute or `~` relative coordinates in the same dimension.
- Automatic attack now scans inventory and hotbar slots 0-35, equips the weapon with the highest normal melee damage, and includes Sharpness damage. Ties keep the selected weapon, then prefer the lower slot.
- Automatic mining now remembers the held tool category. When a tool is exhausted, it selects the tool of the same category with the most durability remaining from inventory and hotbar slots 0-35.
- Added an operator repair UI for read-only isolation. While the system is isolated, `/xiaobo:fpset` or `/xiaobo:fp_recovery` can select an exceptional fake-player record or a tagged orphan entity, remove it after a second confirmation, and automatically retry startup recovery.

### Changed

- Repair operations now use a recoverable lifecycle, allowing an interrupted repair to continue on the next startup.
- The repair UI distinguishes repairable targets from unreadable underlying state. It will not guess which data to delete when the catalog or transaction A/B banks are corrupt.

### Fixed

- Fixed vertical look calculations when a fake player looks straight up or down.
- Fixed imprecise fake-player spawn positions by teleporting the player to the exact requested coordinates after spawning.

### Upgrade Notes

- The behavior pack, resource pack, modules, and BP-to-RP dependency versions are now `1.1.0`.
- Replace both the BP and RP when upgrading so their dependency versions remain consistent.
- Deleting a target through read-only isolation repair permanently discards its items, experience, snapshots, and settings. Back up the world before proceeding.
