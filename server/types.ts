// The per-request context threaded through the handlers.
export interface Ctx {
  kv: Deno.Kv;
  env: Record<string, string | undefined>;
  ip: string;
}
