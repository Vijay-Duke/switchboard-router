import DocsLayout from "@/components/DocsLayout";
import DocsContent from "@/components/DocsContent";
import { extractHeadings } from "@/utils/markdown";
import { loadContent } from "@/lib/content";
import RedirectStub from "@/components/RedirectStub";
import { LANG_CODES, isValidLang } from "@/constants/languages";
import { RETIRED_LANG_CODES, redirectTarget } from "@/constants/redirects";
import { notFound } from "next/navigation";

export const dynamicParams = false;

export async function generateStaticParams() {
  return [...LANG_CODES, ...RETIRED_LANG_CODES].map(lang => ({ lang }));
}

export default async function LangHomePage({ params }) {
  const { lang } = await params;
  const target = redirectTarget(lang, "");
  if (target) return <RedirectStub href={target} />;
  if (!isValidLang(lang)) notFound();

  const content = loadContent(lang, "index") || "# Switchboard Documentation\n\nContent coming soon...";
  const headings = extractHeadings(content);

  return (
    <DocsLayout headings={headings} lang={lang}>
      <DocsContent content={content} />
    </DocsLayout>
  );
}
