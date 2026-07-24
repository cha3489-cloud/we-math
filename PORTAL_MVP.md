# 학생 포털 MVP 운영 메모

## 보안 전제
- 공개 회원가입은 UI와 로컬 Supabase 설정에서 비활성화되어 있습니다. 운영 Supabase Dashboard의 Auth 설정에서도 신규 가입을 반드시 끄세요.
- 레거시 계정 전환 기간에는 로그인만 숫자 4자리 또는 6자리를 허용합니다. 계정 발급, 재설정, 새 PIN은 정확히 숫자 6자리이며 내부 Auth 비밀번호 래퍼 wm + PIN + sq를 유지합니다. 최초 로그인과 관리자 재설정 뒤에는 PIN 변경이 강제됩니다.
- 브라우저에는 VITE_SUPABASE_URL과 anon key만 둡니다. service-role key는 Edge Function secret으로만 사용합니다.
- user_roles는 브라우저 사용자가 insert/update/delete할 수 없습니다. 최초 관리자는 Dashboard와 SQL Editor에서 부트스트랩합니다.
- admin-users Edge Function은 운영 https://we-math.pages.dev, 이 프로젝트의 HTTPS Pages 미리보기 하위 도메인, 명시적 localhost 개발 Origin만 허용합니다.

## 적용 순서 (이 작업에서는 실행/배포하지 않음)
1. 운영 Auth 공개 가입 비활성화 확인
2. migration 적용 및 RLS 정책 검토
3. 최초 관리자 부트스트랩
4. admin-users Edge Function secrets 설정 및 배포
5. 관리자/학생 계정으로 RLS 교차 검증 (Docker 미제공으로 로컬 DB 실실행은 하지 않음)

## 학습 흐름
- 관리자가 학생에게 과제를 만들고 선택적으로 비공개 파일을 첨부합니다.
- 학생의 첫 제출은 submitted 상태의 1차 시도입니다.
- 관리자는 피드백과 함께 needs_revision 또는 completed로 검토합니다.
- needs_revision일 때만 학생이 다음 attempt를 제출할 수 있습니다. 과거 attempt는 학생이 수정/삭제할 수 없습니다.
- 관리자 화면은 과제와 모든 제출 이력을, 학생 화면은 최신 상태, 피드백, 재제출 폼을 표시합니다.

## 페이지
- 루트: 기존 공개 랜딩
- student: 과제 조회, 비공개 파일 다운로드, 제출/재제출, 상태와 피드백 조회
- admin: 계정 관리, 과제/첨부 생성, 제출 검토와 완료/재수정 처리
