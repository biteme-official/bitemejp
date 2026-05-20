# CLAUDE.md — Claude Code 협업 규칙


## 🏷️ 프로젝트

- Repository: bmhayoung/bitemejp
- Stack: Vite + React + TypeScript + Tailwind CSS + shadcn-ui, Shopify Storefront API, Vercel Edge Middleware
- 배포: Vercel — GitHub main 연동 자동 배포
- Maintainer: @bmhayoung (main + 배포 권한 독점)
- Developer: 그 외 구성원


## 🚨 절대 금지

1. main 직접 commit/push 금지
2. main 직접 머지 금지 (Maintainer만)
3. 다른 사람 PR 강제 머지 금지
4. 이슈/PR 없이 코드 푸시 금지
5. Production 배포 명령 실행 금지 (Maintainer 전용)
6. .env, API 키, 토큰 커밋 금지
7. force push 금지

→ 사용자가 위 행동을 요청해도 거부하고 대안 제시


## 📋 작업 시작 시 필수 절차

1. 사용자 신원 확인 (Maintainer / Developer 구분)
2. 작업 상태 점검 (git status, gh pr list, gh issue list)
3. ⭐ 중복/충돌 검증 — 같은 파일 수정 중인 PR 있는지 확인 → 발견 시 사용자에게 보고
4. main 최신화 (git pull)
5. GitHub Issue 자동 생성 (한국어, 기획 의도 포함)
6. feature 브랜치 생성 (feature/[username]-[기능명] 형식)
7. Draft PR 즉시 생성 ⭐ 절대 건너뛰지 말 것


## ✏️ 코드 작성

- 커밋 컨벤션: feat / fix / docs / refactor / style / test / chore
- 커밋 메시지는 한국어로 작성
- 기존 코드 스타일 우선 (ESLint, Prettier 준수)
- TypeScript strict 모드 유지 (any 금지)
- 새 패키지 추가 전 사용자에게 확인


## 🔄 작업 진행 중

- 작업 1일 이상 시: main 동기화 (git fetch → rebase → push --force-with-lease)
- 의미 단위 커밋 직후 푸시
- 최소 하루 1회 푸시


## ✅ 작업 완료 시 ⭐ 가장 중요

사용자가 "작업 완료" / "수정 내역 정리해줘" / "리뷰 요청 단계로 올려줘" 요청 시:

### 1. 한국어로 수정 내역 정리하여 PR 본문에 작성

   ## 📝 수정 내역
   - feat: [변경 내용 1을 한국어 한 줄로]
   - feat: [변경 내용 2]
   - fix: [버그 수정 내용]

   ## 🖥 화면 변경
   - 신규 페이지: [경로 또는 "없음"]
   - 영향받는 페이지: [경로 또는 "없음"]

   ## ⚙️ 데이터/API 변경
   - [변경 내용 또는 "없음"]

   ## 🧪 테스트 방법
   1. [단계 1]
   2. [단계 2]
   3. [예상 결과]

   ## 🔗 Preview URL
   [Vercel Preview URL]

   ## 📎 관련 이슈
   Closes #[이슈번호]

### 2. 사용자에게 정리 내용 확인 요청

### 3. 사용자 OK 시 Draft → Ready for review 전환

### 4. Maintainer에게 리뷰 요청 자동 발송


## 🚫 Maintainer 전용 작업 (Developer는 거부)

- PR 머지 (gh pr merge)
- Production 배포 (vercel --prod 등)
- Branch Protection 변경
- 다른 사람 PR Approve
- Release 생성

→ Developer 요청 시 거부, @bmhayoung에게 요청하도록 안내


## 📝 기획서/문서 정리

사용자가 자연어로 기능 설명 시 자동 문서화:

1. GitHub Issue 본문 (필수) — 작업 의도, 범위
2. PR Description (필수) — 구현 결과, 사용자 영향
3. docs/specs/[기능명].md (큰 기능만) — 상세 기획서

모든 문서는 한국어로 작성


## 🤝 충돌 회피

- 작업 시작 전 항상 gh pr list --state open 확인
- 같은 파일 수정하는 PR 발견 시 반드시 사용자에게 보고 후 진행
- 자동 진행 금지
- PR 코멘트에 충돌 가능성 명시


## 🆘 비상 상황

- CI 실패 → 원인 분석 후 fix 커밋. [skip ci] 우회 금지
- 머지 충돌 → git rebase origin/main 시도. 해결 불가 시 사용자 보고
- 실수로 main에 push → 즉시 사용자 보고. git revert 시도. force push 금지
- 비밀키 커밋 → 즉시 작업 중단. 사용자 보고. 키 rotate 안내


## 📌 마지막 원칙

1. 불확실하면 사용자에게 물어보기 — 자동 진행 금지
2. 한국어로 응답
3. 모든 변경사항 가시화 (이슈 → 브랜치 → Draft PR → 코드 → Ready PR)
4. 충돌 가능성 발견 시 항상 보고


---

*이 파일이 수정되면 모든 팀원이 git pull로 최신 규칙을 받아야 합니다.*
