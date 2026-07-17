import { useNavigate } from "react-router-dom";
import { Layout } from "./Layout";

interface PlaceholderPageProps {
  title: string;
  note: string;
}

/** Routing-skeleton stub for screens not yet built in this wave (W1/W2). */
export function PlaceholderPage({ title, note }: PlaceholderPageProps) {
  const navigate = useNavigate();
  return (
    <Layout>
      <h1>{title}</h1>
      <p>{note}</p>
      <button type="button" onClick={() => navigate("/lobby")}>
        로비로
      </button>
    </Layout>
  );
}
