import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { CatalogPlayer } from "../api/hooks";
import type { ConditionMap, RelationsResponse } from "../api/v2";
import { relationOf } from "../common/relations";
import { Modal } from "../common/Modal";
import { buildPlayerNames } from "../common/player-names";
import { findPlayerSlot, removePlayer, setPrompt, type DeckDraft, type SlotRole } from "./deck-logic";
import { MOUSE_ACTIVATION_PX, TOUCH_ACTIVATION_MS, TOUCH_TOLERANCE_PX } from "./drag-gesture";
import { movePlayerToSlot, type EditorState } from "./tactics-logic";
import { slotPosition } from "./sheet-metrics";
import { playerOverall, teamPower } from "./team-power";
import {
  parseDroppableId,
  playerIdFromDragId,
  slotNumberLabel,
  TacticsBoard,
  type SlotRef,
} from "./TacticsBoard";
import { NO_SELECTION, type TapSelection } from "./tap-place";
import { TeamSheetBar } from "./TeamSheetBar";
import { DirectiveRail } from "./DirectiveRail";
import { PlayerPicker } from "./PlayerPicker";
import styles from "./DeckEditor.module.css";

/**
 * 프롬프트 입력칸이 화면 가장자리·하단 탭바에서 떨어져 있어야 하는 최소 여백(#244 AC13 이
 * 요구하는 24px 보다 넉넉히). 이 값이 곧 "선수를 고르면 화면이 따라오는" 이동의 목표선이다.
 */
const PROMPT_SCROLL_MARGIN_PX = 32;

/**
 * 경기장 아래 **책갈피 탭**(#455 A1 ⑤, hero 확정 — 목업 R5 의 1안).
 *
 * 순서가 곧 위계다: **전체 지시(1순위) · 후보(2순위) · 세부 전술(3순위)**. 2안(하단 버튼 +
 * 아이콘 강조)은 기각됐다 — 버튼은 아무리 강조해도 *"여기에 프롬프트가 있다"* 까지만 보이고
 * **내가 뭐라고 써놨는지**는 안 보인다. 요구는 강조가 아니라 위계였고, 위계는 펼침 ↔ 접힘으로
 * 갈린다(#244 `DirectiveRail` 이 이미 그 원칙 위에 서 있다).
 *
 * ⚠️ 라벨·아이콘·탭 구성은 **조정 포인트**다(hero 컨펌에 포함되지 않았다) — 벤치를 탭 밖으로
 * 빼서 둘로 줄이는 변형까지 열려 있다. 이 배열 한 줄이 그 손잡이다.
 */
const DECK_TABS = [
  { id: "team", icon: "📣", label: "전체 지시", rank: 1 },
  { id: "sub", icon: "👥", label: "후보", rank: 2 },
  { id: "tune", icon: "⚙", label: "세부 전술", rank: 3 },
] as const;
type DeckTabId = (typeof DECK_TABS)[number]["id"];

/**
 * 선수 토큰을 탭하면 뜨는 **메뉴 시트**(#455 A2 ①④, hero 확정 — 목업 A안).
 *
 * ⚠️ **원문 두 항목을 합친 결과다.** hero 원안의 '위치 이동'·'선수 이동'은 화면에서 **같은 동작**
 * (그 선수를 다른 자리로 보낸다)이라 하나로 합쳤고, 비워진 자리에 **[선수 정보]**(강화 진입점)가
 * 들어갔다. 되돌리지 마라 — 되돌리면 같은 일을 하는 항목이 두 개인 메뉴가 된다.
 *
 * 각 항목이 하는 일은 **이미 있는 동선을 부르는 것뿐**이다(새 상태기계를 만들지 않는다):
 *   · `move` → `startAssign`  = #442 R1 엔트리 대기(슬롯 탭 → `movePlayerToSlot`)
 *   · `say`  → `selectPlayer` = #244 A′ 구 토큰 탭이 하던 그 일(탭 레이아웃이면 [전체 지시]로)
 *   · `info` → `onOpenGrowth` = 레일 [선수 강화](`rail-growth-open`)와 **같은 컴포넌트**(#286 W3)
 *   · `close`→ 메뉴만 닫는다(아무 것도 안 바꾼다 — 그게 이 항목의 전부다)
 *
 * ⚠️ 항목 구성·라벨·힌트는 **조정 포인트**다(hero 컨펌 밖) — 이 배열 한 줄이 그 손잡이다.
 * ⚠️ 힌트에 `투입`·`교체` 를 쓰지 마라(#442 R4-A 용어축). 이 화면에는 경기장이 없어서 그 말이
 *    거짓이 되고, `p442` ⑨-b 전수 스캔이 그것을 잡는다. 목업 힌트 *"경기장·벤치에서 고르기"* 를
 *    **`선발·벤치에서 고르기`** 로 바꾼 것이 그 이유다(보드의 두 구역을 그 화면 말로 부른다).
 */
const PLAYER_MENU = [
  { id: "move", icon: "⇄", label: "자리 옮기기", hint: "선발·벤치에서 고르기" },
  { id: "say", icon: "💬", label: "한마디 쓰기", hint: "" },
  { id: "info", icon: "👤", label: "선수 정보", hint: "스탯·강화" },
  { id: "close", icon: "✕", label: "닫기", hint: "" },
] as const;
type PlayerMenuId = (typeof PLAYER_MENU)[number]["id"];

/**
 * 자리 지정 대기(#442 R1)에 들어온 **이유**. 같은 상태·같은 동작인데 유저가 시킨 일이 다르다.
 *   · `"entry"` — 목록의 [엔트리]: **명단에 넣는다**(#442 R3-A 확정 문구가 그것을 말한다)
 *   · `"move"`  — 선수 메뉴의 [자리 옮기기](#455 A2): **이미 명단에 있는 선수를 옮긴다**
 *
 * ⚠️ **"이미 명단에 있나"로 추론하지 마라 — 실제로 그렇게 짰다가 경기전이 깨졌다.**
 * 경기전 후보는 **전원 벤치 선수 = 이미 스쿼드 안**이라(#439 R2) 그 추론이 참이 되고, 안내가
 * hero 확정 문구 대신 "보낼 자리를 누르세요"로 바뀐다(`p442` ①⑥ 가 실제로 red 였다).
 * 그 화면이 채우는 "명단"은 **선발 11** 이고(#442 R3-B 표) 벤치 선수를 거기 넣는 것은 여전히
 * *엔트리* 다. 의도는 상태에서 파생되지 않는다 — 유저가 어느 손잡이를 눌렀느냐가 곧 의도다.
 */
type AssignIntent = "entry" | "move";

