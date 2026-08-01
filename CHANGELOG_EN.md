# Changelog

<p align="center">
  <a href="CHANGELOG.md">简体中文</a> | <strong>English</strong>
</p>

This file records the important player-facing changes in each stable release of Xiaobo Fake Player.

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
