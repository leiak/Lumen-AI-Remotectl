import { Link, Route, Routes } from 'react-router-dom';
import { Inbox } from './pages/Inbox';
import { IssueDetail } from './pages/IssueDetail';
import { LiveStream } from './pages/LiveStream';
import { NewIssue } from './pages/NewIssue';
import { Settings } from './pages/Settings';

export function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>RemoteCTL</h1>
        <nav>
          <Link to="/">Inbox</Link>
          <Link to="/new">New</Link>
          <Link to="/settings">Settings</Link>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Inbox />} />
          <Route path="/issues/:id?" element={<IssueDetail />} />
          <Route path="/issues/:id/stream" element={<LiveStream />} />
          <Route path="/new" element={<NewIssue />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<div className="page"><h2>Not Found</h2><p>No such page.</p></div>} />
        </Routes>
      </main>
    </div>
  );
}
