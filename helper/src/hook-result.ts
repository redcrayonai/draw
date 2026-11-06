/** MCP hook responses arrive either as structured results or text content blocks. */
export function hookResult(response: unknown): Record<string, any> | undefined {
  const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const blocks = Array.isArray(response) ? response : object(response) && Array.isArray(response.content) ? response.content : undefined;
  const text = typeof response === 'string' ? response : blocks?.find(b => object(b) && b.type === 'text')?.text;
  if (typeof text !== 'string') return blocks === undefined && object(response) ? response : undefined;
  try { const value: unknown = JSON.parse(text); return object(value) ? value : undefined; } catch { return undefined; }
}
