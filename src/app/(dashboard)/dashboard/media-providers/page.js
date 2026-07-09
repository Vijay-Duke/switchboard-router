"use client";
// @ts-check

import Link from "next/link";
import { Card } from "@/shared/components";
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";

/**
 * Media hub — pick a modality. Skills live under /dashboard/skills (separate nav).
 * Visible kinds match the product surface we ship (not every experimental kind).
 */
const HUB_KINDS = [
  { id: "image", label: "Text to Image", icon: "brush", blurb: "Image generation providers" },
  { id: "tts", label: "Text to Speech", icon: "record_voice_over", blurb: "Speech synthesis providers" },
  { id: "stt", label: "Speech to Text", icon: "mic", blurb: "Transcription providers" },
  { id: "embedding", label: "Embedding", icon: "data_array", blurb: "Vector embedding providers" },
  { id: "web", label: "Web Fetch & Search", icon: "travel_explore", blurb: "Search + page fetch providers" },
];

export default function MediaProvidersHubPage() {
  return (
    <div className="flex flex-col gap-5 max-w-3xl">
      <div className="flex flex-col gap-1">
        <h1 className="text-[17px] font-semibold text-text-main">Media</h1>
        <p className="text-xs font-mono text-text-subtle">
          image · TTS · STT · embeddings · web — separate from agent Skills
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {HUB_KINDS.map((k) => {
          const meta = MEDIA_PROVIDER_KINDS.find((m) => m.id === k.id);
          return (
            <Link key={k.id} href={`/dashboard/media-providers/${k.id}`} className="group">
              <Card
                padding="sm"
                className="h-full transition-colors group-hover:border-brand-500/40"
              >
                <div className="flex items-start gap-3">
                  <div className="size-9 rounded-lg bg-brand-500/10 text-primary flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-[20px] leading-none">
                      {k.icon || meta?.icon || "perm_media"}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="text-sm font-semibold text-text-main">
                        {k.label || meta?.label || k.id}
                      </h2>
                      <span className="material-symbols-outlined text-text-subtle text-[16px] group-hover:text-primary transition-colors">
                        chevron_right
                      </span>
                    </div>
                    <p className="text-xs text-text-muted mt-0.5">{k.blurb}</p>
                  </div>
                </div>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
