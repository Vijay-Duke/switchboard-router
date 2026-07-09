"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useNotificationStore } from "@/store/notificationStore";
import Sidebar from "../Sidebar";
import Header from "../Header";

function getToastStyle(type) {
  if (type === "success") {
    return {
      wrapper: "border-[#74C08A]/35 bg-[#74C08A]/10 text-[#74C08A]",
      icon: "check_circle",
    };
  }
  if (type === "error") {
    return {
      wrapper: "border-[#E07070]/35 bg-[#E07070]/10 text-[#E07070]",
      icon: "error",
    };
  }
  if (type === "warning") {
    return {
      wrapper: "border-[#E5B454]/35 bg-[#E5B454]/10 text-[#E5B454]",
      icon: "warning",
    };
  }
  return {
    wrapper: "border-[#8A9EB8]/35 bg-[#8A9EB8]/10 text-[#8A9EB8]",
    icon: "info",
  };
}

export default function DashboardLayout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();
  const notifications = useNotificationStore((state) => state.notifications);
  const removeNotification = useNotificationStore((state) => state.removeNotification);

  const isChat = pathname === "/dashboard/basic-chat";

  return (
    <div
      className="flex h-screen w-full overflow-hidden"
      style={{ background: "#16130E" }}
    >
      <div className="fixed top-4 right-4 z-[80] flex w-[min(92vw,380px)] flex-col gap-2">
        {notifications.map((n) => {
          const style = getToastStyle(n.type);
          return (
            <div
              key={n.id}
              className={`rounded-lg border px-3 py-2 shadow-lg backdrop-blur-sm ${style.wrapper}`}
              style={{ background: "#1E1A13" }}
            >
              <div className="flex items-start gap-2">
                <span className="material-symbols-outlined text-[18px] leading-5">{style.icon}</span>
                <div className="min-w-0 flex-1">
                  {n.title ? <p className="text-xs font-semibold mb-0.5">{n.title}</p> : null}
                  <p className="text-xs whitespace-pre-wrap break-words">{n.message}</p>
                </div>
                {n.dismissible ? (
                  <button
                    type="button"
                    onClick={() => removeNotification(n.id)}
                    className="text-current/70 hover:text-current"
                    aria-label="Dismiss notification"
                  >
                    <span className="material-symbols-outlined text-[16px]">close</span>
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div className="hidden lg:flex h-full">
        <Sidebar />
      </div>

      <div
        className={`fixed inset-y-0 left-0 z-50 transform lg:hidden transition-transform duration-300 ease-in-out ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar onClose={() => setSidebarOpen(false)} />
      </div>

      <main className="flex flex-col flex-1 h-full min-w-0 relative isolate">
        <Header key={pathname} onMenuClick={() => setSidebarOpen(true)} />
        <div
          className={`flex-1 overflow-y-auto custom-scrollbar ${isChat ? "flex flex-col overflow-hidden" : ""}`}
          style={{ background: "#16130E" }}
        >
          <div
            className={isChat ? "flex-1 w-full h-full flex flex-col" : "w-full"}
            style={isChat ? undefined : { padding: 22 }}
          >
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
