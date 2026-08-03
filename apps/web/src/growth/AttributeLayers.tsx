import { useState } from "react";
import { StatRadar } from "../common/StatRadar";
import { normalizeInWindow } from "./growth-config";
import type { AttributeBarRow, AttributeView } from "./attribute-view";
import styles from "./AttributeLayers.module.css";

/**
 * **능력치 표시** — 강화탭(`CardGrowthDetail`)과 선수 상세 모달(`match/PlayerDetailModal`)이
 * **같은 컴포넌트**를 쓴다 (#403 W3).
 *
 * `ChoiceCards` 가 세운 선례 그대로다(그 머리말: *"호출부가 흉내 내기 시작하면 한쪽만 낡는다"*).
 * 같은 능력치가 화면마다 다르게 보이지 않게 하는 것이 요점이고, 유지보수도 한 곳으로 모인다.
 *
 * ── 입력은 **뷰모델**이다 ────────────────────────────────────────────────────────────────
 * `CardEffective` 를 직접 받지 않는다 — `api/growth.ts` 가 *"openapi 에 편입되면 이 파일을
 * generated 타입으로 교체한다"* 고 예고했고 `statLevels` 는 제거 후보다. 그 교체가 화면 수정이
 * 되지 않도록 변환은 `attribute-view.ts` 한 곳이 한다.
 *
 * ── 두 모드 ─────────────────────────────────────────────────────────────────────────────
 * · `full`    3층 막대(기본 | 성장분 | 잠재) + 천장 마커 + 레이더 캡 점선. 축 = 서버 `startLo`~`caps`.
 * · `reduced` **남의 성장 진행도는 서버가 주지 않는다** → 그 층들이 `null` 이고 단층 막대만 그린다.
 *   ⚠️ 없는 층을 0 으로 그리지 마라 — "성장분 0"은 모르는 것을 아는 척하는 거짓이다.
 *   대신 `view.note` 가 무엇이 빠졌는지 화면에서 **말한다**.
 *
 * ⚠️ **루트가 Fragment 인 것은 의도다.** 강화탭에서 이 블록은 `.frame`(블록 흐름) 의 직계
 * 형제들이고 위아래 마진이 이웃과 상쇄된다 — 래퍼 `div` 를 하나 끼우면 그 상쇄 관계가 바뀐다.
 * 픽셀 동일이 이 추출의 계약이라(기존 e2e `growth-mock` G4 가 그걸 잡는다) 컨테이너를 만들지 않는다.
 * 필요한 쪽(모달)이 자기 컨테이너를 갖는다.
 *
 * ⚠️ `data-testid` 는 `growth-*` 를 **그대로** 쓴다. 이름을 화면별로 가르면 "두 자리가 같은
 * 컴포넌트"라는 성질을 계약이 확인할 수 없다(같은 selector 로 양쪽을 재는 것이 그 증거다).
 */
export interface AttributeLayersProps {
  view: AttributeView;
  /** 레이더 값 폴리곤 강조색(미지정 시 StatRadar 기본). */
  accentColor?: string;
  /** 방금 오른 스탯 — 성장분 층에 플래시. 없으면 플래시 없음. */
  highlight?: ReadonlySet<string>;
  /** 레이더 SVG 정사각 픽셀. */
  radarSize?: number;
}

