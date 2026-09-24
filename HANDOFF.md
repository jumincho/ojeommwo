# ojeommwo-v2 운영 인계 · v2.6

상태: 2026-09-23 **21:34:04 KST** v2.6 정식 출범, **21:44:42 KST 검증 범위 PASS**. 2026-09-24에는 Claude Opus 5.5 Max의 프런트 개선을 검증·적용했다. 사용자 지정 릴리즈 표기는 **GPT-6 Sol Max (Daybreak Blue)**이며 실제 운영 봇 모델은 **`gpt-6-luna` / `xhigh`**다. 이 문서는 새 작업자·새 모델이 이전 세션의 prompt cache 없이 바로 운영 경계를 재구성하기 위한 현재형 문서다.

## 먼저 지킬 경계

- 원본 소스와 운영 DB는 pororo 호스트 `ojeommwo` 컨테이너 `/root/ojeommwo-v2`다. `ssh pororo-docker`로 컨테이너에 접속한다. 호스트의 관측소 경로는 `/home/ojeommwo/docker1/root/ojeommwo-v2/observatory`다.
- 운영자 Windows PC의 로컬 사본은 평상시 **OFF**인 비상 사본이다. 서버와 동시에 발송하지 않는다. 서버 출처의 소스 seal·관측소 정적 출력·7개 운영 저장소를 맞춘 뒤에만 장애 임대 기능을 쓴다. 자동 offsite 백업은 사용자 결정에 따라 추가하지 않는다.
- `lunch` 채널 `C0123456789`에는 실제 테스트 메시지를 절대 보내지 않는다. 읽기 전용 Slack 권한/가입 검사와 dry-run을 먼저 사용한다. 마지막 실발송 검증은 보호된 운영자 DM `D0123456789` 한 건으로만 수행한다.
- `/bap` 명령과 실제 식사 기록의 함께 먹은 인원 수는 제거된 기능이다. 복구하지 않는다. 사이트 용어·정보량과 수동 새로고침 정책을 유지한다.
- `SERVER/_CLEANUP/_HANDOFF.md`는 별도 세션의 범위다. 여기서 수정하지 않는다.
- API 키·Slack 토큰·OAuth 원문은 `.env` 및 프로젝트 밖의 보호 상태에만 둔다. 로그·문서·Sites 아카이브에 넣지 않는다.

## 실행 흐름

호스트 cron은 후보 갱신을 평일 08:50·11:35·15:00·17:35, 캐시 발송을 11:25·17:25 KST에 한다. 매일 07:40에 서버 전용 Codex 인증을 실제 구조화 호출로 점검한다. Socket Mode 리스너는 한 개다. 다음 두 끼가 가능한 후보·가격·배달·거리·쿨다운·다양성 근거를 먼저 재검증하고, 부족하면 모델 검색으로 보강한다. 11:35에는 충분히 준비돼도 새 식당을 한 번 선택적으로 조사한다(검색 4회·모델 1회·최대 5분). 2026-09-23 실험은 741,714토큰·234초로 신규 검증 결과 0건이었다. 따라서 새 식당 확보는 보장하지 않으며, 기존 카탈로그 회전도 함께 사용한다. 실제 운영 중 카탈로그 검증으로 활성 후보 10→11개, 디디치킨 파닭치킨이 추가됐다. 선택 탐색 실패는 발송 준비 풀을 실패 처리하지 않는다. 불충분한 새 결과로 안전한 기존 후보를 덮어쓰지 않는다.

모델은 후보 웹 조사, 사용자가 대충 입력한 실제 상호·메뉴의 전북대 주변 근거 확인, 카테고리 의미 충돌 재심사를 맡는다. 순위·선호·DB 잠금/원자 저장·중복·TTL은 코드가 수행한다. 음식의 명백한 형식과 페이지 본문에 실제 존재하는 지점·메뉴·가격·배달 근거는 모델 단독 판단보다 우선한다. 서버 Codex CLI 0.156.1 이상에서 Luna xhigh 실호출을 확인한다. 모델 또는 프롬프트 접두부를 바꾸면 첫 요청의 **prompt-cache miss는 정상**이며 과거 캐시 hit를 전제로 장애로 오인하지 않는다. 인증 갱신 토큰이 폐기되면 기존 파일을 직접 덮지 말고 새 device-auth 후보를 동일 계정·최신 시각·권한·실호출까지 확인한 후 프로젝트의 인증 승격 경로로 반영한다.

