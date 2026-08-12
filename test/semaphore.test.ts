import assert from "node:assert/strict";
import test from "node:test";
import { Semaphore } from "../src/semaphore.js";

test("semaphore caps concurrent work", async () => {
  const semaphore = new Semaphore(2);
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 8 }, (_, index) => semaphore.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return index;
  }));

  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(peak, 2);
});
