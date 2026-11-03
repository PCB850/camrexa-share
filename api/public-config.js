// GET /api/public-config -> the two values the browser needs for Supabase Auth.
// Both are public by design (the anon key only reaches what RLS allows:
// the teaser view and county/city lists). Never return the service role key.
import { json, errorResponse, env } from "./_lib/supabase.js";

export function GET() {
  try {
    return json(
      200,
      { supabaseUrl: env("SUPABASE_URL"), supabaseAnonKey: env("SUPABASE_ANON_KEY") },
      { "cache-control": "public, max-age=300" }
    );
  } catch (err) {
    return errorResponse(err);
  }
}
