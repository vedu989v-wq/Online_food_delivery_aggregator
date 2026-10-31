export type CostLine = { userId: string; itemPaise: number };
export type SharedCosts = { deliveryPaise: number; platformPaise: number; sharedTaxPaise: number; sharedDiscountPaise: number };

/** Largest-remainder integer apportionment. Ties are resolved by stable user id. */
export function allocateProportionally(total: number, weights: Map<string, number>): Map<string, number> {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("Invalid allocation amount");
  const entries = [...weights].sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) {
    if (total) throw new Error("Cannot allocate to an empty participant set");
    return new Map();
  }
  if (entries.some(([, weight]) => !Number.isSafeInteger(weight) || weight < 0)) throw new Error("Invalid allocation weight");
  const weightTotal = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (!Number.isSafeInteger(weightTotal)) throw new Error("Allocation weights are too large");
  const effective = weightTotal === 0 ? entries.map(([id]) => [id, 1] as const) : entries;
  const denominator = weightTotal === 0 ? effective.length : weightTotal;
  const rows = effective.map(([id, weight]) => {
    const numerator = total * weight;
    if (!Number.isSafeInteger(numerator)) throw new Error("Allocation amount is too large");
    const base = Math.floor(numerator / denominator);
    return { id, base, remainder: numerator % denominator };
  });
  let pennies = total - rows.reduce((sum, row) => sum + row.base, 0);
  rows.sort((a, b) => b.remainder - a.remainder || a.id.localeCompare(b.id));
  for (let i = 0; i < pennies; i += 1) rows[i % rows.length].base += 1;
  return new Map(rows.map(row => [row.id, row.base]));
}

export function calculateShares(items: CostLine[], costs: SharedCosts): { totalPaise: number; shares: Map<string, number> } {
  for (const amount of Object.values(costs)) if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Costs must be non-negative integer paise");
  const itemWeights = new Map<string, number>();
  for (const item of items) {
    if (!Number.isSafeInteger(item.itemPaise) || item.itemPaise < 0) throw new Error("Item values must be non-negative integer paise");
    itemWeights.set(item.userId, (itemWeights.get(item.userId) ?? 0) + item.itemPaise);
  }
  if (!itemWeights.size) throw new Error("Cart has no priced items");
  const members = [...itemWeights.keys()].sort();
  const itemTotal = [...itemWeights.values()].reduce((sum, amount) => sum + amount, 0);
  if (!Number.isSafeInteger(itemTotal) || costs.sharedDiscountPaise > itemTotal) throw new Error("Shared discount exceeds eligible item value");
  const eachShared = (amount: number) => allocateProportionally(amount, new Map(members.map(id => [id, 1])));
  const tax = allocateProportionally(costs.sharedTaxPaise, itemWeights);
  const discount = allocateProportionally(costs.sharedDiscountPaise, itemWeights);
  const delivery = eachShared(costs.deliveryPaise);
  const platform = eachShared(costs.platformPaise);
  const shares = new Map<string, number>();
  for (const id of members) shares.set(id, (itemWeights.get(id) ?? 0) + (delivery.get(id) ?? 0) + (platform.get(id) ?? 0) + (tax.get(id) ?? 0) - (discount.get(id) ?? 0));
  const totalPaise = itemTotal + costs.deliveryPaise + costs.platformPaise + costs.sharedTaxPaise - costs.sharedDiscountPaise;
  if ([...shares.values()].reduce((sum, amount) => sum + amount, 0) !== totalPaise) throw new Error("Allocation did not reconcile");
  return { totalPaise, shares };
}
