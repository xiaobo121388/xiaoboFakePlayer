import type { Result } from "../domain/results.js";
import type { RecoverySummary } from "./recoveryRunner.js";

export interface StartupRecoveryStatus {
    readonly state: "recovering" | "ready" | "blocked";
    readonly message?: string;
}

interface StartupRecoveryRunner {
    run(): Result<RecoverySummary>;
}

interface StartupRecoveryCallbacks {
    scheduleRetry(retry: () => void): void;
    updateStatus(status: StartupRecoveryStatus): void;
    onReady(summary: RecoverySummary): void;
    onBlocked(message: string): void;
}

export function startRecovery(
    recovery: StartupRecoveryRunner,
    callbacks: StartupRecoveryCallbacks,
): void {
    const attempt = (): void => {
        let result: Result<RecoverySummary>;
        try {
            result = recovery.run();
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            callbacks.updateStatus({ state: "blocked", message });
            callbacks.onBlocked(message);
            return;
        }
        if (result.ok) {
            callbacks.updateStatus({ state: "ready" });
            callbacks.onReady(result.value);
            return;
        }
        if (result.error.code === "WORLD_NOT_READY") {
            callbacks.updateStatus({ state: "recovering", message: result.error.message });
            callbacks.scheduleRetry(attempt);
            return;
        }
        callbacks.updateStatus({ state: "blocked", message: result.error.message });
        callbacks.onBlocked(result.error.message);
    };

    attempt();
}