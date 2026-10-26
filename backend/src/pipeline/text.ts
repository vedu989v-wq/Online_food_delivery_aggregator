export function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\b(biriyani|biriani)\b/g, "biryani").replace(/\brd\b/g, "road")
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
export function tokens(value: string): string[] { return normalize(value).split(" ").filter(Boolean); }
export function similarity(a: string, b: string): number {
  const x = normalize(a), y = normalize(b);
  if (!x || !y) return 0;
  const dp = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 0; j <= y.length; j++) dp[0][j] = j;
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++)
    dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + (x[i-1] === y[j-1] ? 0 : 1));
  return 1 - dp[x.length][y.length] / Math.max(x.length, y.length);
}
export function jaccard(a: string, b: string): number {
  const x = new Set(tokens(a)), y = new Set(tokens(b));
  const intersection = [...x].filter(t => y.has(t)).length;
  const union = new Set([...x, ...y]).size;
  return union ? intersection / union : 0;
}
export function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (n: number) => n * Math.PI / 180;
  const dLat = rad(bLat-aLat), dLng = rad(bLng-aLng);
  const h = Math.sin(dLat/2)**2 + Math.cos(rad(aLat))*Math.cos(rad(bLat))*Math.sin(dLng/2)**2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
}
