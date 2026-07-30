---
name: "Bedrock SAPI 1.26.33 Compatibility"
description: "Use when changing Minecraft Bedrock Script API code, manifests, capabilities, or @minecraft dependencies. Enforces international Bedrock SAPI rules and a 1.26.33 runtime compatibility baseline."
applyTo: "src/**/*.ts, test/**/*.ts, xiaoboFakePlayerbp/manifest.json, xiaoboFakePlayerp/manifest.json, package.json, package-lock.json"
---
# Bedrock SAPI Compatibility

## Migration References

- This project migrates the NetEase AFK fake-player add-on at `D:\MCStudioDownload\work\467359395@qq.com\Cpp\AddOn\9a9a056df0a34d3bbdc0424e7f23818a`. Use that project as the reference for gameplay scope, user-facing behavior, state transitions, and algorithmic logic only; do not copy NetEase-specific APIs or engine assumptions into this international Bedrock implementation.
- Use the international Bedrock project at `D:\Documents\mc模组\云梦假人\FlashFakePlayerPack` as the primary local reference for concrete implementation patterns and public Script API usage. Treat it as an implementation example, not compatibility proof, and adapt it to this repository's architecture and exact 1.26.33 baseline.
- Query `mcdk-assistant` whenever a Script API type, member, event, signature, execution boundary, or runtime availability is uncertain. Verify the answer against 1.26.33 documentation or type definitions before adding active code; do not guess or silently substitute another API.

- Target the international Bedrock public Script API only. Do not use NetEase APIs, private NBT, reflection, hidden GameTest behavior, or commands and fixed delays as substitutes for missing public APIs.
- Treat international Bedrock 1.26.33 as the exact project baseline, not merely a minimum runtime target. Do not leave active code, metadata, capability declarations, documentation, or acceptance criteria on 1.26.34 or another game build.
- Keep both pack manifests at `min_engine_version: [1, 26, 33]`. Keep their `@minecraft/*` module dependency versions aligned with the public API versions supported by that game build.
- Pin every `@minecraft/*` development package in `package.json` and `package-lock.json` to an existing release whose game-build suffix is exactly `1.26.33-stable`; do not use ranges or a 1.26.34 package. Verify the exact package release exists before editing. If a required 1.26.33 release cannot be verified, stop and report the blocker instead of guessing a version.
- Keep `src/domain/capabilities.ts`, [README.md](../../README.md), manifests, dependency metadata, tests, and real-game acceptance checks consistent with the 1.26.33 baseline.
- Verify every added or changed `@minecraft/*` API, event, property, enum, and manifest dependency against documentation or type definitions that apply to 1.26.33. Do not infer runtime availability from a similar name.
- The repository currently contains 1.26.34 dependency and documentation references. Treat them as migration debt to remove in the next implementation task that touches the SAPI baseline; a successful typecheck against those packages is not compatibility evidence.
- Keep Script API calls inside `src/infrastructure/sapi/` or the composition and event boundary in `src/main.ts`. Domain and application code must use the contracts in `src/application/ports.ts`.
- Record user-visible availability in `src/domain/capabilities.ts`. Keep behavior hidden or unsupported when reliable 1.26.33 public-API behavior is unverified, and update tests and documentation when capability status changes.
- After automated checks, perform or explicitly report the relevant real-game validation because Node tests cannot prove engine behavior.
