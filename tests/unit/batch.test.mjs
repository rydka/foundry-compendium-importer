// C15: creation by batches of 50.
import { describe, expect, it } from "vitest";
import { chunk } from "../../scripts/core/batch.mjs";
import { BATCH_SIZE } from "../../scripts/constants.mjs";

describe("chunk (C15)", () => {
  it("uses a batch size of 50", () => {
    expect(BATCH_SIZE).toBe(50);
  });

  it("splits 120 items into 50, 50, 20 in order", () => {
    const input = Array.from({ length: 120 }, (_, i) => i);
    const parts = chunk(input, 50);
    expect(parts.map((p) => p.length)).toEqual([50, 50, 20]);
    expect(parts.flat()).toEqual(input);
  });

  it("splits 500 items into 10 batches of 50", () => {
    const parts = chunk(Array.from({ length: 500 }, (_, i) => i), BATCH_SIZE);
    expect(parts).toHaveLength(10);
    expect(parts.every((p) => p.length === 50)).toBe(true);
  });

  it("returns one batch when the array is smaller than the size", () => {
    expect(chunk([1, 2, 3], 50)).toEqual([[1, 2, 3]]);
  });

  it("returns exactly full batches without an empty tail", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it("returns [] for an empty array", () => {
    expect(chunk([], 50)).toEqual([]);
  });
});
