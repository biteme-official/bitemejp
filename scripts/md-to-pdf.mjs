import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mdPath = resolve(__dirname, '../RISK_REPORT_2026-06-05.md');
const pdfPath = resolve(__dirname, '../RISK_REPORT_2026-06-05.pdf');

const md = readFileSync(mdPath, 'utf-8');

// 마크다운 → HTML 변환 (기본 패턴)
function mdToHtml(text) {
  return text
    // 코드 블록 (인라인보다 먼저 처리)
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre><code class="lang-${lang}">${escHtml(code.trim())}</code></pre>`)
    // 인라인 코드
    .replace(/`([^`]+)`/g, (_, c) => `<code>${escHtml(c)}</code>`)
    // 수평선
    .replace(/^---$/gm, '<hr>')
    // 제목
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    // 굵게 + 기울임
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    // 굵게
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // 테이블
    .replace(/(\|.+\|\n\|[-| :]+\|\n(?:\|.+\|\n?)+)/g, parseTable)
    // 체크박스 리스트
    .replace(/^- \[ \] (.+)$/gm, '<li class="todo unchecked">$1</li>')
    .replace(/^- \[x\] (.+)$/gm, '<li class="todo checked">$1</li>')
    // 순서 없는 목록
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    // li 묶기
    .replace(/(<li[^>]*>[\s\S]+?<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
    // 링크
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // 빈 줄 → 단락 구분
    .replace(/\n\n+/g, '\n\n')
    // 일반 텍스트 줄 → p 태그
    .replace(/^(?!<[a-z]|$)(.+)$/gm, '<p>$1</p>');
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseTable(block) {
  const lines = block.trim().split('\n').filter(l => !l.match(/^\|[-| :]+\|$/));
  const rows = lines.map(l =>
    l.split('|').slice(1, -1).map(c => c.trim())
  );
  const [head, ...body] = rows;
  const th = head.map(c => `<th>${c}</th>`).join('');
  const tb = body.map(r =>
    `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`
  ).join('\n');
  return `<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`;
}

const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BITEME JAPAN 리스크 분석 리포트</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif;
    font-size: 11px;
    line-height: 1.7;
    color: #1a1a2e;
    padding: 32px 40px;
    max-width: 900px;
    margin: 0 auto;
  }
  h1 {
    font-size: 22px;
    font-weight: 700;
    color: #0f172a;
    border-bottom: 3px solid #e63946;
    padding-bottom: 10px;
    margin: 28px 0 16px;
  }
  h2 {
    font-size: 16px;
    font-weight: 700;
    color: #1e3a5f;
    border-left: 4px solid #e63946;
    padding-left: 10px;
    margin: 26px 0 12px;
    background: #f8fafc;
    padding: 6px 12px;
  }
  h3 {
    font-size: 13px;
    font-weight: 700;
    color: #334155;
    margin: 18px 0 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid #e2e8f0;
  }
  h4 {
    font-size: 12px;
    font-weight: 700;
    color: #475569;
    margin: 14px 0 6px;
  }
  p { margin: 6px 0; color: #374151; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 20px 0; }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 10.5px;
  }
  th {
    background: #1e3a5f;
    color: #fff;
    padding: 7px 10px;
    text-align: left;
    font-weight: 600;
  }
  td {
    padding: 6px 10px;
    border-bottom: 1px solid #e2e8f0;
    vertical-align: top;
  }
  tr:nth-child(even) td { background: #f8fafc; }
  code {
    background: #f1f5f9;
    border: 1px solid #e2e8f0;
    border-radius: 3px;
    padding: 1px 5px;
    font-family: 'Consolas', 'D2Coding', 'Courier New', monospace;
    font-size: 10px;
    color: #c0392b;
  }
  pre {
    background: #0f172a;
    border-radius: 6px;
    padding: 14px 16px;
    margin: 10px 0;
    overflow-x: auto;
    page-break-inside: avoid;
  }
  pre code {
    background: none;
    border: none;
    color: #e2e8f0;
    font-size: 9.5px;
    line-height: 1.6;
    padding: 0;
  }
  ul { padding-left: 20px; margin: 6px 0; }
  li { margin: 3px 0; color: #374151; }
  li.todo { list-style: none; padding-left: 4px; }
  li.unchecked::before { content: '☐ '; color: #94a3b8; }
  li.checked::before { content: '☑ '; color: #16a34a; }
  a { color: #2563eb; text-decoration: none; }
  strong { font-weight: 700; color: #0f172a; }
  .cover {
    text-align: center;
    padding: 60px 0 40px;
    border-bottom: 2px solid #e63946;
    margin-bottom: 30px;
  }
  .cover-title {
    font-size: 28px;
    font-weight: 800;
    color: #0f172a;
    margin-bottom: 10px;
  }
  .cover-sub {
    font-size: 13px;
    color: #64748b;
    margin: 4px 0;
  }
  .cover-badge {
    display: inline-block;
    margin-top: 16px;
    background: #e63946;
    color: #fff;
    padding: 6px 18px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 700;
  }
  @media print {
    body { padding: 20px 28px; }
    h2 { page-break-before: auto; }
    pre, table { page-break-inside: avoid; }
  }
</style>
</head>
<body>

<div class="cover">
  <div class="cover-title">BITEME JAPAN<br>운영 리스크 분석 리포트</div>
  <div class="cover-sub">대상 서비스: biteme.co.jp</div>
  <div class="cover-sub">작성일: 2026-06-05</div>
  <div class="cover-sub">작성 배경: 2026-06-04 Shopify API 장애 → 롤백 이후 전체 리스크 점검</div>
  <span class="cover-badge">전체 보안 점수: 3.1 / 10 🔴 매우 위험</span>
</div>

${mdToHtml(md.replace(/^# BITEME JAPAN 운영 리스크 분석 리포트[\s\S]*?---\n\n## 목차[\s\S]*?---\n\n/, ''))}

</body>
</html>`;

// HTML 파일 임시 저장 (디버깅용)
const htmlPath = pdfPath.replace('.pdf', '.html');
writeFileSync(htmlPath, html, 'utf-8');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'networkidle' });

await page.pdf({
  path: pdfPath,
  format: 'A4',
  printBackground: true,
  margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
});

await browser.close();

// HTML 임시 파일 제거
import { unlinkSync } from 'fs';
try { unlinkSync(htmlPath); } catch {}

console.log(`PDF 저장 완료: ${pdfPath}`);
