import type { UploadBatchItem } from "../../tracing/upload/models.js";
import type { QueuedRun, UploadLane } from "../types.js";
import { UPLOAD_QUEUE_RETRIES_BEFORE_SPLIT } from "../constants.js";
import { mergeRun, patchSubmission, postSubmission } from "./submissions.js";

export function runKey(lane: UploadLane, runId: string): string {
  return JSON.stringify([lane.key, runId]);
}

export function parentKey(run: QueuedRun): string | undefined {
  const parentId = run.post?.parent_run_id;
  if (parentId === undefined) return undefined;
  return runKey(run.lane, parentId);
}

export function requeue(run: QueuedRun): void {
  const sent = run.sending;
  run.sending = undefined;
  run.failedUploads += 1;
  if (sent?.post !== undefined) {
    run.post = mergeRun(sent.post, run.patch);
    run.patch = undefined;
  } else if (sent?.patch !== undefined && run.post === undefined) {
    run.patch = run.patch === undefined ? sent.patch : mergeRun(sent.patch, run.patch);
  }
  run.lane.ready.add(run);
}

export function startSending(run: QueuedRun): UploadBatchItem {
  const { post: unsentPost, patch: unsentPatch } = run;
  run.sending = unsentPost === undefined ? { patch: unsentPatch! } : { post: unsentPost };
  run.post = undefined;
  run.patch = undefined;
  return {
    submission:
      unsentPost === undefined ? patchSubmission(unsentPatch!) : postSubmission(unsentPost),
  };
}

export function retriedEnough(batch: QueuedRun[]): boolean {
  return batch.some((run) => run.failedUploads >= UPLOAD_QUEUE_RETRIES_BEFORE_SPLIT);
}
