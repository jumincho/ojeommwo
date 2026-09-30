# 관측소 구조

운영 봇의 JSON store → `scripts/lib/observatory-snapshot.mjs` → 허용된 공개 projection → 인증된 snapshot push → Sites Worker/R2 → 브라우저의 1회 조회 구조다. 운영 DB를 브라우저나 Sites에 직접 노출하지 않는다.

`app/components/Observatory.tsx`는 데이터 조회/검증/필터/상세, MenuCosmos는 3D, TasteMap은 지도/목록과 밀집 선택, TasteRail은 동등한 양 끝 원과 % 축, RerollShop은 메뉴 둘러보기를 맡는다. `app/lib`는 canonical schema, category selection과 deterministic beeswarm을 제공한다.

`worker/snapshot-edge.mjs`는 보안 headers, authenticated upload, bounded gzip 조립, SHA, upload receipt, R2 조건부 write와 cache 정책을 담당한다. `worker/index.ts`는 허용된 path/method를 연결한다. `build/sites-vite-plugin.ts`와 `scripts/build-sites.mjs`가 기존 Sites manifest 및 서버 엔트리를 검증한다.

`scripts/lib/bot-contract.mjs`는 상위 카테고리/별칭/선호/학습 계약을 재사용한다. 모든 메뉴의 ingredient-tags는 메뉴·검증된 주재료 근거를 사용하고 restaurant 이름을 재료로 삼지 않는다. 공개 source fingerprint는 store bytes와 import하는 알고리즘 계약까지 포함하므로 DB/알고리즘 변화가 다음 export에 반영된다. 상세 가격과 배달은 정확한 branch/menu 최신 근거를 우선하고 오래된 가격이나 임의의 배달 가능성을 만들지 않는다.

업로드는 512KiB snapshot, 2KiB chunk, 최대 256 chunk, 4개 병렬 R2 read 및 bounded decompression을 사용한다. 같은 SHA 재시도는 기존 publication의 시간/receipt를 보존한다. ETag 조건부 R2 저장으로 과거 snapshot의 늦은 commit이 새 자료를 덮어쓰지 못한다. 전송/정리 지연과 transient R2 실패는 재시도하고 schema/hash 실패는 거절한다.

pororo host의 `refresh-snapshot-host.sh`가 10분 export/push/해시 확인, 5분 주기의 health가 나이/해시를 확인한다. runtime은 프로젝트 밖 보호 상태를 가리키는 기존 symlink다. root traversal/프로젝트/state 권한을 함께 보존한다. production preview 서버나 임시 tunnel은 필요 없다.

브라우저는 자동 polling 없이 current→static→last-known-good 순으로 fallback한다. WebGL 불가 시 목록 접근, hidden/reduced-motion 처리, GPU 객체 정리, 키보드 선택, 모바일 drawer focus/닫기와 배경 inert 경계를 둔다. localhost emergency viewer는 out과 보호된 공개 snapshot만 서빙하고 host/origin/path/기밀 파일 접근을 제한한다.
