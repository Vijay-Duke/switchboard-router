import DocsLayout from "@/components/DocsLayout";
import DocsContent from "@/components/DocsContent";
import RedirectStub from "@/components/RedirectStub";
import { extractHeadings } from "@/utils/markdown";
import { loadContent, getAllSlugs } from "@/lib/content";
import { LANG_CODES, isValidLang, DEFAULT_LANG } from "@/constants/languages";
import { RETIRED_LANG_CODES, RETIRED_SLUGS, redirectTarget } from "@/constants/redirects";
import { notFound } from "next/navigation";

export const dynamicParams = false;

export async function generateStaticParams() {
  const slugs = getAllSlugs(DEFAULT_LANG);
  const retired = RETIRED_SLUGS.map(s => s.split("/"));
  const params = [];
  // Live pages, plus a redirect stub for every retired slug and retired locale
  // so old bookmarks and search results keep resolving.
  for (const lang of [...LANG_CODES, ...RETIRED_LANG_CODES]) {
    for (const slug of [...slugs, ...retired]) {
      params.push({ lang, slug });
    }
  }
  return params;
}

export default async function DocPage({ params }) {
  const { lang, slug } = await params;
  const target = redirectTarget(lang, slug);
  if (target) return <RedirectStub href={target} />;
  if (!isValidLang(lang)) notFound();

  const content = loadContent(lang, slug);
  if (!content) notFound();

  const headings = extractHeadings(content);

  return (
    <DocsLayout headings={headings} lang={lang}>
      <DocsContent content={content} />
    </DocsLayout>
  );
}
