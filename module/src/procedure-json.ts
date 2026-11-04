// Procedures return named rows as JSON; tag integers so ids survive without rounding.
export const procedureJson = (value: unknown): string => JSON.stringify(value, (_key, v) =>
  typeof v === 'bigint' ? { $bigint: v.toString() } : v
);

export const parseProcedureJson = (text: string): any => JSON.parse(text, (_key, v) =>
  v && typeof v === 'object' && Object.keys(v).length === 1 && typeof v.$bigint === 'string' ? BigInt(v.$bigint) : v
);
