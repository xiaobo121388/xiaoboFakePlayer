import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { CAPABILITY_MATRIX } from "../src/domain/capabilities.js";

interface PackageMetadata {
    readonly version: string;
    readonly devDependencies: Readonly<Record<string, string>>;
}

interface Lockfile {
    readonly version: string;
    readonly packages: Readonly<Record<string, {
        readonly version?: string;
        readonly devDependencies?: Readonly<Record<string, string>>;
    }>>;
}

interface PackManifest {
    readonly header: {
        readonly min_engine_version: readonly number[];
        readonly uuid: string;
        readonly version: readonly number[];
    };
    readonly modules: readonly { readonly version: readonly number[] }[];
    readonly dependencies?: readonly {
        readonly module_name?: string;
        readonly uuid?: string;
        readonly version: string | readonly number[];
    }[];
}

// npm test runs the compiled tests from .test-dist/test.
const REPOSITORY_ROOT = new URL("../../", import.meta.url);
const GAME_BUILD_SUFFIX = ".1.26.52-stable";
const API_PACKAGES = {
    "@minecraft/server": "2.11.0-beta.1.26.52-stable",
    "@minecraft/server-ui": "2.3.0-beta.1.26.52-stable",
    "@minecraft/server-gametest": "1.0.0-beta.1.26.52-stable",
} as const;

function readJson<T>(file: string): T {
    return JSON.parse(readFileSync(new URL(file, REPOSITORY_ROOT), "utf8")) as T;
}

test("the 1.3.0 add-on version matches npm metadata and every pack version", () => {
    const metadata = readJson<PackageMetadata>("package.json");
    const lockfile = readJson<Lockfile>("package-lock.json");
    const behavior = readJson<PackManifest>("xiaoboFakePlayerbp/manifest.json");
    const resources = readJson<PackManifest>("xiaoboFakePlayerp/manifest.json");
    assert.equal(metadata.version, "1.3.0");
    assert.equal(lockfile.version, metadata.version);
    assert.equal(lockfile.packages[""]?.version, metadata.version);
    for (const manifest of [behavior, resources]) {
        assert.deepEqual(manifest.header.version, [1, 3, 0]);
        assert.equal(manifest.header.version.join("."), metadata.version);
        for (const module of manifest.modules) {
            assert.deepEqual(module.version, manifest.header.version);
        }
    }
    assert.deepEqual(
        behavior.dependencies?.find((entry) => entry.uuid === resources.header.uuid)?.version,
        resources.header.version,
    );
});

test("Minecraft development dependencies and lockfile are pinned to the verified 26.52 releases", () => {
    const metadata = readJson<PackageMetadata>("package.json");
    const lockfile = readJson<Lockfile>("package-lock.json");
    const expected = { ...API_PACKAGES, "@minecraft/vanilla-data": "1.26.52" };
    assert.deepEqual(
        Object.keys(metadata.devDependencies).filter((name) => name.startsWith("@minecraft/")).sort(),
        Object.keys(expected).sort(),
    );
    for (const [name, version] of Object.entries(expected)) {
        assert.equal(metadata.devDependencies[name], version, name);
        assert.equal(lockfile.packages[""]?.devDependencies?.[name], version, name);
        assert.equal(lockfile.packages[`node_modules/${name}`]?.version, version, name);
    }
});

test("both manifests use the 26.52 engine and matching Script API modules without changing pack identities", () => {
    const behavior = readJson<PackManifest>("xiaoboFakePlayerbp/manifest.json");
    const resources = readJson<PackManifest>("xiaoboFakePlayerp/manifest.json");
    for (const manifest of [behavior, resources]) {
        assert.deepEqual(manifest.header.min_engine_version, [1, 26, 52]);
        for (const module of manifest.modules) {
            assert.deepEqual(module.version, manifest.header.version);
        }
    }
    assert.equal(behavior.header.uuid, "b6fad072-da4d-49fd-94ac-e1986246f7f6");
    assert.equal(resources.header.uuid, "2a73ae9a-b734-48b0-8750-df774590a2af");
    assert.deepEqual(behavior.header.version, resources.header.version);
    const resourceDependency = behavior.dependencies?.find((entry) => entry.uuid === resources.header.uuid);
    assert.deepEqual(resourceDependency?.version, resources.header.version);
    const modules = behavior.dependencies?.filter((entry) => entry.module_name !== undefined) ?? [];
    assert.deepEqual(modules.map((entry) => entry.module_name).sort(), Object.keys(API_PACKAGES).sort());
    for (const [name, npmVersion] of Object.entries(API_PACKAGES)) {
        assert.ok(npmVersion.endsWith(GAME_BUILD_SUFFIX));
        assert.equal(
            modules.find((entry) => entry.module_name === name)?.version,
            npmVersion.slice(0, -GAME_BUILD_SUFFIX.length),
            name,
        );
    }
});

test("the capability matrix describes the same runtime as the manifests and installed type packages", () => {
    assert.equal(CAPABILITY_MATRIX.gameVersion, "1.26.52");
    const versions = {
        "@minecraft/server": CAPABILITY_MATRIX.serverVersion,
        "@minecraft/server-ui": CAPABILITY_MATRIX.serverUiVersion,
        "@minecraft/server-gametest": CAPABILITY_MATRIX.gameTestVersion,
    };
    assert.deepEqual(versions, API_PACKAGES);
    for (const [name, version] of Object.entries(versions)) {
        assert.equal(readJson<{ readonly version: string }>(`node_modules/${name}/package.json`).version, version);
    }
});

test("active documentation and skin fallback translations contain no stale Bedrock baseline", () => {
    const files = [
        "AGENTS.md",
        "README.md",
        "README_EN.md",
        "docs/architecture.md",
        ".github/instructions/bedrock-sapi-1-26-52.instructions.md",
        ...readdirSync(new URL("xiaoboFakePlayerp/texts/", REPOSITORY_ROOT))
            .filter((name) => name.endsWith(".lang"))
            .map((name) => `xiaoboFakePlayerp/texts/${name}`),
    ];
    for (const file of files) {
        const contents = readFileSync(new URL(file, REPOSITORY_ROOT), "utf8");
        assert.doesNotMatch(contents, /\b1\.26\.(?!52\b)\d+\b|bedrock_26_33_required|bedrock-sapi-1-26-33/, file);
    }
    assert.match(readFileSync(new URL("README.md", REPOSITORY_ROOT), "utf8"), /## \u5b9e\u673a\u53d1\u5e03\u95e8\u69db/);
    assert.match(readFileSync(new URL("README_EN.md", REPOSITORY_ROOT), "utf8"), /## Real-Game Release Gate/);
    assert.match(
        readFileSync(new URL(".github/instructions/bedrock-sapi-1-26-52.instructions.md", REPOSITORY_ROOT), "utf8"),
        /min_engine_version:\s*\[1,\s*26,\s*52\]/,
    );
});
