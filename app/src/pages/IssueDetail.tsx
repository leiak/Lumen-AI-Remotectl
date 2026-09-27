import { useParams } from 'react-router-dom';

export function IssueDetail() {
  const { id } = useParams<{ id: string }>();
  if (!id) {
    return <div className="page issue-detail"><h2>Issue</h2><p>Missing id.</p></div>;
  }
  return <div className="page issue-detail"><h2>Issue {id}</h2><p>Loading…</p></div>;
}
