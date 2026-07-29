export function startRecovery(recovery, callbacks) {
    const attempt = () => {
        let result;
        try {
            result = recovery.run();
        }
        catch (cause) {
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
//# sourceMappingURL=startupRecovery.js.map