export function AttributeLayers({ view, accentColor, highlight, radarSize = 200 }: AttributeLayersProps) {
  // 기본은 레이더 — 강화탭이 그랬고(`growth-layer-radar` aria-selected=true 계약), 모달도 같다.
  const [layer, setLayer] = useState<"radar" | "total">("radar");
  const pct = (v: number) => normalizeInWindow(v, view.axis) * 100;

  return (
    <>
      <div className={styles.layerToggle} role="tablist" aria-label="능력치 보기" data-testid="growth-attr-layer">
        <button
          type="button"
          role="tab"
          aria-selected={layer === "radar"}
          className={layer === "radar" ? `${styles.layerBtn} ${styles.layerBtnActive}` : styles.layerBtn}
          data-testid="growth-layer-radar"
          onClick={() => setLayer("radar")}
        >
          레이더
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={layer === "total"}
          className={layer === "total" ? `${styles.layerBtn} ${styles.layerBtnActive}` : styles.layerBtn}
          data-testid="growth-layer-total"
          onClick={() => setLayer("total")}
        >
          막대
        </button>
      </div>

      {/*
        축소 모드가 **없는 것을 없다고** 말하는 줄. 레이어와 무관하게 항상 보인다 — 숫자의
        출처에 대한 사실이지 막대에 대한 사실이 아니다(레이더만 보는 유저도 알아야 한다).
      */}
      {view.note && (
        <p className={styles.reducedNote} data-testid="growth-attr-reduced" data-mode={view.mode}>
          {view.note}
        </p>
      )}

      {layer === "radar" && (
        <div className={styles.radarRow} data-testid="growth-radar-row">
          <StatRadar
            axes={view.radarAxes}
            window={view.axis}
            size={radarSize}
            accentColor={accentColor}
            testId="growth-radar"
          />
          <div className={styles.sideChips}>
            {view.chips.map((chip) => (
              <div key={chip.key} className={styles.mentalChip} data-testid={`growth-side-chip-${chip.key}`}>
                <span className={styles.mentalLabel}>{chip.label}</span>
                <span className={styles.mentalValue}>
                  {Math.round(chip.value)}
                  {/* 천장은 내 카드에만 있다 — 모르면 `/0` 을 그리지 않고 숫자만 말한다. */}
                  {chip.cap != null && <span className={styles.mentalCap}> /{Math.round(chip.cap)}</span>}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {layer === "total" && (
        <>
          <p className={styles.axisWindowLabel} data-testid="growth-attr-window">
            스탯 축 {Math.round(view.axis.lo)}–{Math.round(view.axis.hi)}
          </p>
          {/*
            범례 (#405 §2.10) — 이 개편의 핵심 정보는 "회색 여백 = 아직 갈 수 있는 곳"이다.
            천장은 **분해해서** 말한다(`천장 73 = 72 + ★2 보너스 1`) — 그래야 승급(★)이
            게이트가 아니라 소폭 보너스라는 §2.6 의 새 역할이 화면에서 읽힌다.
            ⚠️ 축소 모드엔 층이 하나뿐이라 범례를 그리지 않는다 — 없는 색을 설명하는 범례는
            그 자체가 거짓 신호다(`view.ceilingLabel === null` 이 그 판정).
          */}
          {view.ceilingLabel && (
            <p className={styles.attrLegend} data-testid="growth-attr-legend">
              <span>
                <i className={styles.lgBase} />
                기본(발행 원본)
              </span>
              <span>
                <i className={styles.lgGrow} />
                성장분(선택으로 올린 몫)
              </span>
              <span data-testid="growth-ceil-legend">
                <i className={styles.lgCeil} />
                {view.ceilingLabel}
              </span>
            </p>
          )}
        </>
      )}

      {layer === "total" && (
        <dl className={styles.attrs} data-testid="growth-attrs" data-layer={layer} data-mode={view.mode}>
          {view.rows.map((row) => (
            <BarRow key={row.key} row={row} pct={pct} flash={highlight?.has(row.key) ?? false} />
          ))}
        </dl>
      )}
    </>
  );
}

function BarRow({
  row,
  pct,
  flash,
}: {
  row: AttributeBarRow;
  pct: (v: number) => number;
  flash: boolean;
}) {
  // 축 정규화 — width%/left% 는 원시 능력치가 아니라 axis 기준.
  const curPct = pct(row.value);
  const full = row.base != null && row.cap != null && row.grown != null && row.add != null;
  const basePct = row.base != null ? pct(row.base) : 0;
  const grownPct = row.grown != null ? pct(row.grown) : 0;
  const capPct = row.cap != null ? pct(row.cap) : 0;

  return (
    <div className={styles.attrRow} data-testid={`growth-attr-${row.key}`}>
      <dt className={styles.attrName}>{row.label}</dt>
      <dd className={styles.attrBarCell}>
        <span className={styles.bar}>
          {full ? (
            <>
              {/* ① 기본(발행 원본) */}
              <i className={styles.layerBase} style={{ width: `${basePct}%` }} />
              {/* ② 성장분 — 이 개편이 만든 유일한 성장 축 */}
              <i
                className={flash ? `${styles.layerGrow} ${styles.fillUp}` : styles.layerGrow}
                data-testid={`growth-grow-${row.key}`}
                data-add={(row.add ?? 0).toFixed(2)}
                style={{ left: `${basePct}%`, width: `${Math.max(0, grownPct - basePct)}%` }}
              />
              {/* ③ 잠재 보정분 — 성장이 아니라 옵션이라 색을 가른다(0 이면 안 그린다) */}
              {curPct > grownPct + 0.01 && (
                <i
                  className={styles.layerPotential}
                  style={{ left: `${grownPct}%`, width: `${curPct - grownPct}%` }}
                />
              )}
              <i
                className={styles.capLine}
                data-testid={`growth-cap-${row.key}`}
                data-value={Math.round(row.cap ?? 0)}
                style={{ left: `${capPct}%` }}
              />
            </>
          ) : (
            /* 축소 모드 — 층이 하나다. 성장분·천장을 0 으로 그리지 않는다(위 머리말). */
            <i className={styles.layerSingle} style={{ width: `${curPct}%` }} />
          )}
        </span>
      </dd>
      <span className={`${styles.attrNum} ${styles.attrNumBig}`}>
        <b data-testid={`growth-value-${row.key}`} data-value={Math.round(row.value)}>
          {Math.round(row.value)}
        </b>
        {row.add != null && (
          <em className={row.add > 0 ? styles.attrAdd : styles.attrAddZero}>+{row.add.toFixed(1)}</em>
        )}
        {row.cap != null && <span className={styles.attrCap}>천장 {Math.round(row.cap)}</span>}
      </span>
    </div>
  );
}
