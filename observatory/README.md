# 오점뭐 메뉴 관측소

통합 ojeommwo-v2의 `observatory/` 하위 프로젝트. 정식 v2 / 2.0.0, 2026-09-30. [운영 사이트](https://ojeommwo-observatory.jumincho.chatgpt.site/).

Slack 추천·실제 식사·선호 설문의 공개 집계를 3D 코스모스와 취향 지도로 보여준다. 검색, 여러 카테고리 선택, 상세 보기와 메뉴 둘러보기를 제공한다. 문구/정보량/기능 범위는 기존 운영 계약을 유지한다. 선호도 %와 명확한 비선호·중립·선호 방향은 유지한다. 브라우저는 처음 들어올 때 한 번 데이터를 읽고 자동 갱신하지 않는다.

운영 DB/봇은 pororo에 있다. host cron이 10분마다 비밀/Slack 대상/사용자/주소/근거 URL 없는 snapshot을 export하고 기존 Sites Worker의 R2에 전송한다. 사이트를 Sites로 옮긴 것은 안정된 HTTPS origin과 프론트 배포를 위한 결정이며 운영 DB를 이전한 것이 아니다.

서버 소스에서 `corepack pnpm install --frozen-lockfile`, `corepack pnpm audit`, `corepack pnpm run verify:sites`로 검사/빌드한다. npm lock은 이 하위 프로젝트에서 사용하지 않는다. emergency out은 `corepack pnpm exec next build`로 별도 생성한다. 원본 운영 DB가 없는 checkout의 테스트는 이미 공개된 sanitized sample을 사용한다.

기존 `.openai/hosting.json`의 project_id/R2 binding/public audience를 보존한다. 서버 Git 소스를 Sites 원격에 push한 exact commit에서 artifact를 만들고 저장·배포한다. 사용하지 않는 8788 서버/임시 터널/형제 프로젝트를 복원하지 않는다. secret이나 auth token을 파일·Git·client bundle에 넣지 않는다.

Windows는 정상 시 OFF인 비상 모드만 사용한다. 서버에서 만든 out과 root source seal을 동기화하며, 비상 viewer는 localhost만 bind한다. 세부 운영은 상위 HANDOFF.md, 디자인은 DESIGN.md, 전송/보안은 ARCHITECTURE.md와 SECURITY.md를 따른다.
