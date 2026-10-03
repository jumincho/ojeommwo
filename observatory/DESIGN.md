# 현재 디자인 계약

문구·정보량·기능 범위는 사용자와 정한 현재 형태를 유지한다. 내부 계산 메타데이터, 최초 추천일/현재 근거 필터, 자동 데이터 갱신을 늘리지 않는다. 선호도 %는 유지한다. 한눈에 보기/검색/카테고리/상세/둘러보기 구성과 현행 용어를 보존한다.

3D 코스모스는 어두운 공간·은하 팔·성운·성단 코로나·별의 glow·국소 렌즈 효과를 사용한다. label을 효과보다 밝게 유지하고 24/25px의 화면 크기와 충돌 제거를 적용한다. 겹치는 label은 숨기기 전에 성단 주위의 다른 방향(위·아래·좌우·대각 8곳)을 시도하고, 직전 frame의 방향을 먼저 써서 궤도 회전 중 흔들리지 않는다. label은 glow와 가까운 별보다 위에 그리되 raycast하지 않는다. 선택 성단 label을 우선하고 offscreen/toolbar 범위에는 그리지 않는다. 장식은 raycast하지 않아 메뉴 선택을 막지 않는다. 별에 정확히 맞은 클릭이 우선하고, 빗나간 클릭은 취향 지도와 같은 nearest target 규칙으로 마우스·펜 12px, 터치 22px 안의 가장 가까운 별 또는 블랙홀을 선택한다. 궤도 정지와 render 정지를 구분하여 정지 중에도 메뉴를 선택할 수 있다.

취향 지도는 왼쪽 분홍 비선호 0%, 가운데 중립 50%, 오른쪽 초록 선호 100%다. 기호/문구/패턴을 함께 사용하여 색만으로 방향을 구분시키지 않는다. 행 label 15px, 겹침 없는 deterministic beeswarm, nearest pointer target, selected ring의 pointer 비간섭과 roving keyboard focus를 유지한다. 원의 크기는 선호/비선호 양 끝에서 같다.

모바일은 filter/detail drawer, 배경 inert·focus return·Escape, 수평 카드 scroll과 말줄임을 사용한다. 검색 input 자체가 넓은 click target이어야 한다. 실제 362px 및 desktop 화면에서 글씨·button·overflow·인접 선택을 확인한다. reduced-motion과 hidden tab에서는 불필요한 회전/장식을 줄이고 WebGL context loss 때 animation을 멈춘다.

참고 자료는 [WCAG 비텍스트 대비](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html), [Material motion](https://m3.material.io/styles/motion/overview/how-it-works), [Vercel design system 사례](https://vercel.com/blog/how-our-agents-build-on-brand-pages-with-design-md)다. 사용자가 제공한 scroll-world 같은 영상 중심 사례는 실제 메뉴 좌표·선택·가벼운 운용과 목적이 달라 유료 영상/생성 파이프라인을 추가하지 않았다.


v2.5에서는 카메라 축 깊이로 원근 label 크기를 안정화하고 궤도 정지 시 CSS 성운도 멈춘다. 취향 축은 양 끝 glow·문구·기호·동일 원 크기로 비선호/중립/선호 방향을 명확히 한다. 이후 Claude Opus 5 Ultracode의 개선도 이 계약을 유지한다.

표현 다듬기 규칙: 문구·정보량·기능·데이터 흐름은 그대로 두고 표현만 다듬는다. 강제 색상(Windows 대비 테마)에서는 별·선호 축·레일·눌린/선택 상태를 시스템 색(CanvasText·Highlight)으로 다시 그리고 장식 원은 숨긴다. 대비 강화 요청(prefers-contrast: more)에서는 선과 회색을 밝히고 장식 안개를 끈다. hover 효과는 (hover: hover) 장치에만 적용해 터치 후 남지 않게 한다. 데스크톱 측면 패널은 내용이 넘칠 때만 하단 페이드로 스크롤을 알리고(scroll timeline 미지원 브라우저는 표시하지 않음), 키보드 포커스와 패널 자체의 포커스 고리를 가리지 않는다. 데스크톱 폭에서 그래프 열이 620px 이하이면 메뉴 수 표시가 지도·목록을 가리지 않도록 하단 띠를 따로 쓴다. 취향 지도와 목록의 키보드 포커스는 상단 마스크 아래로 숨지 않는다(scroll-padding). 만료되었거나 없는 가격의 '가격 정보 없음'은 실제 가격보다 약하게 표시한다. 높이 540px 이하의 짧은 화면에서는 서랍이 전체 높이를 쓰고 뒤 페이지를 스크롤하지 않으며, 오프라인 안내와 비상 배너는 페이지와 함께 스크롤된다. 비상 화면 CSS는 `.local-emergency-viewer`와 배너에만 적용해 복사된 정적 빌드의 스타일을 바꾸지 않으며, 배너는 서랍 배경(40)과 서랍(44)보다 아래인 39층에 둔다.
