export function ok(value) {
    return { ok: true, value };
}
export function err(code, message) {
    return { ok: false, error: { code, message } };
}
