"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { APP_CONFIG, UPDATER_CONFIG } from "@/shared/constants/config";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { ConfirmModal } from "./Modal";

/**
 * Nav structure matches Switchboard Console standalone mock:
 * Operate → Connect → Tools, plus Diagnostics footer box + endpoint pill.
 */
const NAV_SECTIONS = [
  {
    id: "operate",
    label: "Operate",
    items: [
      { href: "/dashboard", label: "Overview", match: (p) => p === "/dashboard" },
      { href: "/dashboard/combos", label: "Combos", match: (p) => p.startsWith("/dashboard/combos") },
      { href: "/dashboard/usage", label: "Usage", match: (p) => p.startsWith("/dashboard/usage") },
      { href: "/dashboard/quota", label: "Quota", match: (p) => p.startsWith("/dashboard/quota") },
    ],
  },
  {
    id: "connect",
    label: "Connect",
    items: [
      { href: "/dashboard/providers", label: "Providers", match: (p) => p.startsWith("/dashboard/providers") },
      { href: "/dashboard/endpoint", label: "Endpoint & keys", match: (p) => p.startsWith("/dashboard/endpoint") },
    ],
  },
  {
    id: "tools",
    label: "Tools",
    items: [
      { href: "/dashboard/token-saver", label: "Token saver", match: (p) => p.startsWith("/dashboard/token-saver") },
      // Media (image/TTS/STT/embedding/web) and Skills are separate products — never combine.
      {
        href: "/dashboard/media-providers",
        label: "Media",
        match: (p) => p.startsWith("/dashboard/media-providers"),
      },
      {
        href: "/dashboard/skills",
        label: "Skills",
        match: (p) => p.startsWith("/dashboard/skills"),
      },
      {
        href: "/dashboard/agent-library",
        label: "Agent library",
        match: (p) => p.startsWith("/dashboard/agent-library"),
      },
      { href: "/dashboard/cli-tools", label: "CLI tools", match: (p) => p.startsWith("/dashboard/cli-tools") },
      { href: "/dashboard/profile", label: "Settings", match: (p) => p.startsWith("/dashboard/profile") },
    ],
  },
];

