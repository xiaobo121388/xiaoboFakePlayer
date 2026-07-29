import { BankedJsonStore } from "./bankedJsonStore.js";
import { catalogCodec, operationsCodec, permissionCodec } from "./codecs.js";
export class BankedWorldStateStore {
    catalog;
    permissions;
    operations;
    constructor(backend, prefix = "xiaobo:fake_player") {
        this.catalog = new BankedJsonStore(backend, `${prefix}:catalog`, catalogCodec);
        this.permissions = new BankedJsonStore(backend, `${prefix}:permissions`, permissionCodec);
        this.operations = new BankedJsonStore(backend, `${prefix}:operations`, operationsCodec);
    }
    loadCatalog() {
        return this.catalog.load();
    }
    loadPermissions() {
        return this.permissions.load();
    }
    loadOperations() {
        return this.operations.load();
    }
    commitCatalog(expectedRevision, value) {
        return this.catalog.commit(expectedRevision, value);
    }
    commitPermissions(expectedRevision, value) {
        return this.permissions.commit(expectedRevision, value);
    }
    commitOperations(expectedRevision, value) {
        return this.operations.commit(expectedRevision, value);
    }
}
//# sourceMappingURL=bankedWorldStateStore.js.map