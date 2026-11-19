import { linkSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { processIsAlive } from "../../storage/file-lock-support.js";
import { FILE_EXISTS_CODE, FILE_MISSING_CODE } from "../../utils/constants.js";
import { errorCode } from "../../utils/errors.js";
import { removeFile } from "../../utils/files/remove.js";
import {
  BOOT_TIME_SLACK_MS,
  HANDOFF_WAIT_MS,
  LOCK_ATTEMPTS,
  LOCK_TAKEOVER_STALE_MS,
  LOCK_TAKEOVER_SUFFIX,
  LOCK_TEMPORARY_SUFFIX,
  TICK_MS,
} from "../constants.js";
import type { LockHolder } from "../types.js";

function createLock(lock: string, version: string): boolean {
  const temporary = `${lock}${LOCK_TEMPORARY_SUFFIX}${process.pid}`;
  const holder: LockHolder = { pid: process.pid, version };
  writeFileSync(temporary, JSON.stringify(holder));
  try {
    linkSync(temporary, lock);
    return true;
  } catch (error) {
    if (errorCode(error) === FILE_EXISTS_CODE) return false;
    throw error;
  } finally {
    removeFile(temporary);
  }
}

function lockOwner(lock: string): string | undefined {
  try {
    return readFileSync(lock, "utf8");
  } catch (error) {
    if (errorCode(error) === FILE_MISSING_CODE) return undefined;
    throw error;
  }
}

function parseHolder(owner: string): LockHolder | undefined {
  try {
    const { pid, version } = JSON.parse(owner) as Partial<LockHolder>;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
    return { pid, version: typeof version === "string" ? version : "" };
  } catch {
    return undefined;
  }
}

function refreshedBeforeBoot(lock: string): boolean {
  const refreshedAt = statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
  const bootedAt = Date.now() - uptime() * 1000;
  return refreshedAt !== undefined && refreshedAt < bootedAt - BOOT_TIME_SLACK_MS;
}

function ownerIsAlive(lock: string, owner: string): boolean {
  const holder = parseHolder(owner);
  return holder !== undefined && !refreshedBeforeBoot(lock) && processIsAlive(holder.pid) !== false;
}

export function refreshLock(lock: string): void {
  const now = new Date();
  utimesSync(lock, now, now);
}

function claimTakeover(takeover: string, version: string): boolean {
  if (createLock(takeover, version)) return true;
  const claimed = statSync(takeover, { throwIfNoEntry: false });
  if (claimed === undefined || Date.now() - claimed.mtimeMs < LOCK_TAKEOVER_STALE_MS) return false;
  removeFile(takeover);
  return createLock(takeover, version);
}

function takeOverDeadLock(lock: string, deadOwner: string, version: string): boolean {
  const takeover = `${lock}${LOCK_TAKEOVER_SUFFIX}`;
  if (!claimTakeover(takeover, version)) return false;
  try {
    if (lockOwner(lock) === deadOwner) removeFile(lock);
    return createLock(lock, version);
  } finally {
    removeFile(takeover);
  }
}

export function takeLock(lock: string, version: string): boolean {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    if (createLock(lock, version)) return true;
    const owner = lockOwner(lock);
    if (owner === undefined) continue;
    if (ownerIsAlive(lock, owner)) return false;
    return takeOverDeadLock(lock, owner, version);
  }
  return false;
}

export function liveLockHolder(lock: string): LockHolder | undefined {
  const owner = lockOwner(lock);
  return owner !== undefined && ownerIsAlive(lock, owner) ? parseHolder(owner) : undefined;
}

export const isNewerVersion = (candidate: string, current: string) =>
  candidate.localeCompare(current, undefined, { numeric: true }) > 0;

export async function takeLockFromOlder(lock: string, version: string): Promise<boolean> {
  const deadline = Date.now() + HANDOFF_WAIT_MS;
  while (!takeLock(lock, version)) {
    const holder = liveLockHolder(lock);
    if (holder !== undefined && !isNewerVersion(version, holder.version)) return false;
    if (Date.now() >= deadline) return false;
    await delay(TICK_MS);
  }
  return true;
}

export function releaseLock(lock: string): void {
  const owner = lockOwner(lock);
  if (owner !== undefined && parseHolder(owner)?.pid === process.pid) removeFile(lock);
}
