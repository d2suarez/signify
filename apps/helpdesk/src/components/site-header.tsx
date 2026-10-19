import { AppHeader } from "./app-header";

/** Header for requester-facing pages (submit form, my requests, ticket view). */
export async function SiteHeader() {
  return <AppHeader mode="requester" />;
}