export interface DeckEditorProps {
  /**
   * 강화 시트 열기 (#286 W3). 에디터는 **시트를 소유하지 않는다** — 페이지가 연다.
   * 안 주면 레일에 강화 줄이 안 생긴다(하프타임 레일처럼 있으면 안 되는 자리가 있다).
   */
  onOpenGrowth?: (player: CatalogPlayer) => void;
  /** 강화가 잠긴 이유(경기 중 등). 있으면 줄은 보이되 눌리지 않는다. */
  growthLockedReason?: string | null;
  state: EditorState;
  onChange: (state: EditorState) => void;
  /** "AI에 맡기기" — when true, team tactics are managed by AI (sliders disabled/omitted). */
  aiManaged: boolean;
  onToggleAi: (aiManaged: boolean) => void;
  /** owned players (pool). */
  players: CatalogPlayer[];
  playersById: Map<string, CatalogPlayer>;
  /** 컨디션 {playerId: 0..1} — 보드 토큰 + 리스트 행 + 레일 헤드에 쓰인다. */
  conditions?: ConditionMap;
  /** relations (AC-C4) — feeds the rail head trust gauge + personality badge. */
  relations?: RelationsResponse;
  opponentPower?: number;
  opponentName?: string;
  opponentApprox?: boolean;
  /** 상대 정보 시트 열기(#285) — 브리핑에서만 온다. 없으면 버튼 자체가 안 그려진다. */
  onOpponentInfo?: () => void;
  errorPlayerId?: string | null;
  /**
   * Auto 배치 — **빈 자리만 채운다**(#439, hero Q1=ⓑ). 덱셋팅·경기전 **둘 다** 넘긴다.
   * (구 동작: 덱 화면만 넘겨서 경기전엔 버튼 3종이 전부 안 그려졌다 — 실측 4/4 부재.)
   * 무엇으로 채우는지는 호출부가 정한다(후보 목록 = 규칙, `fill-empty.ts` 머리말).
   */
  onAuto?: () => void;
  autoDisabled?: boolean;
  autoHint?: string;
  /**
   * [초기화] 를 감춘다 (#439 R3-a, hero: *"경기 시작 전에 초기화 버튼은 없애. 지금 초기화 사용되지
   * 않고 그 단계에서 초기화하면 너무 해야 할 부담이 커."*).
   *
   * 그 버튼은 확인창도 되돌리기도 없이 `slots: []` 로 **선발·벤치·선수별 프롬프트를 한 번에**
   * 지운다. 덱셋팅에서는 처음부터 다시 짜는 일이 정상이라 남기고, 경기 직전에서만 없앤다
   * — `placementLocked`(감독시간)와는 **다른 축**이다: 경기전은 배치 자체는 열려 있다.
   */
  hideReset?: boolean;
  /**
   * 선수 시트에 **누가 뜨나** (#439 R2, hero Q2=ⓐ).
   *   · `"owned"`(기본) — 보유 선수 전체(덱셋팅)
   *   · `"bench"` — **벤치 선수만**(경기전). 나머지는 필터·비활성이 아니라 **DOM 에 없다**.
   * 선발끼리 자리를 바꾸는 것은 계속 열려 있다(보드 드래그·탭) — 막는 것은 "스쿼드 밖에서
   * 데려오는 것"뿐이고, 그게 hero 가 말한 *"교체선수 외 선수풀 못 쓰게"* 의 경계다.
   */
  poolScope?: "owned" | "bench";
  /**
   * **배치 잠금**(#244, 뜻은 #276 에서 좁혀졌다) — 감독시간처럼 **스쿼드 밖에서 선수를 데려오지
   * 않는** 화면. 빈 슬롯을 눌러도 선수 시트가 열리지 않고 [보유 선수]·[Auto 배치]·[초기화]·
   * [이 자리 선수 바꾸기]·[덱에서 제거]가 사라진다.
   *
   * ⚠️ **"자리 바꾸기가 없다"는 더 이상 이 플래그의 뜻이 아니다**(#276 hero 결정). 감독시간에도
   * 포메이션과 **선발끼리의** 자리 바꾸기는 열린다 — 그건 `lineupEditable` 이 켠다. 이 플래그를
   * 통째로 풀면 보유 선수 시트·Auto·초기화·제거까지 열려 **경기 스쿼드 밖 선수를 후반에 투입**할
   * 수 있게 된다(서버가 400 으로 막지만 화면이 거짓말을 한다) — 그래서 두 축은 따로 간다.
   */
  placementLocked?: boolean;
  /**
   * **라인업 편집 허용**(#276) — `placementLocked` 화면이지만 포메이션 변경 + **선발끼리** 자리
   * 바꾸기는 연다. hero 결정: 감독시간에 포메이션·선발 배치를 바꿀 수 있다.
   * (벤치 ↔ 선발은 여전히 막힌다 — 그건 교체이고 규칙·전송은 `boardMode="subs"` 가 소유한다.)
   */
  lineupEditable?: boolean;
  /** 라인업 편집이 지금은 잠김(감독시간 만료) — 손잡이는 보이되 동작하지 않는다. */
  lineupDisabled?: boolean;
  /**
   * **보드 탭을 호출부가 가져가는 모드**(감독시간 T2/#276).
   *   · `"subs"` — 탭이 "뺄/넣을 선수 지정"(벤치 줄이 펴진다)
   *   · `"move"` — 탭이 "자리 바꿀 두 선발 지정"(벤치는 접힌 채, 교체와 같은 두 번 탭 제스처)
   * 지정 자체는 호출부가 한다(교체 규칙·배치 전송은 감독시간 소유) → 여기서는 탭을 넘겨주기만 한다.
   */
  boardMode?: "subs" | "move";
  onBoardTap?: (playerId: string, role: "starter" | "bench") => void;
  /** 교체로 빠지는 선수 — 보드 토큰에 OUT 표시. */
  subbedOut?: string[];
  /** 지금 지정된 선수(교체의 "뺄 선수" / 자리 바꾸기의 첫 번째 선수) — 보드에서 강조. */
  pendingPlayerId?: string | null;
  /** 팀 세부조정(전술 다이얼) 숨김 — 감독시간은 서버가 후반 전술을 받지 않는다(#254). */
  hideTeamTune?: boolean;
  /** 벤치 줄 숨김 — 감독시간의 한마디 모드(교체 모드에선 자동으로 다시 편다). */
  hideBench?: boolean;
  /** 보드 위에 얹을 줄(감독시간의 교체 요약·모드 탭). */
  boardHeader?: ReactNode;
  /** 프롬프트 블록 아래에 붙일 안내(감독시간 교체 안내 등). */
  railNote?: ReactNode;
  /** 입력 잠금 — 감독시간 만료처럼 "이제 내도 안 들어가는" 상태에서 입력 자체를 닫는다. */
  promptDisabled?: boolean;
  /** 프롬프트 라벨의 맥락(감독시간이면 "(후반)" 을 붙인다). */
  promptScope?: "deck" | "halftime";
  /**
   * **세로 배치 축**(#455 A1). 기본 `"stack"` = 지금까지의 모양(보드 아래 레일이 문서 흐름대로).
   * `"tabs"` = 경기장이 68 상한까지 커지고 그 아래를 **책갈피 탭 3개**가 채운다.
   *
   * ⚠️ **덱셋팅(`DeckPage`)만 `"tabs"` 를 넘긴다.** 이 컴포넌트는 덱셋팅 · 경기전(`BriefingPanel`) ·
   * 감독시간(`HalftimePanel`) **셋이 공유**하므로, 기본값을 바꾸면 A1 스코프 밖 화면 둘이 같이
   * 움직인다. 화면을 구별하는 축을 `poolScope`·`placementLocked` 조합으로 **추론하지 않는 이유**도
   * 그것이다 — 추론은 다음 화면이 늘 때 조용히 틀린다.
   */
  layout?: "stack" | "tabs";
  /**
   * **선수 토큰 탭 = 메뉴**(#455 A2 ①④). 기본 `false` = 지금까지의 모양(탭이 곧 "그 선수 지시").
   *
   * ⚠️ **`layout` 과 다른 축이라 별도 prop 이다.** 오늘은 `DeckPage` 가 둘을 같이 켜지만(폰 덱셋팅),
   * 하나로 묶으면 다음에 다른 화면이 `layout="tabs"` 를 켜는 순간 메뉴가 **조용히 따라간다**.
   * 화면 구별을 `poolScope`·`placementLocked` 조합으로 추론하지 않는 것과 같은 이유다(A1 머리말).
   *
   * ⚠️ **경기전·감독시간은 안 켠다.** 감독시간은 `boardMode` 로 **탭의 주인이 호출부**이고
   * (교체 규칙 ≤3·GK≥1 과 전송을 그쪽이 소유한다) `placementLocked` 라 [자리 옮기기]가 열 수 있는
   * 것이 없다 — 메뉴를 켜면 4항목 중 둘이 아무 일도 못 하는 껍데기가 된다. 경기전은 배치가
   * 열려 있지만 확정 계약(#455 comment 5196070445)이 **폰 덱셋팅 개편**이라 범위 밖이다.
   * 그 두 화면의 무회귀는 `p439`·`p276`·`p294` 가 잰다("메뉴를 모든 화면에" 변이가 거기서 죽는다).
   */
  playerMenu?: boolean;
  /**
   * **선택 대기(강화 3지선다)가 남아 있는 선수 id** — `↑` 뱃지 (#455 A2-2, 확정 계약의 조정 포인트
   * *"강화 `↑` 뱃지 노출"*). 보드·벤치 토큰과 선수 메뉴 `[선수 정보]` 항목 **두 곳**에 같은 신호가 뜬다.
   *
   * ⚠️ **에디터는 이 값을 조회하지 않는다** — `DeckPage` 가 `usePendingChoices()`(전체 목록 **1회**)로
   * 받아 `growthReadyIdsOf` 로 접어 넘긴다. 여기서 훅을 부르면 이 컴포넌트를 공유하는 경기전·
   * 감독시간까지 조회가 붙는다(`layout`·`playerMenu` 와 같은 명시 축).
   * ⚠️ **`layout` 과 묶지 마라.** 저 둘은 *폰 화면 개편* 이라 폭으로 갈렸지만 이건 **정보**다 —
   * 폭이 넓어졌다고 "누가 강화 가능한지"가 사라질 이유가 없다(`p455-a22` ⑦ 이 그 사실을 박제한다).
   * ⚠️ 성(★) 승급 표시는 이 축이 아니다 — 서버 계약이 없다(#455 본문). 여기에 얹지 마라.
   */
  growthReadyIds?: ReadonlySet<string>;
  /**
   * 탭 레이아웃의 **[세부 전술] 탭 꼬리**에 붙일 것(#455 A1) — 지금은 팀 사기 위젯.
   *
   * ⚠️ 왜 여기냐: 그 위젯은 원래 에디터 **아래 형제**였고 폰에서 **68px** 를 먹는다. 68 상한
   * 경기장 아래 남는 세로를 탭이 가져간다는 약속이 그만큼 깎였다(실측 패널 19px = 프롬프트가
   * 못 들어간다). `DeckPage` 주석이 이미 *"사기는 곁눈질로 보는 값이고 프롬프트는 이 화면에 온
   * 이유"* 라고 그 우선순위를 적어 뒀다 — 위로 올리지 않는 것과 같은 이유로 **탭 뒤로** 보낸다.
   * `layout="stack"` 이면 이 값을 안 쓴다(경기전·감독시간은 넘기지도 않는다).
   */
  teamExtra?: ReactNode;
  /**
   * 탭 레이아웃의 **[전체 지시] 탭 꼬리**(#455 A1) — 지금은 덱 규칙 위반 안내(`deck-pre-issues`).
   *
   * `teamExtra` 와 축이 다르다: 저건 "곁눈질 값을 3순위 탭으로 치운 것"이고, 이건 **프롬프트와
   * 같은 스크롤러를 쓰게 해 가림을 없애는 것**이다(그 자리 주석에 실측이 있다).
   * `layout="stack"` 이면 안 쓴다 — 그 화면들은 지금도 페이지 형제로 잘 보인다.
   */
  teamPanelNotice?: ReactNode;
}

