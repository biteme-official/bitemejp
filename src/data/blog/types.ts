export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  ogDescription: string;
  author: string;
  publishedAt: string;
  category: string;
  tags: string[];
  coverImage: string;
  readingTime: number;
  content: BlogSection[];
  relatedProducts: RelatedProduct[];
}

export interface BlogSection {
  type: "paragraph" | "heading2" | "heading3" | "list" | "table" | "callout" | "product-card";
  content?: string;
  items?: string[];
  rows?: string[][];
  headers?: string[];
  variant?: "tip" | "warning" | "info";
  productHandle?: string;
}

export interface RelatedProduct {
  handle: string;
  title: string;
  level?: string;
}
