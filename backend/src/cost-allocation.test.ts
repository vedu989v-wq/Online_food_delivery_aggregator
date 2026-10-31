import test from "node:test";
import assert from "node:assert/strict";
import { allocateProportionally, calculateShares } from "./cost-allocation.js";

test("proportional split example reconciles exactly to 58000 paise", () => {
  const result = calculateShares([
    { userId: "a", itemPaise: 18000 }, { userId: "b", itemPaise: 22000 }, { userId: "c", itemPaise: 15000 },
  ], { deliveryPaise: 3000, platformPaise: 1000, sharedTaxPaise: 2000, sharedDiscountPaise: 3000 });
  assert.equal(result.totalPaise, 58000);
  assert.deepEqual([...result.shares.values()].reduce((a, b) => a + b, 0), 58000);
  assert.deepEqual([...result.shares], [["a", 19007], ["b", 22933], ["c", 16060]]);
});

test("remainder assignment is deterministic and does not lose paise", () => {
  assert.deepEqual([...allocateProportionally(2, new Map([["b", 1], ["a", 1], ["c", 1]]))], [["a", 1], ["b", 1], ["c", 0]]);
});

test("zero item totals split shared costs evenly", () => {
  const result = calculateShares([{ userId: "a", itemPaise: 0 }, { userId: "b", itemPaise: 0 }], { deliveryPaise: 1, platformPaise: 1, sharedTaxPaise: 0, sharedDiscountPaise: 0 });
  assert.equal(result.totalPaise, 2);
  assert.equal([...result.shares.values()].reduce((a, b) => a + b, 0), 2);
});

test("rejects fractional paise and empty items", () => {
  assert.throws(() => calculateShares([{ userId: "a", itemPaise: 10.5 }], { deliveryPaise: 0, platformPaise: 0, sharedTaxPaise: 0, sharedDiscountPaise: 0 }));
  assert.throws(() => calculateShares([], { deliveryPaise: 0, platformPaise: 0, sharedTaxPaise: 0, sharedDiscountPaise: 0 }));
  assert.throws(() => calculateShares([{ userId: "a", itemPaise: 100 }], { deliveryPaise: 500, platformPaise: 0, sharedTaxPaise: 0, sharedDiscountPaise: 101 }));
});
