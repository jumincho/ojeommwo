# 관측소 v2.6 인계

새 작업자 또는 새 모델은 먼저 상위 `AGENTS.md`, `HANDOFF.md`와 이 폴더의 `ARCHITECTURE.md`를 읽는다. 기준 소스는 pororo `/root/ojeommwo-v2/observatory`, 운영 DB는 그 상위 `data/`, 공개 사이트는 https://ojeommwo-observatory.jumincho.chatgpt.site/ 이다. Slack 봇·원본 DB를 Sites로 이전하지 않는다. 로컬 Windows는 평상시 OFF인 비상 사본이다.

사이트 수정은 서버 소스에서 수행한다. `corepack pnpm run verify:sites`와 정적 비상 출력용 `corepack pnpm run verify`를 통과한 소스만 같은 Sites 프로젝트에 게시한다. `.openai/hosting.json`의 기존 프로젝트 ID·R2·공개 범위를 유지한다. 제공자 내부 과거 버전 번호는 제품 릴리즈 정보가 아니므로 문서·UI에 노출하지 않는다. 제공자가 관리하는 배포 이력의 삭제를 소스 파일 정리와 혼동하지 않는다.

## 2026-09-24 프런트 디자인 인계

이번 프런트 개선의 수행자는 **Claude Opus 5.5 Max**다. 원안은 GitHub `claude/affectionate-archimedes-y59nl7` 브랜치의 `f085c7485e419608d0059b2ae08c211bcef08239` 커밋이다. Codex가 서버 기준 소스에 세 변경 파일(`app/globals.css`, `app/components/Observatory.tsx`, `app/components/TasteMap.tsx`)을 동일한 Git blob으로 적용하고 운영 DB가 있는 서버에서 검증·배포한다. CSS와 배치 변경이며 기존 문구·정보·기능·`MenuCosmos.tsx` 코드는 유지한다. GitHub 변경과 Sites 게시의 책임 및 시점은 구분해서 기록한다.

검증에는 검색과 카테고리 배치, 취향 지도 목록 제목·배지, 761~1180px 카테고리 줄바꿈, 태블릿 선호도 라벨, 460px 이하 카드 글자, 761~980px 상세 창, 오프라인 배너의 클릭 방해, 200% 확대와 감소된 동작을 포함한다. Sites와 정적 비상 빌드 모두 운영 DB로 생성한 스냅샷과 함께 확인한다.

호스트 스냅샷 작업 `scripts/refresh-snapshot-host.sh`의 10분 게시와 `--health --max-age-seconds 1200`을 실제 호스트 계정으로 실행한다. 런타임 링크와 프로젝트 밖 push token은 보존한다. HTTP 200만으로 성공을 판정하지 말고 공개 API의 해시, CSP, 브라우저의 3D·지도·검색·버튼·클릭을 확인한다. 서버가 내려가면 마지막 게시본은 보이지만 새 DB는 게시되지 않는다.

회귀 항목은 3D 정지 직후 별 선택, 취향 지도의 인접점 선택, 0/50/100% 축, 다중 카테고리, `pork` 검색, 모바일 하단 버튼과 카드, 큰 글자, 단독 간식 제외, 배달 최신성/불확실성 구분이다. 보안 비밀값과 원시 DB는 공개 스냅샷에 없다. 사이트 화면의 용어·정보량과 수동 새로고침 정책은 유지한다.

새 봇 수행 모델로 변경된 첫 호출은 prompt-cache miss가 정상이다. 모델 변경은 원본 DB 스키마 변경이 아니지만 공개 선호 계산 결과는 다음 게시부터 갱신되므로 운영 소스·스냅샷·Windows 비상 출력의 버전과 seal을 대조한다. 최종 게시 시각과 검증 증거는 상위 인계서에 기록한다.
