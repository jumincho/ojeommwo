# Ojeommwo 관측소 v3

전북대 메뉴의 카테고리·선호·배달 근거를 3D 코스모스와 취향 지도/목록으로 보는 읽기 전용 사이트다. 공개 주소는 https://ojeommwo-observatory.jumincho.chatgpt.site/ 이다. 봇과 같은 프로젝트의 `observatory/` 하위 디렉터리이며 별도 형제 서비스가 아니다.

운영 소스 수정·설치·빌드는 pororo의 `/root/ojeommwo-v2/observatory`에서 수행한다. `corepack pnpm run verify:sites`는 Sites 출력, `corepack pnpm run verify`는 Windows 비상용 Next 정적 출력을 검사·빌드한다. `corepack pnpm audit --prod`로 운영 의존성을 검사한다.

운영 DB가 있는 서버에서는 전체 통합 테스트를 실행한다. 공개 소스만 있는 환경에서는 정제된 샘플 스냅샷과 임시 저장소를 사용하며 운영 DB 통합 검증은 명시적으로 건너뛴다. `pnpm test` 성공을 실제 운영 DB 검사와 혼동하지 않는다.

사이트는 브라우저 자동 갱신을 하지 않는다. 새로운 접속에는 호스트의 주기적 스냅샷 게시가 반영된다. 정제된 공개 데이터만 외부로 전달하며 원본 Slack 식별자·자유 입력·비밀은 게시하지 않는다. 배포와 비상 절차는 상위 `HANDOFF.md`, 최종 검증 결과는 상위 `QUALITY_REPORT.md`를 따른다.
