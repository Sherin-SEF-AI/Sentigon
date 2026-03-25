import { redirect } from "next/navigation";

export default function ForensicSearchRedirect() {
  redirect("/search?tab=forensic");
}
