import { Direction, world } from "@minecraft/server";

import type {
    AttackTargetQuery,
    BlockFace,
    RuntimeBlockHit,
    RuntimeEntityTarget,
    WorldQueries,
} from "../../application/ports.js";
import type { DimensionKey, FakePlayerId, Point } from "../../domain/model.js";
import { SapiFakePlayerRuntime } from "./fakePlayerRuntime.js";

export class SapiWorldQueries implements WorldQueries {
    public constructor(private readonly runtime: SapiFakePlayerRuntime) {}

    public isChunkLoaded(dimension: DimensionKey, position: Point): boolean {
        return world.getDimension(dimension).isChunkLoaded(position);
    }

    public isSolidBlock(dimension: DimensionKey, position: Point): boolean {
        return world.getDimension(dimension).getBlock(position)?.isSolid === true;
    }

    public getBlockFromViewDirection(
        fakePlayerId: FakePlayerId,
        maxDistance: number,
    ): RuntimeBlockHit | undefined {
        const fakePlayer = this.runtime.getHandle(fakePlayerId);
        if (fakePlayer === undefined) return undefined;
        const origin = fakePlayer.getHeadLocation();
        const hit = fakePlayer.dimension.getBlockFromRay(
            origin,
            fakePlayer.getViewDirection(),
            { maxDistance },
        );
        if (hit === undefined) return undefined;
        const hitLocation = {
            x: hit.block.location.x + hit.faceLocation.x,
            y: hit.block.location.y + hit.faceLocation.y,
            z: hit.block.location.z + hit.faceLocation.z,
        };
        return {
            position: { ...hit.block.location },
            face: fromDirection(hit.face),
            faceLocation: { ...hit.faceLocation },
            distance: Math.sqrt(distanceSquared(origin, hitLocation)),
        };
    }

    public hasBlockLineOfSight(
        fakePlayerId: FakePlayerId,
        dimension: DimensionKey,
        position: Point,
        maxDistance: number,
    ): boolean {
        const fakePlayer = this.runtime.getHandle(fakePlayerId);
        if (fakePlayer === undefined || fakePlayer.dimension.id !== dimension) return false;
        const origin = fakePlayer.getHeadLocation();
        const target = blockCenter(position);
        const delta = subtract(target, origin);
        const distance = Math.sqrt(lengthSquared(delta));
        if (distance === 0 || distance > maxDistance) return distance === 0;
        const hit = fakePlayer.dimension.getBlockFromRay(origin, scale(delta, 1 / distance), {
            includeLiquidBlocks: true,
            includePassableBlocks: true,
            maxDistance: distance + 0.01,
        });
        return hit !== undefined && sameBlock(hit.block.location, position);
    }

    public hasLineOfSight(fakePlayerId: FakePlayerId, targetId: string): boolean {
        const fakePlayer = this.runtime.getHandle(fakePlayerId);
        const target = world.getEntity(targetId);
        if (fakePlayer === undefined || target === undefined || fakePlayer.dimension.id !== target.dimension.id) {
            return false;
        }
        const origin = fakePlayer.getHeadLocation();
        const destination = target.getHeadLocation();
        const delta = subtract(destination, origin);
        const distance = Math.sqrt(lengthSquared(delta));
        if (distance === 0) return true;
        const hit = fakePlayer.dimension.getBlockFromRay(origin, scale(delta, 1 / distance), {
            includeLiquidBlocks: true,
            includePassableBlocks: true,
            maxDistance: Math.max(0, distance - 0.01),
        });
        return hit === undefined;
    }

    public distanceSquared(fakePlayerId: FakePlayerId, targetId: string): number | undefined {
        const fakePlayer = this.runtime.getHandle(fakePlayerId);
        const target = world.getEntity(targetId);
        if (fakePlayer === undefined || target === undefined || fakePlayer.dimension.id !== target.dimension.id) {
            return undefined;
        }
        return distanceSquared(fakePlayer.location, target.location);
    }

    public findOnlinePlayer(playerId: string): RuntimeEntityTarget | undefined {
        const player = world.getAllPlayers().find((candidate) => candidate.playfabId === playerId);
        return player === undefined ? undefined : toTarget(player);
    }

    public findAttackTargets(
        fakePlayerId: FakePlayerId,
        query: AttackTargetQuery,
    ): readonly RuntimeEntityTarget[] {
        const fakePlayer = this.runtime.getHandle(fakePlayerId);
        if (fakePlayer === undefined) return [];
        const candidates = new Map<string, RuntimeEntityTarget>();
        for (const family of query.families) {
            for (const entity of fakePlayer.dimension.getEntities({
                closest: query.limit,
                excludeTypes: ["minecraft:player"],
                families: [family],
                location: fakePlayer.location,
                maxDistance: query.maxDistance,
            })) {
                if (entity.isValid && entity.id !== fakePlayer.id) candidates.set(entity.id, toTarget(entity));
            }
        }
        for (const typeId of query.typeIds) {
            for (const entity of fakePlayer.dimension.getEntities({
                closest: query.limit,
                excludeTypes: ["minecraft:player"],
                location: fakePlayer.location,
                maxDistance: query.maxDistance,
                type: typeId,
            })) {
                if (entity.isValid && entity.id !== fakePlayer.id) candidates.set(entity.id, toTarget(entity));
            }
        }
        return [...candidates.values()]
            .sort((left, right) => distanceSquared(left.position, fakePlayer.location)
                - distanceSquared(right.position, fakePlayer.location))
            .slice(0, query.limit);
    }

    public getBlockInfo(dimension: DimensionKey, position: Point) {
        if (!this.isChunkLoaded(dimension, position)) return undefined;
        const block = world.getDimension(dimension).getBlock(position);
        return block === undefined ? undefined : { typeId: block.typeId, solid: block.isSolid };
    }
}

function toTarget(entity: { readonly id: string; readonly dimension: { readonly id: string }; readonly location: Point }): RuntimeEntityTarget {
    return { id: entity.id, dimension: entity.dimension.id, position: entity.location };
}

function subtract(left: Point, right: Point): Point {
    return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function scale(value: Point, multiplier: number): Point {
    return { x: value.x * multiplier, y: value.y * multiplier, z: value.z * multiplier };
}

function lengthSquared(value: Point): number {
    return value.x * value.x + value.y * value.y + value.z * value.z;
}

function distanceSquared(left: Point, right: Point): number {
    return lengthSquared(subtract(left, right));
}

function blockCenter(location: Point): Point {
    return { x: location.x + 0.5, y: location.y + 0.5, z: location.z + 0.5 };
}

function sameBlock(left: Point, right: Point): boolean {
    return Math.floor(left.x) === Math.floor(right.x)
        && Math.floor(left.y) === Math.floor(right.y)
        && Math.floor(left.z) === Math.floor(right.z);
}

function fromDirection(direction: Direction): BlockFace {
    switch (direction) {
        case Direction.Down: return "down";
        case Direction.East: return "east";
        case Direction.North: return "north";
        case Direction.South: return "south";
        case Direction.Up: return "up";
        case Direction.West: return "west";
    }
}