// @ts-check
import { NextResponse } from "next/server";

/** Single-user local mode: no dashboard login. */
export async function GET() {
  return NextResponse.json({
    requireLogin: false,
    authMode: "none",
    oidcConfigured: false,
    oidcLoginLabel: "",
    hasPassword: false,
    displayName: "Local user",
    loginMethod: "none",
    oidcName: null,
    oidcEmail: null,
    oidcLogin: false,
  });
}
