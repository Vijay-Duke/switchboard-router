"use client";
// @ts-check

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Card, Button } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { SKILLS, getSkillRawUrl } from "@/shared/constants/skills";
import { renderSkillMarkdown } from "@/lib/skills/markdown.js";

export default function SkillDetailPage() {
  const params = useParams();
  const id = typeof params?.id === "string" ? params.id : "";
  const catalog = SKILLS.find((s) => s.id === id);
  const [html, setHtml] = useState("");
  const [frontmatter, setFrontmatter] = useState(/** @type {Record<string,string>} */ ({}));
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [rawAbsolute, setRawAbsolute] = useState("");
  const { copied, copy } = useCopyToClipboard(2000);

  const rawPath = getSkillRawUrl(id);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setRawAbsolute(`${window.location.origin}${rawPath}`);
    }
  }, [rawPath]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setHtml("");

    fetch(rawPath)
      .then(async (res) => {
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${res.status}`);
        }
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        const { html: rendered, meta } = renderSkillMarkdown(text);
        setFrontmatter(meta);
        setHtml(rendered);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || "Failed to load skill");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id, rawPath]);

  const title = catalog?.name || frontmatter.name || id;
  const description = catalog?.description || frontmatter.description || "";

  return (
    <div className="max-w-3xl mx-auto space-y-4 pb-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link
            href="/dashboard/skills"
            className="text-xs text-text-muted hover:text-primary inline-flex items-center gap-1 mb-2"
          >
            <span className="material-symbols-outlined text-[14px]">arrow_back</span>
            All skills
          </Link>
          <h1 className="text-[20px] font-semibold text-text-main tracking-tight">
            {title}
          </h1>
          {description ? (
            <p className="text-sm text-text-muted mt-1 leading-relaxed">{description}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => copy(rawAbsolute || rawPath)}
            title={rawAbsolute || rawPath}
          >
            <span className="material-symbols-outlined text-[14px] mr-1">
              {copied ? "check" : "content_copy"}
            </span>
            {copied ? "Copied!" : "Copy raw URL"}
          </Button>
          <a
            href={rawPath}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-border text-xs text-text-main hover:border-primary transition-colors"
          >
            <span className="material-symbols-outlined text-[14px]">open_in_new</span>
            Raw markdown
          </a>
        </div>
      </div>

      {(rawAbsolute || rawPath) && !loading && !error ? (
        <div className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-text-subtle font-semibold mb-0.5">
            Agent fetch URL
          </div>
          <code className="text-[12px] font-mono text-text-main break-all">
            {rawAbsolute || rawPath}
          </code>
        </div>
      ) : null}

      <Card padding="lg" className="overflow-hidden">
        {loading && (
          <p className="text-sm text-text-muted flex items-center gap-2 py-8 justify-center">
            <span className="material-symbols-outlined animate-spin text-[18px]">
              progress_activity
            </span>
            Loading skill…
          </p>
        )}
        {error && (
          <div className="text-sm text-red-400 py-4">
            <p className="font-medium">Could not load skill</p>
            <p className="text-xs mt-1 opacity-80">{error}</p>
            <p className="text-xs text-text-muted mt-2">
              Expected file: <code className="font-mono">skills/{id}/SKILL.md</code>
            </p>
          </div>
        )}
        {!loading && !error && html ? (
          <article
            className="skill-md"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : null}
      </Card>
    </div>
  );
}
