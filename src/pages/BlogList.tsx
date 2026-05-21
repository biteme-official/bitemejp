import { useState } from "react";
import { Link } from "react-router-dom";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { ScrollToTop } from "@/components/ui/ScrollToTop";
import { blogPosts, getAllCategories } from "@/data/blog/posts";
import { Badge } from "@/components/ui/badge";
import { Clock, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

export default function BlogList() {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const categories = getAllCategories();

  const filtered = selectedCategory
    ? blogPosts.filter((p) => p.category === selectedCategory)
    : blogPosts;

  return (
    <div className="bg-background min-h-screen">
      <Header />

      <main className="max-w-4xl mx-auto px-4 pt-6 pb-24">
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground tracking-tight">
            ブログ
          </h1>
          <p className="text-muted-foreground mt-2 text-sm sm:text-base">
            愛犬との毎日に役立つガイド、ヒント、ストーリー。
          </p>
        </div>

        <div className="flex gap-2 mb-8 overflow-x-auto pb-2 scrollbar-hide">
          <button
            onClick={() => setSelectedCategory(null)}
            className={cn(
              "shrink-0 px-4 py-1.5 rounded-full text-sm font-medium transition-colors",
              !selectedCategory
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
            )}
          >
            すべて
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={cn(
                "shrink-0 px-4 py-1.5 rounded-full text-sm font-medium transition-colors",
                selectedCategory === cat
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
              )}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Featured post — horizontal layout */}
        {filtered.length > 0 && (
          <Link
            to={`/blog/${filtered[0].slug}`}
            className="group block mb-8"
          >
            <article className="bg-card rounded-xl border border-border overflow-hidden hover:shadow-md transition-shadow sm:flex">
              <div className="aspect-square sm:w-60 sm:flex-shrink-0 overflow-hidden bg-secondary">
                <img
                  src={filtered[0].coverImage}
                  alt={filtered[0].title}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  loading="eager"
                />
              </div>
              <div className="p-5 sm:p-6 flex flex-col justify-center">
                <div className="flex items-center gap-2 mb-3">
                  <Badge variant="secondary" className="text-xs">
                    {filtered[0].category}
                  </Badge>
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {filtered[0].readingTime} 分で読める
                  </span>
                </div>
                <h2 className="text-lg sm:text-xl font-semibold text-foreground group-hover:text-primary transition-colors leading-snug">
                  {filtered[0].title}
                </h2>
                <p className="text-muted-foreground text-sm mt-2 line-clamp-2">
                  {filtered[0].description}
                </p>
                <span className="inline-flex items-center gap-1 text-primary text-sm font-medium mt-4">
                  続きを読む <ArrowRight className="h-4 w-4" />
                </span>
              </div>
            </article>
          </Link>
        )}

        {/* Grid for remaining posts */}
        {filtered.length > 1 && (
          <div className="grid gap-6 sm:grid-cols-2">
            {filtered.slice(1).map((post) => (
              <Link
                key={post.slug}
                to={`/blog/${post.slug}`}
                className="group block"
              >
                <article className="bg-card rounded-xl border border-border overflow-hidden hover:shadow-md transition-shadow h-full flex flex-col">
                  <div className="aspect-[4/3] overflow-hidden bg-secondary">
                    <img
                      src={post.coverImage}
                      alt={post.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      loading="lazy"
                    />
                  </div>
                  <div className="p-4 flex flex-col flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="secondary" className="text-xs">
                        {post.category}
                      </Badge>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {post.readingTime} 分
                      </span>
                    </div>
                    <h2 className="text-base font-semibold text-foreground group-hover:text-primary transition-colors leading-snug">
                      {post.title}
                    </h2>
                    <p className="text-muted-foreground text-sm mt-1.5 line-clamp-2 flex-1">
                      {post.description}
                    </p>
                    <span className="inline-flex items-center gap-1 text-primary text-sm font-medium mt-3">
                      続きを読む <ArrowRight className="h-4 w-4" />
                    </span>
                  </div>
                </article>
              </Link>
            ))}
          </div>
        )}

        {filtered.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            このカテゴリの記事はまだありません。
          </div>
        )}
      </main>

      <Footer />
      <ScrollToTop />
    </div>
  );
}
