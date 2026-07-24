# 학생 포털 MVP 운영 메모

## 보안 전제
- 공개 회원가입은 UI와 로컬 Supabase 설정에서 비활성화되어 있습니다. 운영 Supabase Dashboard의 Auth 설정에서도 신규 가입을 반드시 끄세요.
- 레거시 계정 전환 기간에는 로그인만 숫자 4자리 또는 6자리를 허용합니다. 계정 발급, 재설정, 새 PIN은 정확히 숫자 6자리이며 내부 Auth 비밀번호 래퍼 `wm + PIN + sq`를 유지합니다.
- 최초 로그인과 관리자 재설정 뒤에는 `change-pin` Edge Function이 Auth 비밀번호를 변경한 뒤 `must_change_pin=false`로 전환합니다. 변경 전에는 역할·본인 프로필·PIN 변경 외 포털 데이터 및 관리자 작업이 RLS에서 차단됩니다.
- 브라우저에는 `VITE_SUPABASE_URL`과 anon key만 둡니다. service-role key는 Edge Function secret으로만 사용합니다.
- `user_roles`는 브라우저 사용자가 insert/update/delete할 수 없습니다. 최초 관리자는 Dashboard와 SQL Editor에서 부트스트랩합니다.
- `admin-users`와 `change-pin` Edge Function은 운영 `https://we-math.pages.dev`, 이 프로젝트의 HTTPS Pages 미리보기 하위 도메인, 명시적 localhost 개발 Origin만 허용합니다.
- 계정 정지는 Auth ban과 별개로 RLS·Storage·Edge Function에서 `suspended_at`을 확인해 기존 JWT도 즉시 차단합니다.
- Data API 권한은 테이블별 최소 GRANT만 부여하며, 제출 검토는 직접 UPDATE가 아니라 `review_submission()` RPC로만 수행합니다.

## 적용 순서
1. 운영 Auth 공개 가입 비활성화 확인
2. migration 적용 및 RLS·GRANT 정책 확인
3. 기존 단일 계정을 최초 관리자 역할로 부트스트랩
4. `admin-users`, `change-pin` Edge Function 배포
5. 관리자/학생 계정으로 RLS 교차 검증
6. 레거시 4자리 로그인 → 6자리 PIN 강제 변경 → 기존 PIN 로그인 실패 확인

## 학습 흐름
- 관리자가 학생에게 과제를 만들고 선택적으로 비공개 파일을 첨부합니다.
- 학생의 첫 제출은 `submitted` 상태의 1차 시도입니다.
- 관리자는 피드백과 함께 `needs_revision` 또는 `completed`로 검토합니다.
- `needs_revision`일 때만 학생이 다음 attempt를 제출할 수 있습니다. 과거 attempt는 학생과 관리자 모두 직접 수정하지 않고 검토 RPC만 상태를 전환합니다.
- 관리자 화면은 과제와 모든 제출 이력을, 학생 화면은 최신 상태, 피드백, 재제출 폼을 표시합니다.
- 마감 시각은 현재 안내용입니다. 지각 제출은 허용되며 화면에 `기한 지남`으로 표시합니다.

## 파일 정책
- 두 Storage bucket은 비공개이며 파일당 최대 10MB입니다.
- 허용 형식은 PDF, JPEG, PNG, WebP입니다.
- 학생 제출은 attempt당 최대 3개입니다.
- 제출 trigger가 모든 경로의 학생 UUID·과제 UUID prefix와 실제 Storage 객체 존재를 확인합니다.
- 제출 DB insert 전 업로드가 실패하면 브라우저가 업로드된 객체를 정리합니다. 비정상 종료로 남은 orphan 파일은 후속 정리 작업 대상입니다.

## 페이지
- 루트: 기존 공개 랜딩
- student: 과제 조회, 비공개 파일 다운로드, 제출/재제출, 상태와 피드백 조회
- admin: 계정 관리, 과제/첨부 생성, 제출 검토와 완료/재수정 처리
