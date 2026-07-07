# HMB 온라인 — 표현/렌더링(2D/3D) 조사 (sub-C)

> 웹 기반(폰 모드 + 데스크탑 모드), 추후 앱 래핑 예정인 축구 시뮬 게임의 "경기 시뮬 결과를 시청각적으로 보여주는 렌더링 레이어" 조사.
> 예산 기조: **싸면 3D, 비싸면 2D면 충분 / PoC 는 저비용 우선.**
> 조사일: 2026-07-07

---

## 0. 요약 (TL;DR)

- **경기 시뮬 표현의 본질은 "이미 계산된 좌표를 화면에 찍는 것"** 이다. 물리·AI 계산이 아니라 위치 보간·재생이므로, 축구 매니지먼트 장르에서 2D 탑다운(도트) 뷰가 오랫동안 표준으로 살아남았다. Football Manager 조차 다수 유저가 3D 대신 2D 뷰를 선호한다([footballmanagerblog](https://www.footballmanagerblog.org/2025/12/fm26-2d-camera-vs-3d-nostalgia-tactics.html)).
- 웹 2D 렌더링은 성숙·저비용이며(HTML Canvas / PixiJS / Phaser), **에셋이 "점·원·유니폼 색" 수준이면 제작비가 거의 0** 에 수렴한다.
- 웹 3D(three.js/Babylon.js/Unity WebGL)는 런타임은 무료여도 **선수 모델·리깅·모션 캡처 에셋 비용이 진짜 비용** 이다. 캐릭터 1종 리깅 $100~$4,000, 모션 캡처 1일 $1,500~$3,000([animost](https://animost.com/industry-updates/how-much-does-it-cost-to-rig-a-3d-character/), [mocaponline](https://mocaponline.com/blogs/mocap-news/motion-capture-cost-guide)).
- 따라서 **PoC 는 2D(PixiJS 또는 Phaser 기반 탑다운 도트 뷰) 권장.** 3D 는 시장 검증 후 확장 옵션.

---

## 1. 2D 도식 렌더링 방식

### 1-1. 왜 2D 도트 뷰인가 (장르 표준)
Football Manager 계열의 2D 매치 뷰는 피치를 위에서 내려다보는(top-down) 시점에서 선수를 **점/도트로 표시**하고 전술 라인을 정연하게 보여준다. FM26 에서도 2D 뷰는 3D 대비 "더 단순하고 눈이 편하며 장시간 세션에 유리"하다는 이유로 여전히 강력하게 선호된다([footballmanagerblog: FM26 2D Camera vs 3D](https://www.footballmanagerblog.org/2025/12/fm26-2d-camera-vs-3d-nostalgia-tactics.html)). 게임 내에서 2D/3D 를 토글로 전환 가능하며, 2D 는 원하는 속도로 빠르게 돌리는 용도로 쓰인다([Top Football Manager Help](https://gamegou.helpshift.com/hc/en/3-top-football-manager/faq/298-can-i-switch-between-2d-and-3d-matches/)). → HMB 시뮬 결과 재생과 정확히 같은 요구.

### 1-2. 웹 2D 렌더링 기술 옵션

| 기술 | 방식 | 성능 특성 | 구현 난이도 |
|------|------|-----------|-------------|
| **SVG** | DOM 벡터, 리테인드 모드 | 오브젝트 수십 개까지 편함, 많아지면 DOM 부담 | 낮음 (선언적, CSS/애니 용이) |
| **HTML Canvas 2D API** | 즉시 모드, CPU 바운드 | 오브젝트 ~50개 단순 애니에는 충분, 늘면 CPU 병목([friendzy](https://friendzy.xyz/2025/07/22/webgl-vs-html5-for-browser-games/)) | 낮음~중간 (직접 draw 루프) |
| **PixiJS** | WebGL/WebGPU 스프라이트 렌더러 | 1000+ 스프라이트 60fps, 벤치 최상위 2D 렌더러([js-game-rendering-benchmark](https://github.com/Shirajuki/js-game-rendering-benchmark)) | 중간 (렌더러만, 게임 로직 직접) |
| **Phaser** | WebGL(Canvas 폴백) 게임 프레임워크 | 물리·입력·씬·트윈·타일맵 등 올인원([generalistprogrammer](https://generalistprogrammer.com/comparisons/phaser-vs-pixijs)) | 중간 (프레임워크 학습 필요, 하지만 필요기능 내장) |

핵심 구분: **PixiJS 는 "렌더링 라이브러리"(그리기 전담, 450KB)**, **Phaser 는 "게임 프레임워크"(씬/입력/트윈/카메라 포함, 1.2MB)** 다. PixiJS 는 순수 렌더링에서 약 2배 빠르고 번들 3배 작지만, 게임 루프·카메라·트윈 등을 직접 구성해야 한다([generalistprogrammer: Phaser vs PixiJS](https://generalistprogrammer.com/comparisons/phaser-vs-pixijs)).

### 1-3. HMB 2D 구현 난이도 (실제)
- 22명 도트 + 공 1개 = **오브젝트 ~23개** → HTML Canvas 만으로도 60fps 무리 없음. 축구 도트 뷰는 성능이 병목이 될 일이 사실상 없다.
- 시뮬 엔진이 뱉는 시계열 좌표(프레임별 x,y)를 **선형/스플라인 보간**으로 부드럽게 재생 + 배속(1x/2x/즉시결과) 지원이면 충분.
- 에셋: 원/점 도형 + 유니폼 2색 + 번호 텍스트 → **디자인 원가 거의 0.**

---

## 2. 3D 렌더링 방식

### 2-1. 웹 3D 엔진 옵션

| 엔진 | 성격 | 특징 | 라이선스/런타임 비용 |
|------|------|------|----------------------|
| **three.js** | 경량 WebGL 래퍼 | 커스텀 셰이더·파티클 강점, r171+ WebGPU 네이티브 지원(2~3x 향상)([cinevva](https://app.cinevva.com/blog/2026-06-09-web-game-engines-2026-comparison.html)) | 무료(MIT) |
| **Babylon.js** | 풀 게임 엔진 | 물리·PBR·glTF 파싱·Inspector 툴링 내장, 상호작용 시 안정적([cinevva](https://app.cinevva.com/blog/2026-06-09-web-game-engines-2026-comparison.html)) | 무료(Apache 2.0) |
| **Unity WebGL** | 데스크탑 에디터 → WebGL 익스포트 | C# 로 빌드 후 WASM 번들, **런타임/다운로드 무겁고 시작 느림, 모바일 브라우저 성능 난점** + Unity Pro 시트 라이선스($2,310/seat/yr)([utsubo](https://www.utsubo.com/blog/threejs-vs-unity-web-comparison)) | 유료 시트 발생 가능 |

three.js 계열은 동등 웹 경험 기준 Unity 대비 **20~40% 저렴**하고 라이선스 $0 이라는 조사도 있다([utsubo: Three.js vs Unity for Web](https://www.utsubo.com/blog/threejs-vs-unity-web-comparison)).

### 2-2. 진짜 비용은 "엔진"이 아니라 "에셋"
웹 3D 엔진 자체는 대부분 무료지만, **축구 3D 뷰의 원가는 선수 모델·리깅·모션(달리기/패스/슛/태클/세리머니)** 이다.
- 3D 캐릭터 리깅: 프리랜서 캐릭터당 $100~$120, 게임용 복잡 리그 $900~$4,000+([animost](https://animost.com/industry-updates/how-much-does-it-cost-to-rig-a-3d-character/)).
- 모션 캡처: 광학 스튜디오 1일 $1,500~$3,000(미드티어), 프리메이드 팩+리타게팅은 ~$400 로 절감 가능([mocaponline](https://mocaponline.com/blogs/mocap-news/motion-capture-cost-guide)).
- 즉, 3D 를 "제대로" 하려면 선수 다양성·애니메이션 세트마다 비용이 누적. PoC 예산과 상충.

### 2-3. 3D 성능·로딩 이슈
- 모바일 GPU 는 데스크탑 대비 약하고, 미최적화 WebGL 은 발열·배터리 소모·프레임 드랍을 유발([pixelfreestudio](https://blog.pixelfreestudio.com/webgl-in-mobile-development-challenges-and-solutions/)).
- glTF/텍스처 로딩 용량 → 첫 진입 지연. Unity WebGL 은 특히 시작·다운로드가 무겁다([utsubo](https://www.utsubo.com/blog/threejs-vs-unity-web-comparison)).
- 완화책: draw call 병합, 30fps 타깃(체감 저하 미미하고 배터리 절감), LOD([friendzy](https://friendzy.xyz/2025/07/22/webgl-vs-html5-for-browser-games/), [pixelfreestudio](https://blog.pixelfreestudio.com/webgl-in-mobile-development-challenges-and-solutions/)).

---

## 3. 2D vs 3D 비교

| 기준 | 2D (Canvas / PixiJS / Phaser) | 3D (three.js / Babylon.js / Unity WebGL) |
|------|-------------------------------|-------------------------------------------|
| **구현 난이도** | 낮음 — 도트 22개 좌표 보간 재생, 성능 병목 사실상 없음 | 높음 — 카메라/조명/스켈레탈 애니/상태머신, 모바일 최적화 필수 |
| **에셋 비용** | 거의 0 (도형·유니폼색·번호) | 높음 — 리깅 캐릭터당 $100~$4,000, 모션캡 1일 $1,500~$3,000 |
| **성능 (모바일)** | 매우 안정적, CPU 여유 | 발열·배터리·로딩 리스크, 미최적화 시 프레임 드랍 |
| **개발 기간** | 짧음 (수 주 PoC 가능) | 김 (에셋 파이프라인 + 엔진 통합) |
| **초기 로딩 용량** | 작음 (수백 KB) | 큼 (모델·텍스처 수 MB~수십 MB) |
| **PoC 적합성** | 높음 — 저비용 우선 기조에 부합 | 낮음 — 시장 검증 후 확장 옵션 |
| **표현력/몰입감** | 전술 가독성 우수, 몰입감은 낮음 | 몰입·마케팅 임팩트 우수 |

> 참고: 2D 렌더러여도 PixiJS/Phaser 는 내부적으로 WebGL 을 쓴다. GPU 가속을 받으면서도 에셋은 2D 스프라이트라 저비용을 유지 — "저비용 2D + GPU 성능"의 스윗스팟.

---

## 4. 웹(폰+데스크탑)·앱 래핑 렌더링

### 4-1. 반응형 렌더링 (폰 모드 + 데스크탑 모드)
- **캔버스/뷰포트 스케일링**: 피치 종횡비를 고정하고 컨테이너 크기에 맞춰 스케일. 폰(세로/가로)·데스크탑(넓은 뷰) 각각 카메라 줌·HUD 배치 분기.
- **입력 이원화**: 데스크탑=마우스/키보드, 폰=터치. Phaser 는 터치/마우스/게임패드 입력을 프레임워크 차원에서 내장([generalistprogrammer](https://generalistprogrammer.com/comparisons/phaser-vs-pixijs)).
- **성능 예산**: 모바일은 30fps 타깃 허용(체감 저하 적고 배터리 절감), draw call 최소화([friendzy](https://friendzy.xyz/2025/07/22/webgl-vs-html5-for-browser-games/)). 2D 도트 뷰는 이 예산에서 매우 여유롭다.
- **렌더러 선택**: PixiJS v8 은 WebGPU 를 코어 렌더러로 통합, WebGL 은 폴백. 브라우저 WebGL→WebGPU 전환기에도 대응([generalistprogrammer](https://generalistprogrammer.com/comparisons/phaser-vs-pixijs)).

### 4-2. Canvas / WebGL / 엔진 정리
- **Canvas 2D API**: CPU 바운드, 오브젝트 소수엔 최적. 도트 뷰 MVP 에 즉시 사용 가능.
- **WebGL (PixiJS/Phaser/three/Babylon)**: GPU 가속, 수천 오브젝트도 60fps. 모바일 GPU 약점 유의([friendzy](https://friendzy.xyz/2025/07/22/webgl-vs-html5-for-browser-games/)).
- **WebGPU**: three.js r171+, PixiJS v8 네이티브. 향후 성능 여지이나 PoC 필수는 아님.

### 4-3. 앱 래핑 방식 (추후)

| 프레임워크 | 렌더링 방식 | 시작시간/성능 | 렌더링 영향 |
|------------|-------------|----------------|-------------|
| **Capacitor** | 웹앱을 네이티브 **WebView** 로 감쌈 + JS 플러그인으로 디바이스 API | 시작 ~2.3s(최저속), 복잡 리스트 ~48fps, 메모리 ~130MB([oflight](https://www.oflight.co.jp/en/columns/flutter-rn-capacitor-tauri-performance)) | **기존 웹 렌더링 그대로 재사용** — 캔버스/WebGL 코드 수정 최소. HMB 에 가장 자연스러움 |
| **React Native** | JS 가 실제 네이티브 UI 컴포넌트 구동 | 네이티브 UI 우수 | 게임 캔버스는 별도 브리지/서피스 필요 — 웹 렌더링 재사용성 낮음, 재작성 부담 |
| **Tauri** | 시스템 네이티브 WebView(주로 데스크탑) | 시작 ~0.8s(최속), ~58fps, 메모리 ~45MB([oflight](https://www.oflight.co.jp/en/columns/flutter-rn-capacitor-tauri-performance)) | 데스크탑 배포에 유리, 모바일은 아직 보조적 |

- **결론**: HMB 처럼 "웹으로 만든 뒤 나중에 앱으로 감싼다"는 전략에는 **Capacitor** 가 정합. WebView 안에서 기존 Canvas/WebGL 렌더링을 그대로 재사용하므로 렌더링 레이어 재작성이 없다. 단, WebView 는 복잡 애니메이션·CSS 효과·구형 저사양 단말에서 렌더링 부담이 있을 수 있으니 도트 2D 처럼 가벼운 렌더링을 유지하면 리스크가 낮다([oflight](https://www.oflight.co.jp/en/columns/flutter-rn-capacitor-tauri-performance)).
- 데스크탑 전용 배포까지 고려하면 **Tauri** 가 시작속도·메모리에서 유리하다([oflight](https://www.oflight.co.jp/en/columns/flutter-rn-capacitor-tauri-performance)).

---

## 5. 오픈소스·상용 사례

1. **OpenFootManager** — GPLv3 오픈소스 축구 매니저. 프론트 React + TypeScript + TailwindCSS. FM 계열 UI/데이터 구조 참고용. <https://github.com/openfootmanager/openfootmanager>
2. **footballSimulationEngine (GallagherAiden)** — Node.js 축구 경기 시뮬레이션 모듈. 두 팀 간 경기를 좌표 시계열로 시뮬 → **HMB "시뮬 결과 → 렌더링" 파이프라인의 입력부** 레퍼런스. <https://github.com/GallagherAiden/footballSimulationEngine>
3. **SimpleSoccerManager (Dirichi)** — p5.js 로 만든 JS 축구 매니저. 캔버스 기반 2D 표현 최소 구현 예. <https://github.com/Dirichi/SimpleSoccerManager>
4. **OpenSoccerStar (dmecke)** — 오픈소스 축구 매니저 브라우저게임. 웹 배포 구조 참고. <https://github.com/dmecke/OpenSoccerStar>
5. **js-game-rendering-benchmark (Shirajuki)** — Three.js/Pixi/Phaser/Babylon/Canvas/DOM 등 렌더러 성능 벤치. 렌더러 선택 근거. <https://github.com/Shirajuki/js-game-rendering-benchmark>

추가 참고: Football Manager 2D vs 3D 뷰 선호 분석([footballmanagerblog](https://www.footballmanagerblog.org/2025/12/fm26-2d-camera-vs-3d-nostalgia-tactics.html)), 웹 3D 엔진 2026 비교([cinevva](https://app.cinevva.com/blog/2026-06-09-web-game-engines-2026-comparison.html)).

---

## 6. PoC 권장 렌더링 수준

**권장: PoC 는 "웹 2D 탑다운 도트 뷰"로 시작한다** — 구체적으로 **PixiJS(경량·고성능 스프라이트) 또는 Phaser(입력·씬·트윈 내장) 기반**으로 22명 도트+공을 시뮬 좌표 보간 재생하고, 배속(즉시결과/1x/2x)과 폰·데스크탑 반응형 스케일을 지원한다. 에셋 원가가 거의 0 이라 저비용 기조에 부합하고, 추후 **Capacitor** 로 동일 렌더링을 앱으로 감쌀 수 있으며, 시장 검증 후에만 three.js/Babylon.js 3D 로 확장한다.

- 추천 스택 1안(가장 저비용): **HTML Canvas 2D** 직접 구현 (도트 23개 수준이면 충분).
- 추천 스택 2안(확장성): **PixiJS v8** (WebGL/WebGPU, 향후 이펙트 여지) 또는 **Phaser 4** (게임 기능 올인원).
- 3D 는 PoC 범위에서 제외 권장 (리깅·모션 에셋 비용과 모바일 성능 리스크 대비 검증 가치 낮음).

---

### 출처 (URL)
- https://www.footballmanagerblog.org/2025/12/fm26-2d-camera-vs-3d-nostalgia-tactics.html
- https://gamegou.helpshift.com/hc/en/3-top-football-manager/faq/298-can-i-switch-between-2d-and-3d-matches/
- https://github.com/Shirajuki/js-game-rendering-benchmark
- https://generalistprogrammer.com/comparisons/phaser-vs-pixijs
- https://www.utsubo.com/blog/threejs-vs-unity-web-comparison
- https://app.cinevva.com/blog/2026-06-09-web-game-engines-2026-comparison.html
- https://www.oflight.co.jp/en/columns/flutter-rn-capacitor-tauri-performance
- https://animost.com/industry-updates/how-much-does-it-cost-to-rig-a-3d-character/
- https://mocaponline.com/blogs/mocap-news/motion-capture-cost-guide
- https://friendzy.xyz/2025/07/22/webgl-vs-html5-for-browser-games/
- https://blog.pixelfreestudio.com/webgl-in-mobile-development-challenges-and-solutions/
- https://github.com/openfootmanager/openfootmanager
- https://github.com/GallagherAiden/footballSimulationEngine
- https://github.com/Dirichi/SimpleSoccerManager
- https://github.com/dmecke/OpenSoccerStar
