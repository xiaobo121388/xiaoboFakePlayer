import { Direction, world } from "@minecraft/server";
export class SapiWorldQueries {
    runtime;
    constructor(runtime) {
        this.runtime = runtime;
    }
    isChunkLoaded(dimension, position) {
        return world.getDimension(dimension).isChunkLoaded(position);
    }
    isSolidBlock(dimension, position) {
        return world.getDimension(dimension).getBlock(position)?.isSolid === true;
    }
    getBlockFromViewDirection(fakePlayerId, maxDistance) {
        const fakePlayer = this.runtime.getHandle(fakePlayerId);
        if (fakePlayer === undefined)
            return undefined;
        const origin = fakePlayer.getHeadLocation();
        const hit = fakePlayer.dimension.getBlockFromRay(origin, fakePlayer.getViewDirection(), { maxDistance });
        if (hit === undefined)
            return undefined;
        const hitLocation = {
            x: hit.block.location.x + hit.faceLocation.x,
            y: hit.block.location.y + hit.faceLocation.y,
            z: hit.block.location.z + hit.faceLocation.z,
        };
        return {
            position: { ...hit.block.location },
            face: fromDirection(hit.face),
            distance: Math.sqrt(distanceSquared(origin, hitLocation)),
        };
    }
    hasBlockLineOfSight(fakePlayerId, dimension, position, maxDistance) {
        const fakePlayer = this.runtime.getHandle(fakePlayerId);
        if (fakePlayer === undefined || fakePlayer.dimension.id !== dimension)
            return false;
        const origin = fakePlayer.getHeadLocation();
        const target = blockCenter(position);
        const delta = subtract(target, origin);
        const distance = Math.sqrt(lengthSquared(delta));
        if (distance === 0 || distance > maxDistance)
            return distance === 0;
        const hit = fakePlayer.dimension.getBlockFromRay(origin, scale(delta, 1 / distance), {
            includeLiquidBlocks: true,
            includePassableBlocks: true,
            maxDistance: distance + 0.01,
        });
        return hit !== undefined && sameBlock(hit.block.location, position);
    }
    hasLineOfSight(fakePlayerId, targetId) {
        const fakePlayer = this.runtime.getHandle(fakePlayerId);
        const target = world.getEntity(targetId);
        if (fakePlayer === undefined || target === undefined || fakePlayer.dimension.id !== target.dimension.id) {
            return false;
        }
        const origin = fakePlayer.getHeadLocation();
        const destination = target.getHeadLocation();
        const delta = subtract(destination, origin);
        const distance = Math.sqrt(lengthSquared(delta));
        if (distance === 0)
            return true;
        const hit = fakePlayer.dimension.getBlockFromRay(origin, scale(delta, 1 / distance), {
            includeLiquidBlocks: true,
            includePassableBlocks: true,
            maxDistance: Math.max(0, distance - 0.01),
        });
        return hit === undefined;
    }
    distanceSquared(fakePlayerId, targetId) {
        const fakePlayer = this.runtime.getHandle(fakePlayerId);
        const target = world.getEntity(targetId);
        if (fakePlayer === undefined || target === undefined || fakePlayer.dimension.id !== target.dimension.id) {
            return undefined;
        }
        return distanceSquared(fakePlayer.location, target.location);
    }
    findOnlinePlayer(playerId) {
        const player = world.getAllPlayers().find((candidate) => candidate.playfabId === playerId);
        return player === undefined ? undefined : toTarget(player);
    }
    findAttackTargets(fakePlayerId, query) {
        const fakePlayer = this.runtime.getHandle(fakePlayerId);
        if (fakePlayer === undefined)
            return [];
        const candidates = new Map();
        for (const family of query.families) {
            for (const entity of fakePlayer.dimension.getEntities({
                closest: query.limit,
                excludeTypes: ["minecraft:player"],
                families: [family],
                location: fakePlayer.location,
                maxDistance: query.maxDistance,
            })) {
                if (entity.isValid && entity.id !== fakePlayer.id)
                    candidates.set(entity.id, toTarget(entity));
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
                if (entity.isValid && entity.id !== fakePlayer.id)
                    candidates.set(entity.id, toTarget(entity));
            }
        }
        return [...candidates.values()]
            .sort((left, right) => distanceSquared(left.position, fakePlayer.location)
            - distanceSquared(right.position, fakePlayer.location))
            .slice(0, query.limit);
    }
    getBlockInfo(dimension, position) {
        if (!this.isChunkLoaded(dimension, position))
            return undefined;
        const block = world.getDimension(dimension).getBlock(position);
        return block === undefined ? undefined : { typeId: block.typeId, solid: block.isSolid };
    }
}
function toTarget(entity) {
    return { id: entity.id, dimension: entity.dimension.id, position: entity.location };
}
function subtract(left, right) {
    return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}
function scale(value, multiplier) {
    return { x: value.x * multiplier, y: value.y * multiplier, z: value.z * multiplier };
}
function lengthSquared(value) {
    return value.x * value.x + value.y * value.y + value.z * value.z;
}
function distanceSquared(left, right) {
    return lengthSquared(subtract(left, right));
}
function blockCenter(location) {
    return { x: location.x + 0.5, y: location.y + 0.5, z: location.z + 0.5 };
}
function sameBlock(left, right) {
    return Math.floor(left.x) === Math.floor(right.x)
        && Math.floor(left.y) === Math.floor(right.y)
        && Math.floor(left.z) === Math.floor(right.z);
}
function fromDirection(direction) {
    switch (direction) {
        case Direction.Down: return "down";
        case Direction.East: return "east";
        case Direction.North: return "north";
        case Direction.South: return "south";
        case Direction.Up: return "up";
        case Direction.West: return "west";
    }
}
//# sourceMappingURL=worldQueries.js.map