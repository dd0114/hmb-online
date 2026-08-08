import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  getBackendHealth,
  retryBackendNow,
  subscribeBackendHealth,
  type BackendHealth,
} from "../api/backend-health";
import { MaintenanceScreen } from "./MaintenanceScreen";

/**
 * 백엔드에 못 닿으면 앱 대신 점검 안내를 띄운다 (#477).
 *
 * <b>라우터 바깥에 둔다.</b> 라우트로 만들면 딥링크·매치 잠금 게이트(#217)와 상호작용이 생기고,
 * "이 화면에서만 안 뜨는" 구멍이 난다. 트리를 통째로 대체하는 쪽이 상태가 하나뿐이라 안전하다.
 *
 * <b>복구는 리로드다.</b> 백엔드가 돌아왔을 때 부분 실패로 남은 쿼리 캐시를 화면마다 다르게
 * 되살리는 것보다, 깨끗하게 부팅하는 편이 예측 가능하다(그리고 그 사이 백엔드 버전이 바뀌었을
 * 수도 있다).
 */
export function MaintenanceGate({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<BackendHealth>(() => getBackendHealth());
  const [retrying, setRetrying] = useState(false);

  useEffect(() => subscribeBackendHealth(setHealth), []);

  // 자동 재확인(backend-health 의 recheck 루프)이든 [다시 시도]든, 복구 신호는 `ok` 하나다.
  // 점검 화면을 보고 있던 경우에만 리로드한다 — 정상 부팅 중에 리로드가 걸리면 안 된다.
  const [wasDown, setWasDown] = useState(false);
  useEffect(() => {
    if (health === "outage") setWasDown(true);
    else if (health === "ok" && wasDown && typeof window !== "undefined") {
      window.location.reload();
    }
  }, [health, wasDown]);

  const onRetry = useCallback(() => {
    setRetrying(true);
    void retryBackendNow().finally(() => setRetrying(false));
  }, []);

  if (health === "outage") {
    return <MaintenanceScreen onRetry={onRetry} retrying={retrying} />;
  }
  return <>{children}</>;
}
