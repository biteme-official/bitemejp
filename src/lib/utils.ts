import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Shopify CDN 이미지를 표시 크기에 맞춰 줄여 받는다.
 * 원본(1,000~1,300px)을 그대로 쓰면 메인 무한 스크롤에서 사진이 쌓여 아이폰 사파리가
 * 메모리 한도를 넘기고 탭을 하얗게 비운 뒤 새로고침한다(실측 184장 ≈ 680MB).
 * Shopify CDN 이 아닌 주소는 그대로 돌려준다.
 */
export function shopifyImageUrl(url: string, width: number): string {
  if (!url.includes("cdn.shopify.com")) return url;
  const u = new URL(url);
  u.searchParams.set("width", String(width));
  return u.toString();
}
