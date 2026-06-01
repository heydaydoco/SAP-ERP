export interface NumberFormat {
  prefix: string;
  suffix: string;
  padding: number;
}

/** Render a counter value as a document number, e.g. {prefix:'SO-2026-',padding:6} + 123 → 'SO-2026-000123'. */
export function formatDocNo(fmt: NumberFormat, value: bigint): string {
  return `${fmt.prefix}${value.toString().padStart(fmt.padding, '0')}${fmt.suffix}`;
}
