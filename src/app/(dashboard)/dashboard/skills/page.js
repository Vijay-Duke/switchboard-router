"use client";
// @ts-check

import { useEffect, useState } from "react";
import { Card, Badge } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import {
  SKILLS,
  getSkillRawUrl,
  getSkillBlobUrl,
} from "@/shared/constants/skills";

function useOrigin() {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  return origin;
}

function absoluteUrl(origin, path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const base = origin || "";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function CopyButton({ value, label = "Copy link" }) {
  const { copied, copy } = useCopyToClipboard(2000);
  return (
    <button
      type="button"
      onClick={() => copy(value)}
      className="px-2 py-1 rounded-md bg-primary text-on-primary text-[11px] font-medium hover:bg-primary/90 transition-colors cursor-pointer shrink-0 inline-flex items-center gap-1"
      title={value}
    >
      <span className="material-symbols-outlined text-[12px]">
        {copied ? "check" : "content_copy"}
      </span>
      {copied ? "Copied!" : label}
    </button>
  );
}

function SkillRow({ skill, origin }) {
  const rawPath = getSkillRawUrl(skill.id);
  const viewPath = getSkillBlobUrl(skill.id);
  const rawAbsolute = absoluteUrl(origin, rawPath);
  const viewAbsolute = absoluteUrl(origin, viewPath);

  return (
    <div
      className={`flex items-start gap-3 p-4 rounded-[14px] border shadow-[var(--shadow-soft)] transition-colors ${
        skill.isEntry
          ? "border-brand-500/40 bg-brand-500/5"
          : "border-border-subtle bg-surface hover:bg-surface-2"
      }`}
    >
      <div
        className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${
          skill.isEntry ? "bg-primary text-on-primary" : "bg-primary/10 text-primary"
        }`}
      >
        <span className="material-symbols-outlined text-[18px]">{skill.icon}</span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-semibold text-sm text-text-main">{skill.name}</h3>
          {skill.isEntry && (
            <Badge variant="primary" size="sm">
              START HERE
            </Badge>
          )}
          {skill.endpoint && (
            <Badge variant="default" size="sm">
              <code className="text-[10px]">{skill.endpoint}</code>
            </Badge>
          )}
        </div>
        <p className="text-xs text-text-muted mt-0.5">{skill.description}</p>

        <div className="mt-2 flex flex-col gap-1">
          <a
            href={viewPath}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12px] text-primary hover:underline inline-flex items-center gap-1 w-fit"
          >
            Open skill docs
            <span className="material-symbols-outlined text-[13px]">open_in_new</span>
          </a>
          <code
            className="text-[11px] font-mono text-text-subtle break-all"
            title="Paste this URL to an AI agent"
          >
            {rawAbsolute || rawPath}
          </code>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 shrink-0 items-end">
        <CopyButton value={rawAbsolute || rawPath} label="Copy agent URL" />
        <a
          href={viewAbsolute || viewPath}
          target="_blank"
          rel="noopener noreferrer"
          className="px-2 py-1 rounded-md border border-border text-[11px] text-text-main hover:border-primary inline-flex items-center gap-1 transition-colors"
        >
          <span className="material-symbols-outlined text-[12px]">open_in_new</span>
          Open
        </a>
      </div>
    </div>
  );
}

export default function SkillsPage() {
  const origin = useOrigin();
  const entryRaw = absoluteUrl(origin, getSkillRawUrl("switchboard"));

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-[17px] font-semibold text-text-main">Skills</h1>
        <p className="text-xs font-mono text-text-subtle">
          agent skill links · not Media providers
        </p>
      </div>

      <Card padding="md">
        <div className="text-xs text-text-muted mb-2">Paste this to your AI:</div>
        <div className="px-3 py-2 rounded bg-surface-2 font-mono text-[12px] text-text-main break-all">
          Read this skill and use it: {entryRaw || getSkillRawUrl("switchboard")}
        </div>
      </Card>

      <div className="space-y-2">
        {SKILLS.map((skill) => (
          <SkillRow key={skill.id} skill={skill} origin={origin} />
        ))}
      </div>

      <Card padding="md">
        <p className="text-xs text-text-muted leading-relaxed">
          <strong className="text-text-main">Open</strong> opens a readable docs page in a new
          tab. <strong className="text-text-main">Copy agent URL</strong> copies{" "}
          <code className="text-[11px]">/api/skills/&lt;id&gt;</code> for AI agents to fetch the
          raw markdown.
        </p>
      </Card>
    </div>
  );
}
