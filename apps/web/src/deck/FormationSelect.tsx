import { FORMATION_LAYOUTS } from "./deck-logic";

interface FormationSelectProps {
  value: string;
  onChange: (formation: string) => void;
  disabled?: boolean;
  /** 기본 = 덱 시트 바의 `formation-select`. 감독시간은 `halftime-formation-select`(halftime-* 관례). */
  testId?: string;
  /** label htmlFor 대상. 한 페이지에 둘이 같이 뜨는 자리는 없지만 소비처가 정할 수 있게 연다. */
  id?: string;
  /** 소비처의 CSS 모듈 클래스 — 마크업은 공유하되 생김새는 그 화면 폭에 맡긴다. */
  classNames?: { label?: string; srOnly?: string; select?: string };
}

/**
 * 포메이션 셀렉트 — 덱(시트 바)과 감독시간(라인업 보드)이 **같은 손잡이**를 쓴다(#276).
 *
 * hero 결정("덱 구성과 같은 조작으로 통일")에 따라 감독시간에도 포메이션을 바꿀 수 있게 되면서
 * 셀렉트가 두 화면에 필요해졌다. 새로 그리면 두 화면이 서로 다른 목록·다른 모양을 갖게 되므로
 * (실제로 FORMATION_LAYOUTS 에 포메이션을 추가하면 한쪽만 늘어난다) 마크업을 여기로 뽑았다.
 * TeamSheetBar 는 자기 CSS 모듈 클래스를 그대로 넘겨 **DOM 이 이전과 동일**하다.
 */
export function FormationSelect(props: FormationSelectProps) {
  const { value, onChange, disabled, testId = "formation-select", id = "formation", classNames } = props;
  return (
    <label className={classNames?.label} htmlFor={id}>
      <span className={classNames?.srOnly}>포메이션</span>
      <select
        id={id}
        data-testid={testId}
        className={classNames?.select}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {Object.keys(FORMATION_LAYOUTS).map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
    </label>
  );
}
