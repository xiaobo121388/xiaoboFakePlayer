import { world } from "@minecraft/server";
export class SapiStringPropertyBackend {
    get(key) {
        const value = world.getDynamicProperty(key);
        if (value === undefined || typeof value === "string")
            return value;
        throw new TypeError(`动态属性 ${key} 不是字符串。`);
    }
    set(key, value) {
        world.setDynamicProperty(key, value);
    }
}
