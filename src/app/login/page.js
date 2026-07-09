// @ts-check
import { redirect } from "next/navigation";

/** Login removed — single-user local app. */
export default function LoginPage() {
  redirect("/dashboard");
}