/**
 * 팀 시트 — **한 화면 = 배치(보드) + 프롬프트** (이슈 #244, hero 확정 2026-07-28).
 *
 * ── 무엇이 바뀌었나 (#106 R1 → #244) ─────────────────────────────────────────────────────
 * #106 은 골격을 [시트 바 · 전술보드 · 보유 선수 · 컨텍스트 지시 레일] 넷으로 세웠고, 모바일에서
 * 레일은 **접힌 하단 독**이었다. 그 결과 실측(390×844): 덱 진입 시 프롬프트 입력이 **화면에 0px**,
 * 선수를 탭해 독을 열어도 세부조정(역할·칩) 147px 이 프롬프트 69px 보다 **넓고 먼저** 왔다.
 * 이 게임의 차별점(선수별 자연어 프롬프트)이 3단계(토큰 탭 → 독 펼침 → 스크롤) 뒤에 있었다.
 *
 * #244 는 비중을 뒤집는다. 일반 축구게임이 [보드 + 세부조정] 을 두던 자리에 **세부조정 대신
 * 프롬프트**가 앉고, 세부조정은 그 아래 ⚙ 버튼 뒤로 밀린다(DirectiveRail). 규칙 한 줄:
 *
 *     **편집은 인라인, 선택은 시트.**
 *       · 편집(프롬프트 · 세부조정) = 화면에 그대로 — 문장을 보면서 조정한다.
 *       · 선택(누구를 넣나) = 바텀시트 — 고르면 배치되고 **그 선수 프롬프트로 화면이 이어진다**.
 *
 * 그래서 이 파일에서 사라진 것 둘:
 *   ① **모바일 하단 독**(`position:fixed` + `--dock-runway` 실측 보정 + 오토스크롤). 레일이 문서
 *      흐름에 그대로 있으므로 독이 덮을 것도, 런웨이로 밀어낼 것도 없다. (#106 R3a 가 풀던 문제
 *      자체가 없어졌다 — 독을 되살리면 그 보정도 같이 되살려야 한다.)
 *   ② **보유 선수 상시 리스트**. 본문에서 리스트가 빠져야 프롬프트가 첫 화면에 남는다. 리스트는
 *      빈 슬롯 탭 / [보유 선수] 버튼 / 레일의 [이 자리 선수 바꾸기] 로 여는 **시트**가 됐다.
 *
 * 배치 수단: 슬롯 탭 → 시트(1급) + 드래그(@dnd-kit, 보조 — 유지). 계약 = e2e/p244-prompt-first.spec.ts.
 */
