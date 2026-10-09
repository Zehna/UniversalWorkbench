import { useEffect, useState } from "react";

function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

/**
 * PWA resilience banner: visible while the browser reports offline,
 * cleared on reconnect. Polite callers (pollers) can key off the same
 * online/offline events to pause and resume.
 */
export function OfflineBanner() {
  const [online, setOnline] = useState<boolean>(() => isOnline());

  useEffect(() => {
    function goOnline(): void {
      setOnline(true);
    }
    function goOffline(): void {
      setOnline(false);
    }
    setOnline(isOnline());
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  if (online) return null;
  return (
    <p role="alert">
      You are offline. Changes are kept locally and will sync on reconnect.
    </p>
  );
}
