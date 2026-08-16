// A tiny assertion helper so the tests carry no external dependency.

function fmt(v: unknown): string {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

export function equal(actual: unknown, expected: unknown, msg?: string): void {
  if (actual !== expected) throw new Error(msg || `expected ${fmt(expected)}, got ${fmt(actual)}`);
}

export function notEqual(actual: unknown, expected: unknown, msg?: string): void {
  if (actual === expected) throw new Error(msg || `expected value not equal to ${fmt(expected)}`);
}

export function ok(value: unknown, msg?: string): void {
  if (!value) throw new Error(msg || `expected a truthy value, got ${fmt(value)}`);
}

export function deepEqual(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(msg || `deepEqual failed:\n  actual:   ${a}\n  expected: ${b}`);
}

export function match(value: string, re: RegExp, msg?: string): void {
  if (!re.test(value)) throw new Error(msg || `expected ${fmt(value)} to match ${re}`);
}

export default { equal, notEqual, ok, deepEqual, match };