export function DeckEditor(props: DeckEditorProps) {
  const {
    state,
    onChange,
    aiManaged,
    onToggleAi,
    onOpenGrowth,
    growthLockedReason,
    players,
    playersById,
    conditions,
    relations,
    opponentPower,
    opponentName,
    opponentApprox,
    onOpponentInfo,
    errorPlayerId,
    onAuto,
    autoDisabled,
    autoHint,
    hideReset = false,
    poolScope = "owned",
    placementLocked = false,
    lineupEditable = false,
    lineupDisabled = false,
    boardMode,
    onBoardTap,
    subbedOut,
    pendingPlayerId,
    hideTeamTune,
    hideBench,
    boardHeader,
    railNote,
    promptDisabled,
    promptScope = "deck",
    layout = "stack",
    playerMenu = false,
    growthReadyIds,
    teamExtra,
    teamPanelNotice,
  } = props;
  const draft = state.draft;
  const tabs = layout === "tabs";

  const [selection, setSelection] = useState<TapSelection>(NO_SELECTION);
  /** 책갈피 탭(#455 A1 ⑤). 기본은 **[전체 지시]** — 프롬프트가 1순위다. */
  const [deckTab, setDeckTab] = useState<DeckTabId>("team");
  /**
   * [후보] 탭 안의 벤치 자리. `TacticsBoard` 가 **자기 벤치를 여기로 포털**한다 — 벤치를 여기서
   * 다시 그리면 슬롯·드롭 대상이 두 벌이 되고 규칙이 두 곳에 산다(#439 major-2).
   */
  const benchHostRef = useRef<HTMLDivElement>(null);
  /**
   * ⚠️ 포털 대상은 **첫 렌더에 아직 null** 이다(ref 가 커밋 뒤에 붙는다). 그대로 두면 벤치가
   * 영영 안 그려지므로 마운트 후 한 번 다시 그린다. `tabs` 가 아니면 이 상태 자체를 안 쓴다.
   */
  const [benchHost, setBenchHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (tabs) setBenchHost(benchHostRef.current);
  }, [tabs]);
  /**
   * 보유 선수 시트. `slot` 이 있으면 **그 자리에 넣을 선수**를 고르는 맥락이고(포지션 자동 필터),
   * null 이면 목록만 여는 맥락이다(첫 빈 자리에 들어간다).
   */
  const [sheetSlot, setSheetSlot] = useState<SlotRef | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const railRef = useRef<HTMLElement>(null);
  /** 시트 선택이 배치로 이어지지 못했을 때의 안내(M-2) — 막다른 길을 만들지 않는다. */
  const [pickNote, setPickNote] = useState<string | null>(null);
  /**
   * **엔트리 대기 선수** (#442 R1, hero 설계) — 목록에서 [엔트리]를 누른 선수. 이 값이 있으면
   * 보드의 **모든** 슬롯이 대상이 되고, 슬롯을 탭하면 그 자리로 들어간다(빈 자리 = 배치 ·
   * 찬 자리 = 맞바꾸기 · 풀 선수가 찬 자리로 오면 밀려난 선수는 벤치로 — #442 R4-B).
   *
   * ⚠️ **후보 판정은 여기 없다** — 이 값은 시트에 실제로 그려진 행(`poolPlayers`)에서만 온다.
   * 경기전이면 그 목록이 벤치뿐이므로(#439 R2 `poolScope`) 스쿼드 밖 선수는 이 상태에 **들어올
   * 자리가 없다**. 여기에 `if (poolScope === "bench")` 같은 두 번째 게이트를 만들면 규칙이
   * 두 곳에 적히고, 그게 #439 major-2 가 났던 방식이다.
   */
  const [assign, setAssign] = useState<{ playerId: string; intent: AssignIntent } | null>(null);
  const assignPlayerId = assign?.playerId ?? null;
  /**
   * 선수 메뉴가 떠 있는 대상 (#455 A2). `null` = 안 떠 있다.
   *
   * ⚠️ **메뉴를 여는 것이 곧 선택은 아니다.** 여기서 `selectPlayer` 까지 같이 부르면 [한마디 쓰기]가
   * 사실상 no-op 이 되고(이미 그 선수 지시가 열려 있다), 그 항목을 지우는 변이가 살아남는다.
   * 누구의 메뉴인지는 **시트 제목**이 말한다.
   */
  const [menuPlayerId, setMenuPlayerId] = useState<string | null>(null);

  // Single DndContext spans the board slots + bench (token sources) AND the owned-player pool list.
  // MouseSensor(터치 아님) + TouchSensor 로 분리한다 — PointerSensor 를 쓰면 터치에서도
  // pointerdown 이 먼저 잡혀 TouchSensor 의 delay(롱프레스) 활성화가 영영 안 걸리고,
  // 거리 기반(distance) 활성화라 손가락이 6px 움직이는 순간 브라우저가 네이티브 스크롤을
  // 시작해 pointercancel 로 드래그가 죽는다(실측, #106 결함). 분리하면 터치는 롱프레스 150ms 로만
  // 드래그가 시작되고, 짧은 스와이프는 리스트 스크롤로 남는다(스크롤·드래그 양립).
  //
  // ⚠️ 임계는 `drag-gesture.ts` 한 곳에서 온다(#439) — 보드 토큰의 **롱프레스 어포던스**(차오르는
  // 링)가 같은 값을 읽는다. 여기에 숫자를 다시 적으면 링이 다 찬 뒤에도 안 잡히거나 그 반대가 된다.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: MOUSE_ACTIVATION_PX } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: TOUCH_ACTIVATION_MS, tolerance: TOUCH_TOLERANCE_PX },
    }),
    useSensor(KeyboardSensor),
  );

  /**
   * **선수를 고르면 그 입력창까지 화면이 따라온다** (#244 A′).
   *
   * 390×844 에서 [보드 + 프롬프트]를 한 화면에 넣으면 팀 컨텍스트는 들어가지만(여유 +73px)
   * 선수 컨텍스트는 헤드가 붙어 프롬프트 아래쪽이 하단탭에 가린다(실측 −38px). 선택지는 셋이었다:
   *   ① 선수를 고르면 보드를 축소 ② 화면이 프롬프트로 이동(이것) ③ 프롬프트를 하단 고정.
   * ②를 고른 이유 = **보드 크기가 화면마다·상태마다 달라지지 않는다**(덱의 주인공이 보드라는
   * 감각을 안 건드린다). 계약은 이 스크롤 뒤에 **가림·잘림을 다시 잰다**(자동 스크롤로 가림을
   * 숨기지 못하게 — p244 AC4).
   * 되돌리려면: 이 훅을 지우고 ①이나 ③으로 바꾼다.
   */
  /**
   * #455 A1 — **탭 레이아웃에서 #244 A′ 를 성립시키는 한 줄.**
   *
   * 지시 레일이 `[📣 전체 지시]` 탭 패널로 들어가면서, 다른 탭이 열려 있는 동안 선수를 고르면
   * 그 선수의 입력칸이 `display:none` 안에 있다 = "선수를 고르면 그 입력창까지 화면이 따라온다"가
   * 깨진다. 실측으로 잡혔다 — `deck-list-dnd` W4([👥 후보] 탭에서 시트로 배치 → `rail-prompt-input`
   * 이 hidden) · `p244` AC4(그 프롬프트가 fold 밖).
   * 아래 스크롤 훅이 **먼저 탭을 맞춰야** 잴 대상이 화면에 생긴다.
   */
  useEffect(() => {
    if (tabs && selection.playerId) setDeckTab("team");
  }, [tabs, selection.playerId]);

  useEffect(() => {
    if (!selection.playerId) return;
    // 탭이 아직 안 넘어갔으면 이번 렌더에서는 잴 것이 없다 — 위 훅이 넘긴 뒤 다시 들어온다.
    if (tabs && deckTab !== "team") return;
    const rail = railRef.current;
    if (!rail) return;
    /**
     * ⚠️ **최소 이동으로 바뀌었다 (#439 조정포인트).**
     *
     * 구현은 `railRef.scrollIntoView({ block: "center" })` 였다 — 레일은 화면보다 긴 블록이라
     * "가운데 정렬"이 곧 **문서 끝까지 스크롤**이었고(390×844 실측 `scrollY` 0 → 415),
     * 그 결과 배치 직후 **보드가 화면 위로 사라졌다**(W0 실측 4회 중 3회 보드 상단 `y = −228`).
     * 선수 하나 놓을 때마다 다시 위로 스크롤해야 하니 **연속 배치가 불가능**했다.
     *
     * 그래서 ①대상을 레일 전체가 아니라 **프롬프트 입력칸**으로 좁히고 ②`block:"nearest"` 로
     * **필요한 만큼만** 움직인다. #244 A′("선수를 고르면 그 입력창까지 화면이 따라온다")는
     * 그대로 성립하고 — 그 계약이 재는 것도 "입력칸이 첫 화면에 있나"이지 이동량이 아니다 —
     * 보드는 화면에 남는다. 계약 = `p439-phone-deck-ux.spec.ts` ⑤(다음 빈 자리 히트테스트)
     * + `p244-prompt-first.spec.ts` AC4(가림·잘림).
     *
     * ⚠️ `scrollIntoView({block:"nearest"})` 로는 부족하다 — **하단 탭바가 `position:fixed`** 라
     * 브라우저는 그것이 입력칸을 덮는 것을 모른다(실측: nearest 만 쓰면 p244 AC4 가 `bottomL←nav-home`
     * 으로 red). 그래서 탭바 높이를 **실측해** 부족분만큼만 직접 굴린다.
     *
     * jsdom 에는 scrollIntoView/scrollBy 가 없다 — 유닛 테스트에서 화면 이동은 관심사가 아니므로
     * 조용히 건너뛴다.
     */
    const target = rail.querySelector<HTMLElement>('[data-testid="rail-prompt-input"]') ?? rail;
    if (typeof window.scrollBy !== "function" || typeof target.getBoundingClientRect !== "function") return;
    /**
     * ⚠️ 탭 레이아웃에서는 **문서가 스크롤되지 않는다**(`Layout fill` = `overflow:hidden`).
     * 굴러야 하는 것은 탭 패널이므로 `window.scrollBy` 는 아무 일도 안 한다 —
     * `scrollIntoView({block:"nearest"})` 가 스크롤 가능한 조상만 **최소로** 굴린다.
     * 아래 탭바 보정도 필요 없다: 패널은 탭바 **위**에서 이미 잘려 있다.
     */
    if (tabs) {
      if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "nearest" });
      return;
    }
    const nav = document.querySelector('[data-testid="nav-bottom"]');
    const navTop = nav ? nav.getBoundingClientRect().top : window.innerHeight;
    const floor = Math.min(navTop, window.innerHeight) - PROMPT_SCROLL_MARGIN_PX;
    const rect = target.getBoundingClientRect();
    // 위로 벗어났으면 그만큼만 올리고, 탭바 아래로 숨었으면 그만큼만 내린다. 이미 보이면 **안 움직인다**.
    const delta =
      rect.top < PROMPT_SCROLL_MARGIN_PX
        ? rect.top - PROMPT_SCROLL_MARGIN_PX
        : rect.bottom > floor
          ? rect.bottom - floor
          : 0;
    if (delta !== 0) window.scrollBy({ top: delta, behavior: "smooth" });
    // `deckTab` 이 의존성에 있는 이유 = 탭이 넘어간 **뒤** 한 번 더 들어와야 잴 대상이 화면에 있다.
  }, [selection.playerId, tabs, deckTab]);

  function mutateDraft(next: DeckDraft) {
    onChange({ ...state, draft: next });
  }

  function selectPlayer(playerId: string | null) {
    setSelection(playerId ? { slot: null, playerId, source: "board" } : NO_SELECTION);
  }

  function handleDragEnd(e: DragEndEvent) {
    /*
     * **교체 모드(`subs`)에서만** 드래그가 빠진다 — 교체의 SoT 는 명시 `subs` 목록이고, 드래그로
     * 선수를 옮기면 규칙(≤3 · GK≥1)을 우회하는 **두 번째 손잡이**가 생긴다.
     *
     * ⚠️ 예전엔 `if (boardMode) return` 이라 [자리] 모드에서도 드래그가 죽어 **어포던스가 역전**돼
     * 있었다: [감독의 한마디] 탭에서는 드래그로 자리가 바뀌는데 **자리 전용 탭에서만** 안 바뀐다
     * (2R 독립검증 minor-2). 덱은 "탭이 1급, 드래그는 보조"(#106)이므로 보조 제스처가 그 일을
     * 하는 탭에서 죽으면 안 된다 → `move` 는 통과시키고 아래 잠금 규칙(선발↔선발)만 적용한다.
     */
    if (boardMode === "subs") return;
    if (!e.over) return;
    const playerId = playerIdFromDragId(String(e.active.id));
    const target = parseDroppableId(String(e.over.id));
    if (placementLocked) {
      // 배치 잠금 화면의 드래그는 **선발끼리 자리 바꾸기**까지만이다(#276) — 벤치로 끌어내리거나
      // 벤치에서 끌어올리면 그건 교체이고, 교체는 규칙(≤3·GK≥1)을 가진 별도 손잡이가 소유한다.
      //
      // 계약 = `e2e/p276-halftime-shape.spec.ts` AC8(폴백 무동작 · 만료 무동작 · 교체 탭 무동작).
      // ⚠️ 아래 `starter↔starter` 한 줄만은 **지금 도달 불가능한 방어**다 — 감독시간에서 벤치 줄은
      //    `hideBench` 로 교체 모드에서만 펴지는데 그 모드는 위에서 이미 return 하기 때문이다.
      //    `hideBench` 가 바뀌는 순간 이 줄이 유일한 방벽이 되므로 지우지 마라(계약이 못 잡는다).
      if (!lineupEditable || lineupDisabled) return;
      const from = findPlayerSlot(draft, playerId);
      if (from?.role !== "starter" || target.role !== "starter") return;
    }
    mutateDraft(movePlayerToSlot(draft, playerId, target.role, target.slotIndex));
    // 보드 모드에서는 지시 대상이 탭으로만 바뀐다 — 자리를 바꿨다고 프롬프트 자리가 딸려 움직이면
    // 같은 제스처가 화면마다 다른 일을 하게 된다. 덱(모드 없음)에서는 #244 대로 놓은 선수가
    // 곧 지시 대상이 된다.
    if (!boardMode) {
      selectPlayer(playerId);
      closeSheet();
    }
  }

  function openSheet(slot: SlotRef | null) {
    setSheetSlot(slot);
    setSheetOpen(true);
  }
  function closeSheet() {
    setSheetOpen(false);
    setSheetSlot(null);
  }

  /**
   * 목록의 [엔트리] — **자리를 보드에서 고르는** 동선의 시작 (#442 R1).
   *
   * hero: *"선수목록 들어가서 선수를 누르면 투입을 누를수 있고, 투입 누르면 '교체할 선수를
   * 선택해주세요' 하고 후보군과 선발군 활성화되게하자."*
   * ⚠️ 그 원문의 "투입"·"교체"는 **설계 인용이다** — 화면 용어는 R3-A 에서 **엔트리 / 명단**으로
   * 바뀌었고(hero: *"엔트리나, 명단으로 사용하자. 투입이랑 교체 대신 그 단어가 맞는거 같아."*),
   * R4-A 에서 후보 목록 이름이 **벤치**가 됐다(hero: *"투입은 경기장 투입이여서 구분되어야해."* —
   * 이 화면에는 경기장이 없으므로 `투입`·`교체` 는 여기 말이 아니다). 인용을 근거로 되돌리지 마라.
   *
   * 왜 필요한가: 폰에서 목록 시트가 보드를 **완전히 덮어** 리스트→슬롯 드래그가 도달 불가능한
   * 죽은 코드다. 그래서 목록에서 고른 선수가 갈 수 있는 자리는 `sheetSlot ?? firstEmptySlot`
   * 하나뿐이었고, 스쿼드가 꽉 찬 상태(=경기전 명단 교체)에서는 막다른 안내문이 전부였다.
   * ⛔ 드래그를 **대체하지 않는다** — 데스크탑 포인터 드래그는 그대로다(`deck-list-dnd.spec.ts`).
   */
  function startAssign(playerId: string, intent: AssignIntent) {
    setAssign({ playerId, intent });
    setPickNote(null);
    closeSheet();
  }

  /**
   * 보드 슬롯 탭.
   *   · 채워진 슬롯 → **그 선수 지시**로 (프롬프트 자리가 그 선수로 바뀐다)
   *   · 빈 슬롯     → **그 자리에 넣을 선수 시트**
   * (#106 의 탭-투-플레이스 2단계 — "슬롯 고르고 리스트에서 고르기" — 는 시트가 흡수했다.
   *  선수끼리 자리를 맞바꾸는 경로는 레일의 [이 자리 선수 바꾸기] + 드래그가 담당한다.)
   */
  function handleSlotTap(slot: SlotRef) {
    const occupant = draft.slots.find((s) => s.role === slot.role && s.slotIndex === slot.slotIndex);
    /**
     * 엔트리 대기 중이면 이 탭이 곧 **자리 지정**이다 (#442 R1). 빈 자리면 배치, 찬 자리면 맞바꾸기 —
     * 둘 다 `movePlayerToSlot` 한 함수가 한다(드래그 드롭과 **같은 경로**라 스왑 규칙이 갈리지
     * 않는다). 감독시간(`boardMode`)에서는 목록 시트 자체가 없어 이 상태에 들어올 수 없지만,
     * 그 화면의 탭 주인은 호출부이므로 명시적으로 비켜 준다.
     */
    if (assignPlayerId && !boardMode) {
      mutateDraft(movePlayerToSlot(draft, assignPlayerId, slot.role, slot.slotIndex));
      selectPlayer(assignPlayerId);
      setAssign(null);
      return;
    }
    // 교체·자리 바꾸기 모드: 탭은 전부 호출부(감독시간)로 넘긴다 — 규칙·전송은 그쪽이 소유한다.
    if (boardMode) {
      if (occupant) onBoardTap?.(occupant.playerId, slot.role);
      return;
    }
    if (occupant) {
      /**
       * #455 A2 ① — **메뉴가 이 탭 앞에 선다**(폰 덱셋팅뿐, `playerMenu`).
       * 구 동작(= 지금도 경기전·감독시간·데스크탑)은 탭이 곧 "그 선수 지시"였고, 그 일은
       * 이제 메뉴의 [한마디 쓰기]가 한다. 여기서 선택까지 같이 하지 않는 이유는
       * `menuPlayerId` 선언부에 있다.
       */
      if (playerMenu) {
        setMenuPlayerId(occupant.playerId);
        return;
      }
      selectPlayer(occupant.playerId);
      return;
    }
    // 배치 잠금이면 빈 자리는 아무 일도 하지 않는다(새 선수를 넣는 화면이 아니다).
    if (placementLocked) return;
    openSheet(slot);
  }

  /**
   * 선수 메뉴 항목 실행 (#455 A2 ①). **여기서 새 동작을 만들지 않는다** — 네 항목 전부
   * 이미 있는 동선(`startAssign` · `selectPlayer` · `onOpenGrowth`)을 부르기만 한다.
   * 새로 적으면 같은 규칙이 두 곳에 살고, 그게 #439 major-2 가 났던 방식이다.
   */
  function runPlayerMenu(id: PlayerMenuId, playerId: string) {
    setMenuPlayerId(null);
    if (id === "move") {
      startAssign(playerId, "move");
      return;
    }
    if (id === "say") {
      selectPlayer(playerId);
      return;
    }
    if (id === "info") {
      const player = playersById.get(playerId);
      if (player) onOpenGrowth?.(player);
    }
    // "close" = 아무 것도 하지 않는다(위에서 이미 닫혔다).
  }

  /**
   * 시트에서 선수 선택 → 배치하고 **그 선수 프롬프트로 이어진다**(이 에픽의 핵심 동선).
   *
   * 자리 맥락이 없는 시트([보유 선수] 버튼)에서의 동작을 명시한다 — 안 정하면 두 사고가 난다
   * (독립 검증 M-1/M-2):
   *   · **이미 배치된 선수**를 고르면 "첫 빈 자리로 이동"시켜 **라인업이 조용히 흐트러졌다**
   *     (DF 가 FW 자리로 가고 원래 자리는 공석, 되돌리기 없음). → 이동하지 않고 **지시 대상만** 바꾼다.
   *     자리를 바꾸려는 사람은 그 자리에서 열거나(빈 슬롯 탭) 레일의 [이 자리 선수 바꾸기]를 쓴다.
   *   · **덱이 꽉 찬 상태**에서 미배치 선수를 고르면 아무 일도 안 일어나는데 레일만 그 선수로 바뀌어
   *     "배치할 슬롯을 고르세요"라는 **따를 수 없는 안내**가 떴다. → 무엇을 해야 하는지 말해준다.
   */
  function handleSheetPick(playerId: string) {
    const alreadyPlaced = Boolean(findPlayerSlot(draft, playerId));
    const target = sheetSlot ?? (alreadyPlaced ? null : firstEmptySlot);
    if (target) {
      mutateDraft(movePlayerToSlot(draft, playerId, target.role, target.slotIndex));
      setPickNote(null);
    } else if (!alreadyPlaced) {
      /* #442 R1 이후 이 상태는 **막다른 길이 아니다** — 같은 행의 [엔트리] 가 자리를 고르게 해 준다.
         안내는 그 손잡이를 가리킨다(구 문구는 시트를 닫고 레일까지 돌아가라고 했다). */
      setPickNote(`빈 자리가 없습니다 — 목록에서 [엔트리]를 누른 뒤 명단에서 바꿀 선수를 고르세요`);
    } else {
      setPickNote(null);
    }
    selectPlayer(playerId);
    closeSheet();
  }

  const starterSlots = draft.slots.filter((s) => s.role === "starter");

  /**
   * 시트에 실제로 그려지는 후보 (#439 R2). **필터가 아니라 목록 자체를 줄인다** — AC 가
   * "DOM 에 없다"이고, 비활성 행으로 남기면 유저는 왜 못 고르는지 모른 채 계속 누른다.
   */
  const poolPlayers = useMemo(() => {
    if (poolScope !== "bench") return players;
    const bench = new Set(draft.slots.filter((s) => s.role === "bench").map((s) => s.playerId));
    return players.filter((p) => bench.has(p.id));
  }, [players, poolScope, draft.slots]);
  /**
   * 후보 목록의 이름 (#442 R4-A). hero 용어축 = **엔트리**(벤치 또는 선발) · **벤치** · **명단** ·
   * **투입**(= 경기장에 들어가는 것). 구 라벨 `교체 선수` 는 로스터 분류 명사로 남겨 뒀었는데,
   * hero 가 축을 갈랐다: *"투입은 경기장 투입이여서 구분되어야해."* — 이 화면에는 경기장이 없으니
   * `교체` 도 여기 말이 아니다. 그래서 그냥 **벤치**다.
   *
   * `보유 선수`(덱셋팅)는 **다른 축**이라 그대로다 — 소속(엔트리/벤치)이 아니라 **보유**를 말한다
   * (자리가 있든 없든 내가 가진 카드 전부). 이걸 `벤치` 로 바꾸면 오히려 거짓말이 된다.
   */
  const poolLabel = poolScope === "bench" ? "벤치" : "보유 선수";
  /** [후보] 탭의 숫자 — 보드가 세는 것과 같은 draft 를 센다(두 곳에서 세면 조용히 갈린다). */
  const benchCount = draft.slots.filter((s) => s.role === "bench").length;

  /**
   * [엔트리] 가 **잠기는** 선수 (#442 R3-B, hero: *"이미 있는 선수는 버튼 비활성화 된 모습으로
   * 보이게하자."*).
   *
   * ⚠️ **"명단"은 화면마다 다르다 — 그래서 이 판정이 `poolScope` 를 아는 여기 한 곳에만 있다**
   * (바로 위 `poolPlayers` 와 같은 자리. `PlayerPicker` 안에서 덱을 다시 해석하면 같은 규칙이
   * 두 곳에 적힌다 — #439 major-2 가 정확히 그 사고였다):
   *   · `"owned"`(덱셋팅) — 채우는 명단 = **덱 전체**(선발 + 후보). 자리를 가졌으면 이미 있다.
   *   · `"bench"`(경기전) — 덱은 얼어 있고 채우는 명단 = **선발**. 후보는 전원 벤치 선수라
   *     "자리를 가졌나"로 판정하면 **전부 잠겨 R2 동선이 통째로 죽는다**(계약이 그걸 잰다).
   *
   * ⚠️ 잠기는 것은 **이 버튼 하나**다. 행 본문 탭(`onPick` = 지시 대상 전환·자리 맞바꾸기)은
   * 계속 열려 있어야 한다 — 같이 잠그면 기존 계약 7건이 서 있는 동선이 죽는다.
   */
  const assignLockedIds = useMemo(() => {
    const alreadyInSquad = (role: SlotRole) =>
      role === "starter" || (poolScope !== "bench" && role === "bench");
    return new Set(draft.slots.filter((s) => alreadyInSquad(s.role)).map((s) => s.playerId));
  }, [draft.slots, poolScope]);

  /** 자리 지정 없이 시트를 열었을 때 들어갈 자리 — 첫 빈 선발, 없으면 첫 빈 벤치. */
  const firstEmptySlot: SlotRef | null = useMemo(() => {
    const taken = (role: "starter" | "bench", i: number) =>
      draft.slots.some((s) => s.role === role && s.slotIndex === i);
    for (let i = 0; i < 11; i += 1) if (!taken("starter", i)) return { role: "starter", slotIndex: i };
    for (let i = 0; i < 7; i += 1) if (!taken("bench", i)) return { role: "bench", slotIndex: i };
    return null;
  }, [draft.slots]);

  const power = useMemo(() => {
    const attrs = starterSlots
      .map((s) => playersById.get(s.playerId)?.attributes)
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
    return teamPower(attrs);
  }, [starterSlots, playersById]);

  const selectedPlayer = selection.playerId ? playersById.get(selection.playerId) : undefined;
  /**
   * 이름은 초크포인트로만(#406 요구 6). 여기는 **API 훅을 안 쓰는 프레젠테이션 컴포넌트**라
   * (`TeamSheet.test` 가 Provider 없이 단독 렌더한다) 훅이 아니라 순수 빌더를 쓴다 —
   * 표는 이미 프롭으로 받고 있다.
   */
  const names = useMemo(() => buildPlayerNames(playersById), [playersById]);
  const selectedSlotData = selection.playerId ? findPlayerSlot(draft, selection.playerId) : undefined;
  /** 메뉴가 떠 있는 선수와 그 자리(제목의 부제 = 어디에 있는 누구인가). */
  const menuPlayer = menuPlayerId ? playersById.get(menuPlayerId) : undefined;
  const menuSlot = menuPlayerId ? findPlayerSlot(draft, menuPlayerId) : undefined;
  const railRelation = selectedPlayer ? relationOf(relations, selectedPlayer.id) : undefined;

  /** 시트의 포지션 자동 필터 — 자리에서 열었으면 그 자리 포지션. */
  const sheetFilter = sheetSlot
    ? (slotPosition(draft.formation, sheetSlot.role, sheetSlot.slotIndex) ?? "ALL")
    : "ALL";
  const sheetTitle = sheetSlot
    ? `${slotNumberLabel(sheetSlot.role, sheetSlot.slotIndex)}번 ${sheetFilter === "ALL" ? "" : `${sheetFilter} `}자리에 넣을 선수`
    : poolLabel;

  /**
   * 탭 레이아웃(#455 A1)에는 **보드 하단 바가 없다.**
   *
   * 담고 있던 것은 전부 다른 자리로 갔다: [보유 선수]·[초기화] → **[후보] 탭**(testid 그대로) ·
   * Auto → 시트 바(`auto-fill-top`) · 힌트("빈 자리 = 선수 고르기") → 탭 이름이 대신 말한다.
   *
   * ⚠️ **조건부 둘도 되살리면 안 된다 — 재 보고 알았다.** 한 번 되살렸더니 그 바가 48px 를 먹어
   * **빈 덱에서 팀 프롬프트 아래 16px 가 하단 탭바 밑으로 들어갔다**(390×844 실측 prompt bottom
   * 796 > navTop 780, `p244` AC1-b). 그런데 둘 다 이 화면에 **이미 동등한 자리가 있다**:
   * - `select-clear`(선택 해제) → 레일의 **×**(`rail-close`). `deck-teamsheet` R2 r1 주석이
   *   원래부터 *"독 안의 레일 × 와 동치"* 라고 적어 두었다.
   * - `board-empty-auto`(Auto 배치로 시작) → **빈 상태 오버레이 안**으로 옮겼다(아래 `emptyOverlay`).
   *   그 오버레이는 `position:absolute` 라 세로 예산이 **0** 이고, 안내문("아래 …를 누르세요")이
   *   가리키던 버튼이 그 안내 **바로 옆**으로 온 것이라 오히려 직접적이다.
   * 즉 없앤 것은 손잡이가 아니라 **중복**이다.
   */

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <div className={styles.sheet} data-testid="deck-editor" data-layout={layout}>
        {/* ① 시트 바 — 포메이션 · 전력 · 3지표 · Auto */}
        <TeamSheetBar
          draft={draft}
          onFormationChange={(formation) => mutateDraft({ ...draft, formation })}
          power={power}
          opponentPower={opponentPower}
          opponentName={opponentName}
          opponentApprox={opponentApprox}
          onOpponentInfo={onOpponentInfo}
          autoDisabled={autoDisabled}
          autoHint={autoHint}
          onAuto={onAuto}
          placementLocked={placementLocked}
          /* 포메이션은 배치 잠금과 **다른 축**(#276) — 라인업 편집이 열린 화면에서는 보인다. */
          formationLocked={placementLocked && !lineupEditable}
          formationDisabled={lineupDisabled}
        />

        <div className={styles.wrap} data-layout={layout} data-deck-layout={layout}>
          {/* ② 배치(보드) — 벤치는 이 카드 안 */}
          <section className={styles.boardCol}>
            {boardHeader}
            {/* 엔트리 대기 안내 (#442 R1) — 보드 **바로 위**에 둔다. 시트가 닫히면서 유저의 눈이
                보드로 돌아오는 자리이고, 여기가 아니면 폰에서 안내와 대상이 다른 화면에 갈린다.
                `role="status"` = 시각 신호(슬롯 맥박)와 같은 사실을 스크린리더에도 말한다. */}
            {assignPlayerId && (
              <div className={styles.assignBar} data-testid="assign-bar" role="status">
                {/* ⚠️ **말이 두 갈래다** (#455 A2 ⑤). 이 대기 상태에 들어오는 문은 둘이고 뜻이 다르다:
                    · 목록의 [엔트리](#442 R1) — 아직 **명단 밖** 선수를 데려온다 → "…엔트리"
                    · 선수 메뉴의 [자리 옮기기](#455 A2) — **이미 명단에 있는** 선수를 옮긴다
                    "명단에서 바꿀 선수를 선택하세요"를 후자에 그대로 쓰면 이미 명단에 있는 사람을
                    명단에 넣으라는 말이 된다. **갈래는 `AssignIntent` 가 들고 있다** — draft 상태로
                    되추론하면 경기전이 깨진다(그 타입 선언부에 실측 red 가 적혀 있다). */}
                <b className={styles.assignWho}>
                  {names.has(assignPlayerId) ? names.full(assignPlayerId) : "선수"}{" "}
                  {assign?.intent === "move" ? "자리 옮기기" : "엔트리"}
                </b>
                <span className={styles.assignHint}>
                  {/* ⚠️ **짧게 써라 — 이 줄은 한 줄 말줄임이다**(`.assignHint`). 첫판은
                      *"옮길 자리를 누르세요 — 선수가 있으면 맞바꿉니다"*(23자) 였는데 390px 실캡처에서
                      `— 선수가 …` 로 잘려 **정작 중요한 '맞바꾼다'가 안 보였다**. DOM 계약은 그때도
                      초록이다(`toContainText` 는 시각적 잘림을 모른다 — #439 `.tokenDragging` 부류).
                      ⚠️ **이 갈래가 더 빡빡하다**(실측 390×844 `scrollWidth`/`clientWidth`):
                      `보낼 자리를 누르세요` **169/169**(안 잘림) vs 엔트리 갈래
                      `명단에서 바꿀 선수를 선택하세요` **204/204**(안 잘림) — 앞 `.assignWho` 가
                      "미드하나 자리 옮기기"로 길어지며 힌트 자리를 35px 먹기 때문이다.
                      즉 옛 문구가 잘린 적은 없고, **여기서만** 예산이 줄었다. 문구를 늘릴 거면 이 수치부터 재라. */}
                  {assign?.intent === "move" ? "보낼 자리를 누르세요" : "명단에서 바꿀 선수를 선택하세요"}
                </span>
                <button
                  type="button"
                  className={styles.assignCancel}
                  data-testid="assign-cancel"
                  onClick={() => setAssign(null)}
                >
                  취소
                </button>
              </div>
            )}
            <TacticsBoard
              draft={draft}
              playersById={playersById}
              conditions={conditions}
              selectedSlot={null}
              /* 보드 모드에서는 지금 지정된 선수가 강조 대상이다(지시 대상이 아니라). */
              selectedPlayerId={boardMode ? (pendingPlayerId ?? null) : selection.playerId}
              /* 엔트리 대기(#442 R1) — 선발·후보 전 슬롯이 대상이 된다. */
              pendingPlace={Boolean(assignPlayerId)}
              subbedOut={subbedOut}
              swapMode={Boolean(boardMode)}
              /* 벤치를 펴는 건 교체 모드뿐 — 자리 바꾸기는 **선발끼리**라 넣을 선수를 고를 일이 없다. */
              hideBench={hideBench && boardMode !== "subs"}
              /* 탭 레이아웃이면 벤치는 [후보] 탭 안으로 간다 — **그리는 코드는 그대로**(포털). */
              benchPortal={tabs ? benchHost : undefined}
              /* 강화 가능(선택 대기) `↑` — 안 넘기면 뱃지가 없다(경기전·감독시간의 오늘 모양). */
              growthReadyIds={growthReadyIds}
              onSlotTap={handleSlotTap}
              /* 빈 상태(#106 R3b A): 선발 0/11 로 처음 들어오면 피치가 "+" 11개짜리 무언의 격자라
                 무엇부터 해야 하는지가 없었다.

                 ⚠️ 이 오버레이는 **완전히 비대화형**이다(텍스트만). R3b 1차 구현은 여기에 Auto CTA
                 버튼을 넣었다가 그 버튼이 선발 슬롯 2·3 을 가로챘다(실측, 실클릭 무반응).
                 CTA 는 피치 밖 보드 하단 바에 있다 — 오버레이 안에 포커스 가능한 요소를 넣지 말 것. */
              emptyOverlay={
                <>
                  <b className={styles.emptyTitle}>선발이 비어 있습니다</b>
                  {/* ⚠️ 안내가 가리키는 버튼이 레이아웃마다 다르다 — 탭 레이아웃엔 보드 하단 바가
                      없고 Auto 는 **위 시트 바**(`auto-fill-top`)에 있다. 문구가 없는 버튼을
                      가리키면 그게 곧 막다른 길이다(이 오버레이가 원래 겨누던 blocker 와 같은 부류). */}
                  <span className={styles.emptyHint} data-testid="board-empty-hint">
                    {tabs
                      ? "슬롯을 눌러 선수를 고르거나, 위 [Auto] 를 누르세요"
                      : "슬롯을 눌러 선수를 고르거나, 아래 [Auto 배치로 시작]을 누르세요"}
                  </span>
                  {autoDisabled && autoHint && (
                    <span className={styles.emptyNote} data-testid="board-empty-note">
                      {autoHint} · 슬롯을 눌러 직접 배치할 수 있습니다
                    </span>
                  )}
                </>
              }
              /* 배치 잠금(감독시간)이면 하단 바를 아예 그리지 않는다 — 버튼은 전부 숨겨졌고
                 힌트("빈 자리 = 선수 고르기")는 **틀린 말**이 된다. 35px 도 같이 돌려받는다. */
              footer={placementLocked || tabs ? undefined : (
                <>
                  {/* 힌트는 한 줄로 — 세 줄로 접히면 보드 카드가 그만큼 커져 프롬프트를 밀어낸다. */}
                  <span className={styles.boardHint}>
                    {/* 이름은 초크포인트로만(#406 요구 6) — 한 줄을 통째로 쓰는 안내라 풀네임 축.
                        카탈로그 미상이면 `미상 선수`(구 동작은 빈 문자열/원시 필드였다). */}
                    {selectedPlayer
                      ? `${names.full(selectedPlayer.id)} 편집 중`
                      : "선수 = 프롬프트 · 빈 자리 = 선수 고르기"}
                  </span>
                  {selectedPlayer && (
                    <button
                      type="button"
                      className={styles.boardBtn}
                      data-testid="select-clear"
                      onClick={() => setSelection(NO_SELECTION)}
                    >
                      선택 해제
                    </button>
                  )}
                  {!placementLocked && onAuto && starterSlots.length === 0 && (
                    <button
                      type="button"
                      className={styles.emptyCta}
                      data-testid="board-empty-auto"
                      disabled={autoDisabled}
                      onClick={onAuto}
                    >
                      Auto 배치로 시작
                    </button>
                  )}
                  {!placementLocked && (
                    <button
                      type="button"
                      className={styles.boardBtn}
                      data-testid="pool-sheet-open"
                      onClick={() => openSheet(null)}
                    >
                      {poolLabel} ({poolPlayers.length})
                    </button>
                  )}
                  {!placementLocked && !hideReset && (
                    <button
                      type="button"
                      className={styles.boardBtn}
                      data-testid="board-reset"
                      onClick={() => {
                        mutateDraft({ ...draft, slots: [] });
                        setSelection(NO_SELECTION);
                      }}
                    >
                      초기화
                    </button>
                  )}
                  {!placementLocked && onAuto && (
                    <button
                      type="button"
                      className={styles.boardBtnPrimary}
                      data-testid="auto-fill"
                      disabled={autoDisabled}
                      onClick={onAuto}
                    >
                      Auto 배치
                    </button>
                  )}
                </>
              )}
            />
            {onAuto && autoHint && (
              <span className={styles.autoHint} data-testid="auto-hint">
                {autoHint}
              </span>
            )}
            {pickNote && (
              <p className={styles.pickNote} data-testid="deck-pick-note">
                {pickNote}
              </p>
            )}
            {errorPlayerId && names.has(errorPlayerId) && (
              <p className={styles.errorNote} data-testid="editor-error-player">
                문제 선수: {names.full(errorPlayerId)}
              </p>
            )}
          </section>

          {/* ③-0 책갈피 탭 — **덱셋팅만**(#455 A1 ⑤, hero 확정). 경기전·감독시간은 `layout="stack"`
              기본값이라 이 줄 자체가 안 그려진다(같은 컴포넌트를 셋이 공유한다). */}
          {tabs && (
            <div className={styles.deckTabs} data-testid="deck-tabs" role="tablist" aria-label="덱 편집">
              {DECK_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  className={styles.deckTab}
                  data-testid={`deck-tab-${t.id}`}
                  data-on={deckTab === t.id ? "1" : undefined}
                  data-rank={t.rank}
                  aria-selected={deckTab === t.id}
                  aria-controls={`deck-tabpanel-${t.id}`}
                  onClick={() => setDeckTab(t.id)}
                >
                  <span aria-hidden="true">{t.icon}</span>
                  <span>{t.label}</span>
                  {t.id === "sub" && <span className={styles.deckTabCount}>{benchCount}</span>}
                </button>
              ))}
            </div>
          )}

          {/* ③ 프롬프트(1급) + 세부조정(⚙ 뒤) — 모바일도 **문서 흐름 그대로**(독 없음).
              탭 레이아웃에서는 이 자리가 곧 **[전체 지시] 탭 패널**이다(프롬프트는 1순위라
              기본으로 펼쳐져 있어야 한다 — 그게 1안을 고른 이유다). */}
          <section
            ref={railRef}
            id={tabs ? "deck-tabpanel-team" : undefined}
            className={tabs ? `${styles.railCol} ${styles.tabPanel}` : styles.railCol}
            data-testid="directive-col"
            {...(tabs ? { role: "tabpanel" as const, hidden: deckTab !== "team" } : {})}
          >
            <DirectiveRail
              section={tabs ? "prompt" : "all"}
              player={selectedPlayer}
              onOpenGrowth={onOpenGrowth}
              growthLockedReason={growthLockedReason}
              slot={selectedSlotData}
              slotNumber={
                selectedSlotData
                  ? slotNumberLabel(selectedSlotData.role, selectedSlotData.slotIndex)
                  : undefined
              }
              condition={selectedPlayer ? conditions?.[selectedPlayer.id] : undefined}
              trust={railRelation?.trust}
              personality={railRelation?.personality}
              tactics={state.tactics}
              teamPrompt={state.teamPrompt}
              aiManaged={aiManaged}
              onTacticsChange={(tactics) => onChange({ ...state, tactics })}
              onTeamPromptChange={(text) => onChange({ ...state, teamPrompt: text })}
              onToggleAi={onToggleAi}
              onPlayerPromptChange={(playerId, text) => mutateDraft(setPrompt(draft, playerId, text))}
              onRemovePlayer={(playerId) => {
                mutateDraft(removePlayer(draft, playerId));
                setSelection(NO_SELECTION);
              }}
              hideTeamTune={hideTeamTune}
              lockRoster={placementLocked}
              note={railNote}
              promptDisabled={promptDisabled}
              promptScope={promptScope}
              onSwapPlayer={
                !placementLocked && selectedSlotData
                  ? () =>
                      openSheet({
                        role: selectedSlotData.role,
                        slotIndex: selectedSlotData.slotIndex,
                      })
                  : undefined
              }
              onClose={() => setSelection(NO_SELECTION)}
            />
            {/**
             * 덱 규칙 위반 안내(`deck-pre-issues`) — 탭 레이아웃에서만 **여기로 들어온다**.
             *
             * ⚠️ 취향이 아니라 실측 때문이다. 페이지 형제로 두면 그 목록이 세로를 먹어 탭 패널이
             * 짧아지고, 그러면 **팀 프롬프트가 패널 밖으로 밀려 그 안내에 가린다** —
             * 390×844 빈 덱 실측 `hitSelf:false · center←deck-pre-issues`(프롬프트 자체는
             * 694~796 로 fold 안이었다 = 예산 초과가 아니라 가림), 360×740 도 같다.
             * 패널 안으로 들어오면 그 목록이 프롬프트와 **같은 스크롤러**를 공유하므로
             * 프롬프트는 패널 맨 위에 그대로 있고 안내는 아래로 이어진다(#244 AC1-b·AC13).
             *
             * ⚠️ 프롬프트 **뒤**에 둔다 — 앞에 두면 안내 길이만큼 프롬프트가 첫 화면에서 밀린다.
             * ⚠️ 저장 피드백·셋업 CTA 는 **안 옮긴다**: 탭과 무관한 페이지 단위 사건이고, 옮기면
             *    다른 탭에 있는 동안 "저장되었습니다"가 안 보인다. 전부 조건부라 평소엔 0px 이다.
             */}
            {tabs && teamPanelNotice}
          </section>

          {/* ③-b [후보] 탭 — 벤치 줄이 **포털로 여기 들어온다**(TacticsBoard 가 그리는 그대로).
              1안의 유일한 대가 = 벤치가 기본으로 안 보인다. hero 가 그 대가를 알고 골랐다.
              되돌리려면 `benchPortal` 을 안 넘기고 탭을 둘로 줄이면 된다(조정 포인트). */}
          {tabs && (
            <section
              id="deck-tabpanel-sub"
              className={`${styles.railCol} ${styles.tabPanel}`}
              role="tabpanel"
              hidden={deckTab !== "sub"}
            >
              <div ref={benchHostRef} className={styles.benchHost} />
              {/* ⚠️ testid 는 하단 바에 있던 것을 **그대로** 쓴다 — 자리를 옮긴 것이지 새 손잡이가
                  생긴 게 아니다. 이름을 바꾸면 #244·#439·#442 계약이 selector 부재로 죽는다. */}
              <div className={styles.tabActions}>
                {!placementLocked && (
                  <button
                    type="button"
                    className={styles.boardBtn}
                    data-testid="pool-sheet-open"
                    onClick={() => openSheet(null)}
                  >
                    {poolLabel} ({poolPlayers.length})
                  </button>
                )}
                {!placementLocked && !hideReset && (
                  <button
                    type="button"
                    className={styles.boardBtn}
                    data-testid="board-reset"
                    onClick={() => {
                      mutateDraft({ ...draft, slots: [] });
                      setSelection(NO_SELECTION);
                    }}
                  >
                    초기화
                  </button>
                )}
              </div>
            </section>
          )}

          {/* ③-c [세부 전술] 탭 — 3순위. 팀 다이얼은 **선수 선택과 무관**하게 팀 값이라
              선수를 고른 동안에도 이 탭은 그대로다(DirectiveRail `section="tune"`). */}
          {tabs && !hideTeamTune && (
            <section
              id="deck-tabpanel-tune"
              className={`${styles.railCol} ${styles.tabPanel}`}
              role="tabpanel"
              hidden={deckTab !== "tune"}
            >
              <DirectiveRail
                section="tune"
                tactics={state.tactics}
                teamPrompt={state.teamPrompt}
                aiManaged={aiManaged}
                onTacticsChange={(tactics) => onChange({ ...state, tactics })}
                onTeamPromptChange={(text) => onChange({ ...state, teamPrompt: text })}
                onToggleAi={onToggleAi}
                onPlayerPromptChange={(playerId, text) => mutateDraft(setPrompt(draft, playerId, text))}
                onRemovePlayer={(playerId) => {
                  mutateDraft(removePlayer(draft, playerId));
                  setSelection(NO_SELECTION);
                }}
                onClose={() => setSelection(NO_SELECTION)}
              />
              {teamExtra}
            </section>
          )}
        </div>
      </div>

      {/* 선택 = 시트. 포커스 트랩·Esc·포커스 복원은 공용 Modal 이 준다(#73 P1). */}
      {sheetOpen && (
        <Modal
          onClose={closeSheet}
          labelledBy="pool-sheet-title"
          overlayClassName={styles.sheetBackdrop}
          overlayTestId="pool-sheet-backdrop"
          className={styles.sheetBox}
          testId="pool-sheet"
        >
          <div className={styles.sheetHead}>
            <b id="pool-sheet-title" className={styles.sheetTitle}>
              {sheetTitle}
            </b>
            <button
              type="button"
              className={styles.sheetClose}
              data-testid="pool-sheet-close"
              onClick={closeSheet}
            >
              닫기 ×
            </button>
          </div>
          <PlayerPicker
            players={poolPlayers}
            draft={draft}
            onPick={handleSheetPick}
            /* [엔트리] = 자리를 보드에서 고르는 동선 (#442 R1). 후보는 `poolPlayers` 가 곧 규칙이고,
               그중 **이미 명단에 있는 선수**를 잠그는 판정도 위 `assignLockedIds` 한 곳에서 온다
               (#442 R3-B) — 여기서 다시 계산하지 않는다. */
            onAssign={(playerId: string) => startAssign(playerId, "entry")}
            assignLockedIds={assignLockedIds}
            conditions={conditions}
            autoFilter={sheetFilter}
            inSheet
          />
        </Modal>
      )}

      {/**
       * 선수 메뉴 (#455 A2 ①④) — **아래에서 올라오는 시트**.
       *
       * ⚠️ 시트 껍데기는 보유 선수 시트와 **같은 클래스**(`sheetBackdrop`/`sheetBox`)를 쓴다.
       * 그게 hero 확정 ④ 의 *"모달 경로는 코드에 남겨 둔다(폭 기준 분기 여지)"* 에 해당하는
       * 자리다 — 그 클래스에는 이미 `@media (min-width:1024px)` 에서 **가운데 정렬 모달**로
       * 바뀌는 분기가 있다. **정직하게**: 이 메뉴는 오늘 폭 ≤899(폰 덱셋팅)에만 뜨므로
       * 그 분기가 메뉴에 대해서는 **한 번도 발화하지 않는다**. 데스크탑에서 메뉴를 켤 날이 오면
       * 그 미디어쿼리가 그대로 모달을 만든다(새로 만들 것이 없다).
       */}
      {menuPlayerId && (
        <Modal
          onClose={() => setMenuPlayerId(null)}
          labelledBy="player-menu-title"
          overlayClassName={styles.sheetBackdrop}
          overlayTestId="player-menu-backdrop"
          className={`${styles.sheetBox} ${styles.menuBox}`}
          testId="player-menu"
        >
          <div className={styles.sheetHead}>
            <b id="player-menu-title" data-testid="player-menu-title" className={styles.sheetTitle}>
              {/* 이름은 초크포인트로만(#406 요구 6). 시트 제목은 한 줄을 통째로 쓰는 넓은 자리 → 풀네임. */}
              {names.has(menuPlayerId) ? names.full(menuPlayerId) : "선수"}
              <span className={styles.menuSub}>
                {menuPlayer ? `${menuPlayer.position} · 전력 ${Math.round(playerOverall(menuPlayer.attributes))}` : ""}
                {menuSlot
                  ? ` · ${menuSlot.role === "starter" ? "선발" : "벤치"} ${menuSlot.slotIndex + 1}번`
                  : ""}
              </span>
            </b>
          </div>
          <div className={styles.menuList}>
            {PLAYER_MENU.map((item) => {
              /* [선수 정보]는 강화 시트를 여는 항목이라 **열 것이 없으면 눌리지 않는다**
                 (레일 `rail-growth-open` 과 같은 판정 — 경기 중에는 능력치가 도중에 바뀌면 안 된다).
                 ⚠️ 항목을 **숨기지는 않는다**: 메뉴 모양이 상태에 따라 4↔3 으로 흔들리면 유저가
                 자리를 외울 수 없고, "A안 = 4항목"이라는 확정 계약도 상태 의존이 된다. */
              const growthOff = !onOpenGrowth || Boolean(growthLockedReason);
              const disabled = item.id === "info" && growthOff;
              const hint = item.id === "info" ? (growthLockedReason ?? item.hint) : item.hint;
              /**
               * 강화 가능(선택 대기 있음) 표시 (#455 A2-2) — **토큰의 `↑` 를 보고 온 사람이 어느
               * 항목으로 가야 하는지**를 그 자리에서 잇는다. 확정 계약이 뱃지 자리로 열어 둔 곳이
               * 정확히 이 항목(`PLAYER_MENU` 의 `info` = 강화 진입점)이다.
               *
               * ⚠️ testid 를 **`pmenu-` 로 시작하면 안 된다** — A2 ① 의 *"메뉴는 4항목"* 이
               * `[data-testid^='pmenu-']` 개수로 재기 때문에 5가 되어 깨진다(A1 의 `token-name-*`
               * 접두 침범과 같은 부류). `growup-` 접두를 쓴다.
               * ⚠️ **잠겼다고 감추지 않는다.** 경기 중이라 못 누르는 것과 대기가 없는 것은 다른
               * 사실이고, 감추면 "경기 끝나고 오면 할 일이 있다"가 화면에서 사라진다.
               */
              const showGrow = item.id === "info" && growthReadyIds?.has(menuPlayerId);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`${styles.menuItem} ${item.id === "close" ? styles.menuItemMuted : ""}`}
                  data-testid={`pmenu-${item.id}`}
                  disabled={disabled}
                  onClick={() => runPlayerMenu(item.id, menuPlayerId)}
                >
                  <span className={styles.menuIcon} aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className={styles.menuLabel}>{item.label}</span>
                  {showGrow && (
                    <span className={styles.menuGrow} data-testid="growup-menu">
                      ↑ 강화 가능
                    </span>
                  )}
                  {hint && <span className={styles.menuHint}>{hint}</span>}
                </button>
              );
            })}
          </div>
        </Modal>
      )}
    </DndContext>
  );
}
