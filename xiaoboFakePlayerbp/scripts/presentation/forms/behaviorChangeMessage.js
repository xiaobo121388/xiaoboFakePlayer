const BEHAVIOR_KINDS = ["follow", "attack", "mine", "place", "use", "projectileClaim"];
export function behaviorChangeMessage(name, previous, current) {
    const changes = [];
    for (const kind of BEHAVIOR_KINDS) {
        if (JSON.stringify(previous[kind]) === JSON.stringify(current[kind]))
            continue;
        const translationKey = kind === "projectileClaim" ? "projectile_claim" : kind;
        changes.push({ text: "\n- " }, {
            translate: previous[kind].enabled === current[kind].enabled
                ? "xiaobo.fp.message.behavior_updated"
                : current[kind].enabled
                    ? "xiaobo.fp.message.behavior_enabled"
                    : "xiaobo.fp.message.behavior_disabled",
            with: { rawtext: [{ translate: `xiaobo.fp.form.behavior.${translationKey}` }] },
        });
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
//# sourceMappingURL=behaviorChangeMessage.js.map