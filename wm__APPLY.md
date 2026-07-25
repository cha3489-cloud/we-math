# we-math 학생 포털 1차 수직 흐름 — 적용 안내

첨부된 `wm__` 파일을 `feature/portal-review-v1` 로컬 브랜치에 매핑해 검증했습니다. 2026-07-25 운영 Supabase에 `20260726000000_portal_review_v2.sql`을 적용하고 catalog 불변식을 확인했으며, `main` 병합은 아직 수행하지 않았습니다.

## 파일 매핑

| 산출물 | 저장소 경로 | 구분 |
|---|---|---|
| wm__supabase__migrations__20260726000000_portal_review_v2.sql | supabase/migrations/20260726000000_portal_review_v2.sql | 신규 |
| wm__src__portal__domain.js | src/portal/domain.js | 교체 |
| wm__src__portal__domain.test.js | src/portal/domain.test.js | 신규 |
| wm__src__portal__student.js | src/portal/student.js | 교체 |
| wm__src__portal__admin.js | src/portal/admin.js | 교체 |
| wm__src__portal__portal.css | src/portal/portal.css | 교체 |
| wm__student__index.html | student/index.html | 교체 |
| wm__admin__index.html | admin/index.html | 교체 |
| wm__supabase__tests__rls_checks.sql | supabase/tests/rls_checks.sql | 신규 (브랜치 전용) |
| 김비서 추가 검증 | tests/portal-review-v2.test.js | 신규 |
| 기존 보안검사 정합화 | tests/security.test.js | 수정 |

변경하지 않은 파일: src/portal/client.js, src/auth.js, Edge Functions(admin-users·change-pin, verify_jwt 설정 포함), 기존 migration.

## 적용 후 보완한 결함

- PDF 업로드는 허용하면서 `<img>`로만 열던 문제를 수정해 이미지와 PDF를 모두 화면 내에서 확인하도록 했습니다. 토큰 없는 iframe `sandbox`가 Chrome 내장 PDF 뷰어를 차단하는 것을 실제 재현해 제거했으며, 비공개 Storage bucket의 60초 signed URL과 서버 `allowed_mime_types` 제한을 유지합니다.
- 관리자 대기열이 전체 과제·제출 이력을 내려받던 구조를 `submissions.status='submitted'` 서버 필터 + 오래된 순 + 최대 100건 조회로 바꿨습니다.
- 신규 테이블과 RPC에서 `authenticated` 권한을 먼저 전부 회수한 뒤 필요한 최소 권한만 다시 부여하고, SECURITY DEFINER 함수의 `search_path`를 빈 값으로 고정했습니다.
- 자동 구성된 호환용 `feedback.body`와 구조화 피드백 항목이 학생 화면에서 중복 표시되지 않도록 했습니다.
- 기존 관리자 전체 과제·미제출·수정 요청·완료 이력을 읽기 전용으로 복원하고, 50개 단위 페이지네이션을 적용했습니다. 검토 확정은 새 대기열에서만 가능합니다.
- 구형 `review_submission` RPC를 fail-closed 호환 래퍼로 교체했습니다. 완료는 v2로 위임해 감사 이벤트를 남기고, 구조화 항목 없는 수정 요청은 서버에서 거부합니다.
- 이미지/PDF signed URL 비동기 경합, 파일 선택 이벤트 중첩, 페이지네이션 연타, 뷰어 Escape·포커스 복귀, 태그 방향키 조작, PDF에 부적합한 사진 중심 문구를 보완했습니다. `[hidden]` CSS 의미도 회귀검사로 고정했습니다.
- 기존 보안 회귀검사를 새 UI 이름에 맞게 갱신하고 v2 전용 보안·흐름 검사 6개를 추가했습니다.
- 첫 독립 검토의 차단 결함을 모두 수정한 뒤 최신 코드 기준 최종 독립 차단 검토에서 `PASS`를 받았습니다.

## 적용 순서

```bash
# 0) 기준 상태 기록
git checkout main && git pull
npm ci && npm test && npm run build   # 기준 결과 기록

# 1) feature branch
git checkout -b feature/portal-review-v1

# 2) 파일 복사 (매핑 표 대로), 커밋
npm test && npm run build             # 전체 회귀검사와 production build 확인

# 3) Supabase branch 생성 후 migration 적용 (운영 금지)
#    Supabase Studio → Branches → create 'portal-review-v1'
#    브랜치에 20260726000000_portal_review_v2.sql 적용

# 4) 합성 데이터로 검증 (실제 학생 데이터 금지)
#    관리자 화면에서 합성 학생 2명(테스트학생A 01000000001 / 테스트학생B 01000000002) 발급
#    합성 과제 등록 → 학생B로 이미지·PDF 제출 → 관리자 검토 → 수정 요청 → 재제출

# 5) RLS 교차 접근 검증 (브랜치 DB에서)
psql "$BRANCH_DB_URL" -v student_a='<A-uuid>' -v student_b='<B-uuid>' \
  -f supabase/tests/rls_checks.sql   # 모든 PASS 확인

# 6) Vite 환경변수를 브랜치 Supabase로 지정해 Preview
VITE_SUPABASE_URL=<branch-url> VITE_SUPABASE_ANON_KEY=<branch-anon-key> npm run dev
#    모바일 뷰(375px) 점검 + 콘솔 오류 0건 확인

# 7) PR 생성 (main 병합은 원장 승인 후)
git push -u origin feature/portal-review-v1
```

## 수동 검증 체크리스트 (완료 조건 대응)

