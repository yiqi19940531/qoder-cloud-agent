import { NextRequest, NextResponse } from "next/server";
import { ACTORS, JD_FALLBACK_ACTOR } from "@/lib/actors";
import { db } from "@/lib/db";
import { localRequestError } from "@/lib/http";

export const runtime = "nodejs";
export function GET(request: NextRequest) {
  const denied = localRequestError(request);
  if (denied) return denied;
  const actors = [...Object.entries(ACTORS).map(([platform, actor]) => {
    const verified = db.prepare("SELECT status,result_count,checked_at FROM actor_verifications WHERE platform=? AND actor_id=?")
      .get(platform, actor.id) as Record<string, unknown> | undefined;
    return { platform, actorId: actor.id, status: verified?.status || "candidate", resultCount: verified?.result_count || 0, checkedAt: verified?.checked_at || null };
  }), (() => {
    const verified = db.prepare("SELECT status,result_count,checked_at FROM actor_verifications WHERE platform='jd' AND actor_id=?")
      .get(JD_FALLBACK_ACTOR) as Record<string, unknown> | undefined;
    return { platform: "jd-备用", actorId: JD_FALLBACK_ACTOR, status: verified?.status || "candidate", resultCount: verified?.result_count || 0, checkedAt: verified?.checked_at || null };
  })()];
  return NextResponse.json({ actors });
}
