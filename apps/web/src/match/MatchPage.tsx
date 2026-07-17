import { useNavigate, useParams } from "react-router-dom";
import { Layout } from "../common/Layout";

/**
 * LLD-web §4-W2 placeholder — 상태 라우팅(BRIEFING/GEN1/H1_BREAK/GEN2/FINISHED)과
 * 실제 매치 플로우는 W2에서 구현. W0는 라우팅 스켈레톤(/match/:id 도달 가능)만 제공.
 */
export function MatchPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  return (
    <Layout>
      <h1>매치</h1>
      <p>매치 ID: {id}</p>
      <p>매치 플로우(브리핑→재생→결과)는 W2에서 구현됩니다.</p>
      <button type="button" onClick={() => navigate("/lobby")}>
        로비로
      </button>
    </Layout>
  );
}
