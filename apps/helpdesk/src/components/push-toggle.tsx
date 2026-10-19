"use client";

import { useEffect, useState } from "react";
import { removePushSubscription, savePushSubscription } from "@/lib/actions";

type Status = "loading" | "unsupported" | "denied" | "off" | "on";

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

export function PushToggle({ vapidPublicKey }: { vapidPublicKey: string | null }) {
  const [status, setStatus] = useState<Status>("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!vapidPublicKey || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setStatus("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setStatus("denied");
      return;
    }
    navigator.serviceWorker
      .getRegistration("/sw.js")
      .then((registration) => registration?.pushManager.getSubscription())
      .then((subscription) => setStatus(subscription ? "on" : "off"))
      .catch(() => setStatus("off"));
  }, [vapidPublicKey]);

  async function enable() {
    if (!vapidPublicKey) return;
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "denied" : "off");
        return;
      }
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
      });
      await savePushSubscription(JSON.stringify(subscription.toJSON()));
      setStatus("on");
    } catch (error) {
      console.error("Enabling push failed:", error);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/sw.js");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await removePushSubscription(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setStatus("off");
    } catch (error) {
      console.error("Disabling push failed:", error);
    } finally {
      setBusy(false);
    }
  }

  if (status === "loading") {
    return <p className="text-sm text-slate-400">Checking this device…</p>;
  }
  if (status === "unsupported") {
    return (
      <p className="text-sm text-slate-500">
        {vapidPublicKey
          ? "This browser doesn't support push notifications. On iPhones and iPads, add this site to your home screen first (Share → Add to Home Screen)."
          : "Push notifications aren't configured on the server yet."}
      </p>
    );
  }
  if (status === "denied") {
    return (
      <p className="text-sm text-slate-500">
        Notifications are blocked for this site — allow them in your browser's site settings, then
        reload this page.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {status === "on" ? (
        <>
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-green-700">
            <span className="size-2 rounded-full bg-green-500" aria-hidden />
            Notifications are on for this device
          </span>
          <button type="button" onClick={disable} disabled={busy} className="btn-secondary">
            {busy ? "Turning off…" : "Turn off"}
          </button>
        </>
      ) : (
        <>
          <span className="text-sm text-slate-600">Get pop-up notifications on this device.</span>
          <button type="button" onClick={enable} disabled={busy} className="btn-primary">
            {busy ? "Enabling…" : "Enable on this device"}
          </button>
        </>
      )}
    </div>
  );
}
