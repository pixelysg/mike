import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createPgClient, type PgClient } from "./pg";

let _pgClient: PgClient | null = null;

/**
 * Server-side database client.
 *
 * When DATABASE_URL is set, returns a direct Postgres client with a
 * Supabase-compatible query API. Otherwise returns the Supabase JS
 * client using the service role key (existing behaviour).
 */
export function createServerSupabase(): SupabaseClient {
  if (process.env.DATABASE_URL) {
    if (!_pgClient) {
      _pgClient = createPgClient(
        process.env.DATABASE_URL,
        process.env.DATABASE_SCHEMA || "public",
      );
    }
    return _pgClient as unknown as SupabaseClient;
  }
  const url = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SECRET_KEY || "";
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Extract and verify the Supabase JWT from the Authorization header.
 * Always routes through Supabase Auth regardless of DATABASE_URL.
 */
export async function getUserIdFromRequest(req: Request): Promise<string> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    throw new Response("Missing or invalid Authorization header", {
      status: 401,
    });
  }
  const token = auth.slice(7).trim();

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SECRET_KEY || "";

  if (!supabaseUrl || !serviceKey) {
    throw new Response("Server auth is not configured", { status: 500 });
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data } = await admin.auth.getUser(token);
  if (!data.user) {
    throw new Response("Invalid or expired token", { status: 401 });
  }
  return data.user.id;
}