선호는 Beta(3,3), 설문 0.9, 실제 식사 1.0, 반감기 180일, 탐색 18%다. 같은 사람·메뉴의 같은 날 설문은 최신 한 건, 다른 날 최근 3건은 1/0.5/0.25배다. 실제 식사가 있으면 같은 사람의 같은 메뉴 설문과 이중 합산하지 않는다. DM 테스트는 학습하지 않는다. 한두 건으로 0/100%에 치닫지 않도록 유지한다.

카테고리는 한식, 치킨, 분식, 돈까스, 족발/보쌈, 찜/탕, 구이, 피자, 중식, 일식, 회/해물, 양식, 아시안, 샌드위치, 샐러드, 버거, 멕시칸, 도시락, 죽만 사용한다. 커피/차·디저트·간식 및 단독 타코야끼를 제외한다. 상호·지점·메뉴 띄어쓰기·후토마끼/후토마키 등의 중복은 공통 식별자로 다룬다. 모호한 입력은 추측으로 DB 확정하지 않고 현재 전북대 주변의 실제 근거를 확인한다. 가격 TTL 7일, 배달 TTL 3일과 폐점/중단 신호를 적용한다. 공개 정보만으로 특정 주소의 결제 순간 주문 가능성을 확정할 수 없다.

날씨는 전북대학교 공대 7호관 `35.8461205, 127.1340012` 기준 기상청 단기예보·특보·생활지수와 에어코리아 실측·경보다. Open-Meteo는 사용하지 않는다. 현재·체감·최고·최저, 고습도, 오늘/내일 강수 시간·확률·양, 주의보, UV 및 PM 경고의 기존 문구·이모지·순서를 유지한다. 공급자 결측을 오래된 현재값으로 가장하지 않는다.

## 관측소와 비상 경로

관측소는 이 프로젝트의 `observatory/` 하위 폴더다. 현재 공개 주소는 https://ojeommwo-observatory.jumincho.chatgpt.site/ 이다. Sites에는 정제된 공개 스냅샷만 게시한다. 호스트가 10분마다 새 스냅샷을 올리고 5분 오프셋 health가 공개 응답 해시를 대조한다. 브라우저 자체는 자동 갱신하지 않는다. 사이트 소스 수정·의존성 설치·빌드는 서버에서 한다. 로컬 Sites 체크아웃은 검증된 서버 소스의 게시 아카이브 작성에만 사용하고 제품 수정을 그곳에서 시작하지 않는다. 8788/임시 trycloudflare 주소와 형제 `ojeommwo-observatory`는 운영 경로가 아니다.

비상 운영은 서버 장애를 별도로 확인한 뒤 Windows에서 `scripts/sync-operating-data-from-server.ps1`, `scripts/enable-local-emergency.ps1`, 복구 후 `scripts/disable-local-emergency.ps1`와 `scripts/reconcile-local-emergency-data.ps1 -DryRun` 순서로 한다. 활성화 전에 소스 seal, 스냅샷 시각, 7개 저장소 해시, 24시간 내 발송 후보를 검사한다. 오래된 동기화본이나 불확실한 네트워크 상태에서는 안전한 활성화를 보장할 수 없다. `-Force`는 독립적으로 서버 장애를 확인했을 때만 사용한다.

## 재현 명령

서버 봇: `node scripts/check-syntax.js`, `node --import ./scripts/setup-node-environment.js --test test/*.test.js`, `node scripts/check-codex-auth.js`, `node scripts/health-check.js --require-pass`, `node scripts/audit-category-arbitration.js --strict`, `node scripts/migrate-food-taxonomy.js --dry-run`, `node scripts/check-weather.js --strict`, `node src/index.js --slack-capability-test`. 이들 읽기/검증 경로는 lunch에 메시지를 보내지 않는다.

서버 관측소: 컨테이너에서 `corepack pnpm run verify:sites`, `corepack pnpm run verify`, `corepack pnpm audit --prod`를 실행한다. 호스트 계정 `ojeommwo`에서는 `/home/ojeommwo/docker1/root/ojeommwo-v2/observatory/scripts/refresh-snapshot-host.sh --health --max-age-seconds 1200`을 실행하고 공개 API와 브라우저의 CSP·3D·취향 지도·모바일을 확인한다. 호스트의 `/root/ojeommwo-v2`는 운영 경로가 아니며 접근이 거부된다. 배포는 `scripts/deploy-integrated-pororo.ps1`의 잠금·롤백 경로를 사용하고 Sites 원래 프로젝트 ID·주소·공개 범위를 유지한다.

