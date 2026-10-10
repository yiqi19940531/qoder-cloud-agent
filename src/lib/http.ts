import { NextRequest, NextResponse } from "next/server";
import { redactSecrets } from "./secrets";

export function localRequestError(request: NextRequest): NextResponse | null {
  const host = request.headers.get("host") || "";
  if (!/^(127\.0\.0\.1|localhost):3000$/.test(host)) {
    return NextResponse.json({ error: "此应用仅允许从本机访问。" }, { status: 403 });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== `http://${host}`) {
    return NextResponse.json({ error: "拒绝跨站请求。" }, { status: 403 });
  }
  return null;
}

export function errorResponse(error: unknown, status = 500) {
  return NextResponse.json({ error: redactSecrets(error instanceof Error ? error.message : "请求失败") }, { status });
}
