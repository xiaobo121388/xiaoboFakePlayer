import { err, ok } from "../domain/results.js";
export class OperationCoordinator {
    heldKeys = new Set();
    tryAcquire(resourceKeys) {
        const keys = Array.from(new Set(resourceKeys)).sort();
        if (keys.length === 0)
            return err("INVALID_STATE", "操作至少需要一个资源键。");
        const busyKey = keys.find((key) => this.heldKeys.has(key));
        if (busyKey !== undefined)
            return err("CONFLICT", `资源 ${busyKey} 正在被其他操作使用。`);
        keys.forEach((key) => this.heldKeys.add(key));
        let released = false;
        return ok({
            keys,
            release: () => {
                if (released)
                    return;
                released = true;
                keys.forEach((key) => this.heldKeys.delete(key));
            },
        });
    }
}