- [x] `npm test` 통과 (8개 파일, 78개 테스트)
- [x] `npm run build` 통과
- [x] 신규 migration PostgreSQL 구문 파싱 통과
- [x] 로컬 Chromium에서 학생·관리자 PDF 내장 뷰어 렌더링 및 콘솔 오류 0건 확인
- [x] 원장 확인: 저장소 외부 자동화·스크립트에서 구형 `review_submission(..., needs_revision)` 호출 없음
- [x] 운영 데이터 없는 별도 임시 Supabase 프로젝트에서 8개 migration 적용·원격 history 일치·RLS SQL 실실행 통과 (Free 플랜은 Preview branch 미지원)
- [x] 학생A 실제 JWT·UI 로그인 → 학생B 제출물·피드백 안 보임 (rls_checks PASS 1~3)
- [x] 학생이 상태 직접 변경·검토 RPC 실행 불가 (rls_checks PASS 4~5)
- [x] 학생의 review_events 접근과 feedback_items 직접 쓰기 차단 (rls_checks PASS 6~7)
- [x] 관리자만 검토 확정 가능, v2 구조화 피드백·감사 이벤트·구형 RPC fail-closed/완료 위임 확인
- [x] 실제 Storage API에서 자기 경로 업로드·삭제 성공, 타 학생 경로 업로드·읽기 차단
- [x] 학생B UI의 1차 수정 필요·2차 완료 이력, 학생A UI의 자기 미제출 과제만 표시, 관리자 UI의 대기열 0·전체 이력·기존 관리 기능 공존 확인
- [x] 서버에서 같은 제출 이중 확정 차단 확인
- [ ] 두 관리자 브라우저 세션으로 동시 확정 시 "이미 처리된 제출" UI 안내 확인
- [x] 실제 학생 UI 이미지 파일 선택→미리보기·품질 경고→Storage 업로드·제출→관리자 이미지 뷰어→구조화 수정 요청→학생 다시 풀 문제→재제출→대기열 재등장
- [ ] 375px 모바일 viewport에서 위 전체 흐름 확인 (원격 브라우저가 `resizeTo(375)`를 무시해 미검증)
- [x] 학생·관리자 실제 임시 프로젝트 연결 브라우저 콘솔 오류 0건
- [x] 운영 Supabase migration `20260726000000` 적용·post catalog 검증 완료 / main 병합 전


## 원격 임시 프로젝트 검증 기록

- Preview branch 생성은 조직의 Free 플랜에서 Pro 전용(HTTP 402)으로 거부되어 생성·과금되지 않았습니다.
- 원장 승인 후 운영 데이터가 없는 두 번째 Free 임시 프로젝트를 생성해 검증했으며, 8개 migration과 `supabase/tests/rls_checks.sql`을 실제 원격 PostgreSQL에서 실행했습니다.
- 합성 관리자·학생 A·학생 B만 사용했고, Storage API·JWT·RLS·RPC·학생/관리자 UI를 검증했습니다.
- 통합검사 19개와 제공 RLS 검사 PASS 1~7이 모두 통과했습니다. 검증 보고서: `we-math-portal-rls-report.json`.
- 검증 종료 후 임시 프로젝트와 합성 데이터·임시 DB 비밀번호·service-role 키·합성 PIN 스크립트를 모두 삭제했고, 운영 프로젝트 링크와 `ACTIVE_HEALTHY` 상태를 확인했습니다.


## 운영 migration 적용 기록

- 적용 시각(UTC): `2026-07-25T21:24:52Z`
- 운영 적용 migration: `20260726000000_portal_review_v2.sql` 1개
- 적용 전 dry-run: 신규 migration 1개만 대상임을 확인
- 적용 후 migration history: 로컬·원격 8개 일치
- 적용 후 dry-run: `Remote database is up to date`
- 실제 catalog 검사: `feedback_items`·`review_events`·`review_submission_v2`·구형 호환 래퍼·RLS 정책·authenticated GRANT 불변식 PASS
- 사용자 행 데이터는 조회·복제하지 않았습니다.
- 적용 전 catalog SHA-256: `768d47a988a08eb304130006394c58c9bf0552d88968ce37f7c2d1c9725875f0`
- 적용 후 catalog SHA-256: `933278b452544a93259576d7114aff0fe4fcfc67a0601a4a78993f58b81763d3`

## 별도 기록: assignments student_id 변경 정책 (이번 PR 제외)

- 위험: `admins update assignments` 정책이 `using/with check (is_admin())`뿐이라, 관리자 세션이 과제의 student_id·created_by를 임의 값으로 UPDATE할 수 있습니다. 1인 관리자 체제에서 실위험은 낮지만, 관리자 계정이 늘거나 세션이 탈취되면 과제를 다른 학생에게 옮겨 제출 무결성(trigger는 insert 시점만 검증)을 흔들 수 있습니다.
- 보완 방법(추후 별도 migration): 해당 UPDATE 정책에 `with check (created_by = auth.uid())`를 추가하고, student_id 변경을 금지하려면 `create trigger`로 `old.student_id = new.student_id`를 강제하거나 컬럼 단위 권한(`revoke update(student_id, created_by) on public.assignments from authenticated`)을 적용합니다. 권장은 컬럼 권한 revoke — 정책 변경 없이 가장 좁게 막습니다.


## 알려진 비차단 표시 부채

- 구조화 항목이 있을 때 `feedback.body`가 `이번 제출에서 다시 확인할 부분입니다.`로 시작하면 자동 구성 본문으로 간주해 중복 표시를 숨깁니다. 원장이 실제 총평을 우연히 같은 문장으로 시작하면 화면에서 총평이 숨겨질 수 있으나 데이터는 보존됩니다. 정석 보완은 추후 `feedback.auto_composed boolean` 같은 명시적 플래그 migration이며, 이번 수직 흐름에서는 스키마 범위를 늘리지 않았습니다.
