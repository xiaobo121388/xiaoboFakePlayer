import type { WorldStateStore } from "../../application/ports.js";
import type { PendingOperations, PermissionTable, WorldCatalog } from "../../domain/model.js";
import { BankedJsonStore, type StringPropertyBackend } from "./bankedJsonStore.js";
import { catalogCodec, operationsCodec, permissionCodec } from "./codecs.js";

export class BankedWorldStateStore implements WorldStateStore {
    private readonly catalog: BankedJsonStore<WorldCatalog>;
    private readonly permissions: BankedJsonStore<PermissionTable>;
    private readonly operations: BankedJsonStore<PendingOperations>;

    public constructor(backend: StringPropertyBackend, prefix = "xiaobo:fake_player") {
        this.catalog = new BankedJsonStore(backend, `${prefix}:catalog`, catalogCodec);
        this.permissions = new BankedJsonStore(backend, `${prefix}:permissions`, permissionCodec);
        this.operations = new BankedJsonStore(backend, `${prefix}:operations`, operationsCodec);
    }

    public loadCatalog() {
        return this.catalog.load();
    }

    public loadPermissions() {
        return this.permissions.load();
    }

    public loadOperations() {
        return this.operations.load();
    }

    public commitCatalog(expectedRevision: number, value: WorldCatalog) {
        return this.catalog.commit(expectedRevision, value);
    }

    public commitPermissions(expectedRevision: number, value: PermissionTable) {
        return this.permissions.commit(expectedRevision, value);
    }

    public commitOperations(expectedRevision: number, value: PendingOperations) {
        return this.operations.commit(expectedRevision, value);
    }
}