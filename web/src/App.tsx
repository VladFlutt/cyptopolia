import { useEffect, useState } from 'react';
import { Home } from './pages/Home';
import { Admin } from './pages/Admin';
import { Player } from './pages/Player';

/** Tiny router: three screens do not need a routing library. */
export function navigate(path: string) {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const h = () => setPath(window.location.pathname);
    window.addEventListener('popstate', h);
    return () => window.removeEventListener('popstate', h);
  }, []);
  return path;
}

export function App() {
  const path = usePath();
  const join = path.match(/^\/j\/([A-Za-z0-9]{4,12})\/?$/);
  if (join) return <Player code={join[1]!.toUpperCase()} />;
  const admin = path.match(/^\/admin(?:\/(\d+))?\/?$/);
  if (admin) return <Admin sessionId={admin[1] ? Number(admin[1]) : null} />;
  return <Home />;
}
