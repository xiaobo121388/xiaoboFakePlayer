const BEHAVIOR_KINDS = ["follow", "attack", "mine", "place", "use"];
export function behaviorChangeMessage(name, previous, current) {
    const changes = [];
    for (const kind of BEHAVIOR_KINDS) {
        if (JSON.stringify(previous[kind]) === JSON.stringify(current[kind]))
            continue;
        changes.push({ text: "\n- " }, {
            translate: previous[kind].enabled === current[kind].enabled
                ? "xiaobo.fp.message.behavior_updated"
                : current[kind].enabled
                    ? "xiaobo.fp.message.behavior_enabled"
                    : "xiaobo.fp.message.behavior_disabled",
            with: { rawtext: [{ translate: `xiaobo.fp.form.behavior.${kind}` }] },
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