export type DomainErrorCode =
    | "CONFLICT"
    | "DATA_CAPACITY"
    | "INVALID_NAME"
    | "INVALID_SLOT"
    | "INVALID_STATE"
    | "NOT_FOUND"
    | "PERMISSION_DENIED"
    | "STALE_REVISION"
    | "WORLD_NOT_READY";

export interface DomainError {
    readonly code: DomainErrorCode;
    readonly message: string;
}

export type Result<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: DomainError };

export function ok<T>(value: T): Result<T> {
    return { ok: true, value };
}

export function err<T>(code: DomainErrorCode, message: string): Result<T> {
    return { ok: false, error: { code, message } };
}