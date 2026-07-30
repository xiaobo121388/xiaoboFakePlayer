import type { RawMessage } from "@minecraft/server";

import type { BehaviorConfig } from "../../domain/model.js";

const BEHAVIOR_KINDS = ["follow", "attack", "mine", "place", "use"] as const;

export function behaviorChangeMessage(
    name: string,
    previous: BehaviorConfig,
    current: BehaviorConfig,
): RawMessage | undefined {
    const changes: RawMessage[] = [];
    for (const kind of BEHAVIOR_KINDS) {
        if (JSON.stringify(previous[kind]) === JSON.stringify(current[kind])) continue;
        changes.push(
            { text: "\n- " },
            {
                translate: previous[kind].enabled === current[kind].enabled
                    ? "xiaobo.fp.message.behavior_updated"
                    : current[kind].enabled
                        ? "xiaobo.fp.message.behavior_enabled"
                        : "xiaobo.fp.message.behavior_disabled",
                with: { rawtext: [{ translate: `xiaobo.fp.form.behavior.${kind}` }] },
            },
        );
    }
    return changes.length === 0
        ? undefined
        : {
            rawtext: [
                { translate: "xiaobo.fp.message.behavior_changed", with: [name] },
                ...changes,
            ],
        };
}