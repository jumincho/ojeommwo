# 관측소 구조

상위 JSON store → scripts/lib/observatory-snapshot.mjs → 공개 projection → 인증된 push → Sites Worker/R2 → 브라우저 단회 조회다. DB/Slack 봇은 서버에 유지하고 사이트만 안정된 HTTPS origin으로 배포한다. 브라우저는 원본 DB에 접근하지 않는다.

Observatory.tsx는 조회·필터·상세, MenuCosmos는 Three.js 3D, TasteMap은 지도/목록, TasteRail은 대칭적인 선호 축, RerollShop은 메뉴 둘러보기를 맡는다. UI 문구와 정보량은 현행을 유지한다. category 최초 클릭은 해당 category만 선택하며 이후 다중 선택할 수 있다.

snapshot-loader.mjs는 API 10초/static 5초의 독립 timeout과 unmount abort를 적용하고 schema·크기 검사를 통과한 데이터만 전달한다. snapshot-freshness.mjs는 가격/배달 만료 시각과 탭 복귀 시 local projection만 갱신한다. 네트워크 자동 polling은 없다. 오래된 cache에서도 만료 사실을 최신처럼 표시하지 않는다.

집계는 상위 봇의 category/alias/선호/학습 계약을 재사용한다. 공개 source fingerprint는 DB bytes와 imported algorithm contract를 포함하므로 다음 export에 DB/알고리즘 변경이 반영된다. catalog도 메뉴 집계·최신 가격 후보에 포함하며 static seed는 검증된 연구 자료를 덮어쓰지 않는다. 가격은 정확한 branch/menu의 검증 시각과 expiry를 갖고, store-level 배달 근거는 가격 근거와 별도로 관리한다. availableNow는 현재 추천 후보의 엄격한 자격이다.

ingredient-tags는 모든 공개 메뉴에 bilingual 검색 태그를 제공한다. 메뉴명과 검증된 주재료 근거를 사용하며 식당명은 재료로 보지 않는다. 햄버거/램 문자 오탐, 우육·미엔·or밥 같은 표기 경계를 회귀로 검사한다.

worker/snapshot-edge.mjs는 보안 headers, 인증 upload, 제한된 gzip 조립, SHA/schema, receipt 및 R2 조건부 저장을 담당한다. 512KiB snapshot, 2KiB chunk, 최대 256 chunk, 4개 병렬 R2 read와 decompression 상한을 지킨다. 동일 SHA 재시도는 원래 publication receipt를 재사용하고 ETag로 늦은 commit의 덮어쓰기를 막는다. transient storage 오류는 영구 schema 오류와 구분해 재시도한다.

host refresh-snapshot-host.sh는 10분 export/push/해시 대조와 5분 health를 담당한다. runtime symlink는 프로젝트 밖 보호 state를 가리킨다. root traverse/프로젝트/state 소유권을 보존한다. 임시 preview/tunnel 상주 프로세스는 필요 없다.

MenuCosmos는 camera-axis depth로 화면 label 크기를 계산하고 충돌 시 안정된 다른 방향을 찾는다. pause는 CSS 장식까지 정지하되 pointer selection은 유지한다. hidden/reduced-motion/WebGL loss/dispose, GPU pixel ratio와 mobile density를 제한한다. 지도는 nearest target capture로 선택 ring이 이웃 클릭을 막지 않는다.

Windows localhost viewer는 서버 prebuilt out과 보호된 공개 snapshot만 제공한다. host/origin/path/비밀 파일 접근을 제한하고 만료된 가격/배달 표시를 제거한다. 운영 DB와 source seal은 상위 수동 emergency sync 계약을 따른다.
