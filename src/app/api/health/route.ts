import { NextRequest, NextResponse } from "next/server";
import { localRequestError } from "@/lib/http";

export const runtime = "nodejs";
export function GET(request: NextRequest) {
  const denied = localRequestError(request);
  if (denied) return denied;
  return NextResponse.json({
    qoderConfigured: Boolean(process.env.QODER_ACCESS_TOKEN && process.env.QODER_AGENT_ID && process.env.QODER_ENVIRONMENT_ID),
    apifyConfigured: Boolean(process.env.QODER_APIFY_VAULT_ID && process.env.QODER_APIFY_MCP_READY === "true"),
    localOnly: true,
  });
}