최종 DM만 `node scripts/send-dinner-dm-preview.js --mode cache --channel D0123456789 --send`로 보낸다. 이 호출은 모든 배포·사이트 게시·Windows 동기화·검증 후 단 한 번 실행한다.

## 현재 운영 상태 · 2026-09-24

- 프런트 디자인 수행자: **Claude Opus 5.5 Max**. 원본은 GitHub `claude/affectionate-archimedes-y59nl7` 브랜치의 `f085c7485e419608d0059b2ae08c211bcef08239`다. Codex가 세 변경 파일 `observatory/app/globals.css`, `observatory/app/components/Observatory.tsx`, `observatory/app/components/TasteMap.tsx`를 서버에 동일한 Git blob으로 반영하고 검증·배포했다. 사이트 용어·문구·표시 정보·기능 및 `MenuCosmos.tsx`는 그대로다.
- 서버·Windows 비상 사본의 관측소 소스 커밋은 `af9bda4a9b57b565fa5399068d1965f72c85a673`, 프로젝트 소스 seal은 `sha256:152fa3d1b73575402092998e91a1cef27c1801a7cd0cce7cae33de15aaca8bd6` / 161파일로 일치한다. 비상 사본은 7개 운영 저장소와 관측소 정적 출력을 동기화했고 정상 운영 동안 OFF다.
- 관측소 서버 `verify:sites` 및 `verify`는 각각 75건 중 **73 PASS / 0 FAIL / 2 SKIP**이며 lint·typecheck·Sites/Next 빌드가 통과했다. 봇 health는 서버·Windows에서 각각 **36 PASS / 0 WARN / 0 FAIL**이다. 호스트 스냅샷 health, 공개 `/healthz`, `/api/snapshot/current`, CSP와 실제 브라우저의 코스모스·취향 지도 축·목록 제목/정렬 배지 표시를 확인했다. 공개 스냅샷은 검증 시점 141개 메뉴였고 자동 게시로 내용·해시가 변할 수 있다.
- 같은 Sites 프로젝트의 새 배포 `appgdep_6ab40d5ea30c8191b62abd6709bc4038`는 **2026-09-24 02:33:42 KST**에 성공했다. 주소와 공개 범위는 그대로다. 이 날짜의 검증은 `lunch` 실발송 없이 마쳤다.
- 정적 출력 교체 중 보관한 이전 Windows 출력 35파일은 자동 삭제 정책에 막혀 별도 삭제 대상 폴더로 이동했고, 사용자가 2026-09-24 삭제했다. 해당 폴더의 부재를 확인했다.

## 2026-09-23 출범 영수증

- 정식 출범: `2026-09-23T21:34:04+09:00`; Bot health `36 PASS / 0 WARN / 0 FAIL`, Windows `620 PASS / 0 FAIL / 2 SKIP`, Linux `612 PASS / 0 FAIL / 10 SKIP`, 관측소 검증은 두 경로 모두 `73 PASS / 0 FAIL / 2 SKIP`.
- 서버·Windows 비상 사본 소스 seal: `sha256:56ab998d1c28a5932cdbfa8556ef9a3d84b5c2af4c5695f9fc8e389cf9cfdbce` / 161파일. 로컬 운영 7개 저장소는 2026-09-23 21:41 KST에 서버 해시와 원자적으로 동기화했고 예약 작업은 OFF다.
- Sites 소스 커밋: `09daca0967c115c85db4d5210967ac452cf7f8a3`, 최종 게시 식별자 `appgdep_6ab3c69f240081919f5035ec4366020d`, 사이트 제품 버전 `2.6`. 호스트 공개 스냅샷은 2026-09-23 21:40:39 KST 측정 `sha256:0017b8a776ea6196eea4272af48c2168da350a3ea2f9ffb8f4d835126bdf3b2b`이며 10분 갱신마다 해시가 달라진다. 공개 API와 정적 예비본은 141개 메뉴·동일 계약 지문, health/CSP/브라우저 점검 PASS.
- 최종 개인 DM: 2026-09-23 21:44 KST 보호된 운영자 DM으로 한 건 발송 성공. `lunch` 실발송 테스트는 하지 않았다.

외부 Slack/API/식당/네트워크의 미래 장애가 불가능하다는 절대 보증으로 해석하지 않는다. Sites 제공자의 옛 내부 배포 이력은 삭제 인터페이스가 없으며 운영·문서에서 참조하지 않는다. 과거 로컬 점검 로그는 삭제 대상으로 모은 뒤 사용자가 2026-09-23 제거했으며, 삭제 대상 폴더의 부재를 확인했다.
