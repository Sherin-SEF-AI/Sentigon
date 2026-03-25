import { redirect } from "next/navigation";

export default function VisualSearchRedirect() {
  redirect("/search?tab=visual");
}
