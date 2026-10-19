import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canReadArticle } from "@/lib/kb";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json([]);

  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 4) return Response.json([]);

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const terms = q.split(/\s+/).map(normalize).filter((t) => t.length >= 3);
  if (terms.length === 0) return Response.json([]);

  const articles = (await prisma.article.findMany({ where: { published: true } }))
    .filter((article) => canReadArticle(user, article))
    .map((article) => {
      const haystack = normalize(`${article.title} ${article.body}`);
      const titleNorm = normalize(article.title);
      let score = 0;
      for (const term of terms) {
        if (titleNorm.includes(term)) score += 2;
        else if (haystack.includes(term)) score += 1;
      }
      return { article, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  return Response.json(
    articles.map(({ article }) => ({ title: article.title, slug: article.slug }))
  );
}
