import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type SessionListItem, type SessionView } from '../api';
import { navigate } from '../App';
import { Address, Header, Notice, StatusBadge } from '../components/ui';
import { useWallet } from '../useWallet';
import { AdminSession } from './AdminSession';

export function Admin({ sessionId }: { sessionId: number | null }) {
  const w = useWallet('Вход ведущего в Криптополию');

  const right = w.address ? <Address value={w.address} label="Ведущий" /> : null;

  if (!w.token || !w.address) {
    return (
      <>
        <Header right={right} />
        <main className="page narrow">
          <h1>Админка ведущего</h1>
          <p className="lead">
            Войдите своим кошельком. Пароль не нужен: кошелёк подпишет короткое сообщение, и сервер узнает ваш адрес.
            Вы увидите только свои партии.
          </p>
          {!w.hasWallet && (
            <Notice kind="error">
              Кошелёк не найден. На компьютере установите расширение MetaMask или другое, на телефоне откройте эту
              страницу во встроенном браузере кошелька.
            </Notice>
          )}
          {w.error && <Notice kind="error">{w.error}</Notice>}
          {w.busy && <Notice>{w.busy}</Notice>}
          <button type="button" className="big" disabled={!w.hasWallet || !!w.busy || !w.cfg} onClick={() => void w.login()}>
            Войти через кошелёк
          </button>
        </main>
      </>
    );
  }

  return (
    <>
      <Header right={right} />
      {sessionId ? (
        <AdminSession id={sessionId} token={w.token} onAuthExpired={w.expire} />
      ) : (
        <SessionList token={w.token} onAuthExpired={w.expire} />
      )}
    </>
  );
}

function SessionList({ token, onAuthExpired }: { token: string; onAuthExpired: () => void }) {
  const [list, setList] = useState<SessionListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(6);
  const [startBalance, setStartBalance] = useState(1500);

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onAuthExpired();
      setError((e as Error).message);
    },
    [onAuthExpired],
  );

  const load = useCallback(() => {
    api<{ sessions: SessionListItem[] }>('/api/sessions', { token })
      .then((r) => setList(r.sessions))
      .catch(handle);
  }, [token, handle]);

  useEffect(load, [load]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const s = await api<SessionView>('/api/sessions', {
        method: 'POST',
        token,
        body: { title, maxPlayers, startBalance },
      });
      navigate(`/admin/${s.id}`);
    } catch (e) {
      handle(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <h1>Мои партии</h1>
      <section className="card">
        <h2>Новая партия</h2>
        <form
          className="grid-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label>
            Название
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, группа ЭК-21" maxLength={60} />
          </label>
          <label>
            Игроков
            <select value={maxPlayers} onChange={(e) => setMaxPlayers(Number(e.target.value))}>
              {[2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            Стартовый баланс, USDG
            <input
              type="number"
              min={1}
              max={1000000}
              value={startBalance}
              onChange={(e) => setStartBalance(Number(e.target.value))}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? 'Создаём токены в сети…' : 'Создать партию'}
          </button>
        </form>
      </section>
      {error && <Notice kind="error">{error}</Notice>}
      {list && list.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Партия</th>
              <th>Код</th>
              <th>Игроки</th>
              <th>Статус</th>
              <th>Создана</th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id} className="clickable" onClick={() => navigate(`/admin/${s.id}`)}>
                <td>
                  <a
                    href={`/admin/${s.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/admin/${s.id}`);
                    }}
                  >
                    {s.title}
                  </a>
                </td>
                <td>
                  <code>{s.code}</code>
                </td>
                <td>
                  {s.players} из {s.maxPlayers}
                </td>
                <td>
                  <StatusBadge status={s.status} />
                </td>
                <td>{new Date(s.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {list && list.length === 0 && <p className="muted">Партий пока нет. Создайте первую.</p>}
    </main>
  );
}
