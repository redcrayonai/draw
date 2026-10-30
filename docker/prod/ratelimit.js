// Stand-in for the hosted ratelimit binding (wrangler.jsonc `ratelimits`),
// which workerd does not have: same `limit({ key })` API under the same binding
// names, as a fixed window counted in this process. workerd runs one isolate per
// Worker, so the count is per container, not per hosted location.
// shortcut: per-container counts; with several replicas, move them to Redis or a Durable Object.
export default function rateLimit({ limit, period }) {
  const ms = period * 1000;
  const windows = new Map(); // key -> { start, count }
  return {
    async limit({ key }) {
      const now = Date.now();
      const start = now - (now % ms);
      // drop finished windows once the map grows, so one-off keys (IPs) do not pile up
      if (windows.size > 10_000) for (const [k, w] of windows) if (w.start !== start) windows.delete(k);
      let w = windows.get(key);
      if (!w || w.start !== start) windows.set(key, (w = { start, count: 0 }));
      return { success: ++w.count <= limit };
    },
  };
}