export default function Sidebar({ onClose }) {
  const pathname = usePathname();
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [shutdownCountdown, setShutdownCountdown] = useState(0);
  // Stable SSR default — set real host only after mount (avoids hydration mismatch)
  const [endpointHost, setEndpointHost] = useState(`127.0.0.1:${UPDATER_CONFIG.appPort}`);
  const { copied, copy } = useCopyToClipboard(2000);

  const INSTALL_CMD = UPDATER_CONFIG.installCmdLatest;

  useEffect(() => {
    setEndpointHost(window.location.host || `127.0.0.1:${UPDATER_CONFIG.appPort}`);
  }, []);

  useEffect(() => {
    fetch("/api/version")
      .then((res) => res.json())
      .then((data) => {
        // Strict gate: only show when API asserts a newer version than current
        if (
          data &&
          data.hasUpdate === true &&
          data.latestVersion &&
          data.currentVersion &&
          data.latestVersion !== data.currentVersion
        ) {
          setUpdateInfo(data);
        } else {
          setUpdateInfo(null);
        }
      })
      .catch(() => {
        setUpdateInfo(null);
      });
  }, []);

  const handleUpdate = () => {
    setShowUpdateModal(false);
    setIsUpdating(true);
  };

  const handleCopyAndShutdown = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_CMD);
    } catch {
      /* clipboard blocked */
    }
    copy(INSTALL_CMD);
    let remaining = UPDATER_CONFIG.shutdownCountdownSec;
    setShutdownCountdown(remaining);
    const timer = setInterval(() => {
      remaining -= 1;
      setShutdownCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(timer);
        fetch("/api/version/shutdown", { method: "POST" }).catch(() => {});
        setIsDisconnected(true);
      }
    }, 1000);
  };

  const handleCancelUpdate = () => {
    setIsUpdating(false);
    setShutdownCountdown(0);
  };

  return (
    <>
      <aside
        className="flex flex-col min-h-full"
        style={{
          width: 236,
          flex: "0 0 236px",
          background: "#1A160F",
          borderRight: "1px solid #332C1E",
        }}
      >
        {/* Logo — mock exact */}
        <div
          className="flex items-center gap-[11px]"
          style={{
            padding: "16px 18px",
            borderBottom: "1px solid #2A2418",
          }}
        >
          <Link href="/dashboard" onClick={onClose} className="flex items-center gap-[11px] min-w-0">
            <div
              className="flex items-center justify-center shrink-0"
              style={{
                width: 27,
                height: 27,
                borderRadius: 7,
                background: "#E5B454",
                color: "#1B1710",
                fontWeight: 700,
                fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
                fontSize: 15,
              }}
            >
              S
            </div>
            <div className="flex flex-col min-w-0" style={{ lineHeight: 1.15 }}>
              <span style={{ fontWeight: 600, fontSize: 14, letterSpacing: "0.2px", color: "#ECE4D2" }}>
                {APP_CONFIG.name}
              </span>
              <span
                style={{
                  fontSize: 10.5,
                  color: "#6F6653",
                  fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
                }}
              >
                routing gateway
              </span>
            </div>
          </Link>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="lg:hidden ml-auto text-[#6F6653] hover:text-[#ECE4D2]"
              aria-label="Close menu"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          ) : null}
        </div>

        {updateInfo && (
          <div className="mx-2.5 mt-2 rounded-lg border border-[#332C1E] bg-[#211C14] px-2.5 py-2">
            <span className="text-[11px] font-semibold text-[#E5B454]">
              ↑ v{updateInfo.latestVersion} available
            </span>
            <button
              type="button"
              onClick={() => setShowUpdateModal(true)}
              className="mt-1 block text-[11px] text-[#A99E86] hover:text-[#E5B454]"
            >
              Update now
            </button>
          </div>
        )}

        {/* Navigation */}
        <nav
          className="flex-1 overflow-y-auto custom-scrollbar flex flex-col"
          style={{ padding: "12px 10px", gap: 2 }}
        >
          {NAV_SECTIONS.map((section) => (
            <div key={section.id}>
              <div className="console-nav-section">{section.label}</div>
              {section.items.map((item) => {
                const active = item.match(pathname);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onClose}
                    className="console-nav-item"
                    data-active={active ? "true" : "false"}
                  >
                    <span className="console-nav-dot" />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}

          {/* Diagnostics box — mock exact */}
          <div
            style={{
              marginTop: 16,
              padding: "11px 12px",
              border: "1px dashed #332C1E",
              borderRadius: 8,
            }}
          >
            <div
              style={{
                fontSize: 10,
                letterSpacing: "1.4px",
                color: "#6F6653",
                textTransform: "uppercase",
                fontWeight: 600,
                marginBottom: 6,
              }}
            >
              Diagnostics
            </div>
            <div
              style={{
                fontSize: 11,
                color: "#7A7059",
                fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
                lineHeight: 1.7,
              }}
            >
              <Link href="/dashboard/console-log" onClick={onClose} className="hover:text-[#E5B454]">
                console
              </Link>
              {" · "}
              <Link href="/dashboard/translator" onClick={onClose} className="hover:text-[#E5B454]">
                translator
              </Link>
              <br />
              <Link href="/dashboard/mitm" onClick={onClose} className="hover:text-[#E5B454]">
                mitm
              </Link>
              {" · "}
              <Link href="/dashboard/cli-tools" onClick={onClose} className="hover:text-[#E5B454]">
                cli tools
              </Link>
            </div>
          </div>
        </nav>

        {/* Endpoint status pill — mock exact */}
        <div style={{ padding: 12, borderTop: "1px solid #2A2418" }}>
          <div
            className="flex items-center justify-between gap-2"
            style={{
              background: "#211C14",
              border: "1px solid #2A2418",
              borderRadius: 8,
              padding: "9px 11px",
            }}
          >
            <div className="flex flex-col min-w-0">
              <span
                style={{
                  fontSize: 9.5,
                  letterSpacing: "1px",
                  color: "#6F6653",
                  textTransform: "uppercase",
                }}
              >
                Endpoint
              </span>
              <span
                className="truncate"
                style={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
                  color: "#A99E86",
                }}
              >
                {endpointHost}
              </span>
            </div>
            <span className="console-online-dot" title="online" />
          </div>
        </div>
      </aside>

      <ConfirmModal
        isOpen={showUpdateModal}
        onClose={() => setShowUpdateModal(false)}
        onConfirm={handleUpdate}
        title="Update Switchboard"
        message="Copy the install command and restart the server after update."
        confirmText="Continue"
      />

      {isUpdating && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
          <div className="card-soft max-w-md w-full p-5 space-y-3">
            <h3 className="text-sm font-semibold text-text-main">Manual update</h3>
            <code className="block text-[11px] font-mono text-primary break-all bg-surface-2 p-2 rounded">
              {INSTALL_CMD}
            </code>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleCopyAndShutdown}
                className="px-3 py-1.5 rounded-lg bg-primary text-[#1B1710] text-xs font-semibold"
              >
                {copied ? "Copied" : "Copy & shutdown"}
                {shutdownCountdown > 0 ? ` (${shutdownCountdown})` : ""}
              </button>
              <button
                type="button"
                onClick={handleCancelUpdate}
                className="px-3 py-1.5 rounded-lg border border-border text-text-muted text-xs"
              >
                Cancel
              </button>
            </div>
            {isDisconnected && (
              <p className="text-[11px] text-text-subtle font-mono">Server shutting down…</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

Sidebar.propTypes = {
  onClose: PropTypes.func,
};
