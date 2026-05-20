import { useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ChevronLeft, Clock, Tag, ArrowRight, ExternalLink, Info, Lightbulb, AlertTriangle } from "lucide-react";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { ScrollToTop } from "@/components/ui/ScrollToTop";
import { Badge } from "@/components/ui/badge";
import { getBlogPost, blogPosts } from "@/data/blog/posts";
import type { BlogSection, BlogPost as BlogPostType } from "@/data/blog/types";
import { cn } from "@/lib/utils";

function ArticleSchema({ post }: { post: BlogPostType }) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    author: { "@type": "Organization", name: post.author },
    publisher: { "@type": "Organization", name: "バイトミー JAPAN" },
    datePublished: post.publishedAt,
    description: post.description,
    image: post.coverImage,
    mainEntityOfPage: `https://biteme.co.jp/blog/${post.slug}`,
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

function SectionRenderer({ section }: { section: BlogSection }) {
  switch (section.type) {
    case "heading2":
      return (
        <h2 className="text-xl sm:text-2xl font-bold text-foreground mt-10 mb-4">
          {section.content}
        </h2>
      );
    case "heading3":
      return (
        <h3 className="text-lg font-semibold text-foreground mt-8 mb-3">
          {section.content}
        </h3>
      );
    case "paragraph":
      return (
        <p className="text-foreground/90 leading-relaxed mb-4">
          {section.content}
        </p>
      );
    case "list":
      return (
        <ul className="space-y-2 mb-6 pl-1">
          {section.items?.map((item, i) => (
            <li key={i} className="flex gap-3 text-foreground/90 leading-relaxed">
              <span className="text-primary mt-1.5 shrink-0 h-1.5 w-1.5 rounded-full bg-primary" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      );
    case "table":
      return (
        <div className="overflow-x-auto mb-6 rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary">
                {section.headers?.map((h, i) => (
                  <th key={i} className="px-4 py-3 text-left font-semibold text-foreground whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.rows?.map((row, ri) => (
                <tr key={ri} className="border-t border-border">
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-4 py-3 text-foreground/90">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "callout": {
      const icons = { tip: Lightbulb, warning: AlertTriangle, info: Info };
      const colors = {
        tip: "bg-green-50 border-green-200 text-green-900",
        warning: "bg-amber-50 border-amber-200 text-amber-900",
        info: "bg-blue-50 border-blue-200 text-blue-900",
      };
      const Icon = icons[section.variant || "info"];
      return (
        <div className={cn("rounded-lg border p-4 mb-6 flex gap-3", colors[section.variant || "info"])}>
          <Icon className="h-5 w-5 shrink-0 mt-0.5" />
          <p className="text-sm leading-relaxed">{section.content}</p>
        </div>
      );
    }
    case "product-card":
      return (
        <Link
          to={`/product/${section.productHandle}`}
          className="group block bg-card rounded-xl border border-border p-4 mb-6 hover:shadow-md hover:border-primary/30 transition-all"
        >
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <p className="text-sm text-foreground/90 leading-relaxed">
                {section.content}
              </p>
              <span className="inline-flex items-center gap-1 text-primary text-sm font-medium mt-2">
                View product <ExternalLink className="h-3.5 w-3.5" />
              </span>
            </div>
          </div>
        </Link>
      );
    default:
      return null;
  }
}

export default function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const post = slug ? getBlogPost(slug) : undefined;

  useEffect(() => {
    if (post) {
      document.title = `${post.title} | バイトミー (BITEME) JAPAN Blog`;
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) metaDesc.setAttribute("content", post.description);

      let ogTitle = document.querySelector('meta[property="og:title"]');
      if (!ogTitle) {
        ogTitle = document.createElement("meta");
        ogTitle.setAttribute("property", "og:title");
        document.head.appendChild(ogTitle);
      }
      ogTitle.setAttribute("content", post.title);

      let ogDesc = document.querySelector('meta[property="og:description"]');
      if (!ogDesc) {
        ogDesc = document.createElement("meta");
        ogDesc.setAttribute("property", "og:description");
        document.head.appendChild(ogDesc);
      }
      ogDesc.setAttribute("content", post.ogDescription);

      let ogImage = document.querySelector('meta[property="og:image"]');
      if (!ogImage) {
        ogImage = document.createElement("meta");
        ogImage.setAttribute("property", "og:image");
        document.head.appendChild(ogImage);
      }
      ogImage.setAttribute("content", post.coverImage);
    }
    window.scrollTo(0, 0);
  }, [post]);

  if (!post) {
    return (
      <div className="bg-background min-h-screen">
        <Header />
        <div className="max-w-4xl mx-auto px-4 py-20 text-center">
          <h1 className="text-2xl font-bold mb-4">Post not found</h1>
          <Link to="/blog" className="text-primary font-medium">
            Back to Blog
          </Link>
        </div>
        <Footer />
      </div>
    );
  }

  const currentIndex = blogPosts.findIndex((p) => p.slug === post.slug);
  const nextPost = blogPosts[currentIndex + 1] || blogPosts[0];
  const publishDate = new Date(post.publishedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="bg-background min-h-screen">
      <ArticleSchema post={post} />
      <Header />

      <main className="max-w-3xl mx-auto px-4 pt-4 pb-24">
        {/* Back nav */}
        <button
          onClick={() => navigate("/blog")}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
        >
          <ChevronLeft className="h-4 w-4" />
          Blog
        </button>

        {/* Cover */}
        <div className="aspect-square rounded-xl overflow-hidden bg-secondary mb-6">
          <img
            src={post.coverImage}
            alt={post.title}
            className="w-full h-full object-cover"
          />
        </div>

        {/* Meta */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <Badge variant="secondary">{post.category}</Badge>
          <span className="text-sm text-muted-foreground">{publishDate}</span>
          <span className="text-sm text-muted-foreground flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" />
            {post.readingTime} min read
          </span>
        </div>

        {/* Title */}
        <h1 className="text-2xl sm:text-3xl font-bold text-foreground leading-tight mb-8">
          {post.title}
        </h1>

        {/* Content */}
        <article className="prose-biteme">
          {post.content.map((section, i) => (
            <SectionRenderer key={i} section={section} />
          ))}
        </article>

        {/* Tags */}
        <div className="flex flex-wrap gap-2 mt-10 pt-6 border-t border-border">
          <Tag className="h-4 w-4 text-muted-foreground" />
          {post.tags.map((tag) => (
            <Badge key={tag} variant="outline" className="text-xs">
              {tag}
            </Badge>
          ))}
        </div>

        {/* Related products */}
        {post.relatedProducts.length > 0 && (
          <div className="mt-10 pt-6 border-t border-border">
            <h2 className="text-lg font-semibold text-foreground mb-4">
              Products Mentioned
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {post.relatedProducts.map((product) => (
                <Link
                  key={product.handle}
                  to={`/product/${product.handle}`}
                  className="flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/30 hover:shadow-sm transition-all group"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
                      {product.title}
                    </p>
                    {product.level && (
                      <span className="text-xs text-muted-foreground">
                        {product.level}
                      </span>
                    )}
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Next post */}
        {nextPost && nextPost.slug !== post.slug && (
          <Link
            to={`/blog/${nextPost.slug}`}
            className="block mt-10 p-5 rounded-xl bg-secondary/50 border border-border hover:border-primary/30 transition-all group"
          >
            <span className="text-xs text-muted-foreground uppercase tracking-wide">
              Next article
            </span>
            <p className="text-base font-semibold text-foreground mt-1 group-hover:text-primary transition-colors">
              {nextPost.title}
            </p>
          </Link>
        )}
      </main>

      <Footer />
      <ScrollToTop />
    </div>
  );
}
