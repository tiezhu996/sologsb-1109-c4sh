import type { BatchReview, ProcessBatch } from '../types/process-batch';
import type { RetainSample, SampleReviewState } from '../types/retain-sample';

/** 取留样当前生效的复核状态（旧数据缺省为观察中） */
export function sampleReviewState(sample: RetainSample): SampleReviewState {
  return sample.reviewState ?? 'observing';
}

/** 取批次指定版本；不传 reviewId 时取最新版本 */
export function batchReviewOf(batch: ProcessBatch | undefined, reviewId?: string): BatchReview | undefined {
  if (!batch || batch.reviews.length === 0) return undefined;
  if (reviewId) {
    return batch.reviews.find((r) => r.id === reviewId);
  }
  return batch.reviews[batch.reviews.length - 1];
}

/** 最新判定版本 */
export function latestReview(batch?: ProcessBatch): BatchReview | undefined {
  if (!batch || batch.reviews.length === 0) return undefined;
  return batch.reviews[batch.reviews.length - 1];
}

/** 留样所依据的版本是否已被后续复核取代 */
export function isSampleStale(batch: ProcessBatch | undefined, sample: RetainSample): boolean {
  if (!batch || !sample.reviewId) return false;
  const latest = latestReview(batch);
  return Boolean(latest && latest.id !== sample.reviewId);
}
