import { world } from "@minecraft/server";

import type { StringPropertyBackend } from "./bankedJsonStore.js";

export class SapiStringPropertyBackend implements StringPropertyBackend {
    public get(key: string): string | undefined {
        const value = world.getDynamicProperty(key);
        if (value === undefined || typeof value === "string") return value;
        throw new TypeError(`动态属性 ${key} 不是字符串。`);
    }

    public set(key: string, value: string): void {
        world.setDynamicProperty(key, value);
    }
}