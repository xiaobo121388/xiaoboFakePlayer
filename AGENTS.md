# Agent Guidelines

## Start Here

- Use Node.js 22 or newer and install dependencies with `npm ci`.
- Treat `src/**/*.ts` as source. `npm run build` overwrites the checked-in runtime JavaScript under `xiaoboFakePlayerbp/scripts/`; never edit that generated directory by hand.
- Keep NodeNext ESM imports ending in `.js`, including imports written in TypeScript and tests.
- Follow [.github/instructions/bedrock-sapi-1-26-30.instructions.md](.github/instructions/bedrock-sapi-1-26-30.instructions.md) and keep the entire project exactly aligned with international Bedrock 1.26.30.

## Validate Changes

- Run `npm run typecheck`, then `npm test`, then `npm run build` for code changes.
- Tests use the Node.js built-in test runner. Add focused `test/*.test.ts` coverage for changed domain, application, or state behavior; there is no Jest, Vitest, lint, or format script.
- A successful automated run does not validate Minecraft engine behavior. Changes to Script API calls, inventory fidelity, simulated-player lifecycle, Persona data, dimensions, watchdog-sensitive scheduling, manifests, or dependency versions require Bedrock 1.26.30 real-game checks.
- After successful validation, mirror both packs to the local Minecraft development directories as specified in [.github/instructions/bedrock-development-pack-sync.instructions.md](.github/instructions/bedrock-development-pack-sync.instructions.md).

## Preserve Boundaries

- Follow the dependency direction in [docs/architecture.md](docs/architecture.md): presentation -> application -> domain, infrastructure -> application, and `src/main.ts` as the composition root and SAPI event-subscription boundary.
- Keep `src/domain/` free of `@minecraft/*` imports and engine objects. Define external contracts in `src/application/ports.ts`; keep `Player`, `SimulatedPlayer`, `ItemStack`, and other SAPI values inside infrastructure.
- Return the discriminated `Result<T>` and existing error codes from `src/domain/results.ts` for expected domain failures. At SAPI boundaries, add operation and stable-ID context to unknown engine exceptions and rethrow them for the command, form, startup, or tick boundary to log.
- Route concurrent writes through `OperationCoordinator`, reacquire authorization and record revision after form waits, and always release acquired leases.
- Treat `src/domain/capabilities.ts` as the source of truth for user-visible feature availability. Do not expose hidden or unsupported capabilities through commands or forms, and do not substitute commands, reflection, fixed delays, private NBT, or NetEase-only APIs for missing public Script API behavior.

## Data Safety

- Preserve the recovery, A/B bank, lifecycle, 41-slot snapshot, and transaction invariants documented in [docs/architecture.md](docs/architecture.md). Recovery paths must remain idempotent; never resolve mixed or corrupt state by overwriting it with empty defaults.
- Keep stable IDs, record revisions, operation phases, complete before/after images, and verified snapshot ordering intact when changing lifecycle or inventory flows.
- Update [README.md](README.md) when commands, permissions, supported capabilities, runtime requirements, or the real-device acceptance matrix change.
