---
name: "Bedrock Development Pack Sync"
description: "Use when finishing changes to this add-on, building runtime scripts, or preparing Minecraft Bedrock testing. Requires validated BP and RP copies in the local development pack directories."
applyTo: "src/**, xiaoboFakePlayerbp/**, xiaoboFakePlayerp/**, package.json, package-lock.json, tsconfig*.json"
---
# Development Pack Sync

- After the requested file changes pass their required checks, run `npm run build` so `xiaoboFakePlayerbp/scripts/` matches `src/`.
- Then mirror the complete pack directories, including deletions, to:
  - BP: `C:\Users\xiaobo\AppData\Roaming\Minecraft Bedrock\Users\Shared\games\com.mojang\development_behavior_packs\xiaoboFakePlayerbp`
  - RP: `C:\Users\xiaobo\AppData\Roaming\Minecraft Bedrock\Users\Shared\games\com.mojang\development_resource_packs\xiaoboFakePlayerp`
- Use Windows `robocopy <source> <destination> /MIR` for each pack. Treat exit codes 0 through 7 as success and 8 or higher as failure.
- Never reverse the copy direction. The repository is authoritative; do not copy development-pack contents back into the repository.
- Do not deploy failed builds or failed tests. If validation or copying is blocked, leave the existing development packs untouched when possible and report the exact blocker.
- Verify both destination `manifest.json` files after copying, and report the deployment result in the final response.
