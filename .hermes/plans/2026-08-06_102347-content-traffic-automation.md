# 시퀀스 수학 콘텐츠 유입 자동화 구현 계획

> **For Hermes:** 단계별로 구현하며 각 단계마다 TDD, 빌드, 실제 URL 검증을 완료한 뒤 다음 단계로 넘어간다.

**Goal:** 홈페이지 블로그를 원본 자산으로 두고 네이버·Instagram·Threads에서 생성한 콘텐츠가 측정 가능한 링크로 홈페이지 유입을 만들도록 자동화한다.

**Architecture:** 게시물 원고를 단일 Markdown/JSON 데이터로 관리하고 빌드 스크립트가 홈페이지 HTML·목록·사이트맵·RSS·채널별 파생 파일을 생성한다. Meta는 기존 API 게시 스크립트를 재사용하고, 네이버는 붙여넣기 직전까지 자동화한다. 모든 링크에는 채널별 UTM을 붙이며 게시 결과와 유입 지표를 Notion에 기록한다.

**Tech Stack:** Vite, Vitest, Node.js 생성 스크립트, 기존 Python/Pillow 카드뉴스 생성기, Instagram Graph API, Threads API, Notion API, GitHub Actions/Pages

---

## 현재 확인된 상태

- 홈페이지 블로그 글 2편이 GitHub Pages에 배포되어 있다.
- 글마다 canonical과 BlogPosting 구조화 데이터는 있다.
- `og:image`, 관련 글 영역, RSS, 방문 분석 도구는 없다.
- 게시물 추가 시 HTML·블로그 목록·Vite 입력·사이트맵을 수동으로 각각 수정한다.
- `/opt/data/sequence_math_blog_automation/scripts/publish_cardnews.py`로 Instagram 카드뉴스와 Threads 게시가 가능하다.
- 네이버 블로그는 공식 안전 게시 API가 없어 붙여넣기·최종 검수 1회를 남긴다.

---

## 1단계: 유입 측정·공유·연속 읽기 기반

### Task 1: UTM 규격과 유입 링크 테스트

**Files**
- Create: `src/marketing/utm.js`
- Create: `tests/utm.test.js`
- Modify: `package.json`

**UTM 규격**

```text
utm_source: naver | instagram | threads
utm_medium: blog | social | story
utm_campaign: 게시물 slug
utm_content: profile | post | story | card-07
```

**TDD**
1. `buildCampaignUrl()`의 실패 테스트 작성
2. `npm test -- --run tests/utm.test.js`로 RED 확인
3. URL 생성·기존 query/hash 보존 구현
4. GREEN 확인

### Task 2: 공유 대표 이미지와 관련 글 영역

**Files**
- Modify: `blog/choosing-math-academy/index.html`
- Modify: `blog/homework-routine-recovery/index.html`
- Modify: `src/style.css`
- Modify: `tests/blog.test.js`
- Create: `public/img/blog/choosing-math-academy-og.png`
- Create: `public/img/blog/homework-routine-recovery-og.png`

**Acceptance**
- 두 글 모두 절대 URL `og:image`, Twitter card 메타 제공
- 본문 하단에 서로 연결되는 관련 글 카드 제공
- 이미지 1200×630, 한글 실제 폰트 사용, 시각 검수 통과
- 모집성 문구 없음

### Task 3: 방문 분석 연결 준비

**Files**
- Create: `src/analytics.js`
- Modify: `index.html`
- Modify: `blog/index.html`
- Modify: 두 게시물 HTML
- Create: `tests/analytics.test.js`

**Approach**
- `VITE_GA_MEASUREMENT_ID`가 있을 때만 GA4 로드
- 개발·테스트 환경에서는 네트워크 호출하지 않음
- UTM 최초 유입값을 세션 단위로 보존
- 사용자에게 필요한 입력은 GA4 Measurement ID 한 개

### Task 4: 검색 도구 연결

**User-owned prerequisite**
- Google Search Console 속성 등록
- 네이버 서치어드바이저 사이트 등록

**Hermes-owned work**
- 검증 메타태그 적용
- `sitemap.xml` 제출 URL 검증
- `robots.txt`와 canonical 재검사

### Task 5: 1단계 검증·배포

```bash
npm test
npm run build
git diff --check
git push origin main
```

실제 확인:
- 두 게시물 HTTP 200
- OG 이미지 HTTP 200
- 관련 글 상호 이동
- UTM 링크 query 보존
- GitHub Actions success

**1단계 완료 기준:** 측정 ID 발급을 제외한 코드 구현이 완료되고, 필요한 사용자 작업이 한 번의 계정 설정으로 정리된다.

---

## 2단계: 단일 원고 데이터 기반 생성

### 구조

```text
content/posts/*.md
content/posts/*.json
scripts/generate-blog.mjs
scripts/generate-channel-package.mjs
```

한 게시물 데이터에서 자동 생성:

- 홈페이지 상세 HTML
- 블로그 목록
- `sitemap.xml`
- `rss.xml`
- canonical·OG·BlogPosting JSON-LD
- 네이버 붙여넣기 원고
- Instagram 7장 문안·캡션
- Threads 3~4개 문안
- UTM 링크

**핵심 검증**
- 같은 slug 중복 차단
- 필수 메타 누락 차단
- 금지 문구 차단
- 새 글이 목록·사이트맵·RSS·Vite 빌드에 자동 포함
- 기존 두 글을 데이터 형식으로 마이그레이션해 출력이 유지되는지 비교

---

## 3단계: 숙제 루틴 콘텐츠 파일럿

원본:
- `https://sequencemath.co.kr/blog/homework-routine-recovery/`

산출물:
- 네이버 모바일 붙여넣기 원고
- 16:9 네이버 이미지 3장
- 1080×1350 Instagram 카드뉴스 7장
- Instagram 캡션
- Threads 3~4개
- 네이버·Instagram·Threads별 UTM 링크
- contact sheet 시각 검수

게시:
- 네이버: 사용자 최종 붙여넣기 1회
- Instagram·Threads: 사용자 공개 승인 후 기존 API로 게시
- 게시 ID·공개 URL 재조회 검증

---

## 4단계: 반복 운영·성과 집계

### Notion 콘텐츠 원장

속성:
- 주제키, slug, 원본 URL, 상태
- 홈페이지·네이버·Instagram·Threads 개별 상태
- 공개 URL·게시 ID
- UTM campaign
- 생성일·게시일·재활용일
- 7일·28일 유입

### 예약 자동화

- 주 1회 미게시 후보 선정
- 초안·이미지·파생 콘텐츠 자동 생성
- 승인 대기 보고
- 승인 후 Meta 게시
- 7일 뒤 유입·도달·클릭 결과 요약
- 중복 주제와 최근 게시물 자동 제외

---

## 위험과 원칙

- 유입 측정 없이 게시량부터 늘리지 않는다.
- 홈페이지와 네이버에 완전히 동일한 글을 기계 복제하지 않는다.
- Instagram 캡션 URL은 클릭되지 않으므로 프로필 링크와 스토리 링크를 사용한다.
- 네이버 로그인 브라우저 자동화는 보안·안정성 때문에 기본 경로로 채택하지 않는다.
- 개원 준비 단계에서는 모집·등록·상담 CTA를 자동 생성하지 않는다.
- Meta 공개 게시는 사용자의 명시적 승인 후 실행한다.

## 단계 운영 규칙

각 단계는 `구현 → 자동 테스트 → 시각 검수 → 실제 배포 → Notion 기록`까지 완료한 뒤 다음 단계로 넘어간다.
