import { useState } from "react";

/** 어드민 목록 한 페이지 크기 (#254) */
export const PAGE_SIZE = 10;

export interface Paged<T> {
  /** 이번 페이지에 보일 항목 */
  items: T[];
  /** 0부터 */
  page: number;
  pages: number;
  total: number;
  size: number;
  setPage: (page: number) => void;
}

/**
 * 목록을 10개씩 잘라 보여 준다.
 * resetKey 가 바뀌면(필터·검색 변경) 1페이지로 돌아간다. 목록이 줄어 페이지가 사라지면 마지막 페이지로 당긴다.
 */
export function usePaged<T>(all: T[], resetKey?: unknown, size = PAGE_SIZE): Paged<T> {
  const [page, setPage] = useState(0);
  const [key, setKey] = useState(resetKey);
  if (key !== resetKey) {
    setKey(resetKey);
    setPage(0);
  }
  const pages = Math.max(1, Math.ceil(all.length / size));
  const cur = Math.min(page, pages - 1);
  return { items: all.slice(cur * size, cur * size + size), page: cur, pages, total: all.length, size, setPage };
}
