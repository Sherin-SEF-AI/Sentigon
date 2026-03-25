"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function PrivacyCenterRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/privacy?tab=camera");
  }, [router]);
  return null;
}
