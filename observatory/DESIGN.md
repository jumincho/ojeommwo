# 현재 디자인 계약

문구·정보량·기능 범위는 사용자와 정한 현재 형태를 유지한다. 내부 계산 메타데이터, 최초 추천일/현재 근거 필터, 자동 데이터 갱신을 늘리지 않는다. 선호도 %는 유지한다. 한눈에 보기/검색/카테고리/상세/둘러보기 구성과 현행 용어를 보존한다.

3D 코스모스는 어두운 공간·은하 팔·성운·성단 코로나·별의 glow·국소 렌즈 효과를 사용한다. label을 효과보다 밝게 유지하고 24/25px의 화면 크기와 충돌 제거를 적용한다. 선택 성단 label을 우선하고 offscreen/toolbar 범위에는 그리지 않는다. 장식은 raycast하지 않아 메뉴 선택을 막지 않는다. 궤도 정지와 render 정지를 구분하여 정지 중에도 메뉴를 선택할 수 있다.

취향 지도는 왼쪽 분홍 비선호 0%, 가운데 중립 50%, 오른쪽 초록 선호 100%다. 기호/문구/패턴을 함께 사용하여 색만으로 방향을 구분시키지 않는다. 행 label 15px, 겹침 없는 deterministic beeswarm, nearest pointer target, selected ring의 pointer 비간섭과 roving keyboard focus를 유지한다. 원의 크기는 선호/비선호 양 끝에서 같다.

모바일은 filter/detail drawer, 배경 inert·focus return·Escape, 수평 카드 scroll과 말줄임을 사용한다. 검색 input 자체가 넓은 click target이어야 한다. 실제 362px 및 desktop 화면에서 글씨·button·overflow·인접 선택을 확인한다. reduced-motion과 hidden tab에서는 불필요한 회전/장식을 줄이고 WebGL context loss 때 animation을 멈춘다.

참고 자료는 [WCAG 비텍스트 대비](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html), [Material motion](https://m3.material.io/styles/motion/overview/how-it-works), [Vercel design system 사례](https://vercel.com/blog/how-our-agents-build-on-brand-pages-with-design-md)다. 사용자가 제공한 scroll-world 같은 영상 중심 사례는 실제 메뉴 좌표·선택·가벼운 운용과 목적이 달라 유료 영상/생성 파이프라인을 추가하지 않았다.

다음 Claude Opus 5 (max) 작업도 이 계약을 보존한다. 기존 효과에 장식을 더하는 것보다 실제 label/선택/가독성의 개선 근거를 우선한다.
