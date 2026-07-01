import { test } from "node:test";
import assert from "node:assert/strict";
import { Mutex, Semaphore } from "../src/utils/concurrency";

test("Mutex serializes concurrent runExclusive calls", async () => {
  const mutex = new Mutex();
  const order: number[] = [];

  async function task(id: number, delayMs: number): Promise<void> {
    await mutex.runExclusive(async () => {
      order.push(id);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      order.push(-id);
    });
  }

  await Promise.all([task(1, 20), task(2, 5), task(3, 1)]);
  // Each task's start (+id) must be immediately followed by its own end (-id)
  // before the next task starts, proving no interleaving occurred.
  for (let i = 0; i < order.length; i += 2) {
    assert.equal(order[i], -order[i + 1]!);
  }
});

test("Semaphore caps concurrent holders and queues the rest", async () => {
  const sem = new Semaphore(2);
  let concurrent = 0;
  let maxConcurrent = 0;

  async function task(): Promise<void> {
    const release = await sem.acquire();
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 10));
    concurrent -= 1;
    release();
  }

  await Promise.all([task(), task(), task(), task(), task()]);
  assert.equal(maxConcurrent, 2);
});

test("Semaphore reports inUse and queued counts", async () => {
  const sem = new Semaphore(1);
  const release1 = await sem.acquire();
  assert.equal(sem.inUse, 1);
  const secondAcquire = sem.acquire();
  assert.equal(sem.queued, 1);
  release1();
  const release2 = await secondAcquire;
  assert.equal(sem.inUse, 1);
  assert.equal(sem.queued, 0);
  release2();
  assert.equal(sem.inUse, 0);
});
