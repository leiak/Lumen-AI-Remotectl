import { useParams } from 'react-router-dom';

export function IssueDetail() {
  const { id } = useParams();
  return <div className="page issue-detail"><h2>Issue {id}</h2><p>Loading…</p></div>;
}
